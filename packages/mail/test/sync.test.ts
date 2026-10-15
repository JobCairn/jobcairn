import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace, layout, newJob, readRecord, updateRecord } from "@careeros/core";
import { FakeMailProvider } from "../src/fake.js";
import { _storeFaults, cleanOrphans, listTriage, storeMessage } from "../src/store.js";
import { MailParseError, parseMessage } from "../src/parse.js";
import { _lockHooks, acquireLock, readMailState, syncMail, SyncBusyError, SYNC_STOPPED, type SyncOptions } from "../src/sync.js";

// Fix round 1: fault switches for the job-record write (F1, F2) and the body parser (F3). Off by default.
const faults = vi.hoisted(() => ({ jobEventFails: 0, parseNext: false }));
vi.mock("@careeros/core", async (importOriginal) => {
  const m = await importOriginal<typeof import("@careeros/core")>();
  const boom = () => Object.assign(new Error("EACCES: permission denied, open '/private/tmp/ws/companies/acme-corp/jobs/x/job.json'"), { code: "EACCES" });
  return {
    ...m,
    addEvent: ((...a: Parameters<typeof m.addEvent>) => { if (faults.jobEventFails > 0) { faults.jobEventFails--; throw boom(); } return m.addEvent(...a); }) as typeof m.addEvent,
    updateRecord: ((kind: string, file: string, fn: never) => {
      if (kind === "job" && faults.jobEventFails > 0) { faults.jobEventFails--; throw boom(); }
      return (m.updateRecord as (k: string, f: string, g: never) => unknown)(kind, file, fn);
    }) as typeof m.updateRecord,
  };
});
vi.mock("../src/parse.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/parse.js")>();
  return { ...m, parseMessage: async (raw: Buffer) => { if (faults.parseNext) { faults.parseNext = false; throw new m.MailParseError("too complex"); } return m.parseMessage(raw); } };
});
import { addr, ALEX, rawMessage, TALENT } from "../src/testing.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const NOW = new Date("2026-01-15T09:00:00.000Z");
const SEEK = addr("noreply", "s.seek.com.au");
const MUM = addr("mum", "example.net");

function setup() {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-sync-")));
  const root = path.join(tmp, "ws");
  initWorkspace(root, { now: NOW });
  const job = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: NOW });
  updateRecord("company", layout(root).companyFile(job.company_slug), (c) => { c.recruiter.email = TALENT; });
  const provider = new FakeMailProvider();
  const opts = (over: Partial<SyncOptions> = {}): SyncOptions => ({ root, provider, account: ALEX, now: NOW, firstSyncDays: 30, lockFile: path.join(tmp, "user-data", "mail-sync.lock"), ...over });
  const jobEmails = () => fs.readdirSync(layout(root).jobEmailsDir(job.company_slug, job.id)).filter((n) => n.endsWith(".json"));
  const timeline = () => readRecord("job", layout(root).jobFile(job.company_slug, job.id)).timeline.map((e) => e.event);
  const allText = () => {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(fs.readFileSync(f, "latin1")); } };
    walk(root);
    return out.join("\n");
  };
  return { root, job, provider, opts, jobEmails, timeline, allText, tmp };
}

describe("first sync", () => {
  it("stores job mail, sorts job-board mail, never writes personal mail, and only reads", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "old" }), "2025-11-01T09:00:00.000Z");
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    const personal = s.provider.add("inbox", rawMessage({ id: "p1", from: MUM, subject: "Dinner on Sunday?", text: "Bring dessert" }));
    s.provider.add("inbox", rawMessage({ id: "b1", from: SEEK, subject: "New AI Engineer jobs for you" }));
    s.provider.add("sent", rawMessage({ id: "r1", from: ALEX, to: TALENT, subject: "Re: Interview for AI Engineer" }));
    const r = await syncMail(s.opts());
    expect(r).toMatchObject({ stored: 2, triaged: 1, skipped: 1, duplicates: 0, capped: false, error: "" });
    expect(s.jobEmails()).toHaveLength(2);
    expect(listTriage(s.root)).toHaveLength(1);
    expect(s.allText()).not.toContain("Dinner on Sunday");
    expect(s.allText()).not.toContain("Bring dessert");
    expect(s.provider.calls).not.toContain(`body inbox ${personal.uid}`);
    expect(s.provider.calls.every((c) => /^(connect|open (inbox|sent)|headers (inbox|sent) .+|body (inbox|sent) \d+|close)$/.test(c))).toBe(true);
    expect(s.timeline()).toEqual(expect.arrayContaining(["Email received", "Email sent"]));
    expect(readMailState(s.root)).toMatchObject({ account: ALEX, mailboxes: { inbox: { uidvalidity: "1", last_uid: 4 }, sent: { uidvalidity: "1", last_uid: 1 } }, last_ok: NOW.toISOString(), last_error: "" });
    expect(fs.existsSync(s.opts().lockFile)).toBe(false);
    expect(JSON.stringify(readMailState(s.root))).not.toMatch(/password|abcd/i);
  });
});

describe("stopping a sync (workspace switch)", () => {
  it("stops between messages, closes the Gmail session, keeps what was stored and releases the lock", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    s.provider.add("inbox", rawMessage({ id: "m2", subject: "Second round for AI Engineer" }));
    const stop = new AbortController();
    // Stopped while the first message is being fetched: it is still stored, the second is never fetched.
    s.provider.beforeBody = (uid) => { if (uid === 1) stop.abort(); };
    const r = await syncMail(s.opts({ signal: stop.signal }));
    expect(r).toMatchObject({ stored: 1, error: SYNC_STOPPED });
    expect(s.provider.calls.filter((c) => c === "close")).toHaveLength(1);
    expect(s.provider.calls).not.toContain("body inbox 2");
    expect(s.provider.calls).not.toContain("open sent");
    // The stopped run isn't an error the person needs to see, and the mark covers only what was stored.
    expect(readMailState(s.root)).toMatchObject({ last_error: "", mailboxes: { inbox: { last_uid: 1 } } });
    expect(fs.existsSync(s.opts().lockFile)).toBe(false);
    // The next run picks up the rest.
    s.provider.beforeBody = null;
    expect(await syncMail(s.opts())).toMatchObject({ stored: 1, error: "" });
  });
  it("never connects when already stopped", async () => {
    const s = setup();
    const stop = new AbortController();
    stop.abort();
    expect(await syncMail(s.opts({ signal: stop.signal }))).toMatchObject({ stored: 0, error: SYNC_STOPPED });
    expect(s.provider.calls).toEqual([]);
    expect(fs.existsSync(s.opts().lockFile)).toBe(false);
  });
});

describe("later syncs", () => {
  it("fetches only new mail", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    await syncMail(s.opts());
    s.provider.add("inbox", rawMessage({ id: "m2", subject: "Next steps" }));
    const r = await syncMail(s.opts());
    expect(r.stored).toBe(1);
    expect(s.provider.calls).toContain("headers inbox from uid 2");
    expect(s.jobEmails()).toHaveLength(2);
  });
  it("re-scans by date when Gmail renumbers a mailbox, without duplicates", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    await syncMail(s.opts());
    s.provider.inbox = { uidValidity: "99", messages: [{ uid: 40, raw: rawMessage({ id: "m1" }), internalDate: "2026-01-14T09:00:00.000Z" }, { uid: 41, raw: rawMessage({ id: "m2", subject: "Next steps" }), internalDate: "2026-01-14T10:00:00.000Z" }] };
    const r = await syncMail(s.opts());
    expect(r).toMatchObject({ stored: 1, duplicates: 1 });
    expect(readMailState(s.root).mailboxes.inbox).toMatchObject({ uidvalidity: "99", last_uid: 41 });
    expect(s.jobEmails()).toHaveLength(2);
  });
  it("stores a message once when it is in INBOX and Sent (Review Focus 2)", async () => {
    const s = setup();
    const raw = rawMessage({ id: "self1", from: ALEX, to: TALENT, cc: ALEX, subject: "Following up" });
    s.provider.add("inbox", raw);
    s.provider.add("sent", raw);
    const r = await syncMail(s.opts());
    expect(r).toMatchObject({ stored: 1, duplicates: 1 });
    expect(s.jobEmails()).toHaveLength(1);
    expect(s.timeline().filter((e) => e.startsWith("Email "))).toHaveLength(1);
  });
  it("handles a message with no Message-ID or Date, once (Review Focus 3)", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: null, date: null }), "2026-01-14T08:00:00.000Z");
    expect((await syncMail(s.opts())).stored).toBe(1);
    const sidecar = JSON.parse(fs.readFileSync(path.join(layout(s.root).jobEmailsDir(s.job.company_slug, s.job.id), s.jobEmails()[0]!), "utf8"));
    expect(sidecar.message_id).toMatch(/\.synthetic@localhost>$/);
    expect(sidecar.date).toBe("2026-01-14T08:00:00.000Z");
    s.provider.inbox.uidValidity = "2";
    expect(await syncMail(s.opts())).toMatchObject({ stored: 0, duplicates: 1 });
  });
  it("skips senders on the ignore list", async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.root, ".careeros"), { recursive: true });
    fs.writeFileSync(path.join(s.root, ".careeros", "mail-state.json"), JSON.stringify({ ignore: { senders: [SEEK], domains: [] } }));
    s.provider.add("inbox", rawMessage({ id: "b1", from: SEEK, subject: "New jobs" }));
    expect(await syncMail(s.opts())).toMatchObject({ triaged: 0, skipped: 1 });
  });
});

describe("caps and resume", () => {
  it("stops at the message cap and resumes next time", async () => {
    const s = setup();
    for (const id of ["a", "b", "c"]) s.provider.add("inbox", rawMessage({ id, subject: `Update ${id}` }));
    expect(await syncMail(s.opts({ caps: { maxMessages: 2 } }))).toMatchObject({ stored: 2, capped: true });
    expect(await syncMail(s.opts({ caps: { maxMessages: 2 } }))).toMatchObject({ stored: 1, capped: false });
    expect(s.jobEmails()).toHaveLength(3);
  });
  it("stops when the network time is used up", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "a" }));
    expect(await syncMail(s.opts({ elapsed: () => 61_000 }))).toMatchObject({ stored: 0, capped: true });
    expect(await syncMail(s.opts())).toMatchObject({ stored: 1 });
  });
  it("keeps only the headers of a message over the size cap and never downloads it", async () => {
    const s = setup();
    const m = s.provider.add("inbox", rawMessage({ id: "big", text: "x".repeat(400) }));
    expect(await syncMail(s.opts({ caps: { maxMessageBytes: 100 } }))).toMatchObject({ stored: 1, too_large: 1 });
    expect(s.provider.calls).not.toContain(`body inbox ${m.uid}`);
  });
  it("ends with a plain error, releases the lock and resumes cleanly after a dropped connection (Review Focus 4)", async () => {
    const s = setup();
    for (const id of ["a", "b", "c"]) s.provider.add("inbox", rawMessage({ id, subject: `Update ${id}` }));
    s.provider.failBodyAt = 2;
    const r = await syncMail(s.opts());
    expect(r).toMatchObject({ stored: 1, error: `${brand.name} couldn't reach Gmail.` });
    expect(readMailState(s.root)).toMatchObject({ mailboxes: { inbox: { last_uid: 1 } }, last_error: `${brand.name} couldn't reach Gmail.` });
    expect(fs.existsSync(s.opts().lockFile)).toBe(false);
    expect(s.provider.calls.at(-1)).toBe("close");
    s.provider.failBodyAt = null;
    expect(await syncMail(s.opts())).toMatchObject({ stored: 2, duplicates: 0, error: "" });
    expect(s.jobEmails()).toHaveLength(3);
    expect(s.timeline().filter((e) => e === "Email received")).toHaveLength(3);
    expect(readMailState(s.root).last_error).toBe("");
  });
  it("reports a revoked password in plain words", async () => {
    const s = setup();
    s.provider.failWith = "auth";
    expect((await syncMail(s.opts())).error).toBe("Gmail didn't accept the address and app password.");
    expect(fs.existsSync(s.opts().lockFile)).toBe(false);
  });
  it("refuses to run two syncs at once", async () => {
    const s = setup();
    const release = acquireLock(s.opts().lockFile, NOW);
    expect(await syncMail(s.opts())).toMatchObject({ error: "A mail sync is already running." });
    expect(s.provider.calls).toEqual([]);
    release();
    expect((await syncMail(s.opts())).error).toBe("");
  });
  it("takes over a lock left by a crashed process", async () => {
    const s = setup();
    fs.mkdirSync(path.dirname(s.opts().lockFile), { recursive: true });
    fs.writeFileSync(s.opts().lockFile, JSON.stringify({ pid: process.pid, at: "2026-01-15T08:00:00.000Z" }));
    expect((await syncMail(s.opts())).error).toBe("");
  });
  it("starts fresh when a different account is connected, keeping the ignore list", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    await syncMail(s.opts());
    await syncMail(s.opts({ account: addr("other", "example.com") }));
    expect(readMailState(s.root).account).toBe(addr("other", "example.com"));
    expect(s.provider.calls.filter((c) => c.startsWith("headers inbox since"))).toHaveLength(2);
  });
});

describe("Task 11: recovery, dedupe and caps carried from earlier reviews", () => {
  afterEach(() => { for (const k of Object.keys(_storeFaults)) delete (_storeFaults as Record<string, unknown>)[k]; });
  const staging = (root: string) => path.join(root, ".careeros", "mail-staging");
  const OLD = new Date("2025-06-01T00:00:00.000Z");
  const storeDirect = async (s: ReturnType<typeof setup>, id: string) => {
    const raw = rawMessage({ id });
    const parsed = await parseMessage(raw);
    const header = { uid: 1, size: raw.length, internalDate: "2026-01-14T09:00:00.000Z", messageId: parsed.message_id, from: [parsed.from], to: parsed.to, cc: parsed.cc, subject: parsed.subject };
    return storeMessage(s.root, { company_slug: s.job.company_slug, job_id: s.job.id }, { raw, parsed, header, mailbox: "INBOX", direction: "in", matched_by: "recruiter", tooLarge: false }, { now: NOW });
  };
  const stores = () => { let n = 0; _storeFaults.onStep = (step) => { if (step === "stage-pre:json") n++; }; return () => n; };

  it("runs cleanOrphans and purgeTriage on every run", async () => {
    const s = setup();
    // cleanOrphans: an interrupted store (its journal left in staging) is finished before anything else.
    _storeFaults.after = "store:eml";
    _storeFaults.crash = true;
    await expect(storeDirect(s, "m0")).rejects.toThrow(/injected/);
    for (const k of Object.keys(_storeFaults)) delete (_storeFaults as Record<string, unknown>)[k];
    expect(fs.readdirSync(staging(s.root)).some((n) => n.endsWith(".journal.json"))).toBe(true);
    s.provider.add("inbox", rawMessage({ id: "b1", from: SEEK, subject: "New AI Engineer jobs for you" }));
    expect(await syncMail(s.opts())).toMatchObject({ triaged: 1, purged: 0 });
    expect(fs.readdirSync(staging(s.root))).toEqual([]);
    expect(s.jobEmails()).toHaveLength(1);
    const t = listTriage(s.root)[0]!;
    for (const ext of ["json", "eml", "md"]) { const f = path.join(s.root, t.ref.replace(/\.json$/, `.${ext}`)); if (fs.existsSync(f)) fs.utimesSync(f, OLD, OLD); }
    expect(await syncMail(s.opts())).toMatchObject({ purged: 1 });
    expect(readMailState(s.root).purged).toBe(1);
    expect(listTriage(s.root)).toHaveLength(0);
  });

  it("finishes an interrupted store first, then counts that message as a duplicate", async () => {
    const s = setup();
    _storeFaults.after = "store:md";
    _storeFaults.crash = true;
    await expect(storeDirect(s, "m1")).rejects.toThrow(/injected/);
    for (const k of Object.keys(_storeFaults)) delete (_storeFaults as Record<string, unknown>)[k];
    const n = stores();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    expect(await syncMail(s.opts())).toMatchObject({ stored: 0, duplicates: 1, error: "" });
    expect(n()).toBe(0);
    expect(s.jobEmails()).toHaveLength(1);
    expect(fs.readdirSync(staging(s.root))).toEqual([]);
  });

  it("never stores a message twice when another process has it mid-move", async () => {
    const s = setup();
    let staged = "";
    _storeFaults.onStep = (step, file) => { if (step === "stage:json") staged = file; };
    _storeFaults.after = "store:md";
    _storeFaults.crash = true;
    await expect(storeDirect(s, "m1")).rejects.toThrow(/injected/);
    for (const k of Object.keys(_storeFaults)) delete (_storeFaults as Record<string, unknown>)[k];
    // Make the journal belong to a live process that is still working: recovery leaves it alone.
    const jf = path.join(staging(s.root), fs.readdirSync(staging(s.root)).find((x) => x.endsWith(".journal.json"))!);
    const j = JSON.parse(fs.readFileSync(jf, "utf8")) as { pid: number; to: { segs: string[]; base: string } };
    j.pid = process.ppid;
    fs.writeFileSync(jf, JSON.stringify(j));
    // Caught between link and unlink: the sidecar has two links.
    fs.linkSync(staged, path.join(s.root, ...j.to.segs, `${j.to.base}.json`));
    const n = stores();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    expect(await syncMail(s.opts())).toMatchObject({ stored: 0, duplicates: 1, error: "" });
    expect(n()).toBe(0);
    expect(s.jobEmails()).toHaveLength(1);
  });

  it("holds a mailbox back at a message staged with no journal yet, and stores it once that is cleared", async () => {
    const s = setup();
    _storeFaults.after = "stage:json";
    _storeFaults.crash = true;
    await expect(storeDirect(s, "m1")).rejects.toThrow(/injected/);
    for (const k of Object.keys(_storeFaults)) delete (_storeFaults as Record<string, unknown>)[k];
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    s.provider.add("inbox", rawMessage({ id: "m2", subject: "Next steps" }));
    expect(await syncMail(s.opts())).toMatchObject({ stored: 0, duplicates: 0, capped: true, error: "" });
    expect(readMailState(s.root).mailboxes.inbox?.last_uid).toBe(0);
    const t = Date.now() + 20; while (Date.now() < t) { /* let the real clock pass the staged files */ }
    expect(cleanOrphans(s.root, new Date(), 0)).toBeGreaterThan(0);
    expect(await syncMail(s.opts())).toMatchObject({ stored: 2, capped: false });
    expect(s.jobEmails()).toHaveLength(2);
  });

  it("after a failed store that recovery publishes, counts it as stored without a retry", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    const n = stores();
    _storeFaults.after = "store:json";
    _storeFaults.crash = true;
    expect(await syncMail(s.opts())).toMatchObject({ stored: 1, duplicates: 0, error: "" });
    expect(n()).toBe(1);
    expect(s.jobEmails()).toHaveLength(1);
    expect(s.timeline().filter((e) => e === "Email received")).toHaveLength(1);
    expect(fs.readdirSync(staging(s.root))).toEqual([]);
  });

  it("retries a store that failed cleanly once", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    let n = 0;
    _storeFaults.onStep = (step) => { if (step === "stage:md" && ++n === 1) throw new Error("disk hiccup"); };
    expect(await syncMail(s.opts())).toMatchObject({ stored: 1, error: "" });
    expect(n).toBe(2);
    expect(s.jobEmails()).toHaveLength(1);
  });

  it("ends with a plain error when a store fails twice, without moving the high-water mark", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    _storeFaults.after = "stage:md";
    const r = await syncMail(s.opts());
    expect(r).toMatchObject({ stored: 0, error: `${brand.name} couldn't save an email to your workspace.` });
    expect(readMailState(s.root).mailboxes.inbox?.last_uid).toBe(0);
    expect(fs.existsSync(s.opts().lockFile)).toBe(false);
    delete _storeFaults.after;
    expect(await syncMail(s.opts())).toMatchObject({ stored: 1, error: "" });
  });

  it("caps a body the server under-reported, downloading at most one byte over the cap", async () => {
    const s = setup();
    const m = s.provider.add("inbox", rawMessage({ id: "big", text: "x".repeat(4000) }));
    m.size = 50;
    const raw = await syncMail(s.opts({ caps: { maxMessageBytes: 1000 } }));
    expect(raw).toMatchObject({ stored: 1, too_large: 1 });
    expect(s.provider.calls).toContain(`body inbox ${m.uid}`);
    const dir = layout(s.root).jobEmailsDir(s.job.company_slug, s.job.id);
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, s.jobEmails()[0]!), "utf8"));
    expect(sidecar.too_large).toBe(true);
    expect(fs.readdirSync(dir).some((n) => n.endsWith(".eml"))).toBe(false);
  });

  it("asks for headers no further than the cap needs", async () => {
    const s = setup();
    for (const id of ["a", "b", "c", "d", "e"]) s.provider.add("inbox", rawMessage({ id, subject: `Update ${id}` }));
    const seen: (number | undefined)[] = [];
    const connect = s.provider.connect.bind(s.provider);
    s.provider.connect = async () => {
      const session = await connect();
      const headers = session.headers;
      session.headers = async (range, o) => { seen.push(o?.limit); return headers(range, o); };
      return session;
    };
    expect(await syncMail(s.opts({ caps: { maxMessages: 2 } }))).toMatchObject({ stored: 2, capped: true });
    expect(seen).toEqual([3]);
  });

  it("resumes a capped re-scan from the first message in the window, never from UID 1", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "old" }), "2025-11-01T09:00:00.000Z");
    s.provider.add("inbox", rawMessage({ id: "a", subject: "Update a" }));
    s.provider.add("inbox", rawMessage({ id: "b", subject: "Update b" }));
    expect(await syncMail(s.opts({ caps: { maxMessages: 1 } }))).toMatchObject({ stored: 1, capped: true });
    expect(await syncMail(s.opts())).toMatchObject({ stored: 1, capped: false });
    expect(s.provider.calls).toContain("headers inbox from uid 3");
    expect(s.provider.calls).not.toContain("body inbox 1");
    expect(s.jobEmails()).toHaveLength(2);
  });

  it("starts an empty re-scanned mailbox at the next UID", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "old" }), "2025-11-01T09:00:00.000Z");
    await syncMail(s.opts());
    expect(readMailState(s.root).mailboxes.inbox).toEqual({ uidvalidity: "1", last_uid: 1 });
  });
});

describe("fix round 1", () => {
  afterEach(() => { faults.jobEventFails = 0; faults.parseNext = false; for (const k of Object.keys(_lockHooks)) delete (_lockHooks as Record<string, unknown>)[k]; });
  const WORKSPACE = `${brand.name} couldn't read or update your workspace.`;
  const received = (s: ReturnType<typeof setup>) => s.timeline().filter((e) => e === "Email received").length;

  it("F1: puts back a timeline event lost when writing it failed, and never adds one twice", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    faults.jobEventFails = 1;
    expect((await syncMail(s.opts())).error).not.toBe("");
    expect(s.jobEmails()).toHaveLength(1);
    expect(received(s)).toBe(0);
    expect(await syncMail(s.opts())).toMatchObject({ stored: 0, duplicates: 1, error: "" });
    expect(received(s)).toBe(1);
    s.provider.add("inbox", rawMessage({ id: "m2", subject: "Next steps" }));
    expect(await syncMail(s.opts())).toMatchObject({ stored: 1, error: "" });
    expect(received(s)).toBe(2);
    // A re-scan sees both again as duplicates: still one event each.
    s.provider.inbox.uidValidity = "2";
    expect(await syncMail(s.opts())).toMatchObject({ duplicates: 2, error: "" });
    expect(received(s)).toBe(2);
    const job = readRecord("job", layout(s.root).jobFile(s.job.company_slug, s.job.id));
    expect(job.timeline.filter((e) => e.event === "Email received").map((e) => e.message_id).sort()).toEqual(["<m1@example.org>", "<m2@example.org>"]);
  });

  it("F2: says the workspace, not Gmail, when the companies folder can't be read, and shows no path", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    const dir = layout(s.root).companiesDir;
    fs.chmodSync(dir, 0o000);
    try {
      const r = await syncMail(s.opts());
      expect(r.error).toBe(WORKSPACE);
      expect(readMailState(s.root).last_error).toBe(WORKSPACE);
      expect(fs.existsSync(s.opts().lockFile)).toBe(false);
    } finally { fs.chmodSync(dir, 0o700); }
  });

  it("F2: says the workspace, not Gmail, when the job's timeline can't be written", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    faults.jobEventFails = 1;
    const r = await syncMail(s.opts());
    expect(r.error).toBe(WORKSPACE);
    expect(r.error).not.toMatch(/Gmail|\//);
  });

  it("F3: keeps a message the parser refuses as headers only, and moves on", async () => {
    const s = setup();
    const m = s.provider.add("inbox", rawMessage({ id: "bad", subject: "Interview for AI Engineer" }));
    s.provider.add("inbox", rawMessage({ id: "m2", subject: "Next steps" }));
    const connect = s.provider.connect.bind(s.provider);
    s.provider.connect = async () => {
      const session = await connect();
      const body = session.body;
      session.body = async (uid, max) => { const b = await body(uid, max); if (uid === m.uid) faults.parseNext = true; return b; };
      return session;
    };
    expect(await syncMail(s.opts())).toMatchObject({ stored: 2, too_large: 0, error: "" });
    expect(faults.parseNext).toBe(false);
    const dir = layout(s.root).jobEmailsDir(s.job.company_slug, s.job.id);
    const sidecars = s.jobEmails().map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { message_id: string; too_large: boolean });
    const bad = sidecars.find((e) => e.message_id === "<bad@example.org>")!;
    expect(bad.too_large).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".eml"))).toHaveLength(1);
    expect(readMailState(s.root).mailboxes.inbox?.last_uid).toBe(2);
    expect(MailParseError).toBeDefined();
  });

  it("F4: a capped run followed by a UIDVALIDITY change still stores the whole backlog", async () => {
    const s = setup();
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    for (const [id, d] of [["a", 10], ["b", 9], ["c", 8]] as const) s.provider.add("inbox", rawMessage({ id, subject: `Update ${id}` }), at(d));
    expect(await syncMail(s.opts({ caps: { maxMessages: 1 } }))).toMatchObject({ stored: 1, capped: true });
    expect(readMailState(s.root).mailboxes.inbox?.complete_through).toBe(at(10));
    s.provider.inbox.uidValidity = "2";
    for (let i = 0; i < 6 && s.jobEmails().length < 3; i++) await syncMail(s.opts({ caps: { maxMessages: 1 } }));
    expect(s.jobEmails()).toHaveLength(3);
  });

  it("F5: when two syncs take over a stale lock at once, only one gets it", () => {
    const s = setup();
    const file = s.opts().lockFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: "2026-01-15T08:00:00.000Z" }));
    let other: (() => void) | null = null;
    // The other process judges the same lock stale and finishes its takeover while this one is mid-acquire.
    _lockHooks.afterStaleCheck = () => { delete _lockHooks.afterStaleCheck; other = acquireLock(file, NOW); };
    expect(() => acquireLock(file, NOW)).toThrow(SyncBusyError);
    expect(other).not.toBeNull();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    other!();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("fix round 2", () => {
  it("N1: a job record that can't be updated never stalls the mailbox at a duplicate", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "m1" }));
    expect(await syncMail(s.opts())).toMatchObject({ stored: 1, error: "" });
    const file = layout(s.root).jobFile(s.job.company_slug, s.job.id);
    const job = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    job.status = "not-a-status";
    job.timeline = [];
    fs.writeFileSync(file, JSON.stringify(job));
    s.provider.inbox.uidValidity = "2";
    const b = s.provider.add("inbox", rawMessage({ id: "b1", from: SEEK, subject: "New AI Engineer jobs for you" }));
    const r = await syncMail(s.opts());
    expect(r).toMatchObject({ duplicates: 1, triaged: 1, repair_failed: 1, error: "" });
    expect(readMailState(s.root).mailboxes.inbox?.last_uid).toBe(b.uid);
    expect(readMailState(s.root).last_error).toBe("");
  });

  it("clamps complete_through to now, so a future-dated message can't move the re-scan start forward", async () => {
    const s = setup();
    s.provider.add("inbox", rawMessage({ id: "f1" }), "2027-06-01T00:00:00.000Z");
    await syncMail(s.opts({ firstSyncDays: 30 }));
    expect(readMailState(s.root).mailboxes.inbox?.complete_through).toBe(NOW.toISOString());
  });
});
