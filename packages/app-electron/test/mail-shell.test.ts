import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GmailProvider } from "@careeros/mail";
import { describe, expect, it, vi } from "vitest";
import { backgroundCommandFor, backgroundHandoff, isBackgroundHandoff, parseBackgroundArgs, relaunchArgs } from "../src/background.js";
import { electronMailHost, fileLog } from "../src/mail-host.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "careeros-mailshell-"));
const WS = path.resolve("/fictional/alex-example/CareerOS");
const OTHER = path.resolve("/fictional/sam-sample/CareerOS");
const A = "0b6f2c9e-1d2a-4c3b-8e7f-123456789abc";
const B = "1c7a3d0f-2e3b-4d4c-9f80-23456789abcd";

describe("background arguments", () => {
  it("finds the background flag and an absolute workspace", () => {
    expect(parseBackgroundArgs(["/x/CareerOS", "--background-sync", "--workspace", WS])).toEqual({ workspace: WS });
    expect(parseBackgroundArgs(["/x/CareerOS", "--background-sync", "--workspace", "relative/ws"])).toEqual({ workspace: "" });
    expect(parseBackgroundArgs(["/x/CareerOS", "--background-sync"])).toEqual({ workspace: "" });
    expect(parseBackgroundArgs(["/x/CareerOS", "--workspace", WS])).toBeNull();
  });
  it("runs the app itself, adding the app path only when running from the repo", () => {
    expect(backgroundCommandFor({ packaged: true, execPath: "/Applications/CareerOS.app/Contents/MacOS/CareerOS", appPath: "/ignored", workspace: WS }))
      .toEqual({ program: "/Applications/CareerOS.app/Contents/MacOS/CareerOS", args: ["--background-sync", "--workspace", WS] });
    expect(backgroundCommandFor({ packaged: false, execPath: "/repo/node_modules/electron/dist/electron", appPath: "/repo/packages/app-electron", workspace: WS }))
      .toEqual({ program: "/repo/node_modules/electron/dist/electron", args: ["/repo/packages/app-electron", "--background-sync", "--workspace", WS] });
  });
});

describe("a background run handed to the running app", () => {
  it("syncs soon when it is for the open workspace, runs headless for another, and ignores anything else", () => {
    expect(backgroundHandoff({ syncMail: true, workspace: WS }, WS)).toEqual({ kind: "soon" });
    // Each workspace has its own schedule: B's run while A is open still syncs B, never A.
    expect(backgroundHandoff({ syncMail: true, workspace: OTHER }, WS)).toEqual({ kind: "headless", workspace: OTHER });
    expect(backgroundHandoff({ syncMail: true, workspace: OTHER }, null)).toEqual({ kind: "headless", workspace: OTHER });
    for (const bad of [undefined, null, {}, { syncMail: true }, { syncMail: true, workspace: "relative/ws" }, { syncMail: true, workspace: `${WS}\u0000x` }, { syncMail: "yes", workspace: WS }, { workspace: WS }]) {
      expect(backgroundHandoff(bad, WS), JSON.stringify(bad)).toEqual({ kind: "ignore" });
    }
  });
});

describe("a person opening the app while a background run holds the lock", () => {
  it("tells a person apart from another background run", () => {
    expect(isBackgroundHandoff({ syncMail: true, workspace: WS })).toBe(true);
    for (const d of [undefined, null, {}, { syncMail: "yes" }, "x"]) expect(isBackgroundHandoff(d), JSON.stringify(d)).toBe(false);
  });
  it("relaunches as the normal app: the same app path, without the background flags", () => {
    expect(relaunchArgs(["--background-sync", "--workspace", WS])).toEqual([]);
    expect(relaunchArgs(["/repo/packages/app-electron", "--background-sync", "--workspace", WS])).toEqual(["/repo/packages/app-electron"]);
    expect(relaunchArgs(["/repo/packages/app-electron", "--workspace", WS, "--background-sync", "--inspect"])).toEqual(["/repo/packages/app-electron", "--inspect"]);
  });
});

describe("mail log", () => {
  it("redacts addresses, stays one line per entry, is private, and keeps its size bounded", () => {
    const file = path.join(tmp(), "logs", "mail-sync.log");
    const l = fileLog(file);
    l.log(`sync failed for ${"alex" + "@" + "example.com"}\nsecond line`);
    expect(l.read()).toEqual(["sync failed for [address] second line"]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    for (let i = 0; i < 3000; i++) l.log(`2026-01-15T09:00:00.000Z sync stored=${i} sorted=0 skipped=0 duplicates=0 too_large=0 capped=no`);
    expect(fs.statSync(file).size).toBeLessThan(300 * 1024);
    expect(l.read()).toHaveLength(50);
    expect(l.read().at(-1)).toContain("stored=2999");
  });
});

describe("electron mail host", () => {
  it("uses Gmail with the allowed hosts, a lock file per workspace in user data, and the image fetcher", async () => {
    const userData = tmp();
    const fetcher = vi.fn(async (_url: string, _init: unknown) => new Response(Buffer.from("GIF89a"), { status: 200, headers: { "content-type": "image/gif" } }));
    const h = electronMailHost({ userData, fetcher, allowedHosts: ["imap.gmail.com", "smtp.gmail.com"], background: (ws) => ({ program: "/x", args: [ws] }) });
    expect(h.provider({ address: "alex" + "@" + "example.com", password: "abcdefghijklmnop", displayName: "Alex Example" })).toBeInstanceOf(GmailProvider);
    expect(h.lockFile(A)).toBe(path.join(userData, `mail-sync-${A}.lock`));
    expect(h.lockFile(B)).not.toBe(h.lockFile(A));
    expect(h.backgroundCommand(WS)).toEqual({ program: "/x", args: [WS] });
    expect(await h.fetchImage("https://images.example.com/p.gif")).toMatchObject({ type: "image/gif" });
    const init = fetcher.mock.calls[0]![1] as unknown as { credentials: string; referrerPolicy: string; redirect: string };
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "manual" });
    await expect(h.fetchImage("http://images.example.com/p.gif")).rejects.toThrow("Images load over https only.");
  });
  it("keeps a separate log per workspace, and refuses anything but a workspace id in a file name", () => {
    const userData = tmp();
    const h = electronMailHost({ userData, fetcher: vi.fn(), allowedHosts: [], background: () => ({ program: "/x", args: [] }) });
    h.log("2026-01-15T09:00:00.000Z sync stored=1", A);
    h.log("2026-01-15T09:00:00.000Z sync stored=2", B);
    h.log("2026-01-15T09:00:00.000Z The background sync folder isn't a workspace.");
    expect(h.readLog(A)).toEqual(["2026-01-15T09:00:00.000Z sync stored=1"]);
    expect(h.readLog(B)).toEqual(["2026-01-15T09:00:00.000Z sync stored=2"]);
    expect(h.readLog()).toEqual(["2026-01-15T09:00:00.000Z The background sync folder isn't a workspace."]);
    expect(fs.readdirSync(path.join(userData, "logs")).sort()).toEqual(["mail-sync.log", `mail-sync-${A}.log`, `mail-sync-${B}.log`].sort());
    for (const bad of ["../x", "", "ABC", `${A}/..`]) {
      expect(() => h.lockFile(bad), bad).toThrow();
      expect(() => h.log("x", bad || "nope"), bad).toThrow();
    }
  });
});

describe("the scheduler in end-to-end runs", () => {
  it("keeps jobs in memory and never runs an OS command", async () => {
    const { e2eScheduler } = await import("../src/e2e.js");
    const s = e2eScheduler();
    expect(s.supported).toBe(true);
    expect(await s.status()).toEqual({ installed: false, detail: "Test run: nothing is installed on this computer." });
    await s.install({ program: "/fictional/app", args: ["--background-sync"], minutes: 15 });
    expect((await s.status()).installed).toBe(true);
    await s.remove();
    expect((await s.status()).installed).toBe(false);
  });
});

describe("remote images for Load images", () => {
  it("go through the guarded node fetcher: a public name that resolves to a private address is refused", async () => {
    const { remoteImageFetcher } = await import("../src/mail-host.js");
    const request = vi.fn();
    const f = remoteImageFetcher({ resolve: async () => [{ address: "10.0.0.7", family: 4 }], request });
    await expect(f("https://images.example.com/p.gif", { redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: {}, signal: new AbortController().signal })).rejects.toThrow();
    // The guard runs in the socket's lookup; with a fake request nothing connects, so check the lookup directly.
    const options = request.mock.calls[0]?.[1] as { lookup: (h: string, o: object, cb: (e: Error | null) => void) => void; agent: unknown } | undefined;
    expect(options).toBeDefined();
    expect(options!.agent).toBe(false);
    const err = await new Promise<Error | null>((r) => options!.lookup("images.example.com", {}, (e) => r(e)));
    expect(err).toBeInstanceOf(Error);
  });
});
