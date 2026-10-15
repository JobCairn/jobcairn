import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

// The one process runner for CareerOS: video tools, read aloud and Claude Code (services re-exports it from here).

export interface RunOptions {
  cwd: string; env?: Record<string, string>; signal?: AbortSignal;
  onLine?: (line: string, stream: "stdout" | "stderr") => void; timeoutMs?: number; lowPriority?: boolean; maxBuffer?: number;
  /** Written to the child's stdin, which is then closed. Without it stdin is not connected. */
  input?: string;
}
export interface RunResult { code: number; stdout: string; stderr: string; cancelled: boolean; timedOut: boolean }
export interface ProcessRunner { run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> }

/** Cap on the per-stream partial-line buffer used to feed `onLine`. A child that writes a huge
 * line with no newline must not grow this buffer without bound. */
const PENDING_LINE_CAP = 64 * 1024;

const KEEP = ["USER", "LOGNAME", "SHELL", "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "ComSpec", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME"];
/** Claude Code also needs these, to find its own config and to reach Anthropic from behind a company proxy. Video tools
 * run offline and never get them. */
export const CLAUDE_ENV_KEYS = ["CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS"] as const;

/** Set for every video tool run: no library may fetch a model (final review I3). Downloads happen only on a click in Settings. */
export const OFFLINE_ENV = { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } as const;

/** Only the variables a tool needs to find itself, its cache and a temp folder. Secrets never pass through. */
export function cleanEnv(extra: Record<string, string>, source: NodeJS.ProcessEnv = process.env, also: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...KEEP, ...also]) { const v = source[k]; if (typeof v === "string") out[k] = v; }
  return { ...out, ...extra };
}

/** Ends a process and everything it started. POSIX: the child leads its own process group. Windows: taskkill /T. */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  setTimeout(() => {
    try { process.kill(-pid, 0); process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }, 1500).unref();
}

export function nodeProcessRunner(platform: NodeJS.Platform = process.platform): ProcessRunner {
  return {
    run(cmd, args, opts) {
      return new Promise<RunResult>((resolve, reject) => {
        if (opts.signal?.aborted) { resolve({ code: -1, stdout: "", stderr: "", cancelled: true, timedOut: false }); return; }
        let child: ChildProcess;
        try {
          child = spawn(cmd, args, {
            cwd: opts.cwd, env: opts.env ?? cleanEnv({}), shell: false, windowsHide: true,
            detached: platform !== "win32", stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          });
        } catch (e) {
          reject(new Error(`${path.basename(cmd)} could not be started: ${(e as Error).message}`));
          return;
        }
        const max = opts.maxBuffer ?? 4 * 1024 * 1024;
        let stdout = "", stderr = "", cancelled = false, timedOut = false, settled = false;
        const keepTail = (s: string) => (s.length > max ? s.slice(s.length - max) : s);
        const pending = { stdout: "", stderr: "" };
        // A throwing onLine must not crash this run (an uncaught exception in a 'data'
        // handler would otherwise take down the whole process, killing every other run too).
        const safeOnLine = (line: string, stream: "stdout" | "stderr") => {
          try { opts.onLine?.(line, stream); }
          catch (e) { console.error(`onLine callback threw and was ignored: ${(e as Error).message}`); }
        };
        const feed = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (stream === "stdout") stdout = keepTail(stdout + text); else stderr = keepTail(stderr + text);
          if (!opts.onLine) return;
          const parts = (pending[stream] + text).split(/\r\n|\n|\r/);
          pending[stream] = parts.pop() ?? "";
          for (const p of parts) if (p) safeOnLine(p, stream);
          // Bound the partial-line buffer: a child that never sends a newline must not grow
          // memory without limit. Flush what's accumulated as one (truncated) line and reset.
          if (pending[stream].length > PENDING_LINE_CAP) {
            const line = pending[stream].slice(0, PENDING_LINE_CAP);
            pending[stream] = "";
            safeOnLine(line, stream);
          }
        };
        if (opts.input !== undefined && child.stdin) {
          child.stdin.on("error", () => { /* the child closed stdin early; its exit code tells the story */ });
          child.stdin.end(opts.input, "utf8");
        }
        child.stdout!.on("data", feed("stdout"));
        child.stderr!.on("data", feed("stderr"));
        if (opts.lowPriority && child.pid) {
          try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here; run at normal priority */ }
        }
        const kill = () => { if (child.pid) killTree(child.pid, platform); };
        const onAbort = () => { cancelled = true; kill(); };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : undefined;
        const done = () => { settled = true; if (timer) clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); };
        child.on("error", (e: NodeJS.ErrnoException) => {
          if (settled) return;
          done();
          reject(new Error(`${path.basename(cmd)} could not be started: ${e.code ?? e.message}`));
        });
        child.on("close", (code) => {
          if (settled) return;
          done();
          for (const s of ["stdout", "stderr"] as const) if (pending[s]) safeOnLine(pending[s], s);
          resolve({ code: code ?? -1, stdout, stderr, cancelled, timedOut });
        });
      });
    },
  };
}

export type FakeScript = (cmd: string, args: string[], opts: RunOptions) => Partial<RunResult> | Promise<Partial<RunResult>>;
export interface FakeRunner extends ProcessRunner { calls: { cmd: string; args: string[]; cwd: string; env?: Record<string, string>; input?: string }[] }

/** A runner for tests: records each call and returns what the script says. Nothing is started. */
export function fakeRunner(script: FakeScript): FakeRunner {
  const calls: FakeRunner["calls"] = [];
  return {
    calls,
    async run(cmd, args, opts) {
      calls.push({ cmd, args: [...args], cwd: opts.cwd, env: opts.env, input: opts.input });
      if (opts.signal?.aborted) return { code: -1, stdout: "", stderr: "", cancelled: true, timedOut: false };
      const res: RunResult = { code: 0, stdout: "", stderr: "", cancelled: false, timedOut: false, ...(await script(cmd, args, opts)) };
      for (const l of res.stdout.split("\n")) if (l) opts.onLine?.(l, "stdout");
      return res;
    },
  };
}

/** For fake scripts: resolves as a cancelled run when the signal aborts. */
export function untilAborted(opts: RunOptions): Promise<Partial<RunResult>> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) { resolve({ code: -1, cancelled: true }); return; }
    opts.signal?.addEventListener("abort", () => resolve({ code: -1, cancelled: true }), { once: true });
  });
}
