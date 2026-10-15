import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { identity } from "@careeros/brand/identity";
import { cleanEnv, nodeProcessRunner, type ProcessRunner } from "@careeros/video";
import { classifyInstall, installFailedText, toolPath, type InstallFailure, type SetupHost, type SetupRunResult } from "@careeros/services";

interface Where { packaged: boolean; resourcesPath: string; /** dist/ (development) or app.asar/dist (packaged). */ here: string }

/** The setup runner's folder (run.mjs, lib.mjs): Resources/careeros-setup, or the repo's scripts/setup in development. */
export function setupRunnerDir(o: Where): string {
  return o.packaged ? path.join(o.resourcesPath, "careeros-setup") : path.resolve(o.here, "..", "..", "..", "scripts", "setup");
}
/** setup/components, shipped as Resources/careeros-setup/components (builder-config RESOURCES.setupComponents). */
export function setupComponentsDir(o: Where): string {
  return o.packaged ? path.join(o.resourcesPath, "careeros-setup", "components") : path.resolve(o.here, "..", "..", "..", "setup", "components");
}

/** The runner and its components, or null when this copy lacks them. */
export function setupFiles(o: Where & { exists?: (p: string) => boolean }): { runner: string; components: string } | null {
  const exists = o.exists ?? fs.existsSync;
  const f = { runner: path.join(setupRunnerDir(o), "run.mjs"), components: setupComponentsDir(o) };
  return exists(f.runner) && exists(f.components) ? f : null;
}

/**
 * Homebrew, quicker and quieter: no `brew update` before each install (the slow, silent part that made a Node.js
 * install look stuck), no hints, no cleanup pass, no analytics. run.mjs sets the same for setup.sh.
 */
export const HOMEBREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ANALYTICS: "1" } as const;

/** Installs reach the network: the person's proxy and certificate settings come along. Nothing else does. */
const NETWORK_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"] as const;

/**
 * The setup runner for one component, run by Electron's own binary as plain Node (no shell, clean environment, no
 * stdin, so nothing can stop and ask for a password). PATH: Homebrew first, then the person's PATH, then
 * ~/.local/bin, where Anthropic's installer puts `claude`, so the runner's re-check finds what was just installed.
 */
export function installCommand(
  files: { runner: string; components: string }, id: string,
  o: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv; home?: string } = {},
): { cmd: string; args: string[]; env: Record<string, string> } {
  const platform = o.platform ?? process.platform;
  const env = cleanEnv({ ELECTRON_RUN_AS_NODE: "1", ...HOMEBREW_ENV }, o.env ?? process.env, NETWORK_KEYS);
  const home = o.home ?? env.HOME ?? os.homedir();
  const sep = platform === "win32" ? ";" : ":";
  env.PATH = [toolPath(env.PATH, platform, { exists: o.exists }), ...(platform === "win32" ? [] : [path.join(home, ".local", "bin")])].filter(Boolean).join(sep);
  return { cmd: process.execPath, args: [files.runner, "install", "--only", id, "--json", "--components", files.components], env };
}

interface SetupResult { name?: unknown; state?: unknown }

/** The last JSON object in the output: a one-line `{ ok, message }`, or the setup runner's pretty-printed `{ ok, results }`. */
function lastJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.trim().startsWith("{")) continue;
    try {
      const v = JSON.parse(lines.slice(i).join("\n")) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* not the start of the report; keep looking */ }
  }
  return null;
}

const UNKNOWN: InstallFailure = { problem: "other", said: "" };

function fromResult(r: SetupResult, f: InstallFailure): SetupRunResult | null {
  const name = typeof r.name === "string" && r.name ? r.name : "That tool";
  switch (r.state) {
    case "installed": return { ok: true, message: `${name} is installed.` };
    case "ok": return { ok: true, message: `${name} was already installed.` };
    case "failed": return { ok: false, message: installFailedText(name, f), problem: f.problem };
    case "unsupported": return { ok: false, message: `${name} can't be installed automatically on this computer.` };
    default: return null;
  }
}

/**
 * What the installer said. The component's own state decides (an optional one that failed leaves the runner's `ok`
 * true); `f` is why it failed, read from all of its output (services install-error.ts).
 */
export function parseInstallOutput(stdout: string, code: number, f: InstallFailure = UNKNOWN): SetupRunResult {
  const j = lastJson(stdout);
  if (j) {
    const results = Array.isArray(j.results) ? (j.results as SetupResult[]) : null;
    const r = results?.length === 1 && results[0] && typeof results[0] === "object" ? fromResult(results[0], f) : null;
    if (r) return r;
    if (typeof j.ok === "boolean" && typeof j.message === "string") return { ok: j.ok, message: j.message.slice(0, 300) };
  }
  return code === 0 ? { ok: true, message: "Installed." } : { ok: false, message: installFailedText(`The installer stopped (exit code ${code}). The tool`, f), problem: f.problem };
}

const INSTALL_TIMEOUT_MS = 30 * 60_000;

/** Runs one component's install: output lines go to `onLine` (progress); on a failure, all of its output says why. */
export async function runComponent(
  runner: ProcessRunner, files: { runner: string; components: string }, id: string,
  o: { onLine(line: string): void; signal: AbortSignal; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; exists?: (p: string) => boolean; cwd: string },
): Promise<SetupRunResult> {
  const c = installCommand(files, id, o);
  const r = await runner.run(c.cmd, c.args, {
    cwd: o.cwd, env: c.env, timeoutMs: INSTALL_TIMEOUT_MS, signal: o.signal,
    onLine: (line) => {
      // The runner's closing JSON report isn't progress.
      if (/^\s*[{}\[\]"]/.test(line)) return;
      o.onLine(line);
    },
  });
  if (r.cancelled) return { ok: false, cancelled: true, message: "Install stopped." };
  if (r.timedOut) return { ok: false, message: installFailedText("The install", { problem: "timeout", said: "" }), problem: "timeout" };
  return parseInstallOutput(r.stdout, r.code, classifyInstall(`${r.stdout}\n${r.stderr}`));
}

/**
 * Setup for the Setup cards (setup.*): Claude Code, Node.js, Python and ffmpeg, in development and in the packaged
 * app alike. The native confirm and the one-at-a-time lock live in services (setup.ts, install-lock.ts).
 */
export function electronSetupHost(o: {
  packaged: boolean; resourcesPath: string; here: string; platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv;
  confirm(message: string, detail: string): Promise<boolean>; runner?: ProcessRunner; exists?: (p: string) => boolean;
}): SetupHost {
  const files = setupFiles(o);
  const runner = o.runner ?? nodeProcessRunner(o.platform);
  return {
    platform: o.platform, env: o.env, home: o.home, canInstall: !!files, confirm: o.confirm, exists: o.exists,
    run: async (id, r) => {
      if (!files) return { ok: false, message: `This copy of ${identity.name} has no installer.` };
      return runComponent(runner, files, id, { ...r, platform: o.platform, env: o.env, home: o.home, exists: o.exists, cwd: o.home });
    },
  };
}
