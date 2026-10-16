export const MAIL_REF_PATTERN = /^(?:companies\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:jobs\/[a-z0-9]+(?:-[a-z0-9]+)*\/)?emails|\.careeros\/mail-triage)\/[a-z0-9][a-z0-9-]{0,99}\.json$/;
export type MailAssetKind = "msg" | "cid" | "img" | "link";

export function mailRefToken(ref: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(ref)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function mailTokenToRef(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,600}$/.test(token)) return null;
  try {
    const bin = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
    const ref = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    return MAIL_REF_PATTERN.test(ref) ? ref : null;
  } catch { return null; }
}

export const mailUrlFor = (ref: string) => `careeros-mail://msg/${mailRefToken(ref)}`;
/** How the viewer shows a message: the sanitized original, or its plain text. */
export type MailView = "original" | "text";
/** The frame URL for one view of a message, from the bridge's `mailUrl(ref)`. The plain-text view adds a fixed `/text` segment. */
export const mailViewUrl = (msgUrl: string, view: MailView) => (view === "text" ? `${msgUrl}/text` : msgUrl);

export function parseMailUrl(url: string): { kind: MailAssetKind; ref: string; arg: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "careeros-mail:") return null;
  const kind = u.hostname as MailAssetKind;
  if (!["msg", "cid", "img", "link"].includes(kind)) return null;
  const parts = u.pathname.split("/").slice(1);
  const ref = mailTokenToRef(parts[0] ?? "");
  if (!ref) return null;
  // msg: the original, or "/text" for the plain-text view (exactly that segment, nothing else).
  if (kind === "msg") return parts.length === 1 ? { kind, ref, arg: "" } : parts.length === 2 && parts[1] === "text" ? { kind, ref, arg: "text" } : null;
  if (parts.length !== 2) return null;
  let arg: string;
  try { arg = decodeURIComponent(parts[1]!); } catch { return null; }
  if (kind === "img" && !/^\d{1,4}$/.test(arg)) return null;
  // A link's number, with a "t" in front for a link in the plain-text view (its own list, not the original's).
  if (kind === "link" && !/^t?\d{1,4}$/.test(arg)) return null;
  // Fix round 1: a cid is an opaque Content-ID (RFC 2392), never a path — but sanitize.ts's
  // "every dot is percent-encoded" protection against `cid:..` only holds for a consumer that
  // reads the still-encoded URL text. This function hands back the *decoded* arg, which fully
  // reverses that trick, so this is the only real gate: reject anything that isn't a plain,
  // printable, non-space ASCII token with no "/", "\", "..", or leading ".", at most 256 bytes.
  if (kind === "cid" && (!arg || arg.length > 256 || !/^[\x21-\x7e]+$/.test(arg) || arg.startsWith(".") || arg.includes("..") || arg.includes("/") || arg.includes("\\"))) return null;
  return { kind, ref, arg };
}

export interface MailAddressView { name: string; address: string }
export interface MailCheck { id: "imap" | "sent" | "smtp"; label: string; ok: boolean; message: string; fix: string }
export interface MailTestResult { ok: boolean; checks: MailCheck[] }
export interface MailCounts { stored: number; triaged: number; skipped: number; duplicates: number; too_large: number }
export interface MailStatus {
  /** False when this shell has no mail support (the mock in a browser, or a test host). */
  available: boolean;
  connected: boolean; address: string; display_name: string; signature: string; password_set: boolean; secure_storage: boolean;
  syncing: boolean; last_sync: string; last_ok: string; next_sync: string; last_error: string; counts: MailCounts; purged: number;
  sync_minutes: number; first_sync_days: number; send_limit_per_hour: number;
  /** "iCloud Drive", "OneDrive", "Dropbox", "Google Drive" or "" */
  cloud_folder: string;
  raw_bytes: number; triage_count: number;
  /**
   * The example workspace ("Explore with an example"): its mail is made up and stored with the example, so Mail shows
   * it without Gmail. Nothing syncs or sends there. Optional: older bridges leave it out.
   */
  example?: boolean;
}
export interface MailQuery {
  company_slug?: string; id?: string; includeCompany?: boolean; direction?: "in" | "out"; unread?: boolean; attachments?: boolean;
  text?: string; limit?: number; offset?: number;
}
export interface MailRow {
  ref: string; company_slug: string; company_name: string; job_id: string; job_title: string; direction: "in" | "out"; date: string;
  subject: string; from: MailAddressView; thread_key: string; attachments: number; opened: boolean; matched_by: string;
  /** One line of the body text, for the Mail list. Only `mail.list` fills it in. */
  snippet?: string;
}
export interface MailList { rows: MailRow[]; total: number }
export interface MailAttachmentView { part: string; name: string; size: number; type: string; inline: boolean; saved_rel: string; risky: boolean }
export interface MailMessageView {
  ref: string; company_slug: string; company_name: string; job_id: string; job_title: string; triage: boolean; direction: "in" | "out";
  from: MailAddressView; to: MailAddressView[]; cc: MailAddressView[]; reply_to: MailAddressView[]; subject: string; date: string;
  message_id: string; references: string[]; thread_key: string; auth: "pass" | "fail" | "none"; warnings: string[];
  images_allowed: boolean; remote_images: number; too_large: boolean; has_raw: boolean; attachments: MailAttachmentView[]; opened_at: string;
}
export interface MailTarget { company_slug: string; id?: string }
export interface TriageItem {
  id: string; ref: string; from: MailAddressView; subject: string; date: string;
  suggestion: { company_slug: string; company_name: string; reason: string } | null;
  /** The sender's domain is free mail or a job board, so only the exact address can be linked to a recruiter. */
  free_mail?: boolean;
}
export interface DraftInput { to: string; cc: string; subject: string; body: string; attach: string[]; in_reply_to: string; references: string[]; purpose: "" | "apply" }
/** "unsure": a send was tried but there was no final reply, so it may have gone. Check Gmail's Sent folder. */
export type DraftStatus = "draft" | "waiting" | "sent" | "failed" | "unsure";
export interface DraftView {
  draft_id: string; company_slug: string; id: string; company_name: string; job_title: string; rel: string; subject: string; to: string;
  status: DraftStatus; updated: string; approval_id: string; note: string;
}
export interface EmailPreviewAttachment { rel: string; name: string; size: number; type: string; locked: string | null }
export interface EmailPreview {
  account: string; from: MailAddressView; to: MailAddressView[]; cc: MailAddressView[]; subject: string;
  /** The exact plain-text body, signature included. */
  text: string; in_reply_to: string; attachments: EmailPreviewAttachment[];
  /** True when any attachment comes from a locked folder. */
  locked: boolean;
  /** For approvals: true while the draft still builds the exact message that was proposed. */
  current: boolean;
  /** Why the message can't be built right now ("" when it can). */
  problem: string;
  job: { company_slug: string; id: string; title: string; company_name: string };
}
export interface DraftDetail { view: DraftView; draft: DraftInput; preview: EmailPreview | null }
export interface BackgroundStatus { supported: boolean; on: boolean; minutes: number; installed: boolean; detail: string; log: string[] }
export interface PruneResult { removed: number; bytes: number }
/** "Re-check filed mail": what today's matching rules would change in mail filed earlier. */
export interface RecheckItem {
  ref: string; subject: string; from: MailAddressView; date: string; company_name: string; job_title: string;
  /** "sort": back to Mail to sort. "unfile": removed, because it isn't job mail. */
  outcome: "sort" | "unfile";
}
export interface RecheckPreview {
  /** True until the app has offered the check once for the current matching rules. */
  due: boolean;
  checked: number; sort: number; unfile: number; items: RecheckItem[];
  /** Ties "apply" to exactly this list: if anything changed since, apply refuses and asks for a new look. */
  token: string;
}
export interface RecheckResult { sorted: number; unfiled: number }

/** Claude's suggested email for the composer (the draft_email action's draft.json), cleaned. `at`: when Claude wrote it. */
export interface DraftSuggestion { subject: string; body: string; at: string }
/**
 * What the composer's "Write with Claude" area needs: Claude's latest suggestion for this job (or null, with
 * `problem` saying why one couldn't be read), and who the email could go to from the job's own records (the
 * company's recruiter, else the ad's apply-by-email address). The address never comes from Claude.
 */
export interface DraftAssist { suggestion: DraftSuggestion | null; problem: string; recipient: MailAddressView | null }
export const SUGGESTION_MAX_BYTES = 64 * 1024;
const SUBJECT_MAX = 300;
const SUGGESTED_BODY_MAX = 20_000;
export const SUGGESTION_UNREADABLE = "Claude's draft couldn't be read. Try again.";

/** No em or en dashes in what the person sends: an em dash becomes a comma, an en dash a hyphen. */
export function plainDashes(s: string): string {
  return s.replace(/\s*\u2014\s*/g, ", ").replace(/\u2013/g, "-").replace(/,\s*,/g, ",");
}

/**
 * Claude's draft.json made safe for the composer: one JSON object with a string subject and body. The subject
 * becomes one line of at most 300 characters; the body keeps its line breaks but loses control and invisible
 * formatting characters, runs of blank lines and dashes. Throws SUGGESTION_UNREADABLE for anything else.
 */
export function parseDraftSuggestion(text: string): { subject: string; body: string } {
  let v: unknown;
  // A code fence around the object (```json ... ```) is tolerated.
  const raw = text.replace(/^\uFEFF/, "").trim().replace(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i, "$1");
  try { v = JSON.parse(raw); } catch { throw new Error(SUGGESTION_UNREADABLE); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(SUGGESTION_UNREADABLE);
  const o = v as Record<string, unknown>;
  if (typeof o.subject !== "string" || typeof o.body !== "string") throw new Error(SUGGESTION_UNREADABLE);
  const invisible = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
  const subject = Array.from(plainDashes(o.subject.replace(invisible, "").replace(/[\p{Cc}\u2028\u2029]/gu, " ")).replace(/\s+/g, " ").trim())
    .slice(0, SUBJECT_MAX).join("").trim();
  const body = plainDashes(o.body.replace(invisible, "").replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n").replace(/[^\P{Cc}\n\t]/gu, ""))
    .split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) throw new Error(SUGGESTION_UNREADABLE);
  return { subject, body: Array.from(body).slice(0, SUGGESTED_BODY_MAX).join("") };
}
