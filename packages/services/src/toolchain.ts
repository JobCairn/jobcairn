// Finds the command-line tools the app runs (node and npm, python3, ffmpeg) the way an app opened from Finder must.
// A Finder app's PATH starts with /usr/bin, where macOS keeps an old python3, so Homebrew's folders go first, and a
// tool counts only when its version is new enough: the first one that is, not just the first one found.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { compareVersions } from "@careeros/contract";
import { exeCandidates, pathFor, safePathDirs, WIN_SYSTEM_ENV_KEYS } from "@careeros/video";

/** Homebrew's folders: Apple silicon (bin, sbin), then Intel. */
export const BREW_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] as const;
/** Where the `brew` program itself lives. Checked by file, never by PATH. */
export const BREW_PROGRAMS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] as const;
const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * PATH for a tool run: `first` (say, the folder of the node that was picked), then on macOS the Homebrew folders that
 * exist, then the person's own PATH, then the system folders if missing. Each folder appears once, at its first place.
 */
export function toolPath(pathVar: string | undefined, platform: NodeJS.Platform, o: { first?: string[]; exists?: (p: string) => boolean } = {}): string {
  const sep = platform === "win32" ? ";" : ":";
  const exists = o.exists ?? fs.existsSync;
  const brew = platform === "darwin" ? BREW_DIRS.filter((d) => exists(d)) : [];
  const tail = platform === "win32" ? [] : SYSTEM_DIRS;
  const out: string[] = [];
  for (const d of [...(o.first ?? []), ...brew, ...(pathVar ?? "").split(sep), ...tail]) if (d && !out.includes(d)) out.push(d);
  return out.join(sep);
}

/** The installed Homebrew, or null. */
export function findBrew(exists: (p: string) => boolean = fs.existsSync): string | null {
  return BREW_PROGRAMS.find((p) => exists(p)) ?? null;
}

export interface ToolSpec {
  /** Program names to try in each folder, in order. */
  names: readonly string[];
  /** Windows names, when they differ (".exe" is added by the finder: see @careeros/video find-exe). */
  win32Names?: readonly string[];
  /** Oldest version that works ("22.0.0"). */
  min: string;
  /** First version that is too new, if any. */
  below?: string;
  /** What the person reads: "Node.js 22 or newer". */
  label: string;
  /** Never run these to read a version (see PYTHON). */
  skip?: readonly string[];
}

export const NODE: ToolSpec = { names: ["node"], min: "22.0.0", label: "Node.js 22 or newer" };
/**
 * 3.11 to 3.14: the voice's ONNX Runtime has macOS wheels for cp311-cp314 only (onnxruntime 1.31.0 on PyPI,
 * 2026-10-11), so a newer python3 is passed over for a versioned one. /usr/bin/python3 is Apple's stand-in: it is
 * 3.9, and on a Mac without the developer tools running it opens an "install the tools" dialog, so it is never run.
 * Windows: python.exe (python.org's installer), then the `py` launcher (it runs the newest Python it knows).
 */
export const PYTHON: ToolSpec = {
  names: ["python3", "python3.14", "python3.13", "python3.12", "python3.11"], win32Names: ["python", "py"], min: "3.11.0", below: "3.15.0",
  label: "Python 3.11 to 3.14", skip: ["/usr/bin/python3"],
};

export interface FoundTool { path: string; version: string; ok: boolean }
export interface FindResult {
  /** The first new-enough tool, else null. */
  tool: FoundTool | null;
  /** Every version that was found, best first, so the UI can say "Python 3.9 is too old". */
  seen: FoundTool[];
}

export const versionOk = (v: string, spec: ToolSpec) => compareVersions(v, spec.min) >= 0 && (!spec.below || compareVersions(v, spec.below) < 0);

/** "v22.13.0" or "Python 3.12.15" -> "22.13.0" / "3.12.15". */
export function readVersion(out: string): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
  return m ? `${m[1]}.${m[2]}.${m[3] ?? "0"}` : null;
}

export type VersionProbe = (program: string) => string | null;

const probeCache = new Map<string, { key: string; version: string | null }>();

/**
 * The environment a `--version` probe gets: PATH is the program's own folder, plus HOME. On Windows also the system
 * variables a program needs to start at all (SystemRoot and friends: WIN_SYSTEM_ENV_KEYS). Nothing else.
 */
export function probeEnv(program: string, platform: NodeJS.Platform = process.platform, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: pathFor(platform).dirname(program), HOME: source.HOME ?? "" };
  if (platform === "win32") for (const k of WIN_SYSTEM_ENV_KEYS) { const v = source[k]; if (typeof v === "string") env[k] = v; }
  return env;
}

/** Runs `<program> --version` (3 s limit, no shell, minimal env) once per file version, then remembers the answer. */
export const probeVersion: VersionProbe = (program) => {
  let key = "";
  try { const st = fs.statSync(program); key = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return null; }
  const hit = probeCache.get(program);
  if (hit && hit.key === key) return hit.version;
  let version: string | null = null;
  try {
    const out = execFileSync(program, ["--version"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: probeEnv(program) });
    version = readVersion(out);
  } catch { version = null; }
  probeCache.set(program, { key, version });
  return version;
};

export const isExecutable = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * Looks through toolPath(PATH) folder by folder and picks the first program that is new enough. Too-old ones are
 * kept in `seen` for the message. Names are tried per folder, so Homebrew's python3.12 beats an older python3 later on.
 */
export function findTool(spec: ToolSpec, env: NodeJS.ProcessEnv, o: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; isExec?: (p: string) => boolean; probe?: VersionProbe } = {}): FindResult {
  const platform = o.platform ?? process.platform;
  const isExec = o.isExec ?? isExecutable;
  const probe = o.probe ?? probeVersion;
  const seen: FoundTool[] = [];
  const tried = new Set<string>();
  const names = platform === "win32" ? spec.win32Names ?? spec.names : spec.names;
  for (const dir of toolDirs(env, platform, o.exists)) {
    for (const p of names.flatMap((name) => exeCandidates(dir, name, platform, env))) {
      if (tried.has(p) || spec.skip?.includes(p) || !isExec(p)) continue;
      tried.add(p);
      const version = probe(p);
      if (!version) continue;
      const found = { path: p, version, ok: versionOk(version, spec) };
      if (found.ok) return { tool: found, seen: [found, ...seen] };
      seen.push(found);
    }
  }
  return { tool: null, seen };
}

/** toolPath(PATH)'s folders worth looking in: real absolute ones only (find-exe safePathDirs). PATH or Windows' `Path`. */
function toolDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists?: (p: string) => boolean): string[] {
  return safePathDirs(toolPath(env.PATH ?? env.Path, platform, { exists }), platform);
}

/** The first program called `name` on toolPath(PATH), with no version check (ffmpeg, say). Windows: `name`.exe. */
export function whichTool(name: string, env: NodeJS.ProcessEnv, o: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; isExec?: (p: string) => boolean } = {}): string | null {
  const platform = o.platform ?? process.platform;
  const isExec = o.isExec ?? isExecutable;
  for (const dir of toolDirs(env, platform, o.exists)) {
    for (const p of exeCandidates(dir, name, platform, env)) if (isExec(p)) return p;
  }
  return null;
}

/**
 * npm and how to start it: `runner.run(cmd, [...pre, "install", ...])`, never through a shell. `npm` is the file that
 * is npm; `node` the node it runs on (that folder must lead the child's PATH).
 */
export interface FoundNpm { npm: string; node: FoundTool; cmd: string; pre: string[] }

/**
 * npm from the same folder as a new-enough node (npm starts with `#!/usr/bin/env node`, so its PATH must lead there).
 * Windows: node can't start npm.cmd without a shell, so npm runs as `node.exe <node folder>\node_modules\npm\bin\npm-cli.js`
 * (where Node.js's installer puts it), like claude/detect.ts launchFor does for Claude Code. Null when it isn't there.
 */
export function findNpm(env: NodeJS.ProcessEnv, o: Parameters<typeof findTool>[2] = {}): FoundNpm | null {
  const platform = o.platform ?? process.platform;
  const node = findTool(NODE, env, o).tool;
  if (!node) return null;
  const isExec = o.isExec ?? isExecutable;
  const p = pathFor(platform);
  const dir = p.dirname(node.path);
  if (platform === "win32") {
    const cli = p.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    return isExec(cli) ? { npm: cli, node, cmd: node.path, pre: [cli] } : null;
  }
  const npm = p.join(dir, "npm");
  return isExec(npm) ? { npm, node, cmd: npm, pre: [] } : null;
}
