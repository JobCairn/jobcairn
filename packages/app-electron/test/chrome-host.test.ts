import net from "node:net";
import { describe, expect, it } from "vitest";
import { chromeCandidates, installQuitDetach, openRemotePage, openViaAppleScript, portOpen, REMOTE_PAGE, REMOTE_SCRIPT, type ExecFileFn } from "../src/chrome-host.js";

describe("chrome host", () => {
  it("looks for Chrome in the usual places", () => {
    expect(chromeCandidates("darwin", "/Users/alex", {})).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Users/alex/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
    expect(chromeCandidates("win32", "C:\\Users\\alex", { ProgramFiles: "C:\\Program Files" })).toEqual(["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]);
    expect(REMOTE_PAGE).toBe("chrome://inspect/#remote-debugging");
  });

  it("opens the remote-control page in Chrome on macOS with AppleScript: the address is an argument, never in the script", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const ok: ExecFileFn = (cmd, args, _o, cb) => { calls.push({ cmd, args }); cb(null); };
    expect(await openViaAppleScript(REMOTE_PAGE, ok)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("/usr/bin/osascript");
    expect(calls[0]!.args).toEqual([...REMOTE_SCRIPT.flatMap((l) => ["-e", l]), REMOTE_PAGE]);
    const script = REMOTE_SCRIPT.join("\n");
    expect(script).toMatch(/tell application "Google Chrome"/);
    expect(script).toMatch(/activate/);
    expect(script).toMatch(/make new window/);
    expect(script).toMatch(/make new tab/);
    expect(script).not.toContain("chrome://");
    // Denied (the Automation prompt), Chrome's own error or a timeout: false, so the caller falls back.
    expect(await openViaAppleScript(REMOTE_PAGE, (_c, _a, _o, cb) => cb(new Error("not allowed")))).toBe(false);
    expect(await openViaAppleScript(REMOTE_PAGE, () => { throw new Error("no osascript"); })).toBe(false);
  });

  it("falls back to Chrome's own binary when AppleScript fails, and uses only the binary off macOS", async () => {
    const log: string[] = [];
    const deps = (script: boolean) => ({
      script: async (url: string) => { log.push(`script ${url}`); return script; },
      spawn: async (bin: string, url: string) => { log.push(`spawn ${bin} ${url}`); return true; },
    });
    expect(await openRemotePage("/chrome", "darwin", deps(true))).toBe(true);
    expect(log).toEqual([`script ${REMOTE_PAGE}`]);
    log.length = 0;
    expect(await openRemotePage("/chrome", "darwin", deps(false))).toBe(true);
    expect(log).toEqual([`script ${REMOTE_PAGE}`, `spawn /chrome ${REMOTE_PAGE}`]);
    log.length = 0;
    expect(await openRemotePage("C:\\chrome.exe", "win32", deps(true))).toBe(true);
    expect(log).toEqual([`spawn C:\\chrome.exe ${REMOTE_PAGE}`]);
  });

  it("checks a local port with a plain connect", async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    expect(await portOpen(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await portOpen(port)).toBe(false);
  });

  it("before an update installs: detaches now, then lets the update's quit through without holding it", async () => {
    const handlers: ((e: { preventDefault(): void }) => void)[] = [];
    const log: string[] = [];
    const app = { on: (_e: "before-quit", cb: (e: { preventDefault(): void }) => void) => handlers.push(cb), quit: () => { log.push("quit"); } };
    const rt = { shutdown: async () => { log.push("shutdown"); }, shutdownSync: () => { log.push("sync"); } };
    const q = installQuitDetach(app, () => rt, { on: () => undefined });
    await q.beforeInstall();
    let prevented = false;
    handlers[0]!({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(false);
    expect(log).toEqual(["shutdown"]);
  });

  it("quitting waits for Chrome search to close its tabs and detach, then quits once (I6)", async () => {
    const handlers: ((e: { preventDefault(): void }) => void)[] = [];
    const exits: (() => void)[] = [];
    const log: string[] = [];
    let release!: () => void;
    const app = { on: (_e: "before-quit", cb: (e: { preventDefault(): void }) => void) => handlers.push(cb), quit: () => { log.push("quit"); handlers.forEach((h) => h({ preventDefault: () => log.push("prevented-again") })); } };
    const rt = { shutdown: () => { log.push("shutdown"); return new Promise<void>((r) => { release = r; }); }, shutdownSync: () => { log.push("sync"); } };
    installQuitDetach(app, () => rt, { on: (_e: "exit", cb: () => void) => exits.push(cb) });
    let prevented = false;
    handlers[0]!({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(log).toEqual(["shutdown"]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(["shutdown", "quit"]);
    exits[0]!();
    expect(log).toEqual(["shutdown", "quit", "sync"]);
  });

  it("quits even when the detach fails", async () => {
    const handlers: ((e: { preventDefault(): void }) => void)[] = [];
    let quit = 0;
    installQuitDetach({ on: (_e, cb) => handlers.push(cb), quit: () => { quit++; } }, () => ({ shutdown: () => Promise.reject(new Error("x")), shutdownSync: () => undefined }), { on: () => undefined });
    handlers[0]!({ preventDefault: () => undefined });
    await new Promise((r) => setTimeout(r, 0));
    expect(quit).toBe(1);
  });
});
