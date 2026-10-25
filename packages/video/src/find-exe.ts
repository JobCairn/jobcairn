// Finding a program on PATH the way a shell would, without running one. Shared by video's tools check and services'
// toolchain (services depends on video, so it lives here, next to the process runner both use).
import path from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
// Only these two can ever be started directly by the OS loader with no interpreter involved - a
// .BAT/.CMD "shim" needs cmd.exe to run it, which is a shell by another name (and a .JS/.VBS shim
// needs a script host). Accepting only .COM/.EXE means a finder here can never hand back something
// that would force the caller into running a shell just to launch it. npm's shims (npm.cmd,
// agent-browser.cmd) are resolved to what they run instead: see services' toolchain findNpm and chrome helper.
const WIN_EXEC_EXTS = [".COM", ".EXE"];
const WIN_DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

/** Windows variables a program needs to start at all (system DLLs, temp, its own settings). No secrets. */
export const WIN_SYSTEM_ENV_KEYS = ["SystemRoot", "SYSTEMROOT", "windir", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "ComSpec"] as const;

/** PATH as Windows spells it too: a copy of process.env there keeps the key as `Path`. */
export const pathVarOf = (env: Record<string, string | undefined>): string => env.PATH ?? env.Path ?? "";

/** The path module for `platform`, so a simulated Windows run on a Mac joins and checks paths the Windows way. */
export const pathFor = (platform: NodeJS.Platform): path.PlatformPath => (platform === "win32" ? path.win32 : path.posix);

/** The PATHEXT extensions that can start without a shell (.COM/.EXE), in PATHEXT's order. "" counts as unset. */
export function winExecExts(env: Record<string, string | undefined>): string[] {
  const raw = (env.PATHEXT || DEFAULT_PATHEXT).split(";").filter(Boolean);
  const allowed = raw.filter((x) => WIN_EXEC_EXTS.includes(x.toUpperCase()));
  return allowed.length ? allowed : WIN_EXEC_EXTS;
}

/**
 * Is `dir` one real, fixed folder? Never an empty entry, "." or another relative one, and on Windows never a
 * root-relative `\tools` with no drive letter (Node's `path.win32.isAbsolute` accepts it, but it means "whichever
 * drive is current"). A Windows entry may be wrapped in one pair of double quotes; pass it through `unquote` first.
 */
export function safeDir(dir: string, platform: NodeJS.Platform): boolean {
  if (!dir) return false;
  return platform === "win32" ? WIN_DRIVE_ABSOLUTE.test(dir) : path.posix.isAbsolute(dir);
}

const unquote = (d: string, platform: NodeJS.Platform) => (platform === "win32" && d.length >= 2 && d.startsWith('"') && d.endsWith('"') ? d.slice(1, -1) : d);

/** The folders of a PATH-style list worth looking in, in order, quotes stripped, unsafe ones (see safeDir) left out. */
export function safePathDirs(pathVar: string, platform: NodeJS.Platform): string[] {
  return pathVar.split(platform === "win32" ? ";" : ":").map((d) => unquote(d, platform)).filter((d) => safeDir(d, platform));
}

/**
 * Every file `name` could be in `dir`, in order. POSIX: just `dir/name`. Windows: `name` plus each runnable PATHEXT
 * extension, or `name` as given when it already ends in one (`python.exe`). Never an extension-less file or a shim.
 */
export function exeCandidates(dir: string, name: string, platform: NodeJS.Platform, env: Record<string, string | undefined> = {}): string[] {
  const p = pathFor(platform);
  if (platform !== "win32") return [p.join(dir, name)];
  const exts = winExecExts(env);
  const own = p.extname(name).toUpperCase();
  if (own && WIN_EXEC_EXTS.includes(own)) return [p.join(dir, name)];
  return exts.map((ext) => p.join(dir, name + ext));
}

/** The first `name` in PATH's safe folders that `exists` accepts, or null. Never runs anything. */
export function findExecutable(name: string, o: { platform: NodeJS.Platform; env: Record<string, string | undefined>; exists: (p: string) => boolean }): string | null {
  for (const dir of safePathDirs(pathVarOf(o.env), o.platform)) {
    for (const c of exeCandidates(dir, name, o.platform, o.env)) if (o.exists(c)) return c;
  }
  return null;
}
