import fs from "node:fs";
import { parseMessage } from "./parse.js";
import { checkSendInput, explainMailError, MailError, type HeaderSummary, type MailboxInfo, type MailErrorKind, type MailProvider, type MailSession, type ProviderCheck } from "./provider.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

/** `size` (Task 11) overrides the size the headers report, to test a server that under-reports it. */
export interface FakeMessage { uid: number; raw: Buffer; internalDate?: string; size?: number }
interface Box { uidValidity: string; messages: FakeMessage[] }

/** An in-memory Gmail for tests and end-to-end runs. Like the real session, it can only read. Test data only. */
export class FakeMailProvider implements MailProvider {
  inbox: Box = { uidValidity: "1", messages: [] };
  sentBox: Box = { uidValidity: "1", messages: [] };
  readonly calls: string[] = [];
  readonly sent: { envelope: { from: string; to: string[] }; raw: Buffer }[] = [];
  failWith: MailErrorKind | null = null;
  /** A body fetch for this UID fails with a network error (a connection that drops mid-sync). */
  failBodyAt: number | null = null;
  /** Called before each body fetch (tests use it to stop a sync part-way through). */
  beforeBody: ((uid: number) => void | Promise<void>) | null = null;
  /** A send gets this final SMTP reply code (a definite refusal: the message didn't go). */
  rejectSendWith: number | null = null;

  constructor(private onSend?: (raw: Buffer) => void) {}

  add(box: "inbox" | "sent", raw: Buffer, internalDate = "2026-01-14T09:00:00.000Z"): FakeMessage {
    const b = box === "inbox" ? this.inbox : this.sentBox;
    const m = { uid: (b.messages.at(-1)?.uid ?? 0) + 1, raw, internalDate };
    b.messages.push(m);
    return m;
  }

  private fail(): void {
    if (this.failWith) throw explainMailError(this.failWith === "auth" ? Object.assign(new Error("x"), { authenticationFailed: true }) : this.failWith === "network" ? Object.assign(new Error("x"), { code: "ECONNRESET" }) : new MailError(this.failWith, `fake ${this.failWith}`));
  }

  async connect(): Promise<MailSession> {
    this.calls.push("connect");
    this.fail();
    let which: "inbox" | "sent" = "inbox";
    const box = () => (which === "inbox" ? this.inbox : this.sentBox);
    const session: MailSession = {
      open: async (w): Promise<MailboxInfo> => {
        which = w;
        this.calls.push(`open ${w}`);
        const b = box();
        return { path: w === "inbox" ? "INBOX" : "[Gmail]/Sent Mail", uidValidity: b.uidValidity, uidNext: (b.messages.at(-1)?.uid ?? 0) + 1, exists: b.messages.length };
      },
      headers: async (range, opts = {}): Promise<HeaderSummary[]> => {
        this.calls.push("sinceUid" in range ? `headers ${which} from uid ${range.sinceUid}` : `headers ${which} since ${range.since.toISOString().slice(0, 10)}`);
        const picked = box().messages.filter((m) => ("sinceUid" in range ? m.uid >= range.sinceUid : (m.internalDate ?? "") >= range.since.toISOString())).slice(0, opts.limit ?? Infinity);
        const out: HeaderSummary[] = [];
        for (const m of picked) {
          const p = await parseMessage(m.raw);
          out.push({ uid: m.uid, size: m.size ?? m.raw.length, internalDate: m.internalDate ?? "", messageId: p.synthetic_id ? "" : p.message_id, from: [p.from], to: p.to, cc: p.cc, subject: p.subject });
        }
        return out;
      },
      body: async (uid, maxBytes) => {
        this.calls.push(`body ${which} ${uid}`);
        await this.beforeBody?.(uid);
        if (this.failBodyAt === uid) throw explainMailError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
        const m = box().messages.find((x) => x.uid === uid);
        if (!m) throw new MailError("other", `Message ${uid} is no longer in Gmail.`);
        // Like the real session: at most one byte more than the cap.
        return maxBytes === undefined ? m.raw : m.raw.subarray(0, maxBytes + 1);
      },
      close: async () => { this.calls.push("close"); },
    };
    return session;
  }

  async test(): Promise<ProviderCheck[]> {
    this.calls.push("test");
    try { this.fail(); } catch (e) {
      const m = e as MailError;
      return [{ id: "imap", ok: false, message: m.message, fix: m.fix }, { id: "sent", ok: false, message: "Not checked, because signing in failed.", fix: "" }, { id: "smtp", ok: false, message: m.message, fix: m.fix }];
    }
    return [
      { id: "imap", ok: true, message: "Signed in to Gmail.", fix: "" },
      { id: "sent", ok: true, message: "Found your Sent folder ([Gmail]/Sent Mail).", fix: "" },
      { id: "smtp", ok: true, message: `Gmail will accept mail you send from ${identity.name}. Nothing was sent.`, fix: "" },
    ];
  }

  async send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ accepted: string[] }> {
    this.calls.push("send");
    checkSendInput(envelope, raw);
    this.fail();
    const n = this.rejectSendWith;
    if (n !== null) throw explainMailError(Object.assign(new Error(`${n} 5.7.1 fake refusal`), { code: "EENVELOPE", responseCode: n, command: "RCPT TO" }));
    this.sent.push({ envelope, raw });
    this.onSend?.(raw);
    return { accepted: envelope.to };
  }
}

/** The largest end-to-end fixture file fakeProviderFromFile will read. */
export const MAX_FIXTURE_BYTES = 20 * 1024 * 1024;

type FixtureEntry = { raw: string; internalDate?: string };
const isEntries = (v: unknown): v is FixtureEntry[] =>
  v === undefined || (Array.isArray(v) && v.every((m) => m !== null && typeof m === "object" && typeof (m as FixtureEntry).raw === "string"
    && ((m as FixtureEntry).internalDate === undefined || typeof (m as FixtureEntry).internalDate === "string")));

/**
 * Reads `{ inbox: [{ raw, internalDate? }], sent: [...] }` (raw as UTF-8 text) for end-to-end runs.
 * Refuses a symlink (checked on the open itself where the OS supports O_NOFOLLOW, and by lstat),
 * anything that isn't a regular file, and anything larger than MAX_FIXTURE_BYTES.
 */
export function fakeProviderFromFile(file: string, onSend?: (raw: Buffer) => void): FakeMailProvider {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) throw new Error("The mail fixture is a link. Point to the file itself.");
  if (!st.isFile()) throw new Error("The mail fixture isn't a file.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let text: string;
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) throw new Error("The mail fixture changed while it was being read.");
    if (fst.size > MAX_FIXTURE_BYTES) throw new Error("The mail fixture is larger than 20 MB.");
    const buf = Buffer.alloc(fst.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    text = buf.subarray(0, off).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const data = JSON.parse(text) as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("The mail fixture must be an object with inbox and sent lists.");
  const { inbox, sent } = data as { inbox?: unknown; sent?: unknown };
  if (!isEntries(inbox) || !isEntries(sent)) throw new Error("The mail fixture's inbox and sent must be lists of { raw, internalDate? }.");
  const f = new FakeMailProvider(onSend);
  for (const m of inbox ?? []) f.add("inbox", Buffer.from(m.raw, "utf8"), m.internalDate);
  for (const m of sent ?? []) f.add("sent", Buffer.from(m.raw, "utf8"), m.internalDate);
  return f;
}
