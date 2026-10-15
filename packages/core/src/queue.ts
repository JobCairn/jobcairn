import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Clock, iso } from "./clock.js";
// Circular with drafts.ts (drafts.ts calls proposeApproval/listApprovals/etc. from
// here). Safe because every use on both sides happens inside a function body, never
// at module top level, so by the time either function runs both modules are loaded.
import { buildDraftMessage, digestOf, draftFile, draftOwnerFile, sendSteps } from "./drafts.js";
import { jobFilePath } from "./jobs.js";
import { assertSegment, insideRoot, LOCKED_DIRS } from "./paths.js";
import { defaults } from "./schema.js";
import { appendLineSafe, readRecord, RecordError, updateRecord, writeRecord } from "./store.js";
import {
  type AccessRequest, type Approval, type ApprovalAction, APPROVAL_ACTIONS, type ApprovalStatus,
  JOB_STATUSES, type KindMap, type RequestStatus,
} from "./types.js";

// Concurrency contract
// ---------------------
// CareerOS is a single-instance desktop app: exactly one process ever calls
// setApprovalStatus / decideAccessRequest for a given workspace at a time, and it
// calls them synchronously (no overlapping writes to the same record from the same
// process). Those two functions are read-check-write (updateRecord reads the current
// file, checks the transition, writes it back) and are NOT safe against a second
// process racing the same id -- that's out of scope here because there is only ever
// one app instance. What *is* expected to race is record *creation*: the CLI (run by
// Claude) and the app can both call proposeApproval/requestAccess for the same
// workspace around the same time, and a double-click or a second window could both
// attempt to create a proposal/request with the same deterministic id. Creation goes
// through store.ts's `exclusive` write (hardlink, not rename), so a colliding id
// fails fast and retries with a fresh suffix rather than overwriting -- see
// writeExclusive below. The double-decide case (approving an already-approved
// record) is still caught, independently, by the NEXT/RNEXT state-machine checks
// below: a second approve on the same id throws instead of silently succeeding.
// The CLI must never expose a way to call setApprovalStatus or decideAccessRequest
// (no `approval decide`/`approval approve`/`request allow`/`request decide` commands):
// only the app decides; the CLI may only propose/request and list/read.

export type QueueKind = "approvals" | "requests";
export interface QueueSkip { file: string; problems: string[] }
export interface ProposeInput { action: ApprovalAction; title: string; summary?: string; steps?: string[]; payload?: Record<string, unknown>; created_by?: "app" | "claude" | "cli" }
export interface ActivityEntry { at: string; event: string; detail: string }

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function realFolder(root: string, dir: string): void {
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(dir); } catch { st = undefined; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`refusing to use ${path.relative(root, dir)}: not a real folder`);
}

export function careerosDir(root: string): string {
  const dir = path.join(root, ".careeros");
  realFolder(root, dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function queueDir(root: string, kind: QueueKind): string {
  const dir = path.join(careerosDir(root), kind);
  realFolder(root, dir);
  fs.mkdirSync(dir, { recursive: true });
  if (!insideRoot(root, dir)) throw new Error("refusing to use a queue outside the workspace");
  return dir;
}

function queueFile(root: string, kind: QueueKind, id: string): string {
  assertSegment(id, "queue id");
  if (!ID.test(id)) throw new Error(`bad queue id "${id}"`);
  return path.join(queueDir(root, kind), `${id}.json`);
}

export function newQueueId(seed: string, c?: Clock): string {
  const stamp = iso(c).replace(/[-:]/g, "").replace(/\.\d+Z$/, "").toLowerCase();
  return `${stamp}-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 6)}`;
}

const MAX_ID_ATTEMPTS = 5;

// Creates a new approval/access-request record under a fresh id, never overwriting
// an existing file. newQueueId is deterministic (time + content hash), so two
// concurrent proposals with the same input in the same second would compute the
// same id; writeRecord(..., { exclusive: true }) makes the actual file creation
// atomic (hardlink, not rename) so a collision fails with EEXIST instead of
// clobbering the record that got there first, and we retry under a new suffixed id.
function writeExclusive<K extends "approval" | "access_request">(
  root: string, kind: QueueKind, rk: K, seed: string, build: (id: string) => Record<string, unknown>, c?: Clock,
): KindMap[K] {
  const base = newQueueId(seed, c);
  for (let n = 0; n < MAX_ID_ATTEMPTS; n++) {
    const id = n === 0 ? base : `${base}-${n + 1}`;
    try {
      return writeRecord(rk, queueFile(root, kind, id), build(id), { exclusive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
  }
  throw new Error(`could not create a unique ${kind === "approvals" ? "approval" : "request"} id after ${MAX_ID_ATTEMPTS} tries`);
}

function listKind<K extends "approval" | "access_request">(root: string, kind: QueueKind, rk: K, skipped?: QueueSkip[]) {
  const dir = queueDir(root, kind);
  const out = [];
  for (const n of fs.readdirSync(dir).sort()) {
    if (!n.endsWith(".json")) continue;
    const f = path.join(dir, n);
    if (!fs.lstatSync(f).isFile()) { skipped?.push({ file: path.relative(root, f), problems: ["not a regular file"] }); continue; }
    try { out.push(readRecord(rk, f)); }
    catch (e) {
      if (e instanceof RecordError) skipped?.push({ file: path.relative(root, e.file), problems: e.problems });
      else throw e;
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

function existing(root: string, kind: QueueKind, id: string): string {
  const f = queueFile(root, kind, id);
  if (!fs.existsSync(f)) throw new Error(`no ${kind === "approvals" ? "approval" : "request"} ${id}`);
  return f;
}

export function proposeApproval(root: string, input: ProposeInput, c?: Clock): Approval {
  if (!(APPROVAL_ACTIONS as readonly string[]).includes(input.action)) throw new Error(`unknown action "${input.action}"`);
  // A fresh copy: the email_send branch below rewrites several fields from a
  // rebuild it trusts more than the caller's payload, and must never mutate
  // whatever object the caller passed in to do that.
  const p: Record<string, unknown> = { ...(input.payload ?? {}) };
  if (input.action === "status_change" || input.action === "apply_handoff") jobFilePath(root, String(p.company_slug ?? ""), String(p.id ?? ""));
  if (input.action === "status_change" && !(JOB_STATUSES as readonly string[]).includes(String(p.status))) throw new Error(`unknown status "${String(p.status)}"`);
  if (input.action === "apply_handoff") {
    if (!p.url) throw new Error("apply_handoff needs a url");
    // Same rule as @careeros/contract's isSafeHttpsUrl (also mirrored in services'
    // isSafeLink): plain https, a real hostname, no embedded username/password, so a
    // link can never be proposed with a userinfo prefix that reads as one destination
    // while the browser actually goes to whatever follows the "@". Duplicated rather
    // than imported: core ships a plain Node build (its dist/ runs under plain `node`,
    // not a TS loader) and must not pick up a dependency on a sibling workspace package
    // that only exists as source.
    // typeof p.url === "string" must gate the URL() call, not just truthiness:
    // String(["https://a.example/x"]) coerces a one-element array into a URL-shaped
    // string and would otherwise parse as "safe", accepting a payload shape
    // isSafeHttpsUrl (which checks typeof first) would reject.
    let safe = false;
    if (typeof p.url === "string") {
      try {
        const u = new URL(p.url);
        safe = u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
      } catch { /* not a URL at all: safe stays false */ }
    }
    if (!safe) throw new Error("hand-off links must be a plain https address, with no embedded username or password");
  }
  if (input.action === "email_send") {
    draftOwnerFile(root, String(p.company_slug ?? ""), String(p.id ?? ""));
    if (!ID.test(String(p.draft_id ?? ""))) throw new Error("an email_send approval needs a draft id");
    if (!/^[0-9a-f]{64}$/.test(String(p.sha256 ?? ""))) throw new Error("an email_send approval needs the message digest");
    // R-C: never trust a caller-supplied digest. Rebuild the draft fresh (this also
    // confirms the draft file still exists) and refuse if it no longer matches --
    // a stale or forged payload can never create an approval.
    let built: ReturnType<typeof buildDraftMessage>;
    try {
      built = buildDraftMessage(root, String(p.company_slug), String(p.id), String(p.draft_id), { message_id: String(p.message_id ?? ""), date: String(p.date ?? "") }, c);
    } catch (e) {
      throw new Error(`an email_send approval needs a draft that can be read: ${(e as Error).message}`);
    }
    if (digestOf(built.message) !== String(p.sha256)) throw new Error("the draft has changed since this digest was computed");
    // The digest only covers the message itself. Everything a reviewer actually
    // reads on the approval card -- draft, account, purpose, title, summary, steps --
    // is set here from that same rebuild, never from the caller's payload: a forged
    // payload with a correct digest could otherwise still show a misleading title,
    // summary or step list for a send that is, underneath, perfectly legitimate.
    const m = built.message;
    const people = [...m.to, ...m.cc].map((a) => a.address);
    p.draft = path.relative(root, draftFile(root, String(p.company_slug), String(p.id), String(p.draft_id))).split(path.sep).join("/");
    p.account = m.from.address;
    p.purpose = built.purpose;
    input = {
      ...input,
      title: `Send "${m.subject.slice(0, 150)}"`,
      summary: `To ${people.join(", ")}${m.attachments.length ? ` with ${m.attachments.length} attachment(s)` : ""}`,
      steps: sendSteps(m.from.address, people.length, String(p.id ?? "")),
      payload: p,
    };
  }
  return writeExclusive(root, "approvals", "approval", JSON.stringify(input), (id) => defaults("approval", {
    id, action: input.action, title: input.title, summary: input.summary ?? "", steps: input.steps ?? [], payload: p,
    created_at: iso(c), created_by: input.created_by ?? "cli",
  }), c);
}

export function listApprovals(root: string, opts: { status?: ApprovalStatus; skipped?: QueueSkip[] } = {}): Approval[] {
  return listKind(root, "approvals", "approval", opts.skipped).filter((a) => !opts.status || a.status === opts.status);
}

export function readApproval(root: string, id: string): Approval {
  return readRecord("approval", existing(root, "approvals", id));
}

const NEXT: Record<ApprovalStatus, ApprovalStatus[]> = { pending: ["approved", "declined"], approved: ["done", "failed"], declined: [], done: [], failed: [] };

export function setApprovalStatus(root: string, id: string, status: ApprovalStatus, note = "", c?: Clock): Approval {
  return updateRecord("approval", existing(root, "approvals", id), (a) => {
    if (!NEXT[a.status].includes(status)) throw new Error(`approval ${id} is ${a.status}; it can't become ${status}`);
    a.status = status;
    if (status === "approved" || status === "declined") a.decided_at = iso(c);
    if (note) a.result_note = note;
    // The claim (pending -> approved) is fsynced: it must survive a power loss once anything irreversible starts.
  }, { durable: status === "approved" });
}

/** Updates the note of an approval that is still running ("approved"), such as a send whose outcome isn't known yet. */
export function setApprovalNote(root: string, id: string, note: string): Approval {
  return updateRecord("approval", existing(root, "approvals", id), (a) => {
    if (a.status !== "approved") throw new Error(`approval ${id} is ${a.status}; its note can't change`);
    a.result_note = note;
  });
}

export function requestAccess(root: string, input: { folder: string; why: string; field?: string; who?: string; minutes?: number }, c?: Clock): AccessRequest {
  if (!(LOCKED_DIRS as readonly string[]).includes(input.folder)) throw new Error(`"${input.folder}" is not a lockable folder`);
  return writeExclusive(root, "requests", "access_request", JSON.stringify(input), (id) => defaults("access_request", {
    id, folder: input.folder, why: input.why, field: input.field ?? "", who: input.who ?? "claude", minutes: input.minutes ?? 15, created_at: iso(c),
  }), c);
}

export function listAccessRequests(root: string, opts: { status?: RequestStatus; skipped?: QueueSkip[] } = {}): AccessRequest[] {
  return listKind(root, "requests", "access_request", opts.skipped).filter((r) => !opts.status || r.status === opts.status);
}

export function readAccessRequest(root: string, id: string): AccessRequest {
  return readRecord("access_request", existing(root, "requests", id));
}

const RNEXT: Record<RequestStatus, RequestStatus[]> = { pending: ["allowed", "denied", "expired"], allowed: ["expired"], denied: [], expired: [] };

export function decideAccessRequest(root: string, id: string, status: RequestStatus, opts: { minutes?: number } = {}, c?: Clock): AccessRequest {
  return updateRecord("access_request", existing(root, "requests", id), (r) => {
    if (!RNEXT[r.status].includes(status)) throw new Error(`request ${id} is ${r.status}; it can't become ${status}`);
    r.status = status;
    if (status === "allowed") {
      const minutes = opts.minutes ?? r.minutes;
      r.minutes = minutes;
      r.expires_at = new Date((c?.now ?? new Date()).getTime() + minutes * 60_000).toISOString();
    }
    if (status === "allowed" || status === "denied") r.decided_at = iso(c);
  });
}

const flat = (s: string) => s.replace(/[\r\n]+/g, " ");

export function logActivity(root: string, event: string, detail = "", c?: Clock): ActivityEntry {
  const e: ActivityEntry = { at: iso(c), event: flat(event), detail: flat(detail) };
  appendLineSafe(root, path.join(careerosDir(root), "activity.jsonl"), JSON.stringify(e) + "\n");
  return e;
}

export function readActivity(root: string, limit = 50): ActivityEntry[] {
  const f = path.join(root, ".careeros", "activity.jsonl");
  if (!fs.existsSync(f) || fs.lstatSync(f).isSymbolicLink()) return [];
  const out: ActivityEntry[] = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line) as ActivityEntry; if (typeof v.event === "string") out.push(v); } catch { /* skip bad lines */ }
  }
  return out.reverse().slice(0, limit);
}
