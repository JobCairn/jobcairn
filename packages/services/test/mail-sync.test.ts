import { layout, readMeta, readRecord, updateRecord } from "@careeros/core";
import { acquireLock, addr, ALEX, rawMessage, TALENT } from "@careeros/mail";
import { describe, expect, it, vi } from "vitest";
import { fakeHost, fakeMailHost, fakeScheduler, memorySecrets } from "../src/fakes.js";
import { mailReadHandlers as R } from "../src/mail-read.js";
import { accountHooks, mailStatus, syncInfo } from "../src/mail-account.js";
import { installMailTimer, mailSyncHandlers as S, runBackgroundSync, runSync } from "../src/mail-sync.js";
import { openSample, sampleCopy } from "./helpers.js";
import { openWorkspace } from "../src/workspace.js";
import { ACME, connectMail, gmailKey, GOOD_PASSWORD } from "./mail-helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

function setup(o: { secretsAvailable?: boolean; supported?: boolean } = {}) {
  const mail = fakeMailHost({ goodPassword: GOOD_PASSWORD });
  const scheduler = fakeScheduler(o.supported ?? true);
  const x = openSample({ mail, scheduler, secretsAvailable: o.secretsAvailable });
  updateRecord("company", layout(x.root).companyFile(ACME[0]), (c) => { c.recruiter.email = TALENT; });
  mail.fake.add("inbox", rawMessage({ id: "s1" }), "2026-01-14T09:00:00.000Z");
  mail.fake.add("inbox", rawMessage({ id: "s2", from: addr("friend", "example.net"), subject: "Dinner on Saturday?" }), "2026-01-14T10:00:00.000Z");
  return { ...x, mail, scheduler };
}

describe("Sync now", () => {
  it("needs a connected account", async () => {
    const { ctx } = setup();
    await expect(S["mail.syncNow"](ctx)).rejects.toThrow("Connect Gmail in Settings > Email first.");
  });
  it("stores job mail, skips personal mail, announces changes and logs counts without addresses or secrets", async () => {
    const { ctx, root, mail } = setup();
    connectMail(ctx, root);
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    const s = await S["mail.syncNow"](ctx);
    expect(s).toMatchObject({ connected: true, syncing: false, last_error: "", counts: { stored: 1, skipped: 1 } });
    expect(R["mail.list"](ctx, { company_slug: ACME[0], id: ACME[1] }).rows.map((r) => r.subject)).toEqual(["Interview for AI Engineer"]);
    expect(readRecord("job", layout(root).jobFile(...ACME)).timeline.at(-1)).toMatchObject({ event: "Email received" });
    expect(seen).toContainEqual(["mail"]);
    expect(seen.at(-1)).toEqual(["mail", "jobs", "home"]);
    expect(mail.logs).toHaveLength(1);
    expect(mail.logs[0]).toMatch(/^2026-01-15T09:00:00\.000Z sync stored=1 sorted=0 skipped=1 duplicates=0 too_large=0 capped=no$/);
    expect(mail.logs.join("\n")).not.toContain(ALEX);
    expect(mail.logs.join("\n")).not.toContain(GOOD_PASSWORD);
  });
  it("shows a revoked password as a plain error and keeps the stored mail", async () => {
    const { ctx, root, host } = setup();
    connectMail(ctx, root);
    await S["mail.syncNow"](ctx);
    host.secrets.set(gmailKey(root), "zzzzyyyyxxxxwwww");
    const s = await S["mail.syncNow"](ctx);
    expect(s.last_error).toBe("Gmail didn't accept the address and app password.");
    expect(s.last_ok).toBe("2026-01-15T09:00:00.000Z");
    expect(R["mail.list"](ctx, {}).total).toBe(1);
  });
  it("runs one sync at a time in a process", async () => {
    const { ctx, root, mail } = setup();
    connectMail(ctx, root);
    const [a, b] = await Promise.all([runSync(ctx), runSync(ctx)]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(mail.fake.calls.filter((c) => c === "connect")).toHaveLength(1);
  });
});

describe("the app timer", () => {
  it("syncs soon after an account is saved, shows the next sync, and stops when the workspace closes", async () => {
    const { ctx, root, mail } = setup();
    installMailTimer(ctx, { firstMs: 20, soonMs: 20 });
    // The first tick finds no account and does nothing.
    await new Promise((r) => setTimeout(r, 60));
    expect(mail.fake.calls).not.toContain("connect");
    expect(syncInfo(ctx).next).not.toBe("");
    connectMail(ctx, root);
    // saveAccount calls this hook; connectMail writes the settings directly, so call it here.
    accountHooks.get(ctx)!();
    await vi.waitFor(() => expect(mail.fake.calls).toContain("connect"), { timeout: 3000, interval: 20 });
    ctx.setRoot(null);
    expect(syncInfo(ctx).next).toBe("");
  });
});

describe("background sync", () => {
  it("installs a per-user schedule only for a connected account, and removes it", async () => {
    const { ctx, root, scheduler } = setup();
    await expect(S["mail.background.set"](ctx, true, 60)).rejects.toThrow("Connect Gmail in Settings > Email first.");
    connectMail(ctx, root);
    const on = await S["mail.background.set"](ctx, true, 120);
    expect(on).toMatchObject({ supported: true, on: true, minutes: 120, installed: true });
    expect(scheduler.installed).toEqual({ program: "/fictional/app", args: ["--background-sync", "--workspace", root], minutes: 120 });
    expect(readRecord("integrations", layout(root).integrations).mail.background).toEqual({ on: true, minutes: 120 });
    const off = await S["mail.background.set"](ctx, false, 120);
    expect(off).toMatchObject({ on: false, installed: false });
    expect(scheduler.installed).toBeNull();
  });
  it("says when the system can't schedule it", async () => {
    const { ctx, root } = setup({ supported: false });
    connectMail(ctx, root);
    expect(await S["mail.background.status"](ctx)).toMatchObject({ supported: false, on: false });
    await expect(S["mail.background.set"](ctx, true, 60)).rejects.toThrow("Background sync isn't available on this system.");
  });
  it("runs headless: syncs, logs one line and exits 0", async () => {
    const { ctx, root, mail, host } = setup();
    connectMail(ctx, root);
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.background.on = true; });
    const r = await runBackgroundSync(host, root);
    expect(r.code).toBe(0);
    expect(r.line).toMatch(/sync stored=1 sorted=0 skipped=1/);
    expect(mail.logs.at(-1)).toBe(r.line);
  });
  it("does nothing when background sync is off, the folder isn't a workspace, or the password store is locked", async () => {
    const { ctx, root, mail, host } = setup();
    connectMail(ctx, root);
    expect(await runBackgroundSync(host, root)).toMatchObject({ code: 0, line: expect.stringMatching(/Background sync is off/) });
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.background.on = true; });
    expect(await runBackgroundSync(host, "/fictional/missing")).toMatchObject({ code: 1, line: expect.stringMatching(new RegExp(String.raw`isn't a ${brand.name} workspace`)) });
    const locked = fakeHost({ mail, secrets: memorySecrets(false) });
    expect(await runBackgroundSync(locked, root)).toMatchObject({ code: 0, line: expect.stringMatching(/password store is locked/) });
    expect(mail.fake.calls).not.toContain("connect");
  });
});

/** Holds the fake Gmail connection open until release() is called, so a sync stays "running". */
function holdConnect(mail: ReturnType<typeof fakeMailHost>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const orig = mail.fake.connect.bind(mail.fake);
  mail.fake.connect = async () => { await gate; return orig(); };
  return release;
}

describe("overlapping triggers", () => {
  it("Sync now during a running sync returns the current status and starts nothing", async () => {
    const { ctx, root, mail } = setup();
    connectMail(ctx, root);
    const release = holdConnect(mail);
    const first = runSync(ctx);
    const s = await S["mail.syncNow"](ctx);
    expect(s.syncing).toBe(true);
    release();
    expect(await first).toMatchObject({ stored: 1 });
    expect(mail.fake.calls.filter((c) => c === "connect")).toHaveLength(1);
    expect(mail.logs).toHaveLength(1);
  });
  it("the timer and the soon hook don't start a second sync while one is running", async () => {
    const { ctx, root, mail } = setup();
    connectMail(ctx, root);
    const release = holdConnect(mail);
    installMailTimer(ctx, { firstMs: 10, soonMs: 10 });
    const first = runSync(ctx);
    accountHooks.get(ctx)!();
    await new Promise((r) => setTimeout(r, 60));
    release();
    await first;
    await new Promise((r) => setTimeout(r, 20));
    expect(mail.fake.calls.filter((c) => c === "connect")).toHaveLength(1);
    expect(mail.logs).toHaveLength(1);
    ctx.setRoot(null);
  });
  it("a background run while another process holds the lock syncs nothing and exits 0", async () => {
    const { ctx, root, mail, host } = setup();
    connectMail(ctx, root);
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.background.on = true; });
    const unlock = acquireLock(mail.lockFile(readMeta(root).workspace_id));
    try {
      const r = await runBackgroundSync(host, root);
      expect(r).toMatchObject({ code: 0, line: expect.stringMatching(/error=A mail sync is already running\.$/) });
      expect(mail.fake.calls).not.toContain("connect");
    } finally { unlock(); }
  });
});

describe("the app timer across workspace switches", () => {
  it("stops the old workspace's timer when another opens, and leaves nothing behind on close", async () => {
    const { ctx, root, mail } = setup();
    connectMail(ctx, root);
    installMailTimer(ctx, { firstMs: 30, soonMs: 30 });
    accountHooks.get(ctx)!(); // a pending "sync soon" for the first workspace
    const other = sampleCopy();
    ctx.setRoot(other); // the sample copy has no account
    expect(syncInfo(ctx).next).not.toBe("");
    await new Promise((r) => setTimeout(r, 100));
    expect(mail.fake.calls).not.toContain("connect");
    ctx.setRoot(null);
    expect(syncInfo(ctx).next).toBe("");
    ctx.setRoot(root);
    await vi.waitFor(() => expect(mail.fake.calls).toContain("connect"), { timeout: 3000, interval: 20 });
    ctx.setRoot(null);
  });
});

describe("background sync settings and the headless run", () => {
  it("refuses an interval outside 15 minutes to 24 hours", async () => {
    const { ctx, root, scheduler } = setup();
    connectMail(ctx, root);
    for (const m of [0, 5, 14, 1441, 30.5, Number.NaN]) {
      await expect(S["mail.background.set"](ctx, true, m)).rejects.toThrow("Choose a background sync interval between 15 minutes and 24 hours.");
    }
    expect(scheduler.installed).toBeNull();
  });
  it("shows the last log lines in the status", async () => {
    const { ctx, root } = setup();
    connectMail(ctx, root);
    await S["mail.syncNow"](ctx);
    expect((await S["mail.background.status"](ctx)).log).toEqual([expect.stringMatching(/sync stored=1/)]);
  });
  it("says so when the password is missing, without naming the address or the folder", async () => {
    const { ctx, root, mail, host } = setup();
    connectMail(ctx, root);
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.background.on = true; });
    host.secrets.remove(gmailKey(root));
    const r = await runBackgroundSync(host, root);
    expect(r).toMatchObject({ code: 0, line: expect.stringMatching(/app password isn't saved/) });
    const missing = await runBackgroundSync(host, "/fictional/missing");
    for (const line of [r.line, missing.line, ...mail.logs]) {
      expect(line).not.toContain(ALEX);
      expect(line).not.toContain(root);
      expect(line).not.toContain("/fictional");
    }
    expect(mail.fake.calls).not.toContain("connect");
  });
  it("a revoked password in the headless run logs Gmail's plain error and still exits 0", async () => {
    const { ctx, root, mail, host } = setup();
    connectMail(ctx, root);
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.background.on = true; });
    host.secrets.set(gmailKey(root), "zzzzyyyyxxxxwwww");
    const r = await runBackgroundSync(host, root);
    expect(r.code).toBe(0);
    expect(r.line).toMatch(/error=Gmail didn't accept the address and app password\.$/);
    expect(mail.logs.join("\n")).not.toContain("zzzzyyyyxxxxwwww");
  });
});

describe("sync state per workspace (fix round 1)", () => {
  it("A is syncing, switch to B: B shows its own state and B's Sync now runs on B's own lock", async () => {
    const { ctx, root: a, mail } = setup();
    connectMail(ctx, a);
    const release = holdConnect(mail);
    const first = runSync(ctx);
    expect(mailStatus(ctx).syncing).toBe(true);

    const b = sampleCopy();
    openWorkspace(ctx, b);
    updateRecord("company", layout(b).companyFile(ACME[0]), (c) => { c.recruiter.email = TALENT; });
    connectMail(ctx, b);
    // B is idle even though A's run is still going.
    expect(mailStatus(ctx)).toMatchObject({ syncing: false, last_ok: "" });

    const bNow = S["mail.syncNow"](ctx);
    // B's request runs (it never waits on A's lock): it shows as syncing on B.
    expect(syncInfo(ctx, b).syncing).toBe(true);
    // A second Sync now on B while B's is running starts nothing more.
    expect(await runSync(ctx)).toBeNull();
    release();
    expect(await first).toMatchObject({ stored: 1, error: "" });
    const s = await bNow;
    expect(s).toMatchObject({ syncing: false, last_error: "", last_ok: "2026-01-15T09:00:00.000Z", counts: { stored: 1, skipped: 1 } });
    expect(R["mail.list"](ctx, { company_slug: ACME[0], id: ACME[1] }).rows).toHaveLength(1);
    expect(mail.fake.calls.filter((c) => c === "connect")).toHaveLength(2);
    expect(mail.logs).toHaveLength(2);
    expect(mail.logs.join("\n")).not.toMatch(/already running/);
    expect(syncInfo(ctx, a).syncing).toBe(false);
    ctx.setRoot(null);
  });
  it("keeps the timer's next sync per workspace", async () => {
    const { ctx, root: a } = setup();
    installMailTimer(ctx, { firstMs: 60_000 });
    expect(syncInfo(ctx, a).next).not.toBe("");
    const b = sampleCopy();
    ctx.setRoot(b);
    expect(syncInfo(ctx, a).next).toBe("");
    expect(syncInfo(ctx, b).next).not.toBe("");
    expect(mailStatus(ctx).next_sync).toBe(syncInfo(ctx, b).next);
    ctx.setRoot(null);
    expect(syncInfo(ctx, b).next).toBe("");
  });
  it("keeps the account address out of a thrown error's log line", async () => {
    const { ctx, root, mail } = setup();
    connectMail(ctx, root);
    mail.provider = () => { throw new Error(`Sign-in refused for ${ALEX}`); };
    await expect(S["mail.syncNow"](ctx)).rejects.toThrow();
    expect(mail.logs).toHaveLength(1);
    expect(mail.logs[0]).toMatch(/sync error=Sign-in refused for \[/);
    expect(mail.logs[0]).not.toContain(ALEX);
  });
});
