import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { careerosDir, layout, listJobs, readRecord, RecordError, updateRecord, writeFileAtomic, type Job } from "@careeros/core";
import { isIgnored, isJobRelated, matchMessage, type CompanyInfo, type HeaderInfo, type IgnoreList } from "./match.js";
import { parseMessage, type ParsedMessage } from "./parse.js";
import { explainMailError, type HeaderSummary, type MailProvider, type MailSession } from "./provider.js";
import { cleanOrphans, isStagingRef, knownMessageIds, MAIL_REF, messageIdFor, readStored, purgeTriage, storeMessage, type StoreInput, type StoreTarget } from "./store.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

const DAY = 86_400_000;
const LOCK_STALE_MS = 15 * 60_000;

export interface SyncCaps { maxMessageBytes: number; maxMessages: number; maxNetworkMs: number }
export const DEFAULT_CAPS: SyncCaps = { maxMessageBytes: 25 * 1024 * 1024, maxMessages: 500, maxNetworkMs: 60_000 };
export interface SyncCounts { stored: number; triaged: number; skipped: number; duplicates: number; too_large: number }
type Box = "inbox" | "sent";
/**
 * One mailbox's progress. `last_uid` is the high-water mark. `complete_through` (fix round 1, F4)
 * is the latest internal date among the messages handled in UID order up to that mark: a re-scan
 * after Gmail renumbers the mailbox starts two days before it, so a backlog a capped run left
 * behind is never skipped.
 */
export interface MailboxState { uidvalidity: string; last_uid: number; complete_through?: string }
export interface MailState {
  schema: 1; account: string; mailboxes: Partial<Record<Box, MailboxState>>;
  last_run: string; last_ok: string; last_error: string; counts: SyncCounts; purged: number; ignore: IgnoreList;
  /** The last "Re-check filed mail" rules version offered (see RECHECK_VERSION); 0 = never. */
  recheck: number;
}
export interface SyncOptions {
  root: string; provider: MailProvider; account: string; now: Date; firstSyncDays: number; lockFile: string;
  caps?: Partial<SyncCaps>;
  /** Milliseconds of network time used so far in this run. Tests replace it. */
  elapsed?: () => number;
  /**
   * Stops the run (another workspace was opened): no new work starts, the Gmail session is closed
   * at once, what was stored stays stored, and the next run carries on from the mark.
   */
  signal?: AbortSignal;
}
/**
 * `repair_failed` (fix round 2, N1): duplicates whose missing timeline event couldn't be put back
 * (the job record can't be read or written). The message itself is stored, so the run goes on.
 */
export interface SyncResult extends SyncCounts { capped: boolean; purged: number; error: string; touched: string[]; repair_failed: number }

/** A stopped run's result error. Not saved as the workspace's last error: nothing went wrong. */
export const SYNC_STOPPED = "The mail sync stopped because another workspace was opened.";
class Stopped extends Error {}

const STORE_FAILED = `${identity.name} couldn't save an email to your workspace.`;
const WORKSPACE_FAILED = `${identity.name} couldn't read or update your workspace.`;

/** A message that can't be handled safely yet (it is still on its way into the store elsewhere). The mailbox stops before it. */
class HoldBack extends Error {}

/**
 * Fix round 1, F2: a local problem (the workspace can't be read or written) in plain words. It
 * never wraps the original error, so no path or file name can leak into the message.
 */
export class WorkspaceError extends Error {
  constructor(message = WORKSPACE_FAILED, readonly fix = `Check that the workspace folder exists and that ${identity.name} can read and write it, then sync again.`) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Runs a local step; anything it throws becomes a WorkspaceError (HoldBack and WorkspaceError pass through). */
function local<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof WorkspaceError || e instanceof HoldBack) throw e;
    throw new WorkspaceError();
  }
}
const zero = (): SyncCounts => ({ stored: 0, triaged: 0, skipped: 0, duplicates: 0, too_large: 0 });
const stateFile = (root: string) => path.join(careerosDir(root), "mail-state.json");
const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

export function readMailState(root: string): MailState {
  let raw: Partial<MailState> = {};
  try { raw = JSON.parse(fs.readFileSync(stateFile(root), "utf8")) as Partial<MailState>; } catch { raw = {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 2000) : []);
  const box = (v: unknown): MailboxState | undefined => {
    const o = v as { uidvalidity?: unknown; last_uid?: unknown; complete_through?: unknown } | undefined;
    if (!(o && typeof o === "object" && typeof o.uidvalidity === "string" && Number.isInteger(o.last_uid) && (o.last_uid as number) >= 0)) return undefined;
    const ct = typeof o.complete_through === "string" && !Number.isNaN(Date.parse(o.complete_through)) ? new Date(o.complete_through).toISOString() : "";
    return { uidvalidity: o.uidvalidity, last_uid: o.last_uid as number, ...(ct ? { complete_through: ct } : {}) };
  };
  const mb = (raw.mailboxes && typeof raw.mailboxes === "object" ? raw.mailboxes : {}) as MailState["mailboxes"];
  const inbox = box(mb.inbox);
  const sent = box(mb.sent);
  const c = (raw.counts && typeof raw.counts === "object" ? raw.counts : {}) as Partial<SyncCounts>;
  const ig = (raw.ignore && typeof raw.ignore === "object" ? raw.ignore : {}) as Partial<IgnoreList>;
  return {
    schema: 1, account: typeof raw.account === "string" ? raw.account : "",
    mailboxes: { ...(inbox ? { inbox } : {}), ...(sent ? { sent } : {}) },
    last_run: typeof raw.last_run === "string" ? raw.last_run : "", last_ok: typeof raw.last_ok === "string" ? raw.last_ok : "",
    last_error: typeof raw.last_error === "string" ? raw.last_error : "",
    counts: { stored: count(c.stored), triaged: count(c.triaged), skipped: count(c.skipped), duplicates: count(c.duplicates), too_large: count(c.too_large) },
    purged: count(raw.purged),
    ignore: { senders: strings(ig.senders), domains: strings(ig.domains) },
    recheck: count(raw.recheck),
  };
}

/** Writes `.careeros/mail-state.json`. It holds UIDs, dates, counts and the ignore list, never a secret. */
export function writeMailState(root: string, s: MailState): void {
  writeFileAtomic(stateFile(root), JSON.stringify(s, null, 2) + "\n");
}

export class SyncBusyError extends Error {
  constructor() { super("A mail sync is already running."); this.name = "SyncBusyError"; }
}

function stale(text: string, now: Date): boolean {
  try {
    const { pid, at } = JSON.parse(text) as { pid: number; at: string };
    if (!(now.getTime() - Date.parse(at) < LOCK_STALE_MS)) return true;
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { return true; }
}

/** @internal Test seam, not re-exported from index.ts: runs after a lock is judged stale, before the takeover. */
export const _lockHooks: { afterStaleCheck?: () => void } = {};

function readOrNull(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

/**
 * Takes over a stale lock atomically (fix round 1, F5). The lock is renamed away under a unique
 * name: only one process can win that rename. The winner then checks the renamed file is the same
 * stale lock it judged; if another process had already replaced it with a fresh lock, that lock
 * is put back (never overwriting) and this sync stays out. Only then is a new lock created with "wx".
 */
function takeOver(file: string, judged: string, body: string): void {
  const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.stale`;
  try { fs.renameSync(file, aside); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new SyncBusyError(); // another process won the rename
    throw e;
  }
  if (readOrNull(aside) !== judged) {
    try { fs.linkSync(aside, file); } catch { /* a newer lock is already there */ }
    fs.rmSync(aside, { force: true });
    throw new SyncBusyError();
  }
  fs.rmSync(aside, { force: true });
  try { fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SyncBusyError(); throw e; }
}

/**
 * One sync at a time across the app timer, Sync now and the background job. The lock lives in
 * user data. A lock is taken over when it is 15 minutes old or its process is gone.
 */
export function acquireLock(file: string, now = new Date()): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, at: now.toISOString() });
  try { fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const judged = readOrNull(file);
    if (judged === null) throw new SyncBusyError(); // released or taken over meanwhile; try again next time
    if (!stale(judged, now)) throw new SyncBusyError();
    _lockHooks.afterStaleCheck?.();
    takeOver(file, judged, body);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try { if (fs.readFileSync(file, "utf8") === body) fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  };
}

export function companyIndex(root: string): CompanyInfo[] {
  const L = layout(root);
  const jobs = listJobs(root);
  const out: CompanyInfo[] = [];
  for (const slug of fs.existsSync(L.companiesDir) ? fs.readdirSync(L.companiesDir).sort() : []) {
    let c;
    try { c = readRecord("company", L.companyFile(slug)); } catch (e) { if (e instanceof RecordError || (e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") continue; throw e; }
    const mine = jobs.filter((j) => j.company_slug === slug).flatMap((j) => {
      try {
        const r = readRecord("job", j.file);
        return [{ id: r.id, title: r.title, status: r.status, last_activity: r.timeline.reduce((m, e) => (e.at > m ? e.at : m), r.found_at) }];
      } catch { return []; }
    });
    out.push({ slug, name: c.name, aliases: c.aliases, website: c.website, recruiter_email: c.recruiter.email, email_match: c.email_match, jobs: mine });
  }
  return out;
}


export async function syncMail(o: SyncOptions): Promise<SyncResult> {
  const r: SyncResult = { ...zero(), capped: false, purged: 0, error: "", touched: [], repair_failed: 0 };
  if (o.signal?.aborted) return { ...r, error: SYNC_STOPPED };
  let release: () => void;
  try { release = acquireLock(o.lockFile, o.now); }
  catch (e) { if (e instanceof SyncBusyError) return { ...r, error: e.message }; throw e; }

  const caps = { ...DEFAULT_CAPS, ...o.caps };
  const t0 = Date.now();
  const elapsed = o.elapsed ?? (() => Date.now() - t0);
  const state = readMailState(o.root);
  if (state.account !== o.account) { state.account = o.account; state.mailboxes = {}; }
  // The ignore list can change in the app while a sync runs; always keep the newest one on disk.
  const save = () => local(() => { state.ignore = readMailState(o.root).ignore; writeMailState(o.root, state); });
  let session: MailSession | null = null;
  let onStop: (() => void) | null = null;
  let known = new Map<string, string>();

  /** "new", "known" (stored already, or a journaled store that recovery always finishes) or "pending" (see isStagingRef). */
  const seen = (id: string): "new" | "known" | "pending" => {
    const ref = known.get(id);
    return ref === undefined ? "new" : isStagingRef(ref) ? "pending" : "known";
  };

  /**
   * Stores one message. On a failure, interrupted stores are recovered and the Message-IDs read
   * again first: if the message is now in place, that counts as stored. Only then is it tried once
   * more. A second failure ends the run with a plain error, before the high-water mark moves.
   */
  const store = (target: StoreTarget, input: StoreInput, id: string): { ref: string; added: boolean } => {
    try { return { ref: storeMessage(o.root, target, input, { now: o.now }).ref, added: true }; }
    catch { /* recover and look again below */ }
    try { cleanOrphans(o.root, o.now); } catch { /* best effort */ }
    try { known = knownMessageIds(o.root); } catch { throw new WorkspaceError(STORE_FAILED); }
    const now = seen(id);
    if (now === "known") return { ref: known.get(id)!, added: false };
    if (now === "pending") throw new HoldBack();
    try { return { ref: storeMessage(o.root, target, input, { now: o.now }).ref, added: true }; }
    catch { throw new WorkspaceError(STORE_FAILED); }
  };

  /**
   * Fix round 1, F1: the job's "Email received/sent" event, keyed by Message-ID (`message_id` on the
   * event). Added only if no event has that key yet, so it is idempotent: a run that stored the
   * message but failed before the event was written gets it back on the next run.
   */
  const ensureEvent = (slug: string, jobId: string, event: string, note: string, id: string) => local(() => {
    const file = layout(o.root).jobFile(slug, jobId);
    const has = (j: Job) => j.timeline.some((e) => e.message_id === id);
    if (has(readRecord("job", file))) return;
    updateRecord("job", file, (j) => { if (!has(j)) j.timeline.push({ at: o.now.toISOString(), event, note, message_id: id }); });
  });

  /**
   * A duplicate already sits in a job's emails folder: make sure its event is there. Only for mail
   * sync put there itself (not one you moved by hand), and only when its sidecar can be read now.
   */
  const repairEvent = (id: string) => {
    const ref = known.get(id);
    const m = ref ? MAIL_REF.exec(ref) : null;
    if (!ref || !m || !m[1] || !m[2]) return;
    let email;
    try { email = readStored(o.root, ref).email; } catch { return; }
    if (email.message_id !== id || email.matched_by === "user") return;
    // Fix round 2, N1: best effort. The message is already stored, so a job record that can't be
    // read or written (say, hand-edited into an invalid state) must never stop the mailbox here;
    // it is counted, and the next duplicate sighting tries again. The event write right after a
    // fresh store still fails the run.
    try { ensureEvent(m[1], m[2], email.direction === "in" ? "Email received" : "Email sent", email.subject.slice(0, 200), id); }
    catch { r.repair_failed++; }
  };

  const handle = async (s: MailSession, which: Box, h: HeaderSummary, companies: CompanyInfo[]) => {
    const from = h.from[0] ?? { name: "", address: "" };
    // Your own message in INBOX (you copied yourself) is sent mail: it matches on its recipients and dedupes with Sent.
    const direction = which === "sent" || from.address.toLowerCase() === o.account.toLowerCase() ? "out" : "in";
    const info: HeaderInfo = { direction, from, to: h.to, cc: h.cc, subject: h.subject };
    if (direction === "in" && isIgnored(info.from.address, state.ignore)) { r.skipped++; return; }
    const match = matchMessage(info, companies, o.account);
    // Personal mail: decided on headers alone; nothing is downloaded or written.
    if (!match && !isJobRelated(info)) { r.skipped++; return; }
    const check = (id: string) => {
      const v = seen(id);
      if (v === "pending") throw new HoldBack();
      return v === "known";
    };
    if (h.messageId && check(h.messageId)) { r.duplicates++; repairEvent(h.messageId); return; }
    const target: StoreTarget = match ? { company_slug: match.company_slug, job_id: match.job_id } : "triage";
    const base = { header: h, mailbox: which === "inbox" ? "INBOX" : "Sent", direction, matched_by: match?.matched_by ?? "none" } as const;
    let input: StoreInput;
    if (h.size > caps.maxMessageBytes) {
      input = { ...base, raw: null, parsed: null, tooLarge: true };
    } else {
      // At most maxMessageBytes + 1 bytes come down, so a server that under-reports the size can't push past the cap.
      const raw = await s.body(h.uid, caps.maxMessageBytes);
      if (raw.length > caps.maxMessageBytes) input = { ...base, raw: null, parsed: null, tooLarge: true };
      else {
        let parsed: ParsedMessage | null = null;
        // A message the parser refuses is kept as headers only, so one bad message can't stall every later sync.
        try { parsed = await parseMessage(raw); } catch { parsed = null; }
        input = { ...base, raw: parsed ? raw : null, parsed, tooLarge: false };
      }
    }
    const id = messageIdFor(input);
    if (check(id)) { r.duplicates++; repairEvent(id); return; }
    const stored = store(target, input, id);
    if (input.tooLarge) r.too_large++;
    known.set(id, stored.ref);
    r.touched.push(stored.ref);
    if (target === "triage") { r.triaged++; return; }
    r.stored++;
    if (target.job_id) ensureEvent(target.company_slug, target.job_id, direction === "in" ? "Email received" : "Email sent", (input.parsed?.subject ?? input.header.subject).slice(0, 200), id);
  };

  try {
    // Every run first finishes or undoes interrupted stores and moves, and sweeps old leftovers in
    // .careeros/mail-staging/ (and only there).
    local(() => cleanOrphans(o.root, o.now));
    const companies = local(() => companyIndex(o.root));
    known = local(() => knownMessageIds(o.root));
    const stopCheck = () => { if (o.signal?.aborted) throw new Stopped(); };
    stopCheck();
    session = await o.provider.connect();
    // A stop closes the connection straight away, so a fetch in flight ends instead of running on.
    const live = session;
    onStop = () => { session = null; void live.close().catch(() => undefined); };
    o.signal?.addEventListener("abort", onStop, { once: true });
    stopCheck();
    let handled = 0;
    outer: for (const which of ["inbox", "sent"] as const) {
      stopCheck();
      if (handled >= caps.maxMessages || elapsed() >= caps.maxNetworkMs) { r.capped = true; break; }
      const info = await live.open(which);
      const prev = state.mailboxes[which];
      const floor = o.now.getTime() - o.firstSyncDays * DAY;
      let range: { sinceUid: number } | { since: Date };
      const rescan = !(prev && prev.uidvalidity === info.uidValidity);
      if (!rescan) range = { sinceUid: prev!.last_uid + 1 };
      else {
        // First run, or Gmail renumbered the mailbox: a re-scan by date. Message-IDs stop duplicates.
        // It starts two days before the last message handled in order (never from the last run's
        // date: a capped run may have left a backlog), or the first-sync window when there is none.
        range = { since: new Date(prev?.complete_through ? Date.parse(prev.complete_through) - 2 * DAY : floor) };
      }
      // One more than the room left, so a full mailbox shows up as capped.
      const list = await live.headers(range, { limit: caps.maxMessages - handled + 1 });
      if (rescan) {
        // Everything below the first message found is older than the window, so a capped re-scan
        // resumes by UID from there, never from UID 1. Nothing found: new mail starts at uidNext.
        const top = Number.isInteger(info.uidNext) && info.uidNext > 0 ? info.uidNext - 1 : 0;
        state.mailboxes[which] = {
          uidvalidity: info.uidValidity, last_uid: list.length ? list[0]!.uid - 1 : top,
          ...(prev?.complete_through ? { complete_through: prev.complete_through } : {}),
        };
        save();
      }
      const box = state.mailboxes[which]!;
      for (const h of list) {
        stopCheck();
        if (handled >= caps.maxMessages || elapsed() >= caps.maxNetworkMs) { r.capped = true; break outer; }
        handled++;
        try { await handle(live, which, h, companies); }
        catch (e) {
          if (o.signal?.aborted) throw new Stopped();
          // Held back: this mailbox stops before the message without moving the high-water mark; the next run tries again.
          if (e instanceof HoldBack) { r.capped = true; continue outer; }
          throw e;
        }
        // The high-water mark moves one message at a time, after it is stored or deliberately skipped.
        box.last_uid = Math.max(box.last_uid, h.uid);
        // Only messages handled in order, up to the high-water mark, move complete_through.
        if (h.internalDate && !Number.isNaN(Date.parse(h.internalDate))) {
          // Clamped to now (fix round 2): a future-dated message can't move the re-scan start forward.
          const d = new Date(Math.min(Date.parse(h.internalDate), o.now.getTime())).toISOString();
          if (!box.complete_through || d > box.complete_through) box.complete_through = d;
        }
        save();
      }
    }
    state.last_ok = o.now.toISOString();
    state.last_error = "";
  } catch (e) {
    if (e instanceof Stopped || o.signal?.aborted) r.error = SYNC_STOPPED;
    else {
      // Only provider (Gmail) failures get Gmail's wording; every local step throws a WorkspaceError.
      r.error = e instanceof WorkspaceError ? e.message : explainMailError(e).message;
      state.last_error = r.error;
    }
  } finally {
    if (onStop) o.signal?.removeEventListener("abort", onStop);
    if (session) { try { await session.close(); } catch { /* the connection is already gone */ } }
    try { r.purged = purgeTriage(o.root, o.now); } catch { r.purged = 0; }
    state.purged = r.purged;
    state.last_run = o.now.toISOString();
    state.counts = { stored: r.stored, triaged: r.triaged, skipped: r.skipped, duplicates: r.duplicates, too_large: r.too_large };
    try { save(); } catch {
      // The workspace can't be written; the next run starts from the last saved mark.
      if (!r.error) r.error = WORKSPACE_FAILED;
    }
    release();
  }
  return r;
}
