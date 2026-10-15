import { layout, readMeta, updateRecord } from "@careeros/core";
import { acquireLock, rawMessage, SYNC_STOPPED, TALENT } from "@careeros/mail";
import { describe, expect, it } from "vitest";
import { fakeMailHost, fakeScheduler } from "../src/fakes.js";
import { mailAccountHandlers as M, mailStatus, syncInfo } from "../src/mail-account.js";
import { installMailTimer, mailSyncHandlers as S, runBackgroundSync, runSync } from "../src/mail-sync.js";
import { openWorkspace } from "../src/workspace.js";
import { openSample, sampleCopy } from "./helpers.js";
import { ACME, connectMail, gmailKey, GOOD_PASSWORD } from "./mail-helpers.js";

const ADDRESS = "alex" + "@" + "example.com";
const GOOD = "abcd efgh ijkl mnop";

/** Two workspaces on one computer: A (Alex) is open, B (a second copy) exists and has been opened once. */
function twoWorkspaces() {
  const mail = fakeMailHost({ goodPassword: GOOD_PASSWORD });
  const scheduler = fakeScheduler();
  const x = openSample({ mail, scheduler });
  const a = x.root;
  const b = sampleCopy();
  openWorkspace(x.ctx, b);
  openWorkspace(x.ctx, a);
  for (const r of [a, b]) updateRecord("company", layout(r).companyFile(ACME[0]), (c) => { c.recruiter.email = TALENT; });
  mail.fake.add("inbox", rawMessage({ id: "w1" }), "2026-01-14T09:00:00.000Z");
  mail.fake.add("inbox", rawMessage({ id: "w2", subject: "Second round for AI Engineer" }), "2026-01-14T10:00:00.000Z");
  const id = (r: string) => readMeta(r).workspace_id;
  return { ...x, a, b, mail, scheduler, id };
}

describe("mail is kept per workspace", () => {
  it("keeps the Gmail password under each workspace's own id", () => {
    const { ctx, host, a, b } = twoWorkspaces();
    connectMail(ctx, a);
    expect(mailStatus(ctx)).toMatchObject({ connected: true, password_set: true });
    expect([...host.secrets.values.keys()]).toEqual([gmailKey(a)]);
    openWorkspace(ctx, b);
    expect(mailStatus(ctx)).toMatchObject({ connected: false, password_set: false });
    expect(gmailKey(a)).not.toBe(gmailKey(b));
  });

  it("never saves a password tested in one workspace into another", async () => {
    const { ctx, b, host } = twoWorkspaces();
    expect((await M["mail.testConnection"](ctx, ADDRESS, "Alex Example", GOOD)).ok).toBe(true);
    openWorkspace(ctx, b);
    expect(() => M["mail.saveAccount"](ctx, ADDRESS, "Alex Example")).toThrow(/Test the connection first/);
    expect(host.secrets.values.size).toBe(0);
  });

  it("a test still running when the workspace changes is never staged for the new one", async () => {
    const { ctx, b, mail, host } = twoWorkspaces();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const realTest = mail.fake.test.bind(mail.fake);
    mail.fake.test = async () => { await held; return realTest(); };
    const testing = M["mail.testConnection"](ctx, ADDRESS, "Alex Example", GOOD);
    openWorkspace(ctx, b);
    release();
    await expect(testing).rejects.toThrow(/workspace changed/);
    expect(() => M["mail.saveAccount"](ctx, ADDRESS, "Alex Example")).toThrow(/Test the connection first/);
    expect(host.secrets.values.size).toBe(0);
  });

  it("gives each workspace its own background schedule; disconnecting one leaves the other's", async () => {
    const { ctx, a, b, scheduler, id } = twoWorkspaces();
    connectMail(ctx, a);
    await S["mail.background.set"](ctx, true, 60);
    openWorkspace(ctx, b);
    connectMail(ctx, b);
    await S["mail.background.set"](ctx, true, 120);
    expect(scheduler.jobs.get(id(a))).toMatchObject({ args: ["--background-sync", "--workspace", a], minutes: 60 });
    expect(scheduler.jobs.get(id(b))).toMatchObject({ args: ["--background-sync", "--workspace", b], minutes: 120 });
    await M["mail.disconnect"](ctx);
    expect([...scheduler.jobs.keys()]).toEqual([id(a)]);
    expect((await S["mail.background.status"](ctx)).installed).toBe(false);
    openWorkspace(ctx, a);
    expect((await S["mail.background.status"](ctx)).installed).toBe(true);
  });

  it("uses a separate sync lock and log per workspace", async () => {
    const { ctx, a, b, mail, id } = twoWorkspaces();
    connectMail(ctx, a);
    await S["mail.syncNow"](ctx);
    expect((await S["mail.background.status"](ctx)).log).toEqual([expect.stringMatching(/sync stored=2/)]);
    expect(mail.lockFile(id(a))).not.toBe(mail.lockFile(id(b)));
    openWorkspace(ctx, b);
    connectMail(ctx, b);
    // A's log never shows in B.
    expect((await S["mail.background.status"](ctx)).log).toEqual([]);
    // Another process syncing A doesn't hold B up.
    const unlockA = acquireLock(mail.lockFile(id(a)));
    try {
      expect(await runSync(ctx)).toMatchObject({ stored: 2, error: "" });
    } finally { unlockA(); }
    expect(mail.readLog(id(b))).toEqual([expect.stringMatching(/sync stored=2/)]);
    expect(mail.readLog(id(a))).toHaveLength(1);
  });

  it("the headless run reads the workspace's own password and writes to its own log", async () => {
    const { ctx, a, b, mail, host, id } = twoWorkspaces();
    connectMail(ctx, a);
    for (const r of [a, b]) updateRecord("integrations", layout(r).integrations, (i) => { i.mail.address = ADDRESS; i.mail.background.on = true; });
    expect((await runBackgroundSync(host, a)).line).toMatch(/sync stored=2/);
    // B has an address but no password of its own: A's is never used for it.
    expect((await runBackgroundSync(host, b)).line).toMatch(/app password isn't saved/);
    expect(mail.readLog(id(a))).toHaveLength(1);
    expect(mail.readLog(id(b))).toEqual([expect.stringMatching(/app password isn't saved/)]);
  });

  it("switching workspace stops the old workspace's sync and closes its Gmail session", async () => {
    const { ctx, a, b, mail } = twoWorkspaces();
    connectMail(ctx, a);
    installMailTimer(ctx, { firstMs: 60 * 60_000 });
    let release!: () => void;
    const fetching = new Promise<void>((started) => {
      mail.fake.beforeBody = () => { started(); return new Promise<void>((r) => { release = r; }); };
    });
    const run = runSync(ctx);
    await fetching;
    expect(syncInfo(ctx, a).syncing).toBe(true);
    openWorkspace(ctx, b);
    expect(mail.fake.calls).toContain("close");
    release();
    expect(await run).toMatchObject({ error: SYNC_STOPPED });
    expect(mail.fake.calls).not.toContain("body inbox 2");
    expect(syncInfo(ctx, a).syncing).toBe(false);
    // The stop isn't shown to A as an error.
    openWorkspace(ctx, a);
    expect(mailStatus(ctx).last_error).toBe("");
    ctx.setRoot(null);
  });

  it("a background run stops cleanly when told to (the person opened the app), keeping what it stored", async () => {
    const { ctx, a, mail, host } = twoWorkspaces();
    connectMail(ctx, a);
    updateRecord("integrations", layout(a).integrations, (i) => { i.mail.background.on = true; });
    const stop = new AbortController();
    mail.fake.beforeBody = (uid) => { if (uid === 1) stop.abort(); };
    const r = await runBackgroundSync(host, a, { signal: stop.signal });
    expect(r.code).toBe(0);
    expect(r.line).toContain(SYNC_STOPPED);
    expect(mail.fake.calls).toContain("close");
    expect(mail.fake.calls).not.toContain("body inbox 2");
    expect(mailStatus(ctx).last_error).toBe("");
  });
});
