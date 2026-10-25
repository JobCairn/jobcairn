// Windows: where a tool our setup installed can be found when the app's PATH is older than the install (the app
// started first, so it never got the new PATH). Two sources: the PATH Windows has saved (the registry, read with
// reg.exe), and the folders our installers use. Also Git Bash, which Claude Code needs on Windows.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { safeDir, safePathDirs } from "@careeros/video";

type Env = Record<string, string | undefined>;

/** Where Windows keeps the saved PATH: the machine's, then the person's (Windows builds PATH in that order). */
export const REG_PATH_KEYS = ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "HKCU\\Environment"] as const;
const REG_TIMEOUT_MS = 2_000;
const MACHINE_PATH_TTL_MS = 5_000;

/** An env value by name, any case (Windows names are case-insensitive; a copied env may say Path or SystemRoot). */
function envGet(env: Env, name: string): string | undefined {
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : env[k];
}

/** `%USERPROFILE%\x` -> `C:\Users\alex\x`. Null when a variable isn't set (the folder can't be known). */
export function expandWinVars(s: string, env: Env): string | null {
  let missing = false;
  const out = s.replace(/%([^%;]+)%/g, (_m, name: string) => {
    const v = envGet(env, name);
    if (v === undefined || v === "") { missing = true; return ""; }
    return v;
  });
  return missing ? null : out;
}

/** The folders in `reg query <key> /v Path`'s output, %variables% expanded, unsafe ones left out. */
export function parseRegPath(out: string, env: Env): string[] {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(out);
  if (!m) return [];
  const dirs: string[] = [];
  for (const raw of m[1]!.trim().split(";")) {
    const d = expandWinVars(raw.trim(), env);
    if (d) dirs.push(d);
  }
  return safePathDirs(dirs.join(";"), "win32");
}

/** Runs `reg query <key> /v Path` and returns its output, or null. */
export type RegQuery = (key: string) => string | null;

/** reg.exe by its full path (never by name, so a PATH folder can't stand in for it): hidden, 2 s limit, no shell. */
export function regQuery(env: Env = process.env): RegQuery {
  const root = envGet(env, "SystemRoot") ?? envGet(env, "windir") ?? "C:\\Windows";
  const reg = path.win32.join(root, "System32", "reg.exe");
  return (key) => {
    if (!safeDir(reg, "win32")) return null;
    try {
      return execFileSync(reg, ["query", key, "/v", "Path"], { encoding: "utf8", timeout: REG_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch { return null; }
  };
}

/** Windows' saved PATH folders (machine, then the person's), read now. A key that can't be read adds nothing. */
export function readMachinePath(env: Env = process.env, query: RegQuery = regQuery(env)): string[] {
  const out: string[] = [];
  for (const key of REG_PATH_KEYS) {
    const text = query(key);
    if (text) for (const d of parseRegPath(text, env)) if (!out.some((x) => x.toLowerCase() === d.toLowerCase())) out.push(d);
  }
  return out;
}

let machineCache: { at: number; dirs: string[] } | null = null;

/** readMachinePath for this computer, read at most once every few seconds (one Setup check asks several times). */
export function cachedMachinePath(now = Date.now()): string[] {
  if (process.platform !== "win32") return [];
  if (!machineCache || now - machineCache.at > MACHINE_PATH_TTL_MS) machineCache = { at: now, dirs: readMachinePath(process.env) };
  return machineCache.dirs;
}

/** Python versions whose usual folders are searched, newest first (PYTHON's range in toolchain.ts). */
export const WIN_PYTHON_FOLDERS = ["Python314", "Python313", "Python312", "Python311"] as const;

const localAppData = (env: Env): string | undefined => {
  const v = envGet(env, "LOCALAPPDATA");
  if (v) return v;
  const home = envGet(env, "USERPROFILE");
  return home ? path.win32.join(home, "AppData", "Local") : undefined;
};

/**
 * Where our Windows installers (winget, python.org) put the tools: Node.js, Python 3.14 to 3.11 and its `py`
 * launcher, and ffmpeg (winget's Links folder, then Gyan.FFmpeg's own bin folders, newest first).
 */
export function winKnownDirs(env: Env, readdir: (dir: string) => string[] = safeReaddir): string[] {
  const j = path.win32.join;
  const pf = envGet(env, "ProgramFiles") || "C:\\Program Files";
  const local = localAppData(env);
  const dirs: string[] = [j(pf, "nodejs")];
  if (local) dirs.push(j(local, "Programs", "nodejs"));
  if (local) dirs.push(...WIN_PYTHON_FOLDERS.map((v) => j(local, "Programs", "Python", v)));
  dirs.push(...WIN_PYTHON_FOLDERS.map((v) => j(pf, v)));
  if (local) dirs.push(j(local, "Programs", "Python", "Launcher"));
  if (local) {
    const winget = j(local, "Microsoft", "WinGet");
    dirs.push(j(winget, "Links"));
    const pkgs = j(winget, "Packages");
    const desc = (a: string, b: string) => b.localeCompare(a, "en", { numeric: true });
    for (const pkg of readdir(pkgs).filter((n) => /^Gyan\.FFmpeg/i.test(n)).sort(desc)) {
      for (const sub of readdir(j(pkgs, pkg)).sort(desc)) dirs.push(j(pkgs, pkg, sub, "bin"));
    }
  }
  return dirs.filter((d) => safeDir(d, "win32"));
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** Test seams for winExtraDirs. */
export interface WinDirSeams { machinePath?: () => string[]; readdir?: (dir: string) => string[] }

/** The folders searched after PATH on Windows: the saved PATH, then the installers' folders (each once). */
export function winExtraDirs(env: Env, o: WinDirSeams = {}): string[] {
  const out: string[] = [];
  for (const d of [...(o.machinePath ?? cachedMachinePath)(), ...winKnownDirs(env, o.readdir)]) if (!out.some((x) => x.toLowerCase() === d.toLowerCase())) out.push(d);
  return out;
}

/** winExtraDirs for this computer's own environment; nothing anywhere but Windows. */
export function defaultWinExtraDirs(): string[] {
  return process.platform === "win32" ? winExtraDirs(process.env) : [];
}

/**
 * Windows: Git for Windows' bash.exe, which Claude Code runs its Bash tool with, or null. In order: a
 * CLAUDE_CODE_GIT_BASH_PATH the person set (Claude Code's own setting for a Git in an unusual place), Git's usual
 * folders (all users, one user, 32-bit), then from a git.exe on PATH or the saved PATH (`<Git>\cmd\git.exe` means
 * `<Git>\bin\bash.exe`). Only a bash.exe that is there counts. Checked by file, never run.
 */
export function findGitBash(h: { env: Env; exists?: (p: string) => boolean; machinePath?: () => string[] }): string | null {
  const exists = h.exists ?? fs.existsSync;
  const j = path.win32.join;
  const own = envGet(h.env, "CLAUDE_CODE_GIT_BASH_PATH");
  const local = localAppData(h.env);
  const pf86 = envGet(h.env, "ProgramFiles(x86)");
  const fixed = [
    own && /\.exe$/i.test(own) ? own : null,
    j(envGet(h.env, "ProgramFiles") || "C:\\Program Files", "Git", "bin", "bash.exe"),
    local ? j(local, "Programs", "Git", "bin", "bash.exe") : null,
    pf86 ? j(pf86, "Git", "bin", "bash.exe") : null,
  ];
  for (const p of fixed) if (p && safeDir(p, "win32") && exists(p)) return p;
  const dirs = [...safePathDirs(envGet(h.env, "PATH") ?? "", "win32"), ...(h.machinePath ?? cachedMachinePath)()];
  for (const d of dirs) {
    if (!exists(j(d, "git.exe"))) continue;
    // git.exe lives in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
    const base = path.win32.basename(d).toLowerCase();
    const parent = path.win32.dirname(d);
    const root = base === "bin" && path.win32.basename(parent).toLowerCase().startsWith("mingw") ? path.win32.dirname(parent) : parent;
    const bash = j(root, "bin", "bash.exe");
    if (exists(bash)) return bash;
  }
  return null;
}
