import { describe, expect, it } from "vitest";
import { ArgError } from "@careeros/contract";
import { layout, readActivity, readMeta, readRecord, updateRecord } from "@careeros/core";
import { cloudFolderName, mailAccountHandlers as M, normalizePassword, setGmailPassword } from "../src/mail-account.js";
import { secretHandlers as S } from "../src/secrets.js";
import { fakeMailHost, fakeScheduler } from "../src/fakes.js";
import { minutes, openSample } from "./helpers.js";
import { ServiceContext } from "../src/context.js";
import { openWorkspace } from "../src/workspace.js";
import { gmailKey } from "./mail-helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const ADDRESS = "alex" + "@" + "example.com";
const GOOD = "abcd efgh ijkl mnop";
const GOOD_SAVED = "abcdefghijklmnop";
const WRONG = "zzzz yyyy xxxx wwww";
const setup = (o: { secretsAvailable?: boolean } = {}) => {
  const mail = fakeMailHost({ goodPassword: GOOD_SAVED });
  const scheduler = fakeScheduler();
  return { ...openSample({ mail, scheduler, ...o }), mail, scheduler };
};
const mailSettings = (root: string) => readRecord("integrations", layout(root).integrations).mail;

describe("mail status", () => {
  it("starts disconnected with the default settings", () => {
    const { ctx } = setup();
    expect(M["mail.status"](ctx)).toMatchObject({
      available: true, connected: false, address: "", password_set: false, secure_storage: true, syncing: false, last_sync: "", last_error: "",
      sync_minutes: 15, first_sync_days: 30, send_limit_per_hour: 10, cloud_folder: "", raw_bytes: 0, triage_count: 0,
    });
  });
  it("says when this app has no mail support", async () => {
    const { ctx } = openSample();
    expect(M["mail.status"](ctx).available).toBe(false);
    await expect(M["mail.testConnection"](ctx, ADDRESS, "Alex Example", GOOD)).rejects.toThrow("Email isn't available in this version of the app.");
  });
});

describe("connecting", () => {
  it("saves nothing after a failed test", async () => {
    const { ctx, host, root } = setup();
    const r = await M["mail.testConnection"](ctx, ADDRESS, "Alex Example", WRONG);
    expect(r.ok).toBe(false);
    expect(r.checks.map((c) => [c.label, c.ok])).toEqual([["Sign in to Gmail", false], ["Find the Sent folder", false], ["Sign in to send", false]]);
    expect(r.checks[0]!.fix).toMatch(/16 letters/);
    expect(() => M["mail.saveAccount"](ctx, ADDRESS, "Alex Example")).toThrow(`Test the connection first. ${brand.name} saves the account only after a passing test.`);
    expect(host.secrets.has(gmailKey(root))).toBe(false);
    expect(mailSettings(root).address).toBe("");
  });
  it("refuses anything that isn't a 16-letter app password before connecting", async () => {
    const { ctx, mail } = setup();
    await expect(M["mail.testConnection"](ctx, ADDRESS, "Alex Example", "my normal password")).rejects.toThrow(/16 letters/);
    await expect(M["mail.testConnection"](ctx, "not-an-address", "Alex Example", GOOD)).rejects.toThrow(/isn't an email address/);
    await expect(M["mail.testConnection"](ctx, ADDRESS, "Alex\nBcc", GOOD)).rejects.toThrow(/one line/);
    expect(mail.accounts).toEqual([]);
  });
  it("saves the tested password and address after a passing test, and never shows it back", async () => {
    const { ctx, host, root, mail } = setup();
    const r = await M["mail.testConnection"](ctx, ADDRESS, "Alex Example", GOOD);
    expect(r.ok).toBe(true);
    expect(mail.accounts.at(-1)).toEqual({ address: ADDRESS, password: GOOD_SAVED, displayName: "Alex Example" });
    const s = M["mail.saveAccount"](ctx, ADDRESS, "Alex Example");
    expect(s).toMatchObject({ connected: true, address: ADDRESS, display_name: "Alex Example", password_set: true });
    expect(JSON.stringify(s)).not.toContain(GOOD_SAVED);
    expect(JSON.stringify(r)).not.toContain(GOOD_SAVED);
    expect(host.secrets.values.get(gmailKey(root))).toBe(GOOD_SAVED);
    expect(mailSettings(root)).toMatchObject({ provider: "gmail", address: ADDRESS, display_name: "Alex Example" });
    expect(readActivity(root)[0]).toMatchObject({ event: "Email connected" });
    expect(() => M["mail.saveAccount"](ctx, ADDRESS, "Alex Example")).toThrow(/Test the connection first/);
  });
  it("forgets a passing test after 10 minutes, or for a different address", async () => {
    const { ctx, setNow } = setup();
    await M["mail.testConnection"](ctx, ADDRESS, "Alex Example", GOOD);
    expect(() => M["mail.saveAccount"](ctx, "other" + "@" + "example.com", "Alex Example")).toThrow(/Test the connection first/);
    setNow(minutes(11));
    expect(() => M["mail.saveAccount"](ctx, ADDRESS, "Alex Example")).toThrow(/Test the connection first/);
  });
  it("refuses to save without secure storage", async () => {
    const { ctx, root } = setup({ secretsAvailable: false });
    await M["mail.testConnection"](ctx, ADDRESS, "Alex Example", GOOD);
    expect(() => M["mail.saveAccount"](ctx, ADDRESS, "Alex Example")).toThrow(/Secure storage isn't available/);
    expect(mailSettings(root).address).toBe("");
  });
});

describe("replacing the password, signature, disconnecting", () => {
  async function connected() {
    const x = setup();
    await M["mail.testConnection"](x.ctx, ADDRESS, "Alex Example", GOOD);
    M["mail.saveAccount"](x.ctx, ADDRESS, "Alex Example");
    return x;
  }
  it("tests a replacement password and keeps the old one when it fails", async () => {
    const { ctx, host, root } = await connected();
    await expect(setGmailPassword(ctx, WRONG)).rejects.toThrow("The new password didn't work: Gmail didn't accept the address and app password.");
    expect(host.secrets.values.get(gmailKey(root))).toBe(GOOD_SAVED);
    await expect(S["secrets.set"](ctx, "gmail_app_password", GOOD)).resolves.toEqual({ name: "gmail_app_password", available: true, set: true });
  });
  it("needs an account before a Gmail password can be stored", async () => {
    const { ctx } = setup();
    await expect(S["secrets.set"](ctx, "gmail_app_password", GOOD)).rejects.toThrow("Connect Gmail in Settings > Email first.");
  });
  it("saves a multi-line signature", async () => {
    const { ctx, root } = await connected();
    expect(M["mail.setSignature"](ctx, "Alex Example\r\nAI Engineer\r\n\r\n").signature).toBe("Alex Example\nAI Engineer");
    expect(mailSettings(root).signature).toBe("Alex Example\nAI Engineer");
  });
  it("disconnects: removes the password and address and turns background sync off", async () => {
    const { ctx, host, root, scheduler } = await connected();
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.background.on = true; });
    await scheduler(readMeta(root).workspace_id).install({ program: "x", args: [], minutes: 60 });
    const s = await M["mail.disconnect"](ctx);
    expect(s).toMatchObject({ connected: false, address: "", display_name: "Alex Example" });
    expect(host.secrets.has(gmailKey(root))).toBe(false);
    expect(mailSettings(root).background.on).toBe(false);
    expect(scheduler.installed).toBeNull();
  });
});

describe("disconnect safety (fix round 1)", () => {
  async function connectedOn() {
    const mail = fakeMailHost({ goodPassword: GOOD_SAVED });
    const scheduler = fakeScheduler();
    const x = { ...openSample({ mail, scheduler }), mail, scheduler };
    await M["mail.testConnection"](x.ctx, ADDRESS, "Alex Example", GOOD);
    M["mail.saveAccount"](x.ctx, ADDRESS, "Alex Example");
    updateRecord("integrations", layout(x.root).integrations, (i) => { i.mail.background.on = true; });
    await scheduler(readMeta(x.root).workspace_id).install({ program: "x", args: [], minutes: 60 });
    return x;
  }
  it("stops background sync first; if that fails, nothing else changes", async () => {
    const { ctx, host, root, scheduler } = await connectedOn();
    scheduler.failRemove = "launchctl failed (fake)";
    const before = mailSettings(root);
    await expect(M["mail.disconnect"](ctx)).rejects.toThrow("launchctl failed (fake)");
    expect(host.secrets.values.get(gmailKey(root))).toBe(GOOD_SAVED);
    expect(mailSettings(root)).toEqual(before);
    expect(readActivity(root)[0]).not.toMatchObject({ event: "Email disconnected" });
  });
  it("is idempotent", async () => {
    const { ctx, host, root, scheduler } = await connectedOn();
    const first = await M["mail.disconnect"](ctx);
    const second = await M["mail.disconnect"](ctx);
    expect(second).toEqual(first);
    expect(host.secrets.has(gmailKey(root))).toBe(false);
    expect(scheduler.installed).toBeNull();
    expect(readActivity(root).filter((e) => e.event === "Email disconnected")).toHaveLength(1);
  });
  it("removes this workspace's OS schedule even when the record says background sync is off", async () => {
    const { ctx, root, scheduler } = await connectedOn();
    // The job was installed but the record didn't say so (a failed write, or someone edited integrations.json).
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.background.on = false; });
    expect(scheduler.installed).not.toBeNull();
    await M["mail.disconnect"](ctx);
    expect(scheduler.installed).toBeNull();
  });
  it("clears a tested, not yet saved password in every window at once", async () => {
    const { ctx, host, root } = await connectedOn();
    const other = new ServiceContext(host);
    openWorkspace(other, root);
    await M["mail.testConnection"](other, ADDRESS, "Alex Example", GOOD);
    await M["mail.disconnect"](ctx);
    expect(() => M["mail.saveAccount"](other, ADDRESS, "Alex Example")).toThrow(/Test the connection first/);
    expect(host.secrets.has(gmailKey(root))).toBe(false);
  });
  it("blocks removing the Gmail password through the generic secrets call", async () => {
    const { ctx, host, root } = await connectedOn();
    let err: unknown;
    try { S["secrets.remove"](ctx, "gmail_app_password"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ArgError);
    expect((err as Error).message).toBe("Use Disconnect in Settings > Email to remove the Gmail app password.");
    expect(host.secrets.values.get(gmailKey(root))).toBe(GOOD_SAVED);
  });
});

describe("app password format", () => {
  it("takes four groups of four letters, with or without spaces, and nothing else", () => {
    expect(normalizePassword(" ABCD efgh ijkl mnop ")).toBe(GOOD_SAVED);
    expect(normalizePassword(GOOD_SAVED)).toBe(GOOD_SAVED);
    expect(normalizePassword("abcd\u00a0efgh\u00a0ijkl\u00a0mnop")).toBe(GOOD_SAVED);
    for (const bad of ["my normal password", "abcd efgh ijkl mno", "abcd  efgh ijkl mnop", "abcd efgh ijkl mnop1", "abcd-efgh-ijkl-mnop"]) {
      expect(() => normalizePassword(bad), bad).toThrow(/16 letters/);
    }
  });
});

describe("cloud folders", () => {
  it("names the sync service a workspace lives in", () => {
    expect(cloudFolderName("/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/CareerOS")).toBe("iCloud Drive");
    expect(cloudFolderName("/Users/alex/Library/CloudStorage/GoogleDrive-alex/My Drive/CareerOS")).toBe("Google Drive");
    expect(cloudFolderName("C:\\Users\\Alex\\OneDrive - Acme Corp\\CareerOS")).toBe("OneDrive");
    expect(cloudFolderName("/Users/alex/Dropbox/CareerOS")).toBe("Dropbox");
    expect(cloudFolderName("/Users/alex/CareerOS")).toBe("");
  });
});
