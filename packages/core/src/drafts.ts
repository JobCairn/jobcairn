import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Clock, iso } from "./clock.js";
import { jobFilePath } from "./jobs.js";
import { assertSegment, insideRoot, isCaseInsensitiveFs, layout, realish } from "./paths.js";
import { lockedFolderFor, lockedFolderForFd } from "./privacy.js";
import { listApprovals, newQueueId, proposeApproval, setApprovalStatus } from "./queue.js";
import { readRecord, writeFileAtomic } from "./store.js";
import type { Approval, EmailAddress, MailSettings } from "./types.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

export const MAX_RECIPIENTS = 20;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 24 * 1024 * 1024;
// C0/DEL/NEL controls, Unicode line/paragraph separators, directional marks and
// embedding/override/isolate controls -- anything that could smuggle a fake header
// line or hide text from a human reviewing a subject or a recipient's name.
const CTRL = /[\x00-\x1f\x7f\x85\u061c\u2028\u2029\u200d\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MSG_ID = /^<[^<>\s]{1,995}>$/;

export interface Draft {
  to: EmailAddress[]; cc: EmailAddress[]; subject: string; attach: string[]; in_reply_to: string; references: string[];
  purpose: "" | "apply"; body: string;
}

export function isEmailAddress(s: string): boolean {
  const at = s.lastIndexOf("@");
  if (at < 1 || s.length > 254) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  return local.length <= 64 && LOCAL.test(local) && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") && DOMAIN.test(domain);
}

// A quote, backslash, comma or semicolon in a name could either break the
// "Name <addr>" round-trip or (combined with a control character) smuggle a fake
// header line past a naive parser. Names are capped well short of the subject limit.
const NAME_BAD = /["\\,;]/;
const MAX_NAME_LENGTH = 200;

function checkName(name: string, context: string): void {
  if (CTRL.test(name) || name.length > MAX_NAME_LENGTH || NAME_BAD.test(name)) {
    throw new Error(`The name in "${context.slice(0, 80)}" isn't valid. Names can't contain quotes, backslashes, commas, semicolons, line breaks or other control characters, and must be at most ${MAX_NAME_LENGTH} characters.`);
  }
}

// Mail package review, Task 8 fix round 2: a literal RFC 2047 encoded word ("=?utf-8?q?...?=")
// in an attachment's actual on-disk file name decodes to different visible text in a
// standards-compliant mail client than what CareerOS's own preview and approval digest show for
// that same name -- what the recruiter ends up seeing would no longer match what was approved.
// Refused here, upstream of the preview/digest/wire, so all three stay in agreement ("what the
// recruiter sees wins"); the mail package's buildMime refuses a hand-built CanonicalMessage
// carrying one too, as defense in depth for anything that reaches it without going through this
// check first.
function checkAttachmentName(name: string): void {
  if (name.includes("=?")) throw new Error(`An attachment name can't contain "=?". Rename the file and try again.`);
}

/** "Name <address>" or "address", separated by commas or semicolons. Throws on anything else; never accepts a line break. */
export function parseAddressList(input: string): EmailAddress[] {
  if (CTRL.test(input.replace(/\t/g, " "))) throw new Error("Addresses can't contain line breaks or control characters.");
  const out: EmailAddress[] = [];
  for (const raw of input.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const m = raw.match(/^(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>$/);
    const name = m ? (m[1] ?? "").trim() : "";
    const address = (m ? m[2]! : raw).trim();
    if (!m && /["<>]/.test(raw)) throw new Error(`"${raw.slice(0, 80)}" isn't an email address.`);
    if (!isEmailAddress(address)) throw new Error(`"${raw.slice(0, 80)}" isn't an email address.`);
    if (name) checkName(name, raw);
    if (!out.some((a) => a.address.toLowerCase() === address.toLowerCase())) out.push({ name, address });
  }
  if (out.length > MAX_RECIPIENTS) throw new Error(`One email can go to at most ${MAX_RECIPIENTS} people.`);
  return out;
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `"${a.name}" <${a.address}>` : a.address;
}

function checkRel(rel: string): void {
  const parts = rel.split("/");
  if (!rel || rel.length > 1024 || CTRL.test(rel) || rel.includes("\\") || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)
    || parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) {
    throw new Error(`"${rel}" can't be attached. Attach files from inside the workspace.`);
  }
}

// R-A (made stricter in the final review): attachments may only come from the draft's own job
// folder. me/ (even with a grant), anyone else's company/job folder, learning/, knowledge/, etc.
// are refused outright, and so is a file whose fd turns out to live in a lockable folder.
// Compared case-sensitively by default: on a case-sensitive volume, folding case could
// let an unrelated, same-letters-different-case folder stand in for "me/" or the job
// folder it merely resembles. `foldCase` is only passed as true by a caller that has
// already confirmed (via isCaseInsensitiveFs) that the volume treats case as
// insignificant -- resolveAttachment calls this on a realpath, which a case-insensitive
// filesystem can hand back in different casing than what was written.
export function checkAttachmentScope(slug: string, id: string, rel: string, foldCase = false): void {
  const r = foldCase ? rel.toLowerCase() : rel;
  // A company-level draft (id "", a recruiter with no saved job) attaches only what was copied for it into the
  // company's emails/outgoing folder, never another job's files or received mail.
  const ownPrefix = id ? `companies/${slug}/jobs/${id}/` : `companies/${slug}/emails/outgoing/`;
  const jp = foldCase ? ownPrefix.toLowerCase() : ownPrefix;
  if (r.startsWith(jp)) return;
  if (r === "me" || r.startsWith("me/")) throw new Error(ME_NOT_ATTACHABLE);
  throw new Error(`"${rel}" can't be attached. Attach a file from this ${id ? "job" : "company"}'s own folder.`);
}

/**
 * Who owns a draft: a job (`id` set), or a company itself (`id` ""), for an email that isn't about one job, such as
 * a general enquiry to a recruitment agency. Returns the owner's record file; throws when it isn't there.
 */
export function draftOwnerFile(root: string, slug: string, id: string): string {
  if (id) return jobFilePath(root, slug, id);
  assertSegment(slug, "company slug");
  const f = layout(root).companyFile(slug);
  if (!fs.existsSync(f)) throw new Error(`no company ${slug}`);
  if (!insideRoot(root, f)) throw new Error("refusing to write outside the workspace");
  return f;
}

/** What an email send approval says it will do, for a job's draft or a company's. */
export function sendSteps(from: string, people: number, id: string): string[] {
  return id
    ? [`Send one email from ${from} to ${people} recipient(s)`, "Save the sent copy in the job's emails folder", 'Add "Email sent" to the job timeline']
    : [`Send one email from ${from} to ${people} recipient(s)`, "Save the sent copy in the company's emails folder"];
}

/** Said when a draft names a file under me/: attachments only ever come from the job's own folder. */
export const ME_NOT_ATTACHABLE = "Files from your private me/ folder can't be attached to an email. If you want to send one, copy it into this job's folder first, then attach it from there.";
/** Said when a file in the job's folder is really one of the private folders (a link or a moved folder). */
export const PRIVATE_NOT_ATTACHABLE = (folder: string) => `This file is really in ${folder}, a private folder, so it can't be attached. Attach a file from this job's own folder.`;

/** Checks a draft. forSend also requires a recipient and a subject. */
export function checkDraft(d: Draft, forSend: boolean): Draft {
  if (CTRL.test(d.subject) || d.subject.length > 300) throw new Error("The subject must be one line of at most 300 characters.");
  if (d.in_reply_to && !MSG_ID.test(d.in_reply_to)) throw new Error("In-Reply-To must look like <id@host>.");
  if (d.references.length > 50 || d.references.some((r) => !MSG_ID.test(r))) throw new Error("References must be a list of <id@host> values.");
  if (d.attach.length > 10) throw new Error("Attach at most 10 files.");
  for (const rel of d.attach) {
    checkRel(rel);
    // Task 8 review item a: refuse an "=?" file name when the draft is saved, not only when
    // resolveAttachment reads the file at build time. checkRel has already ruled out "\\", so "/"
    // is the only separator and the last part is the file name.
    checkAttachmentName(path.posix.basename(rel));
  }
  for (const a of [...d.to, ...d.cc]) {
    if (!isEmailAddress(a.address)) throw new Error(`"${a.address}" isn't an email address.`);
    if (a.name) checkName(a.name, a.name);
  }
  // Dedupe To/Cc case-insensitively: an address already in To is dropped from Cc so no
  // one appears twice (and so the same person can't be shown as both To and Cc).
  const toAddrs = new Set(d.to.map((a) => a.address.toLowerCase()));
  const cc = d.cc.filter((a) => !toAddrs.has(a.address.toLowerCase()));
  if (d.to.length + cc.length > MAX_RECIPIENTS) throw new Error(`One email can go to at most ${MAX_RECIPIENTS} people.`);
  if (d.body.length > 100_000) throw new Error("The message is longer than 100,000 characters.");
  if (forSend && !d.to.length) throw new Error("Add at least one recipient in To.");
  if (forSend && !d.subject.trim()) throw new Error("Add a subject.");
  return { ...d, cc };
}

const HEADERS = new Set(["to", "cc", "subject", "attach", "in-reply-to", "references", "purpose"]);

export function parseDraft(text: string): Draft {
  const norm = text.replace(/\r\n?/g, "\n");
  const split = norm.indexOf("\n\n");
  const head = split < 0 ? norm : norm.slice(0, split);
  const body = split < 0 ? "" : norm.slice(split + 2);
  const d: Draft = { to: [], cc: [], subject: "", attach: [], in_reply_to: "", references: [], purpose: "", body };
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z-]+):[ \t]?(.*)$/);
    if (!m) throw new Error(`Draft header line "${line.slice(0, 60)}" isn't "Name: value".`);
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "bcc") throw new Error("BCC isn't supported. Put every recipient in To or Cc so you can see them.");
    if (!HEADERS.has(key)) throw new Error(`Unknown draft header "${m[1]}".`);
    if (key === "to") d.to.push(...parseAddressList(value));
    else if (key === "cc") d.cc.push(...parseAddressList(value));
    else if (key === "subject") d.subject = value;
    else if (key === "attach") { if (value) d.attach.push(value); }
    else if (key === "in-reply-to") d.in_reply_to = value;
    else if (key === "references") d.references = value.split(/\s+/).filter(Boolean);
    else if (value === "apply" || value === "") d.purpose = value;
    else throw new Error(`Purpose can only be "apply".`);
  }
  return checkDraft(d, false);
}

export function serializeDraft(d: Draft): string {
  const lines = [`To: ${d.to.map(formatAddress).join(", ")}`];
  if (d.cc.length) lines.push(`Cc: ${d.cc.map(formatAddress).join(", ")}`);
  lines.push(`Subject: ${d.subject}`);
  for (const a of d.attach) lines.push(`Attach: ${a}`);
  if (d.in_reply_to) lines.push(`In-Reply-To: ${d.in_reply_to}`);
  if (d.references.length) lines.push(`References: ${d.references.join(" ")}`);
  if (d.purpose) lines.push(`Purpose: ${d.purpose}`);
  return `${lines.join("\n")}\n\n${d.body}`;
}

/**
 * The drafts folder of a job: checked to exist, real, and inside the workspace.
 * Walks emails/ and drafts/ with lstat *before* creating anything -- a recursive
 * mkdir would otherwise happily create through a pre-planted symlink (e.g.
 * companies/<slug>/jobs/<id>/emails -> me/identity), landing writes in a locked
 * folder. Also refuses if either segment resolves into a locked folder.
 *
 * The locked-folder check runs on realish(dir), not on dir itself: dir (emails/
 * drafts) doesn't exist yet at this point, so a plain realpath would just throw.
 * realish() resolves the nearest existing ancestor instead -- for example the job
 * folder itself, or the company folder above it -- so a symlinked ancestor planted
 * further up the tree (not just emails/ or drafts/ directly) is still caught.
 */
function draftsFolder(root: string, slug: string, id: string): string {
  draftOwnerFile(root, slug, id);
  const L = layout(root);
  const emailsDir = id ? L.jobEmailsDir(slug, id) : L.companyEmailsDir(slug);
  const dir = L.draftsDir(slug, id);
  for (const seg of [emailsDir, dir]) {
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(seg); } catch { st = undefined; }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`refusing to use ${path.relative(root, seg)}: not a real folder`);
  }
  const locked = lockedFolderFor(root, realish(dir));
  if (locked) throw new Error(`refusing to use a drafts folder inside ${locked}, which is locked`);
  fs.mkdirSync(dir, { recursive: true });
  if (!insideRoot(root, dir) || fs.lstatSync(dir).isSymbolicLink()) throw new Error("refusing to use a drafts folder outside the workspace");
  return dir;
}

export function draftFile(root: string, slug: string, id: string, draftId: string): string {
  assertSegment(draftId, "draft id");
  if (!ID.test(draftId)) throw new Error(`bad draft id "${draftId}"`);
  return path.join(draftsFolder(root, slug, id), `${draftId}.md`);
}

const relOf = (root: string, f: string) => path.relative(root, f).split(path.sep).join("/");

export function writeDraft(root: string, slug: string, id: string, d: Draft, draftId?: string, c?: Clock): { draft_id: string; rel: string } {
  const checked = checkDraft(d, false);
  for (const rel of checked.attach) checkAttachmentScope(slug, id, rel);
  const dir = draftsFolder(root, slug, id);
  let name = draftId;
  if (!name) {
    const base = newQueueId(`${slug}/${id}/${JSON.stringify(checked)}`, c);
    name = base;
    for (let n = 2; fs.existsSync(path.join(dir, `${name}.md`)); n++) name = `${base}-${n}`;
  }
  const file = draftFile(root, slug, id, name);
  writeFileAtomic(file, serializeDraft(checked));
  return { draft_id: name, rel: relOf(root, file) };
}

export function readDraft(root: string, slug: string, id: string, draftId: string): Draft {
  const file = draftFile(root, slug, id, draftId);
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { throw new Error(`The draft ${draftId} can't be found.`); }
  if (!st.isFile()) throw new Error(`The draft ${draftId} isn't a regular file.`);
  return parseDraft(fs.readFileSync(file, "utf8"));
}

export function listDraftFiles(root: string, slug: string, id: string): { draft_id: string; rel: string; sent: boolean; mtime: string }[] {
  const dir = layout(root).draftsDir(slug, id);
  const out: { draft_id: string; rel: string; sent: boolean; mtime: string }[] = [];
  for (const [folder, sent] of [[dir, false], [path.join(dir, "sent"), true]] as const) {
    let names: string[];
    try { if (fs.lstatSync(folder).isSymbolicLink() || !insideRoot(root, folder)) continue; names = fs.readdirSync(folder); } catch { continue; }
    for (const n of names.sort()) {
      const f = path.join(folder, n);
      const draftId = n.replace(/\.md$/, "");
      if (!n.endsWith(".md") || !ID.test(draftId) || !fs.lstatSync(f).isFile()) continue;
      out.push({ draft_id: draftId, rel: relOf(root, f), sent, mtime: fs.statSync(f).mtime.toISOString() });
    }
  }
  return out;
}

export function moveDraftToSent(root: string, slug: string, id: string, draftId: string): void {
  const file = draftFile(root, slug, id, draftId);
  const dest = path.join(path.dirname(file), "sent", `${draftId}.md`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!insideRoot(root, dest)) throw new Error("refusing to move a draft outside the workspace");
  fs.renameSync(file, dest);
}

/** A path given on the command line, as a workspace-relative path with "/" separators. */
export function workspaceRel(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : fs.existsSync(path.resolve(p)) ? path.resolve(p) : path.join(root, p);
  if (!fs.existsSync(abs)) throw new Error(`"${p}" can't be found`);
  if (!insideRoot(root, abs)) throw new Error(`"${p}" must be a file inside the workspace`);
  return path.relative(fs.realpathSync.native(root), fs.realpathSync.native(abs)).split(path.sep).join("/");
}

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown", ".txt": "text/plain", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".ics": "text/calendar", ".html": "text/html", ".json": "application/json", ".zip": "application/zip",
};
export const mimeTypeFor = (name: string) => TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";

export interface ResolvedAttachment { rel: string; name: string; size: number; sha256: string; type: string; locked: string | null; content: Buffer }

// O_NOFOLLOW isn't defined on Windows; fall back to no extra flag there (NTFS
// reparse points/hardlinks are out of scope for this check).
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Reads one attachment, refusing locked folders (unless allowed once), links
 * (symlinks and hard links -- nlink > 1), hidden paths and files over 20 MB.
 *
 * Reads from a pinned file descriptor rather than re-touching the path after the
 * checks: lstat, then open(O_RDONLY|O_NOFOLLOW) -- which fails if the path has
 * become a symlink in the meantime -- then fstat the open fd and require it to
 * still be a regular file with nlink === 1 and the same dev/ino the lstat saw.
 * This closes the gap between "we checked this path" and "we read this path"
 * that a symlink swap of the final file could otherwise exploit.
 *
 * `rel` as given can still reach outside the job's folder (or into a locked one)
 * through a symlinked *ancestor* -- the job folder itself, or a subfolder of it --
 * even though the string looks safely scoped. So once the fd is pinned, this also
 * resolves the fd's real location and re-checks it didn't itself race onto a
 * different file (bigint dev/ino against the open fd -- realpathSync re-walks
 * every segment live, so an ancestor swapped between the open and this resolve
 * would otherwise go unnoticed), then runs the scope check against that real
 * location, not the path as given.
 *
 * The locked-folder decision itself is *not* made from that real path string,
 * though: on macOS, a realpath/stat interleave can still make genuinely-locked
 * bytes come back as "not locked", because any path-based check needs one more
 * path resolution after the file is already open, and each resolution reopens a
 * fresh race window. lockedFolderForFd sidesteps that entirely by comparing the
 * pinned fd's own dev/ino against what it finds walking the locked folders --
 * no further path resolution, no further window.
 */
export function resolveAttachment(root: string, slug: string, id: string, rel: string, c?: Clock): ResolvedAttachment {
  checkRel(rel);
  const abs = path.join(root, ...rel.split("/"));
  let lst: fs.Stats;
  try { lst = fs.lstatSync(abs); } catch { throw new Error(`"${rel}" can't be found. It may have been moved or deleted.`); }
  if (lst.isSymbolicLink() || !lst.isFile()) throw new Error(`"${rel}" isn't a regular file.`);
  if (lst.nlink > 1) throw new Error(`"${rel}" is a hard link, which can't be attached. Attach the original file.`);
  let fd: number;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW); }
  catch { throw new Error(`"${rel}" can't be found. It may have been moved or deleted.`); }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.nlink !== 1 || fst.dev !== lst.dev || fst.ino !== lst.ino) {
      throw new Error(`"${rel}" changed while it was being attached. Try again.`);
    }
    if (!insideRoot(root, abs)) throw new Error(`"${rel}" points outside the workspace.`);
    const realAbs = fs.realpathSync.native(abs);
    const fdBig = fs.fstatSync(fd, { bigint: true });
    const realBig = fs.statSync(realAbs, { bigint: true });
    if (realBig.dev !== fdBig.dev || realBig.ino !== fdBig.ino) {
      throw new Error(`"${rel}" changed while it was being attached. Try again.`);
    }
    const realRel = path.relative(fs.realpathSync.native(root), realAbs).split(path.sep).join("/");
    if (realRel === ".." || realRel.startsWith(`..${path.posix.sep}`) || path.isAbsolute(realRel)) {
      throw new Error(`"${rel}" points outside the workspace.`);
    }
    if (realRel.split("/").some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) {
      throw new Error(`"${rel}" can't be attached. Attach files from inside the workspace.`);
    }
    checkAttachmentScope(slug, id, realRel, isCaseInsensitiveFs(root));
    // Grants don't matter here: a file that is really in a private folder is never attached.
    const locked = lockedFolderForFd(root, fd, c, { ignoreGrants: true });
    if (locked?.reason === "unverifiable") throw new Error(`${identity.name} can't confirm this file isn't in ${locked.folder} (the folder is too large, partly unreadable or missing). Tidy it, then try again.`);
    if (locked) throw new Error(PRIVATE_NOT_ATTACHABLE(locked.folder));
    if (fst.size > MAX_ATTACHMENT_BYTES) throw new Error(`"${rel}" is larger than 20 MB.`);
    const content = fs.readFileSync(fd);
    // Kept for the preview type: a file from a private folder is refused above, so this is always null now.
    const lockable: string | null = null;
    const name = path.basename(abs);
    checkAttachmentName(name);
    return { rel, name, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex"), type: mimeTypeFor(abs), locked: lockable, content };
  } finally {
    fs.closeSync(fd);
  }
}

export interface MessageStamp { message_id: string; date: string }
export interface CanonicalMessage {
  draft_id: string; message_id: string; date: string; from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[];
  subject: string; in_reply_to: string; references: string[]; text: string; purpose: "" | "apply";
  attachments: { rel: string; name: string; size: number; sha256: string; type: string; locked: string | null }[];
}
export interface BuiltDraft { message: CanonicalMessage; digest: string; contents: Buffer[]; purpose: "" | "apply" }

export function newStamp(draftId: string, account: string, c?: Clock): MessageStamp {
  const domain = account.slice(account.lastIndexOf("@") + 1) || "localhost";
  return { message_id: `<${draftId}.${crypto.randomBytes(6).toString("hex")}@${domain}>`, date: iso(c) };
}

export function messageText(body: string, signature: string): string {
  const b = body.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const s = signature.replace(/\r\n?/g, "\n").trim();
  return s ? `${b}\n\n${s}\n` : `${b}\n`;
}

export function mailAccount(root: string): MailSettings {
  return readRecord("integrations", layout(root).integrations).mail;
}

// Deterministic regardless of the key order the caller's object literal happened to
// use: every object's keys are sorted before stringifying, recursively.
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** SHA-256 over every field of the message the send will use, with sorted object keys. */
export function digestOf(m: CanonicalMessage): string {
  return crypto.createHash("sha256").update(stableStringify(m)).digest("hex");
}

export function buildDraftMessage(root: string, slug: string, id: string, draftId: string, stamp: MessageStamp, c?: Clock): BuiltDraft {
  const acct = mailAccount(root);
  if (!acct.address) throw new Error("Gmail isn't connected. Connect it in Settings > Email first.");
  const d = checkDraft(readDraft(root, slug, id, draftId), true);
  for (const rel of d.attach) checkAttachmentScope(slug, id, rel);
  const atts = d.attach.map((rel) => resolveAttachment(root, slug, id, rel, c));
  if (atts.reduce((n, a) => n + a.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("The attachments add up to more than 24 MB, which Gmail won't send.");
  const message: CanonicalMessage = {
    draft_id: draftId, message_id: stamp.message_id, date: stamp.date,
    from: { name: acct.display_name, address: acct.address },
    to: d.to.map((a) => ({ name: a.name, address: a.address })), cc: d.cc.map((a) => ({ name: a.name, address: a.address })),
    subject: d.subject.trim(), in_reply_to: d.in_reply_to, references: d.references, text: messageText(d.body, acct.signature),
    purpose: d.purpose,
    attachments: atts.map((a) => ({ rel: a.rel, name: a.name, size: a.size, sha256: a.sha256, type: a.type, locked: a.locked })),
  };
  return { message, digest: digestOf(message), contents: atts.map((a) => a.content), purpose: d.purpose };
}

export function proposeEmailSend(root: string, slug: string, id: string, draftId: string, createdBy: "app" | "claude" | "cli", c?: Clock): Approval {
  const acct = mailAccount(root);
  const stamp = newStamp(draftId, acct.address, c);
  const built = buildDraftMessage(root, slug, id, draftId, stamp, c);
  const m = built.message;
  const people = [...m.to, ...m.cc].map((a) => a.address);
  const approval = proposeApproval(root, {
    action: "email_send",
    title: `Send "${m.subject.slice(0, 150)}"`,
    summary: `To ${people.join(", ")}${m.attachments.length ? ` with ${m.attachments.length} attachment(s)` : ""}`,
    steps: sendSteps(acct.address, people.length, id),
    payload: {
      company_slug: slug, id, draft_id: draftId, draft: relOf(root, draftFile(root, slug, id, draftId)), account: acct.address,
      sha256: built.digest, message_id: stamp.message_id, date: stamp.date, purpose: built.purpose,
    },
    created_by: createdBy,
  }, c);
  // Only replace older pending proposals of this same draft once the new one has
  // actually been created: if proposeApproval throws, the old proposal must stay
  // pending rather than being declined for a replacement that never happened.
  for (const a of listApprovals(root, { status: "pending" })) {
    if (a.id !== approval.id && a.action === "email_send" && a.payload.company_slug === slug && a.payload.id === id && a.payload.draft_id === draftId) {
      setApprovalStatus(root, a.id, "declined", "Replaced by a newer version of the draft", c);
    }
  }
  return approval;
}
