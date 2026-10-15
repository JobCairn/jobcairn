import fs from "node:fs";
import path from "node:path";
import { CLAUDE_MIN_VERSION, compareVersions, parseVersion, type ClaudeAuth, type ClaudeCliProblem, type ClaudeLogin } from "@careeros/contract";
import type { McpLaunch } from "./args.js";
import type { ProcessRunner } from "./process.js";

/** What main gives the engine. The renderer never sees any of it. */
export interface ClaudeHost {
  runner: ProcessRunner;
  platform: NodeJS.Platform;
  /** Only PATH, HOME/USERPROFILE, APPDATA and npm_config_prefix are read, to find the CLI. */
  env: NodeJS.ProcessEnv;
  home: string;
  /** The bundled CareerOS plugin folder (with .claude-plugin/plugin.json), passed to each run with --plugin-dir. */
  pluginDir: string;
  /** How Claude Code starts the `careeros mcp` server for a run. */
  mcp: McpLaunch;
  /** Opens a terminal window running the CLI, so the person signs in there. */
  openTerminal(cliPath: string): Promise<boolean>;
  /** Test seam: is this a runnable file? Defaults to a real stat check. */
  isExecutable?(p: string): boolean;
}

/** How to start the CLI: the command and any arguments before ours (a Windows npm shim runs through node). */
export interface ClaudeLaunch { cli: string; cmd: string; pre: string[] }

export const DETECT_TIMEOUT_MS = 10_000;
export const AUTH_TIMEOUT_MS = 15_000;

function defaultExecutable(platform: NodeJS.Platform): (p: string) => boolean {
  return (p) => {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return false;
      return platform === "win32" || (st.mode & 0o111) !== 0;
    } catch { return false; }
  };
}

/** Every place we look, in order: PATH first, then the installers' usual folders. */
export function claudeCandidates(h: Pick<ClaudeHost, "platform" | "env" | "home">): string[] {
  const p = h.platform === "win32" ? path.win32 : path.posix;
  const names = h.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const pathVar = h.env.PATH ?? h.env.Path ?? "";
  const dirs = pathVar.split(h.platform === "win32" ? ";" : ":").filter((d) => d && p.isAbsolute(d));
  if (h.platform === "win32") {
    const appData = h.env.APPDATA ?? p.join(h.home, "AppData", "Roaming");
    dirs.push(p.join(h.home, ".local", "bin"), p.join(h.home, ".claude", "local"), p.join(appData, "npm"));
  } else {
    dirs.push(p.join(h.home, ".claude", "local"), p.join(h.home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", p.join(h.home, ".npm-global", "bin"));
  }
  const prefix = h.env.npm_config_prefix;
  if (prefix && p.isAbsolute(prefix)) dirs.push(h.platform === "win32" ? prefix : p.join(prefix, "bin"));
  const out: string[] = [];
  for (const d of dirs) for (const n of names) { const c = p.join(d, n); if (!out.includes(c)) out.push(c); }
  return out;
}

export function findClaude(h: ClaudeHost): string | null {
  const ok = h.isExecutable ?? defaultExecutable(h.platform);
  return claudeCandidates(h).find((c) => ok(c)) ?? null;
}

/**
 * Node can't start a .cmd without a shell (and a shell is never used), so a Windows npm shim runs as
 * `node <package>/cli.js`. Null when the shim's script or node can't be found.
 */
export function launchFor(cli: string, h: ClaudeHost): ClaudeLaunch | null {
  if (h.platform !== "win32" || !cli.toLowerCase().endsWith(".cmd")) return { cli, cmd: cli, pre: [] };
  const ok = h.isExecutable ?? defaultExecutable(h.platform);
  const dir = path.win32.dirname(cli);
  const script = ["cli.js", "cli.mjs"].map((f) => path.win32.join(dir, "node_modules", "@anthropic-ai", "claude-code", f)).find((f) => ok(f));
  if (!script) return null;
  const pathVar = h.env.PATH ?? h.env.Path ?? "";
  const node = [dir, ...pathVar.split(";")].filter(Boolean).map((d) => path.win32.join(d, "node.exe")).find((f) => ok(f));
  return node ? { cli, cmd: node, pre: [script] } : null;
}

export interface CliCheck { launch: ClaudeLaunch | null; version: string; problem: ClaudeCliProblem | null }

export async function checkCli(h: ClaudeHost, env: Record<string, string>): Promise<CliCheck> {
  const cli = findClaude(h);
  if (!cli) return { launch: null, version: "", problem: "missing" };
  const launch = launchFor(cli, h);
  if (!launch) return { launch: null, version: "", problem: "broken" };
  let out = "";
  try {
    const r = await h.runner.run(launch.cmd, [...launch.pre, "--version"], { cwd: h.home, env, timeoutMs: DETECT_TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) return { launch, version: "", problem: "broken" };
    out = r.stdout;
  } catch { return { launch, version: "", problem: "broken" }; }
  const v = parseVersion(out);
  if (!v) return { launch, version: "", problem: "broken" };
  const version = v.join(".");
  return { launch, version, problem: compareVersions(version, CLAUDE_MIN_VERSION) < 0 ? "too_old" : null };
}

const LOGIN_KEYS = ["loggedIn", "logged_in", "isLoggedIn", "authenticated"];

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * The sign-in type from `auth status --json`. Any sign of an API key or a cloud provider wins, because Claude Code
 * then bills per run; a subscription needs a positive sign. Anything else is "unknown".
 */
export function authFrom(j: Record<string, unknown>): ClaudeAuth {
  const method = str(j.authMethod ?? j.auth_method);
  const keySource = str(j.apiKeySource ?? j.api_key_source);
  const provider = str(j.apiProvider ?? j.api_provider);
  const plan = str(j.subscriptionType ?? j.subscription_type);
  if (/api.?key|console/i.test(method) || (keySource && keySource.toLowerCase() !== "none") || (provider && !/^first.?party$/i.test(provider))) return "api_key";
  if (/claude\.?ai|subscription|oauth/i.test(method) || (plan && plan.toLowerCase() !== "none")) return "subscription";
  return "unknown";
}

/**
 * `claude auth status --json`. Only the logged-in flag and the sign-in type are read; the output is never kept,
 * logged or shown. Non-zero exit means signed out; anything we can't read is "unknown".
 */
export async function checkAuth(h: ClaudeHost, launch: ClaudeLaunch, env: Record<string, string>): Promise<{ login: ClaudeLogin; auth: ClaudeAuth }> {
  let r;
  try { r = await h.runner.run(launch.cmd, [...launch.pre, "auth", "status", "--json"], { cwd: h.home, env, timeoutMs: AUTH_TIMEOUT_MS }); } catch { return { login: "unknown", auth: "unknown" }; }
  if (r.timedOut || r.cancelled) return { login: "unknown", auth: "unknown" };
  let j: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(r.stdout) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) j = v as Record<string, unknown>;
  } catch { /* not JSON */ }
  let login: ClaudeLogin | null = null;
  if (j) for (const k of LOGIN_KEYS) if (typeof j[k] === "boolean") { login = j[k] ? "signed_in" : "signed_out"; break; }
  login ??= r.code === 0 ? "unknown" : "signed_out";
  return { login, auth: j && login !== "signed_out" ? authFrom(j) : "unknown" };
}

/** The logged-in flag only (see checkAuth). */
export async function checkLogin(h: ClaudeHost, launch: ClaudeLaunch, env: Record<string, string>): Promise<ClaudeLogin> {
  return (await checkAuth(h, launch, env)).login;
}

const AUTH_ERROR = /not (?:logged|signed) in|please run \/login|\/login\b|authentication_error|invalid api key|oauth token|unauthori[sz]ed/i;
/** True when a failed run's text reads like a sign-in problem. */
export function isAuthError(text: string): boolean { return AUTH_ERROR.test(text); }
