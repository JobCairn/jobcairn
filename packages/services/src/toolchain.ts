// Finds the command-line tools the app runs (node and npm, python3, ffmpeg) the way an app opened from Finder must.
// A Finder app's PATH starts with /usr/bin, where macOS keeps an old python3, so Homebrew's folders go first, and a
// tool counts only when its version is new enough: the first one that is, not just the first one found.
// Windows: after PATH, also the saved PATH and our installers' folders (win-paths.ts), so a tool Setup just installed
// is found even though the app's own PATH predates the install.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { compareVersions } from "@careeros/contract";
import { exeCandidates, pathFor, safeDir, safePathDirs, WIN_SYSTEM_ENV_KEYS } from "@careeros/video";
import { defaultWinExtraDirs, winExtraDirs } from "./win-paths.js";

/** Homebrew's folders: Apple silicon (bin, sbin), then Intel. */
export const BREW_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] as const;
/** Where the `brew` program itself lives. Checked by file, never by PATH. */
export const BREW_PROGRAMS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] as const;
const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * PATH for a tool run: `first` (say, the folder of the node that was picked), then on macOS the Homebrew folders that
 * exist, then the person's own PATH, then the system folders if missing. Each folder appears once, at its first place.
 * Windows: after PATH, `extra` (default: win-paths winExtraDirs, the saved PATH and our installers' folders), so a
 * tool installed after the app started is found and runs. Folders compare without case there.
 */
export function toolPath(pathVar: string | undefined, platform: NodeJS.Platform, o: { first?: string[]; exists?: (p: string) => boolean; extra?: readonly string[] } = {}): string {
  const sep = platform === "win32" ? ";" : ":";
  const exists = o.exists ?? fs.existsSync;
  const brew = platform === "darwin" ? BREW_DIRS.filter((d) => exists(d)) : [];
  const tail = platform === "win32" ? o.extra ?? defaultWinExtraDirs() : SYSTEM_DIRS;
  const key = (d: string) => (platform === "win32" ? d.toLowerCase() : d);
  const out: string[] = [];
  const keys = new Set<string>();
  for (const d of [...(o.first ?? []), ...brew, ...(pathVar ?? "").split(sep), ...tail]) {
    if (d && !keys.has(key(d))) { keys.add(key(d)); out.push(d); }
  }
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
  /** Windows: also ask the `py` launcher for each supported version (`py -3.12`), never for its default. */
  pyLauncher?: boolean;
}

export const NODE: ToolSpec = { names: ["node"], min: "22.0.0", label: "Node.js 22 or newer" };
/**
 * 3.11 to 3.14: the voice's ONNX Runtime has macOS wheels for cp311-cp314 only (onnxruntime 1.31.0 on PyPI,
 * 2026-10-11), so a newer python3 is passed over for a versioned one. /usr/bin/python3 is Apple's stand-in: it is
 * 3.9, and on a Mac without the developer tools running it opens an "install the tools" dialog, so it is never run.
 * Windows: python.exe (python.org's installer and winget's), then the `py` launcher asked for each supported version,
 * newest first (`py -3.14` ... `py -3.11`), never for its default (that may be a 3.15 when a 3.12 is there too). The
 * launcher only says where that Python is: the python.exe it names is what's checked, and what the features run.
 */
export const PYTHON: ToolSpec = {
  names: ["python3", "python3.14", "python3.13", "python3.12", "python3.11"], win32Names: ["python"], min: "3.11.0", below: "3.15.0",
  label: "Python 3.11 to 3.14", skip: ["/usr/bin/python3"], pyLauncher: true,
};

export interface FoundTool { path: string; version: string; ok: boolean }
export interface FindResult {
  /** The first new-enough tool, else null. */
  tool: FoundTool | null;
  /** Every version that was found, best first, so the UI can say "Python 3.9 is too old". */
  seen: FoundTool[];
}

export const versionOk = (v: string, spec: ToolSpec) => compareVersions(v, spec.min) >= 0 && (!spec.below || compareVersions(v, spec.below) < 0);

/** The X.Y versions `spec` accepts, newest first ("3.14" ... "3.11"). Empty unless its range is within one major. */
export function supportedMinors(spec: Pick<ToolSpec, "min" | "below">): string[] {
  if (!spec.below) return [];
  const [maj, lo] = spec.min.split(".").map(Number);
  const [bmaj, bmin] = spec.below.split(".").map(Number);
  if (maj !== bmaj || !Number.isInteger(lo) || !Number.isInteger(bmin)) return [];
  const out: string[] = [];
  for (let m = bmin! - 1; m >= lo!; m--) out.push(`${maj}.${m}`);
  return out;
}

/** "v22.13.0" or "Python 3.12.15" -> "22.13.0" / "3.12.15". */
export function readVersion(out: string): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
  return m ? `${m[1]}.${m[2]}.${m[3] ?? "0"}` : null;
}

/** `<program> --version`'s version, or null. `timeoutMs`: a shorter limit, for a program that may be a stand-in. */
export type VersionProbe = (program: string, o?: { timeoutMs?: number }) => string | null;

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

const fileKey = (p: string): string | null => { try { const st = fs.statSync(p); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return null; } };

/** Runs `<program> --version` (3 s limit unless told, no shell, minimal env) once per file version, then remembers. */
export const probeVersion: VersionProbe = (program, o = {}) => {
  const key = fileKey(program);
  if (key === null) return null;
  const hit = probeCache.get(program);
  if (hit && hit.key === key) return hit.version;
  let version: string | null = null;
  try {
    const out = execFileSync(program, ["--version"], { encoding: "utf8", timeout: o.timeoutMs ?? 3_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: probeEnv(program) });
    version = readVersion(out);
  } catch { version = null; }
  probeCache.set(program, { key, version });
  return version;
};

const pyCache = new Map<string, { key: string; path: string | null }>();

/**
 * Windows: the python.exe that `py -<version>` runs (`py -3.12 -c "import sys; print(sys.executable)"`, 3 s limit,
 * no shell, minimal env), remembered per launcher file and version. Null when the launcher has no such Python.
 */
export function pyLauncherPython(py: string, version: string): string | null {
  const key = fileKey(py);
  if (key === null) return null;
  const id = `${py}|${version}`;
  const hit = pyCache.get(id);
  if (hit && hit.key === key) return hit.path;
  let found: string | null = null;
  try {
    const out = execFileSync(py, [`-${version}`, "-c", "import sys; print(sys.executable)"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: probeEnv(py) });
    const line = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
    found = /\.exe$/i.test(line) && safeDir(line, "win32") ? line : null;
  } catch { found = null; }
  pyCache.set(id, { key, path: found });
  return found;
}

export const isExecutable = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

/** What findTool and whichTool take. All but `platform` are test seams. */
export interface FindOptions {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  isExec?: (p: string) => boolean;
  probe?: VersionProbe;
  /** Windows: the folders searched after PATH (default: win-paths winExtraDirs). */
  extra?: readonly string[];
  /** Windows: the python.exe the `py` launcher runs for "3.12", or null (default: pyLauncherPython). */
  pyPython?: (py: string, version: string) => string | null;
}

/** Windows' folder of Microsoft Store app aliases, where python.exe may be the stand-in that opens the Store. */
const STORE_DIR = /\\microsoft\\windowsapps\\?$/i;
/** How long a WindowsApps program gets to answer --version: a real Store Python answers at once. */
export const STORE_PROBE_MS = 1_500;

/**
 * Looks through toolPath(PATH) folder by folder and picks the first program that is new enough. Too-old ones are
 * kept in `seen` for the message. Names are tried per folder, so Homebrew's python3.12 beats an older python3 later on.
 * Windows: PATH, then the saved PATH and our installers' folders, with WindowsApps last: its python.exe is often the
 * Store's stand-in, so it counts only when --version answers quickly with a version (it is never run without
 * arguments, which is what opens the Store). Then, for PYTHON, the `py` launcher with each supported version.
 */
export function findTool(spec: ToolSpec, env: NodeJS.ProcessEnv, o: FindOptions = {}): FindResult {
  const platform = o.platform ?? process.platform;
  const win = platform === "win32";
  const isExec = o.isExec ?? isExecutable;
  const probe = o.probe ?? probeVersion;
  const seen: FoundTool[] = [];
  const tried = new Set<string>();
  const names = win ? spec.win32Names ?? spec.names : spec.names;
  const dirs = toolDirs(env, platform, o);
  const consider = (p: string, store: boolean): FoundTool | null => {
    const id = win ? p.toLowerCase() : p;
    if (tried.has(id) || spec.skip?.includes(p) || !isExec(p)) return null;
    tried.add(id);
    const version = store ? probe(p, { timeoutMs: STORE_PROBE_MS }) : probe(p);
    if (!version) return null;
    const found = { path: p, version, ok: versionOk(version, spec) };
    if (found.ok) return found;
    seen.push(found);
    return null;
  };
  for (const dir of dirs) {
    const store = win && STORE_DIR.test(dir);
    for (const p of names.flatMap((name) => exeCandidates(dir, name, platform, env))) {
      const found = consider(p, store);
      if (found) return { tool: found, seen: [found, ...seen] };
    }
  }
  if (win && spec.pyLauncher) {
    const pyPython = o.pyPython ?? pyLauncherPython;
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
    const launchers: string[] = [];
    for (const d of [...dirs, ...(root && safeDir(root, "win32") ? [root] : [])]) {
      for (const p of exeCandidates(d, "py", platform, env)) if (!launchers.some((x) => x.toLowerCase() === p.toLowerCase()) && isExec(p)) launchers.push(p);
    }
    for (const py of launchers) {
      for (const v of supportedMinors(spec)) {
        const p = pyPython(py, v);
        const found = p && safeDir(p, "win32") ? consider(p, STORE_DIR.test(pathFor(platform).dirname(p))) : null;
        if (found) return { tool: found, seen: [found, ...seen] };
      }
    }
  }
  return { tool: null, seen };
}

/**
 * The folders worth looking in: toolPath(PATH)'s real absolute ones (find-exe safePathDirs), PATH or Windows' `Path`.
 * Windows: the saved PATH and our installers' folders after PATH, and WindowsApps moved to the very end.
 */
function toolDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, o: Pick<FindOptions, "exists" | "extra">): string[] {
  if (platform !== "win32") return safePathDirs(toolPath(env.PATH ?? env.Path, platform, { exists: o.exists }), platform);
  const dirs = safePathDirs(toolPath(env.PATH ?? env.Path, platform, { exists: o.exists, extra: o.extra ?? winExtraDirs(env) }), platform);
  return [...dirs.filter((d) => !STORE_DIR.test(d)), ...dirs.filter((d) => STORE_DIR.test(d))];
}

/** The first program called `name` on toolPath(PATH), with no version check (ffmpeg, say). Windows: `name`.exe. */
export function whichTool(name: string, env: NodeJS.ProcessEnv, o: Pick<FindOptions, "platform" | "exists" | "isExec" | "extra"> = {}): string | null {
  const platform = o.platform ?? process.platform;
  const isExec = o.isExec ?? isExecutable;
  for (const dir of toolDirs(env, platform, o)) {
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
export function findNpm(env: NodeJS.ProcessEnv, o: FindOptions = {}): FoundNpm | null {
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
