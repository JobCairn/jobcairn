import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { explainMailError, GMAIL_HOSTS, GmailProvider, HEADER_CHUNK, MailError, uidSet, type ImapClient, type SmtpClient } from "../src/provider.js";
import { ALEX, rawMessage } from "../src/testing.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

// Fictional credentials only.
const ACCOUNT = { address: ALEX, password: "abcd" + "efgh" + "ijkl" + "mnop", displayName: "Alex Example" };
type Msg = { uid: number; raw: Buffer; date: string };

function fakeImap(opts: { messages?: Msg[]; sentPath?: string | null; connectError?: unknown; log?: string[] } = {}): ImapClient {
  const log = opts.log ?? [];
  const msgs = opts.messages ?? [];
  const client: ImapClient = {
    mailbox: false,
    connect: async () => { log.push("connect"); if (opts.connectError) throw opts.connectError; },
    logout: async () => { log.push("logout"); },
    close: () => { log.push("close"); },
    list: async () => [{ path: "INBOX", specialUse: "\\Inbox" }, ...(opts.sentPath === null ? [] : [{ path: opts.sentPath ?? "[Gmail]/Sent Mail", specialUse: "\\Sent" }])],
    getMailboxLock: async (path, o) => {
      log.push(`lock ${path} readOnly=${o.readOnly}`);
      client.mailbox = { path, uidValidity: 7n, uidNext: 100, exists: msgs.length };
      return { release: () => log.push(`release ${path}`) };
    },
    search: async (q) => { log.push(`search since ${q.since?.toISOString().slice(0, 10)}`); return msgs.map((m) => m.uid); },
    fetch: async function* (range) {
      log.push(`fetch ${range}`);
      // Real servers answer "N:*" with the last message even when its UID is below N.
      for (const m of msgs) yield { uid: m.uid, size: m.raw.length, internalDate: new Date(m.date), envelope: { subject: `Subject ${m.uid}`, messageId: `<id${m.uid}${"@"}example.org>`, from: [{ name: "Acme Talent", address: ALEX }], to: [], cc: [] } };
    },
    fetchOne: async (uid, q) => { log.push(`fetchOne ${uid} ${Object.keys(q).join(",")}`); return { source: msgs.find((m) => String(m.uid) === uid)?.raw }; },
    on: () => client,
  };
  return client;
}
const okSmtp = (log: string[] = []): SmtpClient => ({ verify: async () => { log.push("verify"); return true; }, sendMail: async () => ({ accepted: [] }), close: () => { log.push("smtp close"); } });

describe("GmailProvider options", () => {
  it("uses implicit TLS with certificate checks on the two Gmail hosts only", () => {
    const p = new GmailProvider(ACCOUNT);
    expect(p.imapOptions()).toMatchObject({ host: "imap.gmail.com", port: 993, secure: true, logger: false, auth: { user: ALEX, pass: ACCOUNT.password }, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: "imap.gmail.com" } });
    expect(p.smtpOptions()).toMatchObject({ host: "smtp.gmail.com", port: 465, secure: true, logger: false, disableFileAccess: true, disableUrlAccess: true, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" } });
  });
  it("refuses a host outside the allowed list before connecting", async () => {
    const log: string[] = [];
    const p = new GmailProvider(ACCOUNT, { imap: () => fakeImap({ log }), allowedHosts: ["smtp.gmail.com"] });
    await expect(p.connect()).rejects.toThrow(/may only connect to smtp\.gmail\.com/);
    expect(log).toEqual([]);
  });

  it("contains no insecure option anywhere, and pins servername to the host", () => {
    const p = new GmailProvider(ACCOUNT);
    const INSECURE_KEYS = ["ignoreTLS", "doSTARTTLS", "requireTLS", "checkServerIdentity", "ciphers", "secureProtocol", "maxVersion", "proxy", "insecureHTTPParser", "pfx", "ca"];
    for (const [o, port] of [[p.imapOptions(), 993], [p.smtpOptions(), 465]] as const) {
      const walk = (v: unknown, at: string): void => {
        if (!v || typeof v !== "object") return;
        for (const [k, x] of Object.entries(v)) {
          expect(INSECURE_KEYS, `${at}.${k}`).not.toContain(k);
          if (k === "rejectUnauthorized") expect(x, `${at}.${k}`).toBe(true);
          if (k === "secure") expect(x, `${at}.${k}`).toBe(true);
          walk(x, `${at}.${k}`);
        }
      };
      walk(o, "options");
      expect(o.port).toBe(port);
      expect(o.secure).toBe(true);
      expect(o.tls).toEqual({ rejectUnauthorized: true, minVersion: "TLSv1.2", servername: o.host });
      expect(GMAIL_HOSTS).toContain(o.host);
    }
    // nodemailer would otherwise greet Gmail with this computer's own host name.
    expect(p.smtpOptions().name).toBe("[127.0.0.1]");
  });

  it("never turns certificate checks off anywhere in the mail package source", () => {
    const dir = path.resolve(import.meta.dirname, "../src");
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(dir)) {
      const text = fs.readFileSync(f, "utf8");
      const rel = path.relative(dir, f);
      expect(text, rel).not.toMatch(/rejectUnauthorized\s*:\s*false/);
      expect(text, rel).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    }
  });

  it("refuses every connection when the allowed list leaves out both Gmail hosts, and can't be widened", async () => {
    const calls: string[] = [];
    const none = new GmailProvider(ACCOUNT, { imap: () => { calls.push("imap"); return fakeImap(); }, smtp: () => { calls.push("smtp"); return okSmtp(); }, allowedHosts: [] });
    await expect(none.connect()).rejects.toMatchObject({ kind: "host" });
    await expect(none.send({ from: ALEX, to: ["talent" + "@" + "example.org"] }, Buffer.from("x"))).rejects.toMatchObject({ kind: "host" });
    const checks = await none.test();
    expect(checks.map((c) => c.ok)).toEqual([false, false, false]);
    expect(calls).toEqual([]);
    // Listing another host doesn't make CareerOS connect to it: the hosts are fixed to Gmail's.
    const seen: string[] = [];
    const other = new GmailProvider(ACCOUNT, { imap: (o) => { seen.push(o.host); return fakeImap(); }, allowedHosts: ["mail.example.com"] });
    await expect(other.connect()).rejects.toMatchObject({ kind: "host" });
    expect(seen).toEqual([]);
  });
});

describe("GmailProvider sessions", () => {
  const msgs: Msg[] = [3, 5, 6].map((uid) => ({ uid, raw: rawMessage({ id: `m${uid}` }), date: "2026-01-14T09:00:00.000Z" }));
  it("opens mailboxes read-only, finds Sent by its flag, and peeks bodies", async () => {
    const log: string[] = [];
    const s = await new GmailProvider(ACCOUNT, { imap: () => fakeImap({ messages: msgs, sentPath: "[Gmail]/Gesendet", log }) }).connect();
    expect(await s.open("inbox")).toEqual({ path: "INBOX", uidValidity: "7", uidNext: 100, exists: 3 });
    expect((await s.open("sent")).path).toBe("[Gmail]/Gesendet");
    expect((await s.body(5)).equals(msgs[1]!.raw)).toBe(true);
    await s.close();
    expect(log).toContain("lock INBOX readOnly=true");
    expect(log).toContain("lock [Gmail]/Gesendet readOnly=true");
    expect(log).toContain("fetchOne 5 source");
    expect(log.at(-1)).toBe("logout");
  });
  it("drops UIDs below the high-water mark that the server returns anyway", async () => {
    const s = await new GmailProvider(ACCOUNT, { imap: () => fakeImap({ messages: msgs }) }).connect();
    await s.open("inbox");
    expect((await s.headers({ sinceUid: 5 })).map((x) => x.uid)).toEqual([5, 6]);
    expect((await s.headers({ sinceUid: 7 })).map((x) => x.uid)).toEqual([]);
    const all = await s.headers({ since: new Date("2025-12-16T00:00:00.000Z") });
    expect(all.map((x) => x.uid)).toEqual([3, 5, 6]);
    expect(all[0]).toMatchObject({ messageId: "<id3" + "@" + "example.org>", subject: "Subject 3", internalDate: "2026-01-14T09:00:00.000Z", from: [{ name: "Acme Talent", address: ALEX }] });
  });
  it("refuses a UID that isn't a positive whole number, so nothing odd reaches the IMAP command", async () => {
    const s = await new GmailProvider(ACCOUNT, { imap: () => fakeImap({ messages: msgs }) }).connect();
    await s.open("inbox");
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 32]) {
      await expect(s.body(bad), String(bad)).rejects.toThrow(/UID/);
      await expect(s.headers({ sinceUid: bad }), String(bad)).rejects.toThrow(/UID/);
    }
    await expect(s.headers({ since: new Date("nope") })).rejects.toThrow(/date/);
  });
});

describe("Task 11: chunked header fetches, limits and capped bodies", () => {
  const many: Msg[] = Array.from({ length: 250 }, (_, i) => ({ uid: i < 120 ? i + 1 : i + 31, raw: rawMessage({ id: `c${i}` }), date: "2026-01-14T09:00:00.000Z" }));
  it("searches UIDs first, then fetches headers in chunks of HEADER_CHUNK as compact sets", async () => {
    const log: string[] = [];
    const s = await new GmailProvider(ACCOUNT, { imap: () => fakeImap({ messages: many, log }) }).connect();
    await s.open("inbox");
    const all = await s.headers({ sinceUid: 1 });
    expect(all.map((h) => h.uid)).toEqual(many.map((m) => m.uid));
    const fetches = log.filter((l) => l.startsWith("fetch "));
    expect(fetches).toEqual(["fetch 1:100", "fetch 101:120,151:230", "fetch 231:280"]);
    expect(HEADER_CHUNK).toBe(100);
  });
  it("fetches only the first `limit` headers", async () => {
    const log: string[] = [];
    const s = await new GmailProvider(ACCOUNT, { imap: () => fakeImap({ messages: many, log }) }).connect();
    await s.open("inbox");
    expect((await s.headers({ sinceUid: 200 }, { limit: 3 })).map((h) => h.uid)).toEqual([200, 201, 202]);
    expect(log.filter((l) => l.startsWith("fetch "))).toEqual(["fetch 200:202"]);
    expect(await s.headers({ since: new Date("2026-01-01T00:00:00.000Z") }, { limit: 0 })).toEqual([]);
    await expect(s.headers({ sinceUid: 1 }, { limit: -1 })).rejects.toThrow(/limit/);
  });
  it("asks for at most maxBytes + 1 bytes of a body", async () => {
    const log: string[] = [];
    const c = fakeImap({ messages: many, log });
    const seen: unknown[] = [];
    const inner = c.fetchOne;
    c.fetchOne = async (uid, q, o) => { seen.push(q); return inner(uid, q, o); };
    const s = await new GmailProvider(ACCOUNT, { imap: () => c }).connect();
    await s.open("inbox");
    await s.body(1, 100);
    expect(seen).toEqual([{ source: { start: 0, maxLength: 101 } }]);
    await expect(s.body(1, -5)).rejects.toThrow(/size limit/);
  });
  it("writes UID sets compactly", () => {
    expect(uidSet([1, 2, 3, 5, 7, 8])).toBe("1:3,5,7:8");
    expect(uidSet([])).toBe("");
  });
});

describe("read-only by construction", () => {
  // Every imapflow method that could change anything on the server. None may ever be touched.
  const MUTATING = [
    "messageFlagsAdd", "messageFlagsSet", "messageFlagsRemove", "setFlagColor", "messageDelete", "messageMove", "messageCopy",
    "append", "mailboxOpen", "mailboxClose", "mailboxCreate", "mailboxDelete", "mailboxRename", "mailboxSubscribe", "mailboxUnsubscribe",
    "expunge", "idle", "run", "exec", "download", "downloadMany", "fetchAll",
  ];
  const READ = new Set(["mailbox", "connect", "logout", "close", "list", "getMailboxLock", "search", "fetch", "fetchOne", "on"]);

  function recording(inner: ImapClient) {
    const touched: string[] = [];
    const args: { name: string; args: unknown[] }[] = [];
    const proxy = new Proxy(inner as unknown as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (typeof prop === "string") touched.push(prop);
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => { args.push({ name: String(prop), args: a }); return (v as (...x: unknown[]) => unknown).apply(target, a); };
      },
      set(target, prop, value) {
        // The fake sets `mailbox` on itself; anything else writing through the proxy is a bug.
        if (prop !== "mailbox") throw new Error(`unexpected write to ${String(prop)}`);
        return Reflect.set(target, prop, value);
      },
    }) as unknown as ImapClient;
    return { proxy, touched, args };
  }

  it("never asks for a flag change, a move, a delete or an append, and opens every mailbox read-only", async () => {
    const msgs: Msg[] = [1, 2].map((uid) => ({ uid, raw: rawMessage({ id: `r${uid}` }), date: "2026-01-14T09:00:00.000Z" }));
    const rec = recording(fakeImap({ messages: msgs }));
    const p = new GmailProvider(ACCOUNT, { imap: () => rec.proxy, smtp: () => okSmtp() });
    const s = await p.connect();
    await s.open("inbox");
    await s.headers({ sinceUid: 1 });
    await s.headers({ since: new Date("2026-01-01T00:00:00.000Z") });
    await s.body(1);
    await s.open("sent");
    await s.body(2);
    await s.body(2, 10);
    await s.close();
    await p.test();

    for (const m of MUTATING) expect(rec.touched, m).not.toContain(m);
    for (const t of rec.touched) expect(READ.has(t) || t === "then", t).toBe(true);
    const locks = rec.args.filter((a) => a.name === "getMailboxLock");
    expect(locks.length).toBe(2);
    for (const l of locks) expect(l.args[1]).toEqual({ readOnly: true });
    // A body is fetched as `source` only, which imapflow sends as BODY.PEEK[] (see the contract test below).
    // Task 11: a capped body is `source` with a byte range, which imapflow sends as BODY.PEEK[]<0.N>.
    for (const f of rec.args.filter((a) => a.name === "fetchOne")) expect([{ source: true }, { source: { start: 0, maxLength: 11 } }]).toContainEqual(f.args[1]);
    expect(rec.args.filter((a) => a.name === "fetchOne").map((a) => a.args[1])).toContainEqual({ source: { start: 0, maxLength: 11 } });
    for (const f of rec.args.filter((a) => a.name === "fetch")) expect(Object.keys(f.args[1] as object).sort()).toEqual(["envelope", "internalDate", "size", "uid"]);
  });

  it("offers no way to change anything through the session", async () => {
    const s = await new GmailProvider(ACCOUNT, { imap: () => fakeImap() }).connect();
    const methods = new Set<string>();
    for (let o: object | null = s; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) if (typeof (s as unknown as Record<string, unknown>)[k] === "function" && k !== "constructor") methods.add(k);
    }
    expect([...methods].sort()).toEqual(["body", "close", "headers", "open"]);
  });

  it("relies on imapflow 2.2.11 sending EXAMINE for readOnly and BODY.PEEK for source (library contract guard)", () => {
    const req = createRequire(import.meta.url);
    const root = path.dirname(req.resolve("imapflow"));
    const select = fs.readFileSync(path.join(root, "commands", "select.js"), "utf8");
    const fetch = fs.readFileSync(path.join(root, "commands", "fetch.js"), "utf8");
    expect(select).toMatch(/!options\.readOnly \? 'SELECT' : 'EXAMINE'/);
    expect(fetch).toMatch(/if \(query\.source\) \{[\s\S]{0,800}setBodyPeek\(null, partial\)/);
    expect(fetch).toMatch(/\.PEEK`/);
  });
});

describe("GmailProvider test connection", () => {
  it("passes all three checks without sending anything", async () => {
    const log: string[] = [];
    const checks = await new GmailProvider(ACCOUNT, { imap: () => fakeImap({ log }), smtp: () => okSmtp(log) }).test();
    expect(checks.map((c) => [c.id, c.ok])).toEqual([["imap", true], ["sent", true], ["smtp", true]]);
    expect(checks[2]!.message).toContain("Nothing was sent");
    expect(log).toEqual(["connect", "logout", "verify", "smtp close"]);
  });
  it("explains each failure with its fix", async () => {
    const auth = Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "[AUTHENTICATIONFAILED] Invalid credentials (Failure)" });
    const smtpAuth = Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH" });
    const checks = await new GmailProvider(ACCOUNT, { imap: () => fakeImap({ connectError: auth }), smtp: () => ({ ...okSmtp(), verify: async () => { throw smtpAuth; } }) }).test();
    expect(checks.map((c) => [c.id, c.ok])).toEqual([["imap", false], ["sent", false], ["smtp", false]]);
    expect(checks[0]!.message).toBe("Gmail didn't accept the address and app password.");
    expect(checks[0]!.fix).toMatch(/16 letters/);
    expect(checks[1]!.message).toMatch(/Not checked/);
    const noSent = await new GmailProvider(ACCOUNT, { imap: () => fakeImap({ sentPath: null }), smtp: () => okSmtp() }).test();
    expect(noSent[1]).toMatchObject({ id: "sent", ok: false, message: "Gmail's Sent folder wasn't found." });
  });
});

describe("explainMailError", () => {
  it("turns library errors into plain words", () => {
    expect(explainMailError(Object.assign(new Error("x"), { responseText: "[ALERT] Application-specific password required" })).kind).toBe("app-password-needed");
    expect(explainMailError(Object.assign(new Error("x"), { responseText: "[ALERT] Your account is not enabled for IMAP use." })).kind).toBe("imap-off");
    expect(explainMailError(Object.assign(new Error("getaddrinfo ENOTFOUND imap.gmail.com"), { code: "ENOTFOUND" })).kind).toBe("network");
    expect(explainMailError(Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })).kind).toBe("tls");
    const other = explainMailError(new Error(`Weird ${ALEX} reply`));
    expect(other.kind).toBe("other");
    expect(other.message).not.toContain(ALEX);
    expect(explainMailError(new MailError("no-sent", "x")).kind).toBe("no-sent");
  });
  it("says whether a failed send definitely didn't go, or might have (Task 17 fix round 0)", () => {
    const smtp = (msg: string, extra: Record<string, unknown>) => explainMailError(Object.assign(new Error(msg), extra));
    // A 4xx/5xx reply to MAIL FROM, RCPT TO or DATA, or to the message itself: Gmail said no.
    expect(smtp("Can't send mail - all recipients were rejected", { code: "EENVELOPE", responseCode: 550, command: "RCPT TO" }).delivery).toBe("not-sent");
    expect(smtp("Data command failed", { code: "EENVELOPE", responseCode: 451, command: "DATA" }).delivery).toBe("not-sent");
    expect(smtp("Message failed", { code: "EMESSAGE", responseCode: 552, command: "DATA" }).delivery).toBe("not-sent");
    // Never got as far as a message: sign-in, name lookup, refused connection, bad certificate.
    expect(smtp("Invalid login", { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }).delivery).toBe("not-sent");
    expect(smtp("getaddrinfo ENOTFOUND smtp.gmail.com", { code: "ENOTFOUND" }).delivery).toBe("not-sent");
    expect(smtp("connect ECONNREFUSED", { code: "ECONNREFUSED" }).delivery).toBe("not-sent");
    expect(smtp("self-signed certificate", { code: "SELF_SIGNED_CERT_IN_CHAIN" }).delivery).toBe("not-sent");
    expect(new MailError("other", "Add at least one recipient.").delivery).toBe("not-sent");
    // No final reply: a timeout, a reset or a close could come after the message was accepted.
    expect(smtp("Timeout", { code: "ETIMEDOUT", command: "CONN" }).delivery).toBe("unknown");
    expect(smtp("socket hang up", { code: "ECONNRESET" }).delivery).toBe("unknown");
    expect(smtp("Connection closed unexpectedly", { code: "ECONNECTION", command: "CONN" }).delivery).toBe("unknown");
    expect(smtp("Something odd", {}).delivery).toBe("unknown");
    expect(smtp("Timeout", { code: "ETIMEDOUT", command: "CONN" }).message).toBe(`${brand.name} couldn't reach Gmail.`);
    // Fix round 1: text that only looks like a sign-in or certificate problem, with no reply code
    // and no handshake phase, follows the same rule: it may have come after the message went.
    expect(smtp("Invalid credentials", { code: "ESOCKET", command: "CONN" }).delivery).toBe("unknown");
    expect(smtp("peer certificate changed mid-stream", { code: "ESOCKET", command: "CONN" }).delivery).toBe("unknown");
    expect(smtp("Connection closed unexpectedly", { code: "ETLS", command: "CONN" }).delivery).toBe("unknown");
    // Failures in a phase before MAIL FROM never handed a message over.
    expect(smtp("Invalid login: 535-5.7.8 Username and Password not accepted", { code: "EAUTH" }).delivery).toBe("not-sent");
    expect(smtp("Connection closed unexpectedly", { code: "ECONNECTION", command: "EHLO" }).delivery).toBe("not-sent");
    expect(smtp("Error upgrading connection with STARTTLS", { code: "ETLS", command: "STARTTLS" }).delivery).toBe("not-sent");
    expect(smtp("Timeout", { code: "ETIMEDOUT", command: "AUTH PLAIN" }).delivery).toBe("not-sent");
    expect(smtp("unable to verify the first certificate", { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }).delivery).toBe("not-sent");
    expect(smtp("Hostname/IP does not match certificate's altnames", { code: "ERR_TLS_CERT_ALTNAME_INVALID" }).delivery).toBe("not-sent");
  });
  it("never throws, even with a lone-surrogate secret or a hostile error object", () => {
    expect(() => explainMailError(new Error("odd reply abcd"), ["abcd\uD800efgh"])).not.toThrow();
    expect(explainMailError(new Error("odd reply"), ["\uDFFF\uDFFF\uDFFF\uDFFF"]).kind).toBe("other");
    const hostile = { get message(): string { throw new Error("boom"); } };
    expect(() => explainMailError(hostile)).not.toThrow();
  });
});

describe("the app password never leaks", () => {
  const PW = ACCOUNT.password;
  const SPACED = "abcd efgh ijkl mnop";
  const USERPASS = ALEX + ":" + PW;
  // Fix round 1: case and separator variants of the password.
  const UPPER = PW.toUpperCase();
  const MIXED = "AbCd" + "eFgH" + "iJkL" + "mNoP";
  const UPPER_SPACED = SPACED.toUpperCase();
  const HYPHENS = "abcd-" + "efgh-" + "ijkl-" + "mnop";
  const UPPER_HYPHENS = HYPHENS.toUpperCase();
  const B64_PW = Buffer.from(PW).toString("base64");
  const forms = [PW, SPACED, ALEX, USERPASS, Buffer.from(USERPASS).toString("base64"), Buffer.from("\0" + ALEX + "\0" + PW).toString("base64"),
    UPPER, MIXED, UPPER_SPACED, HYPHENS, UPPER_HYPHENS, B64_PW.slice(0, 12), B64_PW.slice(0, 16)];
  // Deliberately unrecognised text, so each error takes the "other" path that echoes (redacted) server text.
  const leaky = () => {
    const text = `Unexpected reply for ${USERPASS} (${SPACED}) user=${ALEX} pass=${PW} AUTH PLAIN ${forms[5]} basic ${forms[4]} `
      + `u=${UPPER} m=${MIXED} us=${UPPER_SPACED} h=${HYPHENS} uh=${UPPER_HYPHENS} b12=${B64_PW.slice(0, 12)}; b16=${B64_PW.slice(0, 16)};`;
    return Object.assign(new Error(text), { responseText: text, response: text, code: "EWEIRD", cause: new Error(text) });
  };
  const assertClean = (e: unknown, where: string) => {
    const err = e as MailError;
    expect(err, where).toBeInstanceOf(MailError);
    expect((err as { cause?: unknown }).cause, where).toBeUndefined();
    const surfaces = [err.message, err.fix, String(err.stack), String(err), JSON.stringify(err), JSON.stringify(Object.entries(err))];
    for (const s of surfaces) for (const f of forms) expect(s, `${where}: ${f.slice(0, 4)}...`).not.toContain(f);
  };

  it("is scrubbed from every IMAP failure: connect, open, list, search, fetch, body", async () => {
    const thrower = (which: keyof ImapClient) => {
      const c = fakeImap({ messages: [{ uid: 1, raw: rawMessage(), date: "2026-01-14T09:00:00.000Z" }] });
      const bad = async () => { throw leaky(); };
      if (which === "fetch") c.fetch = async function* () { yield* []; throw leaky(); };
      else (c as unknown as Record<string, unknown>)[which] = bad;
      return c;
    };
    const run = async (which: keyof ImapClient, act: (s: Awaited<ReturnType<GmailProvider["connect"]>>) => Promise<unknown>) => {
      const p = new GmailProvider(ACCOUNT, { imap: () => thrower(which) });
      let caught: unknown = null;
      try { const s = await p.connect(); await act(s); } catch (e) { caught = e; }
      expect(caught, which).not.toBeNull();
      assertClean(caught, which);
    };
    await run("connect", async () => undefined);
    await run("getMailboxLock", (s) => s.open("inbox"));
    await run("list", (s) => s.open("sent"));
    await run("search", async (s) => { await s.open("inbox"); return s.headers({ since: new Date("2026-01-01T00:00:00.000Z") }); });
    await run("fetch", async (s) => { await s.open("inbox"); return s.headers({ sinceUid: 1 }); });
    await run("fetchOne", async (s) => { await s.open("inbox"); return s.body(1); });
  });

  it("is scrubbed from the test results and from SMTP verify and send failures", async () => {
    const p = new GmailProvider(ACCOUNT, {
      imap: () => fakeImap({ connectError: leaky() }),
      smtp: () => ({ verify: async () => { throw leaky(); }, sendMail: async () => { throw leaky(); }, close: () => undefined }),
    });
    const checks = await p.test();
    const text = JSON.stringify(checks);
    for (const f of forms) expect(text).not.toContain(f);
    expect(checks[0]!.message).toMatch(/\[address\]|\[secret\]/);
    let caught: unknown = null;
    try { await p.send({ from: ALEX, to: ["talent" + "@" + "example.org"] }, Buffer.from("x")); } catch (e) { caught = e; }
    assertClean(caught, "send");
  });

  it("is scrubbed even when the thrown value isn't an Error", async () => {
    const p = new GmailProvider(ACCOUNT, { imap: () => fakeImap({ connectError: `LOGIN ${ALEX} ${PW} -> ${USERPASS}` }) });
    let caught: unknown = null;
    try { await p.connect(); } catch (e) { caught = e; }
    assertClean(caught, "string");
  });
});

describe("sending", () => {
  it("passes the exact bytes to SMTP (captured by nodemailer's stream transport)", async () => {
    const raw = rawMessage({ from: ALEX, id: "s1" });
    let captured: Buffer | null = null;
    const smtp = (): SmtpClient => {
      const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
      return { verify: async () => true, close: () => t.close(), sendMail: async (m) => { const info = await t.sendMail(m); captured = info.message as Buffer; return info as never; } };
    };
    const r = await new GmailProvider(ACCOUNT, { smtp }).send({ from: ALEX, to: ["talent" + "@" + "example.org"] }, raw);
    expect(captured!.equals(raw)).toBe(true);
    expect(r.accepted).toEqual(["talent" + "@" + "example.org"]);
  });

  it("treats an accepted message whose recipients can't be matched back as maybe sent, not refused (fix round 1)", async () => {
    const smtp = (): SmtpClient => ({ verify: async () => true, close: () => undefined, sendMail: async () => ({ accepted: ["someone" + "@" + "example.net"] }) as never });
    const e = await new GmailProvider(ACCOUNT, { smtp }).send({ from: ALEX, to: ["talent" + "@" + "example.org"] }, Buffer.from("x")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailError);
    expect((e as MailError).delivery).toBe("unknown");
  });

  it("hands nodemailer only the caller's envelope and raw buffer, and returns only `accepted`", async () => {
    const raw = Buffer.from("Subject: x\r\n\r\nodd\nline endings\r\n.\r\n", "utf8");
    const envelope = { from: ALEX, to: ["talent" + "@" + "example.org", "hr" + "@" + "example.net"] };
    const got: unknown[] = [];
    let closed = 0;
    const smtp = (): SmtpClient => ({
      verify: async () => true, close: () => { closed++; },
      sendMail: async (m) => { got.push(m); return { accepted: ["talent" + "@" + "example.org", "intruder" + "@" + "example.com"], rejected: ["hr" + "@" + "example.net"], response: "250 OK", messageId: "<x>" } as never; },
    });
    const r = await new GmailProvider(ACCOUNT, { smtp }).send(envelope, raw);
    expect(got).toHaveLength(1);
    const m = got[0] as { envelope: unknown; raw: Buffer };
    expect(Object.keys(m).sort()).toEqual(["envelope", "raw"]);
    expect(m.envelope).toEqual(envelope);
    expect(m.raw).toBe(raw);
    // Only addresses the caller asked for are reported, and nothing else comes back.
    expect(r).toEqual({ accepted: ["talent" + "@" + "example.org"] });
    expect(closed).toBe(1);
  });

  it("refuses an envelope with no recipients or a line break before connecting", async () => {
    const calls: string[] = [];
    const p = new GmailProvider(ACCOUNT, { smtp: () => { calls.push("smtp"); return okSmtp(); } });
    await expect(p.send({ from: ALEX, to: [] }, Buffer.from("x"))).rejects.toThrow(/recipient/);
    await expect(p.send({ from: ALEX + "\r\nRCPT TO:<x>", to: ["talent" + "@" + "example.org"] }, Buffer.from("x"))).rejects.toThrow(/line break/);
    await expect(p.send({ from: ALEX, to: ["talent" + "@" + "example.org\n"] }, Buffer.from("x"))).rejects.toThrow(/line break/);
    expect(calls).toEqual([]);
  });
});
