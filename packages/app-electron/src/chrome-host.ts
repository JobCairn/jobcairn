import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { localStatePath, nodeProcessRunner, spawnLaunch, type ChromeHost } from "@careeros/services";

/**
 * Main-process access for "Search in my Chrome" (lane S). The renderer never sees these paths. Nothing here
 * changes Chrome's settings: the person switches Chrome's remote control on themselves, on the page we open.
 */
export const REMOTE_PAGE = "chrome://inspect/#remote-debugging";

/** Where Google Chrome usually lives. */
export function chromeCandidates(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    const app = "Google Chrome.app/Contents/MacOS/Google Chrome";
    return [`/Applications/${app}`, path.join(home, "Applications", app)];
  }
  if (platform === "win32") {
    return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((x): x is string => !!x)
      .map((r) => path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
}

/** Is anything listening on 127.0.0.1:<port>? Only a TCP connect; nothing is sent. */
export function portOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/**
 * macOS: brings Chrome forward and opens the address in a new tab (a new window when none is open). A running Chrome
 * drops an address handed to its binary, so AppleScript asks Chrome itself. The address arrives as an argument,
 * never pasted into the script.
 */
export const REMOTE_SCRIPT = [
  "on run argv",
  'tell application "Google Chrome"',
  "activate",
  "if (count of windows) is 0 then",
  "make new window",
  "set URL of active tab of front window to item 1 of argv",
  "else",
  "tell front window to make new tab with properties {URL:item 1 of argv}",
  "end if",
  "end tell",
  "end run",
] as const;

/** Long enough for the person to answer macOS's one-time "control Google Chrome" prompt. */
const SCRIPT_TIMEOUT_MS = 60_000;

export type ExecFileFn = (cmd: string, args: string[], opts: { timeout: number; windowsHide: boolean }, cb: (err: Error | null) => void) => unknown;

/** Runs REMOTE_SCRIPT with osascript, no shell. False when it fails or the person says no to macOS's prompt. */
export function openViaAppleScript(url: string, run: ExecFileFn = execFile): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      run("/usr/bin/osascript", [...REMOTE_SCRIPT.flatMap((l) => ["-e", l]), url], { timeout: SCRIPT_TIMEOUT_MS, windowsHide: true }, (err) => resolve(!err));
    } catch { resolve(false); }
  });
}

/** Opens Chrome's remote-control page: AppleScript on macOS, then Chrome's own binary when that fails (or elsewhere). */
export async function openRemotePage(bin: string, platform: NodeJS.Platform, d = { script: openViaAppleScript, spawn: openInChrome }): Promise<boolean> {
  if (platform === "darwin" && (await d.script(REMOTE_PAGE))) return true;
  return d.spawn(bin, REMOTE_PAGE);
}

/** Opens an address with Chrome's own binary, no shell. Starts Chrome on the page; a running Chrome may only come forward. */
export function openInChrome(bin: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, [url], { detached: true, stdio: "ignore", shell: false, windowsHide: false });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

export function electronChromeHost(o: { dataDir: string; confirm(message: string, detail: string, ok?: string): Promise<boolean>; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): ChromeHost {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = os.homedir();
  const chrome = () => chromeCandidates(platform, home, env).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
  return {
    runner: nodeProcessRunner(), platform, env, home, dataDir: o.dataDir,
    chromeInstalled: () => chrome() !== null,
    openRemotePage: async () => { const bin = chrome(); return bin ? openRemotePage(bin, platform) : false; },
    portOpen: (port) => portOpen(port),
    confirm: o.confirm,
    // Chrome's profile list (only profile names are read from it) and its own command line, to open the app's tabs
    // in the profile the person job-searches in.
    localStateFile: localStatePath(platform, home, env),
    launch: spawnLaunch,
    chromeBin: chrome,
    runSync: (cmd, args, r) => { spawnSync(cmd, args, { cwd: r.cwd, env: r.env, timeout: r.timeoutMs, stdio: "ignore", shell: false, windowsHide: true }); },
  };
}

interface QuitApp {
  on(event: "before-quit", cb: (e: { preventDefault(): void }) => void): unknown;
  quit(): void;
}
interface QuitRuntime { shutdown(): Promise<void>; shutdownSync(): void }

/**
 * Quitting waits (briefly; the runtime caps it) for Search in my Chrome to close its tabs and let go of the person's
 * Chrome, then quits for real. If the process exits any other way, a last synchronous detach runs.
 */
export interface QuitDetach {
  /** Lets go of Chrome now and lets the next quit through untouched (an update's quit-and-install relaunches the app). */
  beforeInstall(): Promise<void>;
}

export function installQuitDetach(app: QuitApp, runtime: () => QuitRuntime | null, proc: { on(event: "exit", cb: () => void): unknown } = process): QuitDetach {
  let quitting = false;
  app.on("before-quit", (e) => {
    const rt = runtime();
    if (quitting || !rt) return;
    quitting = true;
    e.preventDefault();
    void rt.shutdown().catch(() => undefined).finally(() => app.quit());
  });
  proc.on("exit", () => { try { runtime()?.shutdownSync(); } catch { /* exiting anyway */ } });
  return {
    beforeInstall: async () => {
      quitting = true;
      try { await runtime()?.shutdown(); } catch { /* quitting anyway */ }
    },
  };
}
