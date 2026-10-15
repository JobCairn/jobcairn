import fs from "node:fs";
import path from "node:path";
import { cleanEnv, type ProcessRunner } from "../claude/process.js";

/**
 * The browser helper (agent-browser) as the app runs it: one named session ("careeros") that holds the one
 * connection to the person's Chrome, our own empty config file (so no user config or plugin is loaded), a
 * folder we own as the working folder, array arguments, no shell, a clean environment and a timeout.
 */
export const SESSION = "careeros";
/** Chrome's own remote control (chrome://inspect > "Allow remote debugging for this browser instance"). */
export const REMOTE_PORT = 9222;
export const REMOTE_ENDPOINT = `ws://127.0.0.1:${REMOTE_PORT}/devtools/browser`;
/** The version the commands here were read against (`agent-browser --help` and `skills get core`). */
export const HELPER_VERSION = "0.38.2";
export const HELPER_MIN_VERSION = "0.38.0";
/**
 * Disk space the pinned helper takes once installed, in MB: the registry's `dist.unpackedSize` for
 * agent-browser@0.38.2 is 117,855,861 bytes (no dependencies; it ships prebuilt binaries for each platform).
 * Re-measure with `npm view agent-browser@<version> dist.unpackedSize` when the pin moves.
 */
export const HELPER_SIZE_MB = 118;
export const COMMAND_TIMEOUT_MS = 45_000;
/**
 * The helper's own idle limit, passed on every command: with no command for this long its background process
 * (daemon) exits by itself, even if the app was force-quit. agent-browser never times out a session attached to the
 * person's Chrome unless told to ("user-attached browsers are exempt from the default"). Exiting only lets go of
 * Chrome: Chrome and its tabs stay open. The app's own idle check (service.ts) closes its tabs sooner.
 */
export const HELPER_IDLE_TIMEOUT = "10m";
/** Page text is capped long before this; the runner's own buffer stays small. */
const MAX_BUFFER = 512 * 1024;

export interface HelperLaunch {
  /** The helper's executable (absolute). */
  bin: string;
  /** Our own `{}` config file, passed with --config. */
  config: string;
  /** Working folder: one the app owns, so no `./agent-browser.json` is picked up. */
  cwd: string;
  /** PATH for the helper (it starts through Node), HOME for its session sockets. */
  path: string;
  home: string;
}

export interface HelperResult {
  ok: boolean;
  /** Raw stdout (the helper's JSON answer). */
  out: string;
  /** Plain words for a failure: the helper's `error`, else stderr. */
  err: string;
  timedOut: boolean;
  /** The helper's `data` object from its `--json` answer, or null. */
  data: Record<string, unknown> | null;
  /** The helper's error code, for example "tab_gone" when the bound tab was closed. */
  code: string;
}

export type HelperRun = (args: string[], o?: { timeoutMs?: number; connect?: boolean; signal?: AbortSignal }) => Promise<HelperResult>;

/**
 * The helper's config file, as the app writes it: Chrome's address in `cdp`, so EVERY command of the app's session
 * attaches to the person's own Chrome and nothing else.
 *
 * Why (found on the owner's Mac, agent-browser 0.38.2): a session that was attached with `--cdp` on its first
 * command only, and whose background daemon then restarted (idle, crash, reboot), silently LAUNCHES the helper's
 * own bundled "Chrome for Testing" (a temporary profile, `--remote-debugging-port=0`) on its next command, and keeps
 * answering as if all were well. Every profile check then fails. With `cdp` in the config (checked against a test
 * Chrome on another port): commands reuse the one connection; a restarted daemon re-attaches to the same address;
 * a daemon that had launched its own browser drops it and attaches; and when Chrome isn't listening the command
 * fails ("All CDP discovery methods failed") instead of launching anything.
 */
export const HELPER_CONFIG_TEXT = `${JSON.stringify({ cdp: REMOTE_ENDPOINT })}\n`;

/** True when a config file's text pins the session to the person's Chrome (and nothing else decides the browser). */
export function configPinsChrome(raw: string): boolean {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return !!j && typeof j === "object" && j.cdp === REMOTE_ENDPOINT && j.autoConnect !== true && !j.provider && !j.executablePath;
  } catch { return false; }
}

/**
 * Writes (or repairs) the helper's config file so it pins Chrome's address. Idempotent; the file is the app's own,
 * owner-only. Returns the path.
 */
export function writeHelperConfig(file: string): string {
  let have = "";
  try { have = fs.readFileSync(file, "utf8"); } catch { have = ""; }
  if (have !== HELPER_CONFIG_TEXT) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, HELPER_CONFIG_TEXT, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return file;
}

/**
 * "host:port" of the browser a session drives, from `get cdp-url` (`ws://127.0.0.1:9222/devtools/browser[/<id>]`).
 * Only these two parts are ever kept: the browser id after the path is dropped. "" when unreadable.
 */
export function cdpHostPort(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "ws:" && u.protocol !== "wss:" && u.protocol !== "http:") return "";
    const port = u.port || (u.protocol === "wss:" ? "443" : "80");
    return `${u.hostname}:${port}`.slice(0, 80);
  } catch { return ""; }
}

/** True when that is the person's own Chrome: this computer, Chrome's remote control port. A launched helper browser uses a random port. */
export function isOwnChrome(hostPort: string): boolean {
  const i = hostPort.lastIndexOf(":");
  const host = hostPort.slice(0, i), port = hostPort.slice(i + 1);
  return (host === "127.0.0.1" || host === "localhost" || host === "[::1]") && port === String(REMOTE_PORT);
}

/** What the attachment check saw: the browser's "host:port" ("" when the helper didn't answer) and whether it is the person's Chrome. */
export interface Attachment { ok: boolean; cdp: string; reconnected: boolean }

/**
 * Is the app's session attached to the person's own Chrome (not a browser the helper launched)? One cheap command,
 * `get cdp-url`, which needs no tab. With `reconnect`, a session that isn't attached is closed (which stops a
 * browser the helper launched for this session only; an attached Chrome is only let go) and asked once more, which
 * re-attaches through the config's address (Chrome may ask "Allow remote debugging?" once). Nothing is retried after that.
 */
export async function checkAttached(run: HelperRun, o: { reconnect: boolean }): Promise<Attachment> {
  const look = async (): Promise<{ ok: boolean; cdp: string }> => {
    const r = await run(["get", "cdp-url"], { timeoutMs: 20_000 });
    const cdp = r.ok ? cdpHostPort(r.data?.cdpUrl) : "";
    return { ok: r.ok && isOwnChrome(cdp), cdp };
  };
  const first = await look();
  if (first.ok || !o.reconnect) return { ...first, reconnected: false };
  await run(["close"], { timeoutMs: 10_000 });
  const second = await look();
  return { ...second, reconnected: true };
}

export function helperEnv(l: Pick<HelperLaunch, "path" | "home">, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return cleanEnv({ PATH: l.path, HOME: l.home }, source);
}

/** The only flags the app itself puts after a helper command. Anything else that looks like a flag is refused. */
const OWN_FLAGS = new Set(["--label", "-i", "-c"]);
const SNAPSHOT_FLAGS = new Set(["-u", "-s"]);

/**
 * True when no argument could be read by the helper as a flag. The helper parses flags anywhere on the line, and
 * `--` doesn't stop it, so text from Claude (search words, addresses) must never start with "-" (for example
 * "--no-pin-tab" would undo the tab pin).
 */
export function safeArgs(args: readonly string[]): boolean {
  // `-u` (link addresses) and `-s <scope>` only on a snapshot, which never carries text from Claude.
  const own = args[0] === "snapshot" ? (a: string) => OWN_FLAGS.has(a) || SNAPSHOT_FLAGS.has(a) : (a: string) => OWN_FLAGS.has(a);
  return args.every((a) => typeof a === "string" && !/[\0\r\n]/.test(a) && (!a.trimStart().startsWith("-") || own(a)));
}

/** Reads the helper's `--json` answer: `{ success, data, error, code? }`. */
export function parseHelperJson(stdout: string): { success: boolean; data: Record<string, unknown> | null; error: string; code: string } | null {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) return null;
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    if (!j || typeof j !== "object" || typeof j.success !== "boolean") return null;
    const data = j.data && typeof j.data === "object" && !Array.isArray(j.data) ? j.data as Record<string, unknown> : null;
    const code = typeof j.code === "string" ? j.code : /^tab_gone\b/.test(String(j.error ?? "")) ? "tab_gone" : "";
    return { success: j.success, data, error: typeof j.error === "string" ? j.error : "", code };
  } catch { return null; }
}

/** One owner of the app's helper session at a time: `acquire` resolves with the release function. */
export interface SessionLock { acquire(): Promise<() => void> }

const memoryLocks = new Map<string, Promise<void>>();

/** Serialises everyone in this process who uses the same key. */
export function memoryLock(key: string): SessionLock {
  return {
    async acquire() {
      const before = memoryLocks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => { release = r; });
      const chained = before.then(() => mine);
      memoryLocks.set(key, chained);
      await before;
      return () => { release(); if (memoryLocks.get(key) === chained) memoryLocks.delete(key); };
    },
  };
}

export const LOCK_WAIT_MS = 3 * 60_000;

/**
 * A lock folder shared by main and jobcairn-chrome (two processes, one helper session). `mkdir` is atomic;
 * the folder holds the owner's pid. A lock whose owner has gone (a stopped run, a crash) or that is older than
 * whose owner process is gone is taken over. In-process callers queue on a memory lock first.
 */
export function fileLock(dir: string, o: { pid?: number; alive?(pid: number): boolean; now?(): number; sleep?(ms: number): Promise<void>; waitMs?: number } = {}): SessionLock {
  const pid = o.pid ?? process.pid;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const alive = o.alive ?? ((p: number) => { try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } });
  const mem = memoryLock(`file:${dir}:${pid}`);
  const owner = path.join(dir, "owner.json");
  const stale = (): boolean => {
    try {
      const j = JSON.parse(fs.readFileSync(owner, "utf8")) as { pid?: unknown; at?: unknown };
      if (typeof j.pid !== "number" || typeof j.at !== "number") return true;
      // Stale only when the owner has gone. A live owner keeps its lock however long a step takes.
      return !alive(j.pid);
    } catch {
      // No owner file yet: the owner may be between mkdir and write. Only stale once the folder is old.
      try { return now() - fs.statSync(dir).mtimeMs > 10_000; } catch { return false; }
    }
  };
  /**
   * Removes a stale lock, atomically: only the holder of `<dir>.takeover` (created with O_EXCL) may check and remove,
   * so two waiters can never both decide the lock is stale and one delete the other's fresh lock. A takeover file
   * left by a crash is cleared once it is old.
   */
  const takeover = `${dir}.takeover`;
  const takeOver = (): boolean => {
    let fd: number;
    try { fd = fs.openSync(takeover, "wx", 0o600); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(takeover).mtimeMs > 10_000) fs.rmSync(takeover, { force: true }); } catch { /* gone */ }
      return false;
    }
    try {
      fs.closeSync(fd);
      if (!stale()) return false;
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } finally { fs.rmSync(takeover, { force: true }); }
  };
  return {
    async acquire() {
      const releaseMem = await mem.acquire();
      const t0 = now();
      try {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        for (;;) {
          try {
            fs.mkdirSync(dir, { mode: 0o700 });
            fs.writeFileSync(owner, JSON.stringify({ pid, at: now() }), { mode: 0o600 });
            break;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            if (takeOver()) continue;
            if (now() - t0 > (o.waitMs ?? LOCK_WAIT_MS)) throw new Error("Chrome is busy with another step. Try again in a moment.");
            await sleep(100);
          }
        }
      } catch (e) { releaseMem(); throw e; }
      return () => {
        try {
          const j = JSON.parse(fs.readFileSync(owner, "utf8")) as { pid?: unknown };
          if (j.pid === pid) fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* already gone */ }
        releaseMem();
      };
    },
  };
}

/** The lock folder for the helper session: next to our config file, which main and jobcairn-chrome share. */
export function sessionLockDir(config: string): string { return path.join(path.dirname(config), "browser-session.lock"); }

/** Plain words when the session would not be attached to the person's Chrome. */
export const NOT_ATTACHED = "Chrome isn't connected. Open Settings › Search in my Chrome and press Connect.";

export class BrowserHelper {
  private readonly lock: SessionLock;
  private readonly readConfig: (file: string) => string;
  private pinned = false;
  constructor(private runner: ProcessRunner, readonly launch: HelperLaunch, lock?: SessionLock, o: { readConfig?: (file: string) => string } = {}) {
    this.lock = lock ?? memoryLock(`helper:${launch.config}`);
    this.readConfig = o.readConfig ?? ((f) => fs.readFileSync(f, "utf8"));
  }

  /** The config pins Chrome's address (see HELPER_CONFIG_TEXT). Without it the helper could launch its own browser. */
  private configPinned(): boolean {
    if (this.pinned) return true;
    try { this.pinned = configPinsChrome(this.readConfig(this.launch.config)); } catch { this.pinned = false; }
    return this.pinned;
  }

  /**
   * Runs `fn` as the session's only user: every helper call from main or jobcairn-chrome waits for the lock, so a
   * "switch to my tab, then act" sequence can never be split by someone else switching the session's tab.
   */
  async session<T>(fn: (run: HelperRun) => Promise<T>): Promise<T> {
    const release = await this.lock.acquire();
    try { return await fn((args, o) => this.raw(args, o)); } finally { release(); }
  }

  /** One helper command on its own (takes the lock for just this command). */
  run(args: string[], o: { timeoutMs?: number; connect?: boolean; signal?: AbortSignal } = {}): Promise<HelperResult> {
    return this.session((r) => r(args, o));
  }

  /**
   * One helper command on the app's session, with the tab pin (a closed tab fails with tab_gone instead of
   * falling back to one of the person's tabs) and JSON output. `connect` adds Chrome's address (only the first
   * connection needs it). Only call inside `session`.
   */
  private async raw(args: string[], o: { timeoutMs?: number; connect?: boolean; signal?: AbortSignal } = {}): Promise<HelperResult> {
    if (!safeArgs(args)) return { ok: false, out: "", err: "That text can't be passed to the browser.", timedOut: false, data: null, code: "refused" };
    // Never let the helper fall back to launching its own browser: no Chrome address in the config, no command.
    if (!this.configPinned()) return { ok: false, out: "", err: NOT_ATTACHED, timedOut: false, data: null, code: "not_attached" };
    // --no-webmcp: page-provided tool summaries never reach a run.
    const pre = ["--session", SESSION, "--config", this.launch.config, "--pin-tab", "--no-webmcp", "--idle-timeout", HELPER_IDLE_TIMEOUT, "--json", ...(o.connect ? ["--cdp", REMOTE_ENDPOINT] : [])];
    try {
      const r = await this.runner.run(this.launch.bin, [...pre, ...args], {
        cwd: this.launch.cwd, env: helperEnv(this.launch), timeoutMs: o.timeoutMs ?? COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal: o.signal,
      });
      const j = parseHelperJson(r.stdout);
      // The helper says it just launched a browser of its own: that is never the person's Chrome, so nothing it
      // answered counts (the attachment check closes it and re-attaches).
      const life = j?.data?.lifecycle;
      if (life && typeof life === "object" && (life as { launched?: unknown }).launched === true) {
        return { ok: false, out: r.stdout, err: NOT_ATTACHED, timedOut: false, data: j?.data ?? null, code: "launched" };
      }
      const ok = r.code === 0 && !r.timedOut && !r.cancelled && (j ? j.success : true);
      return { ok, out: r.stdout, err: j?.error || r.stderr, timedOut: r.timedOut, data: j?.data ?? null, code: j?.code ?? "" };
    } catch (e) {
      return { ok: false, out: "", err: (e as Error).message, timedOut: false, data: null, code: "" };
    }
  }
}

/** `agent-browser 0.38.2` to "0.38.2", else "". */
export function helperVersion(out: string): string {
  const m = /agent-browser\s+v?(\d{1,4}\.\d{1,4}\.\d{1,4})/i.exec(out);
  return m ? m[1]! : "";
}

/** The helper's command and flag behaviour was checked on HELPER_VERSION's minor line only (0.38.x). */
export function supportedVersion(v: string): boolean {
  const minor = (x: string) => x.split(".").slice(0, 2).join(".");
  return versionAtLeast(v, HELPER_MIN_VERSION) && minor(v) === minor(HELPER_VERSION);
}

export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}

/** Where to look for the helper, in order: the copy the app installed, then PATH, then Homebrew and npm's usual bins. */
export function helperCandidates(o: { ownDir: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string }): string[] {
  const p = o.platform === "win32" ? path.win32 : path.posix;
  const name = o.platform === "win32" ? "agent-browser.cmd" : "agent-browser";
  const out = [p.join(o.ownDir, "node_modules", ".bin", name)];
  const sep = o.platform === "win32" ? ";" : ":";
  for (const d of (o.env.PATH ?? o.env.Path ?? "").split(sep)) if (d && p.isAbsolute(d)) out.push(p.join(d, name));
  if (o.platform === "darwin") out.push("/opt/homebrew/bin/agent-browser", "/usr/local/bin/agent-browser");
  if (o.env.npm_config_prefix && p.isAbsolute(o.env.npm_config_prefix)) out.push(p.join(o.env.npm_config_prefix, "bin", name));
  out.push(p.join(o.home, ".npm-global", "bin", name));
  return [...new Set(out)];
}

