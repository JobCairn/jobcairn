// Finds the command-line tools the app runs (node and npm, python3, ffmpeg) the way an app opened from Finder must.
// A Finder app's PATH starts with /usr/bin, where macOS keeps an old python3, so Homebrew's folders go first, and a
// tool counts only when its version is new enough: the first one that is, not just the first one found.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compareVersions } from "@careeros/contract";

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
 */
export const PYTHON: ToolSpec = {
  names: ["python3", "python3.14", "python3.13", "python3.12", "python3.11"], min: "3.11.0", below: "3.15.0",
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

/** Runs `<program> --version` (3 s limit, no shell, minimal env) once per file version, then remembers the answer. */
export const probeVersion: VersionProbe = (program) => {
  let key = "";
  try { const st = fs.statSync(program); key = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return null; }
  const hit = probeCache.get(program);
  if (hit && hit.key === key) return hit.version;
  let version: string | null = null;
  try {
    const out = execFileSync(program, ["--version"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: path.dirname(program), HOME: process.env.HOME ?? "" } });
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
  for (const dir of toolPath(env.PATH, platform, { exists: o.exists }).split(platform === "win32" ? ";" : ":")) {
    if (!path.isAbsolute(dir)) continue;
    for (const name of spec.names) {
      const p = path.join(dir, name);
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

/** The first program called `name` on toolPath(PATH), with no version check (ffmpeg, say). */
export function whichTool(name: string, env: NodeJS.ProcessEnv, o: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; isExec?: (p: string) => boolean } = {}): string | null {
  const platform = o.platform ?? process.platform;
  const isExec = o.isExec ?? isExecutable;
  for (const dir of toolPath(env.PATH, platform, { exists: o.exists }).split(platform === "win32" ? ";" : ":")) {
    if (dir && path.isAbsolute(dir) && isExec(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/** npm from the same folder as a new-enough node (npm starts with `#!/usr/bin/env node`, so its PATH must lead there). */
export function findNpm(env: NodeJS.ProcessEnv, o: Parameters<typeof findTool>[2] = {}): { npm: string; node: FoundTool } | null {
  const node = findTool(NODE, env, o).tool;
  if (!node) return null;
  const npm = path.join(path.dirname(node.path), "npm");
  return (o.isExec ?? isExecutable)(npm) ? { npm, node } : null;
}
