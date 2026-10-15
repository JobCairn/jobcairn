import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_EVERY_MS, createUpdates, FIRST_CHECK_MS, notesMarkdown, PROGRESS_EVERY_MS, updateErrorText, updatesSupported, type Updater } from "../src/updates.js";

type Fn = (...a: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/** electron-updater's autoUpdater, faked: `check` decides what a check does (emit events, resolve or reject). */
function fakeUpdater(check: (u: ReturnType<typeof fakeUpdater>) => Promise<unknown> = async () => null) {
  const on = new Map<string, Fn[]>();
  const u = {
    autoDownload: false, autoInstallOnAppQuit: false,
    on(ev: string, fn: Fn) { on.set(ev, [...(on.get(ev) ?? []), fn]); return u; },
    emit(ev: string, ...a: unknown[]) { for (const fn of on.get(ev) ?? []) fn(...a); },
    checkForUpdates: vi.fn(async () => check(u)),
    quitAndInstall: vi.fn(),
  };
  return u;
}
const NOW = new Date("2026-10-15T09:00:00.000Z");
const make = (u: Updater, o: { supported?: boolean; auto?: boolean; beforeInstall?: () => Promise<void> } = {}) => {
  const load = vi.fn(async () => u);
  const log = vi.fn();
  const up = createUpdates({ supported: o.supported ?? true, auto: o.auto ?? true, load, now: () => NOW, log, beforeInstall: o.beforeInstall });
  const changes = vi.fn();
  up.onChange(changes);
  return { up, load, log, changes };
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("updatesSupported", () => {
  it("only the packaged mac app, and never in an end-to-end run", () => {
    expect(updatesSupported({ packaged: true, platform: "darwin", env: {} })).toBe(true);
    expect(updatesSupported({ packaged: false, platform: "darwin", env: {} })).toBe(false);
    expect(updatesSupported({ packaged: true, platform: "win32", env: {} })).toBe(false);
    expect(updatesSupported({ packaged: true, platform: "darwin", env: { CAREEROS_E2E_HOME: "/tmp/x" } })).toBe(false);
  });
});

describe("the update status", () => {
  it("checks, downloads with progress, and waits for Restart to update", async () => {
    const u = fakeUpdater(async (x) => {
      x.emit("checking-for-update");
      x.emit("update-available", { version: "0.2.0" });
      return { updateInfo: { version: "0.2.0" } };
    });
    const { up, changes } = make(u);
    expect(up.status()).toEqual({ kind: "idle" });
    await up.check();
    expect(u.autoDownload).toBe(true);
    expect(u.autoInstallOnAppQuit).toBe(true);
    expect(up.status()).toEqual({ kind: "available", version: "0.2.0" });

    u.emit("download-progress", { percent: 12.7 });
    expect(up.status()).toEqual({ kind: "downloading", version: "0.2.0", percent: 12 });
    // Progress pushes at most every PROGRESS_EVERY_MS; the status itself is always current.
    const before = changes.mock.calls.length;
    u.emit("download-progress", { percent: 40 });
    u.emit("download-progress", { percent: 55 });
    expect(up.status()).toMatchObject({ percent: 55 });
    expect(changes.mock.calls.length).toBe(before);
    vi.advanceTimersByTime(PROGRESS_EVERY_MS);
    expect(changes.mock.calls.length).toBe(before + 1);

    u.emit("update-downloaded", { version: "0.2.0", releaseNotes: "<h2>New</h2><ul><li>Faster &amp; calmer</li></ul>" });
    expect(up.status()).toEqual({ kind: "ready", version: "0.2.0", notes: "### New\n\n- Faster & calmer" });

    up.install();
    await vi.waitFor(() => expect(u.quitAndInstall).toHaveBeenCalledWith(false, true));
  });

  it("lets go of Chrome before quit-and-install, so the app's quit handling can't hold up the relaunch", async () => {
    const order: string[] = [];
    const u = fakeUpdater(async (x) => { x.emit("update-downloaded", { version: "0.2.0" }); return null; });
    u.quitAndInstall.mockImplementation(() => { order.push("install"); });
    const { up } = make(u, { beforeInstall: async () => { order.push("detach"); } });
    await up.check();
    up.install();
    await vi.waitFor(() => expect(order).toEqual(["detach", "install"]));
  });

  it("says when this is the newest version", async () => {
    const u = fakeUpdater(async (x) => { x.emit("checking-for-update"); x.emit("update-not-available", { version: "0.1.1" }); return null; });
    const { up } = make(u);
    await up.check();
    expect(up.status()).toEqual({ kind: "none", checked_at: NOW.toISOString() });
  });

  it("turns a failed check into plain words and logs the real reason", async () => {
    const u = fakeUpdater(async (x) => { const e = new Error("net::ERR_INTERNET_DISCONNECTED"); x.emit("error", e); throw e; });
    const { up, log } = make(u);
    await up.check();
    expect(up.status()).toEqual({ kind: "error", message: "Couldn't reach GitHub to check for updates. Check your internet connection and try again." });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ERR_INTERNET_DISCONNECTED"));
  });

  it("a failed background download shows as an error, with no stray rejection", async () => {
    const u = fakeUpdater(async (x) => {
      x.emit("update-available", { version: "0.2.0" });
      const downloadPromise = Promise.reject(new Error("socket hang up ECONNRESET"));
      queueMicrotask(() => x.emit("error", new Error("socket hang up ECONNRESET")));
      return { updateInfo: { version: "0.2.0" }, downloadPromise };
    });
    const { up } = make(u);
    await up.check();
    await vi.waitFor(() => expect(up.status()).toMatchObject({ kind: "error", message: expect.stringMatching(/internet connection/) }));
  });

  it("keeps a downloaded update ready through later checks and errors, and doesn't check again", async () => {
    const u = fakeUpdater();
    const { up } = make(u);
    await up.check();
    u.emit("update-downloaded", { version: "0.2.0", releaseNotes: null });
    u.emit("error", new Error("boom"));
    u.emit("checking-for-update");
    u.emit("update-not-available", {});
    expect(up.status()).toEqual({ kind: "ready", version: "0.2.0", notes: "" });
    await up.check();
    expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("runs one check at a time, and installs nothing before an update is ready", async () => {
    let finish!: () => void;
    const u = fakeUpdater(() => new Promise<null>((r) => { finish = () => r(null); }));
    const { up } = make(u);
    const a = up.check();
    const b = up.check();
    expect(a).toBe(b);
    expect(up.status()).toEqual({ kind: "checking" });
    up.install();
    await vi.waitFor(() => expect(u.checkForUpdates).toHaveBeenCalledTimes(1));
    finish();
    await a;
    expect(up.status()).toEqual({ kind: "none", checked_at: NOW.toISOString() });
    expect(u.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("automatic checks", () => {
  it("checks 10 seconds after launch, then every 6 hours, and stops when turned off", async () => {
    const u = fakeUpdater();
    const { up } = make(u);
    up.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(u.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(u.checkForUpdates).toHaveBeenCalledTimes(2);
    up.setAuto(false);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(u.checkForUpdates).toHaveBeenCalledTimes(2);
    up.stop();
  });

  it("with automatic checks off, only Check for updates checks", async () => {
    const u = fakeUpdater();
    const { up, load } = make(u, { auto: false });
    up.start();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(load).not.toHaveBeenCalled();
    await up.check();
    expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
    up.stop();
  });

  it("checks right away when turned back on after a skipped launch check", async () => {
    const u = fakeUpdater();
    const { up } = make(u, { auto: false });
    up.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    up.setAuto(true);
    await vi.waitFor(() => expect(u.checkForUpdates).toHaveBeenCalledTimes(1));
    up.stop();
  });

  it("never loads the updater in development or test runs", async () => {
    const u = fakeUpdater();
    const { up, load } = make(u, { supported: false });
    up.start();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    await up.check();
    expect(load).not.toHaveBeenCalled();
    expect(up.supported).toBe(false);
    expect(up.status()).toEqual({ kind: "idle" });
  });
});

describe("notesMarkdown", () => {
  it("turns GitHub's HTML into Markdown and keeps no markup", () => {
    expect(notesMarkdown("<p>Hello <b>there</b></p><p>Line<br>two</p><script>x</script>")).toBe("Hello there\n\nLine\ntwo");
    expect(notesMarkdown("<p>a &lt;tag&gt; &#39;q&#39; &#x2014;</p>")).toBe("a <tag> 'q' —");
  });
  it("joins a list of versions' notes, and is empty for none", () => {
    expect(notesMarkdown([{ version: "0.2.0", note: "<p>B</p>" }, { version: "0.1.2", note: null }])).toBe("### 0.2.0\n\nB\n\n### 0.1.2");
    expect(notesMarkdown(null)).toBe("");
    expect(notesMarkdown(undefined)).toBe("");
  });
  it("cuts very long notes", () => {
    const s = notesMarkdown("x".repeat(5000));
    expect(s.length).toBe(4001);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("updateErrorText", () => {
  it("names offline, a release without the update feed, and a failed install; anything else is generic", () => {
    expect(updateErrorText(new Error("getaddrinfo ENOTFOUND github.com"))).toMatch(/internet connection/);
    expect(updateErrorText(new Error("Cannot find latest-mac.yml in the latest release artifacts (https://github.com/x): HttpError: 404"))).toMatch(/isn't ready for automatic updates/);
    expect(updateErrorText(new Error("Code signature at URL file:///x did not pass validation"))).toMatch(/couldn't be installed/);
    expect(updateErrorText("weird")).toBe("Couldn't check for updates. Try again later, or download the newest version from GitHub.");
  });
});
