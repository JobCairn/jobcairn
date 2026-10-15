import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { EmailAddress } from "@careeros/core";
import { redact } from "./redact.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

export const GMAIL = { imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 } } as const;
export const GMAIL_HOSTS: string[] = [GMAIL.imap.host, GMAIL.smtp.host];

export interface MailAccount { address: string; password: string; displayName: string }
export interface MailboxInfo { path: string; uidValidity: string; uidNext: number; exists: number }
export interface HeaderSummary { uid: number; size: number; internalDate: string; messageId: string; from: EmailAddress[]; to: EmailAddress[]; cc: EmailAddress[]; subject: string }
/** Read-only by construction: there is no way to change flags, move, delete, expunge or append. */
export interface MailSession {
  open(which: "inbox" | "sent"): Promise<MailboxInfo>;
  /**
   * Headers of the messages from a UID on, or since a date, oldest UID first. Task 11: with
   * `limit`, only the first `limit` of them are fetched. Headers are fetched in chunks of
   * HEADER_CHUNK UIDs, never as one huge range.
   */
  headers(range: { sinceUid: number } | { since: Date }, opts?: { limit?: number }): Promise<HeaderSummary[]>;
  /** Task 11: with `maxBytes`, at most maxBytes + 1 bytes are downloaded, so a longer result means the message is over the cap. */
  body(uid: number, maxBytes?: number): Promise<Buffer>;
  close(): Promise<void>;
}
export interface ProviderCheck { id: "imap" | "sent" | "smtp"; ok: boolean; message: string; fix: string }
export interface MailProvider {
  connect(): Promise<MailSession>;
  test(): Promise<ProviderCheck[]>;
  send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ accepted: string[] }>;
}

export type MailErrorKind = "auth" | "app-password-needed" | "imap-off" | "no-sent" | "network" | "tls" | "host" | "other";
/** Carries plain words only. It never wraps the library error (no `cause`), so nothing from it can leak. */
/**
 * For a failed send (Task 17 fix round 0): "not-sent" when the message certainly didn't go (a
 * 4xx/5xx reply from Gmail, or a failure before any message could be handed over), "unknown" when
 * there was no final reply (a timeout, reset or close), so Gmail may have accepted it.
 */
export type MailDelivery = "not-sent" | "unknown";
export class MailError extends Error {
  constructor(readonly kind: MailErrorKind, message: string, readonly fix = "", readonly delivery: MailDelivery = "not-sent") { super(message); this.name = "MailError"; }
}

const TEXT: Record<Exclude<MailErrorKind, "other">, [string, string]> = {
  auth: ["Gmail didn't accept the address and app password.",
    "Check the address, then create a new app password and paste all 16 letters. If Google's App Passwords page says the setting isn't available for your account (some work, school or Advanced Protection accounts), email can't be connected yet. Keep using Gmail directly for now."],
  "app-password-needed": ["Gmail needs an app password, not your normal password.", `Create an app password named ${identity.name} on Google's App Passwords page and paste its 16 letters.`],
  "imap-off": ["IMAP is turned off in Gmail.", "In Gmail, open Settings > See all settings > Forwarding and POP/IMAP and turn on IMAP."],
  "no-sent": ["Gmail's Sent folder wasn't found.", "In Gmail settings, open Labels and tick \"Show in IMAP\" for Sent Mail."],
  network: [`${identity.name} couldn't reach Gmail.`, "Check your internet connection and try again."],
  tls: ["The secure connection to Gmail couldn't be checked.", "Check the computer's date and time. Some office or school networks inspect secure traffic; try another network."],
  host: [`${identity.name} only connects to Gmail's own servers.`, ""],
};
/** Failures that happen before a connection to Gmail exists, so no message can have been handed over. */
const NOT_CONNECTED_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EDNS"]);
/** nodemailer refusals made on this side before the message is streamed (bad envelope, empty or oversized message). */
const CLIENT_REFUSAL_CODES = new Set(["EAUTH", "EENVELOPE", "EMESSAGE", "EREQUIRETLS"]);
/** Node's own TLS verification codes: raised only during the handshake, before any SMTP command. */
const TLS_HANDSHAKE_CODE = /^(?:ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$|ERR_SSL_)/;
/** nodemailer tags an error with the command it was answering; these all come before MAIL FROM. */
const BEFORE_MAIL_FROM = /^(?:EHLO|HELO|LHLO|STARTTLS|AUTH\b)/;
const NETWORK_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEOUT", "ESOCKET", "ECONNECTION", "EPIPE", "NoConnection"]);

/**
 * Turns any library error into a MailError in plain words. Only the "other" kind echoes server
 * text, and that goes through `redact` with the given secrets (the app password, the address and
 * their combined forms), which also strips every email address and long token.
 */
export function explainMailError(e: unknown, secrets: readonly string[] = []): MailError {
  // Task 10: this runs inside error handlers, so it must never throw itself (a hostile getter on
  // the thrown value, or anything unexpected in redaction): fall back to a plain message.
  try {
    return explainMailErrorUnsafe(e, secrets);
  } catch {
    return new MailError("other", "Gmail returned an error.", "Try again in a few minutes.");
  }
}

function explainMailErrorUnsafe(e: unknown, secrets: readonly string[]): MailError {
  if (e instanceof MailError) return e;
  const o = (e !== null && typeof e === "object" ? e : {}) as { message?: unknown; responseText?: unknown; response?: unknown; code?: unknown; authenticationFailed?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const text = `${typeof e === "string" ? e : str(o.message)} ${str(o.responseText)} ${str(o.response)}`;
  const code = str(o.code);
  const rc = typeof (o as { responseCode?: unknown }).responseCode === "number" ? (o as { responseCode: number }).responseCode : 0;
  // A final 4xx/5xx reply, or a refusal before anything was handed over, means the message didn't go.
  // Anything else (a timeout, a reset, a close with no reply) may have come after Gmail accepted it.
  const command = str((o as { command?: unknown }).command);
  const definite = (rc >= 400 && rc < 600) || NOT_CONNECTED_CODES.has(code) || CLIENT_REFUSAL_CODES.has(code) || TLS_HANDSHAKE_CODE.test(code)
    || BEFORE_MAIL_FROM.test(command) || o.authenticationFailed === true;
  // Fix round 1: every kind follows the same rule. A sign-in or certificate word in the text alone
  // (with no reply code, handshake code or pre-MAIL FROM phase) doesn't prove nothing was handed over.
  const delivery: MailDelivery = definite ? "not-sent" : "unknown";
  const make = (k: Exclude<MailErrorKind, "other">) => new MailError(k, TEXT[k][0], TEXT[k][1], delivery);
  if (/application-specific password required|5\.7\.9/i.test(text)) return make("app-password-needed");
  if (/not enabled for IMAP|IMAP access is disabled/i.test(text)) return make("imap-off");
  if (o.authenticationFailed === true || code === "EAUTH" || /AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted|\b535\b/i.test(text)) return make("auth");
  if (/certificate|CERT_|ERR_TLS|self[- ]signed|unable to verify/i.test(`${text} ${code}`)) return make("tls");
  if (NETWORK_CODES.has(code) || /timed? ?out|socket hang up|connection closed/i.test(text)) return make("network");
  const first = text.trim().split(/\r?\n/)[0] ?? "";
  return new MailError("other", `Gmail returned an error: ${redact(first, secrets).slice(0, 200)}`, "Try again in a few minutes.", delivery);
}

interface Envelope { date?: Date; subject?: string; messageId?: string; from?: { name?: string; address?: string }[]; to?: { name?: string; address?: string }[]; cc?: { name?: string; address?: string }[] }
/** The part of imapflow's client CareerOS uses. It has no flag, move, copy, append or delete methods on purpose. */
export interface ImapClient {
  mailbox: false | { path: string; uidValidity: bigint; uidNext: number; exists: number };
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  getMailboxLock(path: string, opts: { readOnly: true }): Promise<{ release(): void }>;
  search(q: { since?: Date; uid?: string }, opts: { uid: true }): Promise<number[] | false>;
  fetch(range: string, q: { uid: true; envelope: true; size: true; internalDate: true }, opts: { uid: true }): AsyncIterable<{ uid: number; size?: number; internalDate?: Date | string; envelope?: Envelope }>;
  fetchOne(uid: string, q: { source: true | { start: number; maxLength: number } }, opts: { uid: true }): Promise<{ source?: Buffer } | false>;
  on(event: "error", fn: (e: Error) => void): unknown;
}
export interface SmtpClient {
  verify(): Promise<unknown>;
  sendMail(m: { envelope: { from: string; to: string[] }; raw: Buffer }): Promise<{ accepted?: unknown[] }>;
  close(): void;
}
export interface ImapOptions {
  host: string; port: number; secure: true; auth: { user: string; pass: string }; logger: false; emitLogs: false; disableAutoIdle: true;
  connectionTimeout: number; greetingTimeout: number; socketTimeout: number; tls: { rejectUnauthorized: true; minVersion: "TLSv1.2"; servername: string };
}
export interface SmtpOptions {
  host: string; port: number; secure: true; auth: { user: string; pass: string }; logger: false; debug: false;
  /** The EHLO name. Without it nodemailer sends this computer's host name, which often contains the owner's name. */
  name: string;
  connectionTimeout: number; greetingTimeout: number; socketTimeout: number; disableFileAccess: true; disableUrlAccess: true;
  tls: { rejectUnauthorized: true; minVersion: "TLSv1.2"; servername: string };
}
export interface GmailDeps { imap?: (o: ImapOptions) => ImapClient; smtp?: (o: SmtpOptions) => SmtpClient; allowedHosts?: string[] }

const toAddr = (list: Envelope["from"]): EmailAddress[] =>
  (list ?? []).filter((a) => a.address).map((a) => ({ name: (a.name ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim(), address: a.address! }));

const MAX_UID = 2 ** 32 - 1;
function checkUid(uid: number): void {
  if (!Number.isInteger(uid) || uid < 1 || uid > MAX_UID) throw new MailError("other", "That message UID isn't valid.");
}
/** Task 11: how many UIDs one header FETCH asks for. */
export const HEADER_CHUNK = 100;
/** Sorted UIDs as a compact IMAP set ("3,5:9,12"). */
export function uidSet(uids: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < uids.length; ) {
    let j = i;
    while (j + 1 < uids.length && uids[j + 1] === uids[j]! + 1) j++;
    out.push(i === j ? String(uids[i]) : `${uids[i]}:${uids[j]}`);
    i = j + 1;
  }
  return out.join(",");
}

class ImapSession implements MailSession {
  #c: ImapClient;
  #secrets: readonly string[];
  #lock: { release(): void } | null = null;
  constructor(c: ImapClient, secrets: readonly string[]) { this.#c = c; this.#secrets = secrets; }

  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) { throw explainMailError(e, this.#secrets); }
  }

  open(which: "inbox" | "sent"): Promise<MailboxInfo> {
    return this.#guard(async () => {
      this.#lock?.release();
      this.#lock = null;
      let path = "INBOX";
      if (which === "sent") {
        const sent = (await this.#c.list()).find((b) => b.specialUse === "\\Sent");
        if (!sent) throw new MailError("no-sent", TEXT["no-sent"][0], TEXT["no-sent"][1]);
        path = sent.path;
      }
      // readOnly: true makes imapflow send EXAMINE, so nothing in the mailbox can change.
      this.#lock = await this.#c.getMailboxLock(path, { readOnly: true });
      const mb = this.#c.mailbox;
      if (!mb) throw new MailError("other", "Gmail didn't open the mailbox.");
      return { path, uidValidity: String(mb.uidValidity), uidNext: mb.uidNext, exists: mb.exists };
    });
  }

  headers(range: { sinceUid: number } | { since: Date }, opts: { limit?: number } = {}): Promise<HeaderSummary[]> {
    return this.#guard(async () => {
      const limit = opts.limit ?? Infinity;
      if (!(limit === Infinity || (Number.isInteger(limit) && limit >= 0))) throw new MailError("other", "That message limit isn't valid.");
      let found: number[] | false;
      let min = 0;
      if ("sinceUid" in range) {
        checkUid(range.sinceUid);
        min = range.sinceUid;
        // Task 11: UID SEARCH first (numbers only), then the headers in chunks.
        found = await this.#c.search({ uid: `${range.sinceUid}:*` }, { uid: true });
      } else {
        if (!(range.since instanceof Date) || Number.isNaN(range.since.getTime())) throw new MailError("other", "That start date isn't valid.");
        found = await this.#c.search({ since: range.since }, { uid: true });
      }
      // "N:*" matches the last message even when its UID is below N, so the floor is applied here too.
      const uids = [...new Set(found || [])].filter((u) => Number.isInteger(u) && u >= Math.max(1, min) && u <= MAX_UID).sort((a, b) => a - b).slice(0, limit);
      const out: HeaderSummary[] = [];
      for (let i = 0; i < uids.length; i += HEADER_CHUNK) {
        const chunk = uids.slice(i, i + HEADER_CHUNK);
        const want = new Set(chunk);
        for await (const m of this.#c.fetch(uidSet(chunk), { uid: true, envelope: true, size: true, internalDate: true }, { uid: true })) {
          if (!want.has(m.uid)) continue;
          want.delete(m.uid);
          const d = m.internalDate ? new Date(m.internalDate) : m.envelope?.date;
          out.push({
            uid: m.uid, size: m.size ?? 0, internalDate: d && !Number.isNaN(d.getTime()) ? d.toISOString() : "",
            messageId: m.envelope?.messageId ?? "", subject: m.envelope?.subject ?? "",
            from: toAddr(m.envelope?.from), to: toAddr(m.envelope?.to), cc: toAddr(m.envelope?.cc),
          });
        }
      }
      return out.sort((a, b) => a.uid - b.uid);
    });
  }

  body(uid: number, maxBytes?: number): Promise<Buffer> {
    return this.#guard(async () => {
      checkUid(uid);
      if (maxBytes !== undefined && !(Number.isInteger(maxBytes) && maxBytes >= 0)) throw new MailError("other", "That size limit isn't valid.");
      // imapflow fetches `source` as BODY.PEEK[] (BODY.PEEK[]<0.N> with a length), which never sets \Seen.
      // Task 11: with a cap, one byte more than the cap is asked for, so the caller can tell it was over.
      const q = maxBytes === undefined ? { source: true as const } : { source: { start: 0, maxLength: maxBytes + 1 } };
      const m = await this.#c.fetchOne(String(uid), q, { uid: true });
      if (!m || !m.source) throw new MailError("other", `Message ${uid} is no longer in Gmail.`);
      return m.source;
    });
  }

  async close(): Promise<void> {
    this.#lock?.release();
    this.#lock = null;
    try { await this.#c.logout(); } catch { this.#c.close(); }
  }
}

/**
 * @internal The input checks every MailProvider.send runs before anything else: at least one
 * recipient, no CR, LF or NUL in any envelope address, and raw bytes. Shared by GmailProvider and
 * FakeMailProvider so code tested against the fake hits the same refusals. Not re-exported from index.ts.
 */
export function checkSendInput(envelope: { from: string; to: string[] }, raw: Buffer): void {
  if (!Array.isArray(envelope?.to) || !envelope.to.length) throw new MailError("other", "Add at least one recipient.", "");
  if ([envelope.from, ...envelope.to].some((a) => typeof a !== "string" || /[\r\n\0]/.test(a))) throw new MailError("other", "An address can't contain a line break or a NUL character.", "");
  if (!Buffer.isBuffer(raw)) throw new MailError("other", "The message must be bytes.", "");
}

const ok = (id: ProviderCheck["id"], message: string): ProviderCheck => ({ id, ok: true, message, fix: "" });
const failed = (id: ProviderCheck["id"], e: MailError): ProviderCheck => ({ id, ok: false, message: e.message, fix: e.fix });

export class GmailProvider implements MailProvider {
  // Private fields (#) so the password can't be read off the object or show up in a dump of it.
  #account: MailAccount;
  #deps: GmailDeps;
  #allowed: string[];

  constructor(account: MailAccount, deps: GmailDeps = {}) {
    this.#account = account;
    this.#deps = deps;
    this.#allowed = [...(deps.allowedHosts ?? GMAIL_HOSTS)];
  }

  /** Every form the secret could take in a server reply or library message. */
  #secrets(): string[] {
    const { address, password } = this.#account;
    // redact() also matches each secret in any case and with spaces or hyphens between characters
    // (fix round 1), so Google's "abcd efgh ijkl mnop" display form and its variants are covered.
    const compact = password.replace(/\s+/g, "");
    return [password, compact, address, `${address}:${password}`, `${address}:${compact}`, `\0${address}\0${password}`, `\0${address}\0${compact}`].filter(Boolean);
  }

  #explain(e: unknown): MailError { return explainMailError(e, this.#secrets()); }

  #assertHost(host: string): void {
    // The hosts themselves are fixed to Gmail's; the allowed list can only narrow them.
    if (!GMAIL_HOSTS.includes(host) || !this.#allowed.includes(host)) {
      const names = this.#allowed.filter((h) => GMAIL_HOSTS.includes(h));
      throw new MailError("host", names.length ? `Mail may only connect to ${names.join(" and ")}.` : TEXT.host[0], TEXT.host[1]);
    }
  }

  imapOptions(): ImapOptions {
    const { host, port } = GMAIL.imap;
    return {
      host, port, secure: true, auth: { user: this.#account.address, pass: this.#account.password }, logger: false, emitLogs: false, disableAutoIdle: true,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: host },
    };
  }

  smtpOptions(): SmtpOptions {
    const { host, port } = GMAIL.smtp;
    return {
      host, port, secure: true, auth: { user: this.#account.address, pass: this.#account.password }, logger: false, debug: false, name: "[127.0.0.1]",
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000, disableFileAccess: true, disableUrlAccess: true,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: host },
    };
  }

  #imap(): ImapClient {
    this.#assertHost(GMAIL.imap.host);
    const c = (this.#deps.imap ?? ((o) => new ImapFlow(o) as unknown as ImapClient))(this.imapOptions());
    c.on("error", () => undefined); // a dropped socket surfaces as a rejected call; never crash the process
    return c;
  }

  #smtp(): SmtpClient {
    this.#assertHost(GMAIL.smtp.host);
    return (this.#deps.smtp ?? ((o) => nodemailer.createTransport(o) as unknown as SmtpClient))(this.smtpOptions());
  }

  async connect(): Promise<MailSession> {
    const c = this.#imap();
    try { await c.connect(); } catch (e) { try { c.close(); } catch { /* already closed */ } throw this.#explain(e); }
    return new ImapSession(c, this.#secrets());
  }

  async test(): Promise<ProviderCheck[]> {
    const checks: ProviderCheck[] = [];
    let c: ImapClient | null = null;
    try {
      c = this.#imap();
      await c.connect();
      checks.push(ok("imap", "Signed in to Gmail."));
      const sent = (await c.list()).find((b) => b.specialUse === "\\Sent");
      checks.push(sent ? ok("sent", `Found your Sent folder (${sent.path}).`) : failed("sent", new MailError("no-sent", TEXT["no-sent"][0], TEXT["no-sent"][1])));
    } catch (e) {
      checks.push(failed("imap", this.#explain(e)));
      checks.push({ id: "sent", ok: false, message: "Not checked, because signing in failed.", fix: "" });
    } finally {
      if (c) { try { await c.logout(); } catch { c.close(); } }
    }
    try {
      const t = this.#smtp();
      try { await t.verify(); } finally { t.close(); }
      checks.push(ok("smtp", `Gmail will accept mail you send from ${identity.name}. Nothing was sent.`));
    } catch (e) {
      checks.push(failed("smtp", this.#explain(e)));
    }
    return checks;
  }

  /**
   * Sends `raw` byte-for-byte to the caller's envelope. nodemailer's `raw` form doesn't add,
   * rewrite or re-encode any header or content. Only `accepted` comes back, and only addresses
   * the caller asked for.
   */
  async send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ accepted: string[] }> {
    checkSendInput(envelope, raw);
    const t = this.#smtp();
    try {
      const r = await t.sendMail({ envelope: { from: envelope.from, to: [...envelope.to] }, raw });
      const asked = new Set(envelope.to.map((a) => a.toLowerCase()));
      // nodemailer's stream transport (used in tests) reports no `accepted`; the SMTP transport always does.
      const reported = Array.isArray(r.accepted) ? r.accepted.map(String) : envelope.to;
      const accepted = reported.filter((a) => asked.has(a.toLowerCase()));
      // Gmail has already answered 250 to the message here, so it may well have gone: never "not sent".
      if (!accepted.length) throw new MailError("other", "Gmail accepted the message but didn't confirm any recipient.", "Check Gmail's Sent folder.", "unknown");
      return { accepted };
    } catch (e) {
      throw this.#explain(e);
    } finally {
      t.close();
    }
  }
}
