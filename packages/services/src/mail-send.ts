import fs from "node:fs";
import path from "node:path";
import {
  appendLineDurable, buildDraftMessage, careerosDir, iso, jobFilePath, listDraftFiles, logActivity, moveDraftToSent, readActivity, readApproval,
  setApprovalNote, setApprovalStatus, updateRecord, type Approval, type Clock,
} from "@careeros/core";
import { acquireLock, buildMime, envelopeFor, explainMailError, isStagingRef, knownMessageIds, parseMessage, readStored, redact, storeMessage, SyncBusyError } from "@careeros/mail";
import type { ServiceContext } from "./context.js";
import { plainError } from "./errors.js";
import { currentAccount, isExampleMail, mailHost, mailSettings } from "./mail-account.js";
import { workspaceIdOf } from "./workspace-registry.js";
import { jobDirRel, touch } from "./read.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

const HOUR = 3_600_000;
const LOG = "mail-sends.jsonl";
/** A "started" send from another process older than this is treated as interrupted (SMTP gives up long before). */
const STARTED_STALE_MS = 15 * 60_000;
const LOCK_WAIT_MS = 5_000;

export const UNSURE = "Not sure it sent. Check Gmail's Sent folder.";
export const DRAFT_UNSURE = "Not sure the last send of this draft went out. Check Gmail's Sent folder, then use Mark as sent or Send again on that email.";
export const ALREADY_SENT = "This draft was already sent. To send it again, make a new draft.";
export const NOT_WAITING = "This email isn't waiting for a check.";
export const CONFIRM_AGAIN = "Confirm that you want to send this email again.";
export const FOUND_IN_SENT = "Already in Gmail's Sent folder, so it wasn't sent again.";

/**
 * One line of `.careeros/mail-sends.jsonl`, the send journal. "started" is written (under the send
 * lock, together with the hourly limit check) before the message goes to Gmail. Then one of:
 * "sent" (Gmail accepted it, it was found in Sent, or you marked it sent), "failed" (Gmail
 * definitely refused it) or "unknown" (no final reply, or the app stopped mid-send).
 */
export type SendState = "started" | "sent" | "failed" | "unknown";
export interface SendRecord {
  at: string; approval: string; draft_id: string; company_slug: string; id: string; message_id: string; state: SendState;
  pid: number; by: "send" | "sync" | "user";
}
type SendKey = Pick<SendRecord, "approval" | "draft_id" | "company_slug" | "id" | "message_id">;

/** Sends running in this process, so reconciliation never mistakes one for an interrupted send. */
const inFlight = new Set<string>();
const flightKey = (root: string, approval: string) => `${root}\u0000${approval}`;

/** A send that may have gone but had no final reply. The approval stays open with UNSURE. */
export class SendUnsureError extends Error { constructor() { super(UNSURE); this.name = "SendUnsureError"; } }
/** Send again found the message in Sent; the approval was closed as sent and nothing went out. */
export class FoundInSentError extends Error { constructor() { super(FOUND_IN_SENT); this.name = "FoundInSentError"; } }
/** Gmail definitely refused the message, or it never reached Gmail. The approval fails. */
export class SendRefusedError extends Error { constructor(message: string) { super(message); this.name = "SendRefusedError"; } }

/** @internal Test seam: runs inside the send lock, after the limit check and before "started" is written. */
export const _sendHooks: { afterCheck?: () => void } = {};

/** @internal Appends one journal line. Exported for tests that recreate a crash. */
export function recordSend(root: string, r: SendKey & { state: SendState; by?: SendRecord["by"] }, c?: Clock): void {
  const line: SendRecord = {
    at: iso(c), approval: r.approval, draft_id: r.draft_id, company_slug: r.company_slug, id: r.id, message_id: r.message_id, state: r.state,
    pid: process.pid, by: r.by ?? "send",
  };
  // fsynced (fix round 1): "started" must be on disk before Gmail gets anything, even across a power loss.
  appendLineDurable(root, path.join(careerosDir(root), LOG), JSON.stringify(line) + "\n");
}

export function readSendLog(root: string): SendRecord[] {
  const f = path.join(root, ".careeros", LOG);
  if (!fs.existsSync(f) || fs.lstatSync(f).isSymbolicLink()) return [];
  const out: SendRecord[] = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as SendRecord;
      if (typeof v.approval === "string" && typeof v.at === "string" && ["started", "sent", "failed", "unknown"].includes(v.state)) out.push(v);
    } catch { /* skip a torn or hand-edited line */ }
  }
  return out;
}

interface SendStatus { key: SendKey; state: SendState; last: SendRecord; attempts: { at: string; failed: boolean }[] }

function statusByApproval(root: string): Map<string, SendStatus> {
  const m = new Map<string, SendStatus>();
  for (const r of readSendLog(root)) {
    let s = m.get(r.approval);
    if (!s) { s = { key: r, state: r.state, last: r, attempts: [] }; m.set(r.approval, s); }
    if (r.state === "started") s.attempts.push({ at: r.at, failed: false });
    else if (r.state === "failed" && s.attempts.length) s.attempts.at(-1)!.failed = true;
    s.state = r.state;
    s.last = r;
  }
  return m;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A "started" send with nothing running it any more (the app stopped mid-send) counts as "unknown". */
function effective(root: string, s: SendStatus, now: Date): SendState {
  if (s.state !== "started") return s.state;
  if (s.last.pid === process.pid) return inFlight.has(flightKey(root, s.key.approval)) ? "started" : "unknown";
  return now.getTime() - Date.parse(s.last.at) > STARTED_STALE_MS || !alive(s.last.pid) ? "unknown" : "started";
}

/** The send state of one approval, or null when it never started a send. */
export function sendState(root: string, approval: string, now: Date): SendState | null {
  const s = statusByApproval(root).get(approval);
  return s ? effective(root, s, now) : null;
}

/**
 * Sends (or possible sends) in the 60 minutes before `now`. Counts "Email sent" activity entries,
 * as the settings promise, and every journal attempt that wasn't definitely refused (so a send
 * whose outcome is unknown counts too). Both live in the workspace, so the limit holds across
 * restarts. Each activity entry has a journal attempt written before it, so the larger count wins.
 */
export function sentInLastHour(root: string, now: Date): number {
  const since = now.getTime() - HOUR;
  const fromActivity = readActivity(root, 100_000).filter((e) => e.event === "Email sent" && Date.parse(e.at) > since).length;
  let fromJournal = 0;
  for (const s of statusByApproval(root).values()) for (const t of s.attempts) if (!t.failed && Date.parse(t.at) > since) fromJournal++;
  return Math.max(fromActivity, fromJournal);
}

/**
 * Runs `fn` holding the workspace's send lock (`.careeros/mail-send.lock`, taken with mail's
 * `acquireLock`: exclusive create, taken over when its process is gone or it is 15 minutes old),
 * so the app and the CLI can't both pass the hourly limit or both claim one draft. The section is
 * short and synchronous; a busy lock is waited for briefly.
 */
function withSendLock<T>(root: string, fn: () => T): T {
  const file = path.join(careerosDir(root), "mail-send.lock");
  const until = Date.now() + LOCK_WAIT_MS;
  let release: () => void;
  for (;;) {
    try { release = acquireLock(file, new Date()); break; } catch (e) {
      if (!(e instanceof SyncBusyError)) throw e;
      if (Date.now() > until) throw new Error("Another email is being sent from this workspace. Try again in a moment.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { release(); }
}

/**
 * Whether the synced mail proves this Message-ID was sent from this account (fix round 1): a stored
 * copy that is outgoing and either came from Gmail's Sent mailbox or has the account's own From.
 * An incoming message carrying the same ID (a reply quoting it, or a planted one) isn't proof.
 */
function sentProof(root: string, known: Map<string, string>, messageId: string): boolean {
  const ref = known.get(messageId);
  if (!ref || isStagingRef(ref)) return false;
  let email;
  try { email = readStored(root, ref).email; } catch { return false; }
  if (email.message_id !== messageId || email.direction !== "out") return false;
  const account = mailSettings(root).address.toLowerCase();
  return email.mailbox === "Sent" || (!!account && email.from.address.toLowerCase() === account);
}

function knownIds(root: string): Map<string, string> {
  try { return knownMessageIds(root); } catch { return new Map(); }
}

/**
 * Claims one send: under the send lock, checks that this approval and its draft have no send on
 * record that blocks it and that the hourly limit has room, then writes "started". `again` is
 * Send again on an approval whose send is "unknown".
 */
export function claimSend(root: string, key: SendKey, o: { limit: number; now: Date; again: boolean; approval?: Approval }, c?: Clock): "claimed" | "found" {
  return withSendLock(root, () => {
    const all = statusByApproval(root);
    const mine = all.get(key.approval);
    if (o.again) {
      if (!mine || effective(root, mine, o.now) !== "unknown") throw new Error(NOT_WAITING);
      // Fix round 1: look in the synced Sent mail first. Found there, it is closed as sent, not sent twice.
      if (o.approval && sentProof(root, knownIds(root), key.message_id)) {
        finishConfirmed(root, o.approval, "sync", FOUND_IN_SENT, c);
        return "found";
      }
    } else if (mine) throw new Error(`${identity.name} already tried to send this email. Check Gmail's Sent folder.`);
    for (const s of all.values()) {
      if (s.key.approval === key.approval || s.key.company_slug !== key.company_slug || s.key.id !== key.id || s.key.draft_id !== key.draft_id) continue;
      const st = effective(root, s, o.now);
      if (st === "started" || st === "unknown") throw new Error(DRAFT_UNSURE);
      if (st === "sent") throw new Error(ALREADY_SENT);
    }
    const recent = sentInLastHour(root, o.now);
    if (recent >= o.limit) {
      throw new Error(`${identity.name} has sent ${recent} email${recent === 1 ? "" : "s"} in the last hour, the most your settings allow. Try again later or raise the limit in Settings > Email.`);
    }
    _sendHooks.afterCheck?.();
    recordSend(root, { ...key, state: "started" }, c);
    return "claimed";
  });
}

/** The job's "Email sent" event, keyed by Message-ID like sync's, so a later sync of Gmail's Sent copy never repeats it. */
function sentEvent(root: string, slug: string, id: string, subject: string, messageId: string, c?: Clock): void {
  if (!id) return; // a company's own email (a recruiter enquiry) has no job timeline; the agency's shows it from the draft
  updateRecord("job", jobFilePath(root, slug, id), (j) => {
    if (j.timeline.some((e) => e.message_id === messageId)) return;
    j.timeline.push({ at: iso(c), event: "Email sent", note: subject.slice(0, 200), message_id: messageId });
  });
}

/** The draft owner's folder: the job's, or (id "") the company's. */
const ownerRel = (slug: string, id: string) => (id ? jobDirRel(slug, id) : `companies/${slug}`);

const keyOf = (a: Approval): SendKey => {
  const p = a.payload as Record<string, unknown>;
  return { approval: a.id, company_slug: String(p.company_slug ?? ""), id: String(p.id ?? ""), draft_id: String(p.draft_id ?? ""), message_id: String(p.message_id ?? "") };
};
const subjectOf = (a: Approval) => a.title.replace(/^Send "/, "").replace(/"$/, "");

/** Closes a send confirmed some way other than Gmail's reply: journal, event, draft move, activity, approval done. */
function finishConfirmed(root: string, a: Approval, by: "sync" | "user", note: string, c?: Clock): Approval {
  const k = keyOf(a);
  recordSend(root, { ...k, state: "sent", by }, c);
  try { sentEvent(root, k.company_slug, k.id, subjectOf(a), k.message_id, c); } catch { /* the job record can't be written; the approval still closes */ }
  try { if (listDraftFiles(root, k.company_slug, k.id).some((f) => f.draft_id === k.draft_id && !f.sent)) moveDraftToSent(root, k.company_slug, k.id, k.draft_id); } catch { /* left in drafts */ }
  try { touch(root, ownerRel(k.company_slug, k.id)); } catch { /* the index catches up later */ }
  try { logActivity(root, by === "user" ? "Email marked as sent" : "Email confirmed sent", subjectOf(a).slice(0, 200), c); } catch { /* best effort */ }
  return setApprovalStatus(root, a.id, "done", note, c);
}

/** "Mark as sent" on a send whose outcome is unknown. Sends nothing. */
export function markSent(root: string, a: Approval, now: Date, c?: Clock): Approval {
  if (a.action !== "email_send" || a.status !== "approved") throw new Error(NOT_WAITING);
  return withSendLock(root, () => {
    if (sendState(root, a.id, now) !== "unknown") throw new Error(NOT_WAITING);
    return finishConfirmed(root, a, "user", "Marked as sent", c);
  });
}

/**
 * Settles sends whose outcome isn't known; runs at workspace open and after each mail sync. A send
 * whose Message-ID is now in the synced mail (Gmail's Sent copy) is marked sent and its approval
 * done. An interrupted "started" send that isn't there becomes "unknown", and its approval is
 * noted UNSURE (Mark as sent / Send again). Sends still running are left alone.
 */
export function reconcileSends(root: string, now: Date, c?: Clock): { sent: number; unsure: number } {
  const out = { sent: 0, unsure: 0 };
  if (![...statusByApproval(root).values()].some((s) => s.state === "started" || s.state === "unknown")) return out;
  withSendLock(root, () => {
    const known = knownIds(root);
    for (const s of statusByApproval(root).values()) {
      if (effective(root, s, now) !== "unknown") continue;
      let a: Approval | null;
      try { a = readApproval(root, s.key.approval); } catch { a = null; }
      if (sentProof(root, known, s.key.message_id)) {
        if (a && a.action === "email_send" && a.status === "approved") finishConfirmed(root, a, "sync", "Sent. Found in Gmail's Sent folder.", c);
        else recordSend(root, { ...s.key, state: "sent", by: "sync" }, c);
        out.sent++;
      } else if (s.state === "started") {
        recordSend(root, { ...s.key, state: "unknown" }, c);
        if (a && a.status === "approved") setApprovalNote(root, a.id, UNSURE);
        out.unsure++;
      }
    }
  });
  return out;
}

/**
 * Runs one approved email_send (or, with `again`, Send again on one whose outcome is unknown).
 * Before the attempt it throws a plain Error. After it: SendRefusedError when the message
 * certainly didn't go, SendUnsureError when there was no final reply. Once Gmail accepts it,
 * nothing fails: problems are added to the returned note.
 */
export async function sendEmailApproval(ctx: ServiceContext, a: Approval, opts: { again?: boolean; root?: string } = {}): Promise<string> {
  const host = mailHost(ctx);
  // Fixed for the whole send: if the person switches workspace while it is in flight, the send
  // finishes and its journal, timeline, sent copy and log all land in the workspace it started in.
  const root = opts.root ?? ctx.requireRoot();
  const p = a.payload as Record<string, unknown>;
  const key = keyOf(a);
  const { company_slug: slug, id, draft_id: draftId, message_id: messageId } = key;
  const account = currentAccount(ctx, root);
  const secrets = account ? [account.password, account.address] : [];
  const logId = workspaceIdOf(root) || undefined;
  /** Plain words with no path, password or address, for anything that fails before the message leaves. */
  const fail = (e: unknown): Error => {
    let msg = plainError(e, root).message;
    for (const s of secrets) if (s) msg = msg.split(s).join("[hidden]");
    return new Error(msg);
  };

  let built: ReturnType<typeof buildDraftMessage>;
  let claimed: "claimed" | "found";
  try {
    if (!account && isExampleMail(root)) throw new Error("This is the example workspace, so nothing is sent. Its emails are made up.");
    if (!account) throw new Error("Gmail isn't connected. Connect it in Settings > Email, then propose the email again.");
    if (account.address.toLowerCase() !== String(p.account ?? "").toLowerCase()) throw new Error("This email was prepared for another Gmail account. Propose it again.");
    built = buildDraftMessage(root, slug, id, draftId, { message_id: messageId, date: String(p.date ?? "") }, ctx.clock());
    if (built.digest !== p.sha256) throw new Error("The draft changed. Review it again.");
    // The intent, on disk before anything leaves.
    claimed = claimSend(root, key, { limit: mailSettings(root).send_limit_per_hour, now: ctx.now(), again: !!opts.again, approval: a }, ctx.clock());
  } catch (e) {
    throw fail(e);
  }
  // Send again found it in Sent: the approval is already closed as sent. Nothing goes out.
  if (claimed === "found") throw new FoundInSentError();

  const m = built.message;
  const envelope = envelopeFor(m);
  const flight = flightKey(root, a.id);
  inFlight.add(flight);
  let raw: Buffer;
  let accepted: string[];
  try {
    try {
      raw = await buildMime(m, built.contents);
    } catch (e) {
      // Nothing was handed to Gmail.
      try { recordSend(root, { ...key, state: "failed" }, ctx.clock()); } catch { /* stays "started": treated as maybe sent */ }
      throw new SendRefusedError(fail(e).message);
    }
    try {
      accepted = (await host.provider(account).send(envelope, raw)).accepted;
    } catch (e) {
      const err = explainMailError(e, secrets);
      const msg = redact(err.message, secrets);
      const unsure = err.delivery === "unknown";
      try { recordSend(root, { ...key, state: unsure ? "unknown" : "failed" }, ctx.clock()); } catch { /* stays "started": treated as maybe sent */ }
      try { host.log(redact(`${ctx.now().toISOString()} send ${unsure ? "unknown" : "error"}=${msg}`, secrets), logId); } catch { /* logging is best effort */ }
      throw unsure ? new SendUnsureError() : new SendRefusedError(msg);
    }
  } finally {
    inFlight.delete(flight);
  }

  // The message has left. From here on, problems are reported in the note, never as a failed approval.
  const problems: string[] = [];
  try { recordSend(root, { ...key, state: "sent" }, ctx.clock()); }
  catch { problems.push("the send couldn't be recorded"); }
  try { logActivity(root, "Email sent", m.subject.slice(0, 200), ctx.clock()); } catch { problems.push("the activity log couldn't be updated"); }
  try { host.log(redact(`${ctx.now().toISOString()} send ok recipients=${accepted.length}`, secrets), logId); } catch { /* best effort */ }
  try {
    const parsed = await parseMessage(raw);
    const s = storeMessage(root, { company_slug: slug, job_id: id }, {
      raw, parsed, mailbox: "Sent", direction: "out", matched_by: "user", tooLarge: false,
      header: { uid: 0, size: raw.length, internalDate: m.date, messageId: m.message_id, from: [m.from], to: m.to, cc: m.cc, subject: m.subject },
    }, ctx.clock());
    touch(root, s.ref);
  } catch { problems.push("the sent copy couldn't be saved (Gmail has it in Sent)"); }
  try { sentEvent(root, slug, id, m.subject, m.message_id, ctx.clock()); } catch { problems.push("the timeline couldn't be updated"); }
  try { moveDraftToSent(root, slug, id, draftId); } catch { problems.push("the draft couldn't be moved to sent"); }
  try { touch(root, ownerRel(slug, id)); } catch { /* the index catches up on the next refresh */ }
  const asked = envelope.to.length;
  let note = `Sent to ${accepted.length} recipient${accepted.length === 1 ? "" : "s"}`;
  if (accepted.length < asked) note += `; Gmail refused ${asked - accepted.length}`;
  return problems.length ? `${note}, but ${problems.join(" and ")}` : note;
}
