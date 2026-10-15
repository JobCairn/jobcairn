import path from "node:path";
import { oneLine } from "./errors.js";
import { captionsModelFile, HF_VERSION, pickCaptionsModel, type CaptionsModel, type HfPaths } from "./hf.js";
import { cleanEnv, OFFLINE_ENV, type ProcessRunner } from "./process.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

export const TOOL_IDS = ["ffmpeg", "ffprobe", "node", "chrome", "hyperframes", "python", "narrate", "supertonic", "whisper"] as const;
export type ToolId = (typeof TOOL_IDS)[number];
export const INSTALLABLE: Record<ToolId, "ffmpeg" | "chrome" | "hyperframes" | "supertonic" | "whisper" | null> = {
  ffmpeg: "ffmpeg", ffprobe: "ffmpeg", node: null, chrome: "chrome", hyperframes: "hyperframes", python: "supertonic", narrate: null, supertonic: "supertonic", whisper: "whisper",
};
export interface ToolStatus { id: ToolId; label: string; ok: boolean; required: boolean; version: string; path: string; message: string; install: string | null }
/** `captionsModel`: the installed captions model a run uses, or null when none is installed (captions style "none"). */
export interface ToolPaths extends HfPaths { python: string; narrate: string; captionsModel: CaptionsModel | null }
export interface ToolsReport { ok: boolean; tools: ToolStatus[]; paths: ToolPaths | null; checked_at: string }
export interface ToolsEnv {
  runner: ProcessRunner; platform: NodeJS.Platform; env: Record<string, string | undefined>; home: string; pluginDir: string;
  exists(p: string): boolean; isFile(p: string): boolean; readFile(p: string): string; now(): Date;
  /** The caption style in Settings. "none" burns in no captions, so the captions model is optional. */
  captions?: string;
}

/** The captions model's row in the tools card. */
export const CAPTIONS_MODEL_MESSAGE = "About 140 MB, one-time download. Times the on-screen words to the voice. Runs on this computer.";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
// Only these two can ever be started directly by the OS loader with no interpreter involved - a
// .BAT/.CMD "shim" needs cmd.exe to run it, which is a shell by another name (and a .JS/.VBS shim
// needs a script host). Accepting only .COM/.EXE means `findOnPath` can never hand back something
// that would force the caller into running a shell just to launch it.
const WIN_EXEC_EXTS = [".COM", ".EXE"];
const WIN_DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

/** Parses the first `(major).(minor)` pair out of `re`'s capture groups. A plain `RegExp#exec`
 * call (no global flag, so it only ever runs once, from the start) stays linear even on a large
 * block of hostile text - there is no backtracking blow-up risk here because every pattern this
 * file uses anchors on a short literal prefix ("version", "v", "Python") before the digits, and
 * every digit group this file passes in is capped at `\d{1,4}` so a huge run of digits can never
 * turn into `Infinity` once `Number()`'d (an `Infinity` major version would pass any `>= N` floor). */
export function majorMinor(text: string, re: RegExp): [number, number] | null {
  const m = re.exec(text);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

function winExecExts(e: ToolsEnv): string[] {
  // "" (unset) is treated the same as missing (Fix round 1, item 7) - `??` would otherwise accept
  // an explicitly empty PATHEXT literally, which (after intersecting with WIN_EXEC_EXTS) ends up
  // at the same fallback anyway, but `||` says what's actually meant.
  const raw = (e.env.PATHEXT || DEFAULT_PATHEXT).split(";").filter(Boolean);
  const allowed = raw.filter((x) => WIN_EXEC_EXTS.includes(x.toUpperCase()));
  return allowed.length ? allowed : WIN_EXEC_EXTS;
}

/** Looks a binary up on PATH, the way a shell would - but never runs a shell to do it, and never
 * trusts a directory it can't pin down to one real, fixed location: an empty PATH entry (classic
 * `::` or a leading/trailing `:`/`;`), a literal "." or other relative entry, and - on Windows - a
 * root-relative entry with no drive letter (`\tools`, which Node's own `path.win32.isAbsolute`
 * calls "absolute" even though it actually means "the root of whichever drive happens to be
 * current," exactly the same ambient-context problem a relative entry has) are all skipped. A
 * Windows PATH entry may be wrapped in one pair of double quotes (standard, for a directory
 * containing a space); those are stripped before any of the above checks run. Only `.COM`/`.EXE`
 * are ever tried as extensions on Windows (see `WIN_EXEC_EXTS`); there is no bare-name fallback
 * there, since an extension-less match on Windows isn't reliably something the OS loader will run
 * directly. */
export function findOnPath(name: string, e: ToolsEnv): string | null {
  const isWin = e.platform === "win32";
  const p = isWin ? path.win32 : path.posix;
  const sep = isWin ? ";" : ":";
  const exts = isWin ? winExecExts(e) : [""];
  const dirs = (e.env.PATH ?? e.env.Path ?? "")
    .split(sep)
    .map((d) => (isWin && d.length >= 2 && d.startsWith('"') && d.endsWith('"') ? d.slice(1, -1) : d))
    .filter((d) => d !== "" && p.isAbsolute(d) && (!isWin || WIN_DRIVE_ABSOLUTE.test(d)));
  for (const dir of dirs) {
    for (const ext of exts) {
      const c = p.join(dir, name + ext);
      if (e.exists(c)) return c;
    }
  }
  return null;
}

/** An env var naming a path (`HYPERFRAMES_BROWSER_PATH`, `CHROME_PATH`, `npm_config_prefix`) is
 * used only when it's already an absolute path - never resolved against this process's own
 * working directory, which has nothing to do with where CareerOS or the user's tools actually
 * live. A relative value is simply ignored, not "made absolute" some other way. */
function absoluteEnvPath(e: ToolsEnv, value: string | undefined): string | null {
  if (!value) return null;
  const p = e.platform === "win32" ? path.win32 : path.posix;
  return p.isAbsolute(value) ? value : null;
}

/** Runs `cmd args` through the injected runner, with a clean environment and a timeout, purely to
 * read back a version string - never through a shell, and this is the only use this file ever
 * makes of a found binary (asking "what version are you", nothing that installs or changes
 * anything). Any failure - the process throwing on start, exiting non-zero, or being killed for
 * running past `timeoutMs` - is folded into a plain `null`, never a thrown error and never a hang:
 * the caller always gets an answer. `cwd` defaults to the user's home but can be overridden (the
 * Supertonic probe uses a neutral one instead - see `checkTools`). */
async function versionOf(e: ToolsEnv, cmd: string, args: string[], cwd: string = e.home): Promise<string | null> {
  const r = await exitOf(e, cmd, args, cwd);
  return r && r.code === 0 ? r.out : null;
}

/** Like versionOf, but keeps the exit code (narrate.py --check: 0 model here, 5 model missing, 3 not installed). Always offline. */
async function exitOf(e: ToolsEnv, cmd: string, args: string[], cwd: string = e.home): Promise<{ code: number; out: string } | null> {
  try {
    // The host env (final review M6): an app opened from Finder adds Homebrew to its PATH there, not to process.env.
    const r = await e.runner.run(cmd, args, { cwd, timeoutMs: 20_000, env: cleanEnv({ ...OFFLINE_ENV }, e.env as NodeJS.ProcessEnv) });
    return r.cancelled || r.timedOut ? null : { code: r.code, out: `${r.stdout}\n${r.stderr}` };
  } catch {
    return null;
  }
}

/** ffmpeg/ffprobe's own git/nightly build identifiers - `N-112345-gabc1234` from an ordinary git
 * checkout build, or a dated `2025-01-15-git-abcdef1234` from some static-build providers - carry
 * no `(major).(minor)` pair at all, so the ordinary version check would fail closed on a
 * perfectly good, very recent build. A git/nightly build is - by construction - never older than
 * any numbered release, so these are accepted outright rather than compared against the 6.x
 * floor, and shown as e.g. "N-112345 (development build)" instead of a bare number. */
function gitBuildVersion(id: "ffmpeg" | "ffprobe", out: string): string | null {
  const m = new RegExp(`^${id} version (?:N-(\\d{1,7})-g[0-9a-f]+|(\\d{4}-\\d{2}-\\d{2})-git-\\S+)`).exec(out);
  if (!m) return null;
  return `${m[1] ? `N-${m[1]}` : m[2]} (development build)`;
}

function chromeCandidates(e: ToolsEnv): string[] {
  const own = [absoluteEnvPath(e, e.env.HYPERFRAMES_BROWSER_PATH), absoluteEnvPath(e, e.env.CHROME_PATH)].filter((x): x is string => !!x);
  if (e.platform === "darwin") {
    return [...own, ...["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium"].flatMap((a) => [`/Applications/${a}`, `${e.home}/Applications/${a}`])];
  }
  if (e.platform === "win32") {
    const roots = [e.env.ProgramFiles, e.env["ProgramFiles(x86)"], e.env.LOCALAPPDATA].filter((x): x is string => !!x);
    return [...own, ...roots.map((r) => path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe"))];
  }
  return [...own, ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((n) => findOnPath(n, e)).filter((x): x is string => !!x)];
}

/** Reads HyperFrames's own `package.json` out of the global npm folder next to Node - never
 * `npm ls` or anything that runs npm - and treats every byte of it as hostile: malformed JSON,
 * a missing `bin`, or a `bin` that isn't a string or a plain `{command: path}` object (an array,
 * a number, an empty object) all fall through to the next candidate folder rather than throwing.
 * The resolved CLI path is also checked for containment: `bin` is joined onto the package
 * directory and then independently resolved, and the result must land *strictly inside* that
 * directory, not merely equal to it - a `bin` of "." (resolves to the folder itself), "../../x"
 * or an absolute path like "/etc/passwd" is refused, not followed. The path that was actually
 * checked - `resolvedCli`, not a path recomputed some other way afterwards - is what's returned,
 * so nothing downstream can ever run a different file than the one this function validated.
 * `version` is returned raw/unsanitised; the caller compares it exactly against `HF_VERSION` and
 * only sanitises it for display (Fix round 1, item 4). */
function hyperframesPkg(e: ToolsEnv, node: string | null): { dir: string; version: string; cli: string } | null {
  const p = e.platform === "win32" ? path.win32 : path.posix;
  const prefix = absoluteEnvPath(e, e.env.npm_config_prefix);
  const dirs = [
    ...(prefix ? [e.platform === "win32" ? p.join(prefix, "node_modules") : p.join(prefix, "lib", "node_modules")] : []),
    ...(e.platform === "win32" && e.env.APPDATA ? [p.join(e.env.APPDATA, "npm", "node_modules")] : []),
    ...(node ? (e.platform === "win32" ? [p.join(p.dirname(node), "node_modules")] : [p.join(p.dirname(node), "..", "lib", "node_modules")]) : []),
  ];
  for (const d of dirs) {
    const dir = p.join(d, "hyperframes");
    let pkg: unknown;
    try {
      pkg = JSON.parse(e.readFile(p.join(dir, "package.json")));
    } catch {
      continue; // unreadable or malformed JSON: try the next candidate folder
    }
    if (pkg === null || typeof pkg !== "object") continue;
    const rawBin = (pkg as { bin?: unknown }).bin;
    let bin: string | undefined;
    if (typeof rawBin === "string") {
      bin = rawBin;
    } else if (rawBin && typeof rawBin === "object" && !Array.isArray(rawBin)) {
      const rec = rawBin as Record<string, unknown>;
      const candidate = rec.hyperframes ?? Object.values(rec)[0];
      if (typeof candidate === "string") bin = candidate;
    }
    if (!bin) continue; // missing bin, or bin in a shape we don't recognise
    if (p.isAbsolute(bin)) continue; // an absolute bin path is refused outright
    const resolvedDir = p.resolve(dir);
    const resolvedCli = p.resolve(dir, bin);
    if (!resolvedCli.startsWith(resolvedDir + p.sep)) continue; // escapes the package folder, or resolves to the folder itself ("." etc.)
    // Deliberately uses a follows-symlinks check (`isFile`, not an `lstat`-based one): `npm link`
    // makes a package's directory (or its bin entries) into symlinks on purpose, and following
    // that is the intended behaviour, not a bypass - the containment check above already fixed
    // `resolvedCli` to a specific, lexically-validated path before a symlink target is ever
    // considered, so a directory or a dangling/non-file target still gets refused here.
    if (!e.isFile(resolvedCli)) continue;
    const version = (pkg as { version?: unknown }).version;
    return { dir, version: typeof version === "string" ? version : "", cli: resolvedCli };
  }
  return null;
}

export async function checkTools(e: ToolsEnv): Promise<ToolsReport> {
  const p = e.platform === "win32" ? path.win32 : path.posix;
  const tools: ToolStatus[] = [];
  const add = (id: ToolId, label: string, required: boolean, ok: boolean, version: string, toolPath: string, message: string) =>
    tools.push({ id, label, required, ok, version, path: toolPath, message: ok ? "" : message, install: ok ? null : INSTALLABLE[id] });

  const ffmpegExe = findOnPath("ffmpeg", e);
  const ffprobeExe = findOnPath("ffprobe", e);
  const node = findOnPath("node", e);
  const python = e.platform === "win32" ? path.win32.join(e.home, ".careeros", "venv", "Scripts", "python.exe") : `${e.home}/.careeros/venv/bin/python`;
  const pythonExists = e.exists(python);
  const neutralCwd = p.dirname(python); // never the user's home - see the Supertonic probe below

  // Every one of these actually spawns a process with its own (up to) 20s timeout; run one at a
  // time, a worst case of 5 missing/hanging tools would take ~100s. They're independent of each
  // other, so they run concurrently instead - worst case ~20s. The report built below always
  // lists tools in the same fixed order regardless of which probe happens to resolve first.
  const [ffmpegOut, ffprobeOut, nodeOut, pyOut, stOut] = await Promise.all([
    ffmpegExe ? versionOf(e, ffmpegExe, ["-version"]) : Promise.resolve(null),
    ffprobeExe ? versionOf(e, ffprobeExe, ["-version"]) : Promise.resolve(null),
    node ? versionOf(e, node, ["--version"]) : Promise.resolve(null),
    pythonExists ? versionOf(e, python, ["--version"]) : Promise.resolve(null),
    // -I (isolated mode): ignores PYTHONPATH and any user site-packages, and never adds the
    // script/cwd directory to sys.path - without it, a hostile `supertonic.py` dropped into cwd
    // (or reachable via PYTHONPATH) could be imported instead of the real package, forging a false
    // "Supertonic is installed". The cwd is the venv's own folder, never the user's home, for the
    // same reason (Fix round 1, item 9).
    // Final review I3: not just "can Python import supertonic" but "is the voice model on this computer", asked
    // offline (--no-download plus the offline env), so the check itself can never start a download.
    pythonExists ? exitOf(e, python, ["-I", p.join(e.pluginDir, "skills", "voice", "scripts", "narrate.py"), "--check", "--no-download"], neutralCwd) : Promise.resolve(null),
  ]);

  const ff = (id: "ffmpeg" | "ffprobe", exe: string | null, out: string | null) => {
    if (!exe) { add(id, id, true, false, "", "", `Videos need ${id === "ffmpeg" ? "ffmpeg to join audio and pictures" : "ffprobe (part of ffmpeg) to check finished videos"}. ${identity.name} can install it for you.`); return null; }
    const git = out ? gitBuildVersion(id, out) : null;
    const v = !git && out ? majorMinor(out, /version\s+n?(\d{1,4})\.(\d{1,4})/) : null;
    // Fails closed: a binary that exits 0 but prints something we can't read as a version number
    // or a recognised git/nightly build identifier (garbage, a format HyperFrames doesn't
    // recognise, megabytes of unrelated noise) is treated the same as one that's missing or too
    // old, not waved through on the assumption it's probably fine.
    const ok = !!git || (!!out && !!v && v[0] >= 6);
    const version = git ? oneLine(git) : v ? oneLine(`${v[0]}.${v[1]}`) : "";
    add(id, id, true, ok, version, exe, out ? `Videos need ${id} 6 or newer. You have ${v ? `${v[0]}.${v[1]}` : "an unknown version"}. ${identity.name} can update it for you.` : `${id} is installed but did not start. ${identity.name} can reinstall it for you.`);
    return ok ? exe : null;
  };
  const ffmpeg = ff("ffmpeg", ffmpegExe, ffmpegOut);
  const ffprobe = ff("ffprobe", ffprobeExe, ffprobeOut);

  const nv = nodeOut ? majorMinor(nodeOut, /v(\d{1,4})\.(\d{1,4})/) : null;
  const nodeOk = !!nv && (nv[0] > 22 || (nv[0] === 22 && nv[1] >= 13));
  add("node", "Node.js", true, nodeOk, nv ? oneLine(`${nv[0]}.${nv[1]}`) : "", node ?? "", `Videos need Node.js 22.13 or newer to run HyperFrames. Run ${identity.name} setup to install it.`);

  const chrome = chromeCandidates(e).find((c) => e.exists(c)) ?? null;
  add("chrome", "Chrome", true, !!chrome, "", chrome ?? "", `Videos need Google Chrome or Chromium to draw each frame. ${identity.name} can install Chrome for you.`);

  const hf = hyperframesPkg(e, node);
  // Raw-vs-display, per Fix round 1 item 4: hf.version is compared to HF_VERSION exactly, with no
  // sanitisation - sanitising first would let a version string carrying a hidden/invisible
  // character (e.g. a trailing bidi override) silently compare equal to the real release. Display
  // text always goes through oneLine() instead.
  const hfOk = !!hf && hf.version === HF_VERSION && e.isFile(hf.cli);
  const hfDisplayVersion = hf ? oneLine(hf.version) : "";
  add("hyperframes", "HyperFrames", true, hfOk, hfDisplayVersion, hf?.cli ?? "",
    hf ? `Videos need HyperFrames ${HF_VERSION}. You have ${hfDisplayVersion || "an unknown version"}. ${identity.name} can install the right version.` : `Videos need HyperFrames to render. ${identity.name} can install it for you.`);

  const pv = pyOut ? majorMinor(pyOut, /Python (\d{1,4})\.(\d{1,4})/) : null;
  const pyOk = !!pv && (pv[0] > 3 || (pv[0] === 3 && pv[1] >= 10));
  add("python", `${identity.name} Python`, true, pyOk, pv ? oneLine(`${pv[0]}.${pv[1]}`) : "", python, `Narration needs the ${identity.name} Python set up by the voice installer. ${identity.name} can install it for you.`);

  const narrate = p.join(e.pluginDir, "skills", "voice", "scripts", "narrate.py");
  add("narrate", "Narration script", true, e.exists(narrate), "", narrate, `The narration script is missing from this copy of ${identity.name}. Reinstall ${identity.name}.`);

  // Supertonic needs Python itself to be ok, not just the "import supertonic" probe to have
  // succeeded (Fix round 1, carried from the Task 13 review): a too-old Python can still manage to
  // import the package, but CareerOS can't trust that interpreter to actually run it the same way
  // later, so pyOk gates this just as much as the import probe does.
  // Installed but without its model: the video stops and points to Settings > Voice, the one place that downloads it.
  if (pyOk && stOut?.code === 5) {
    tools.push({ id: "supertonic", label: "Supertonic voice", required: true, ok: false, version: "", path: python, install: null,
      message: "The Supertonic voice model isn't on this computer yet. Download it in Settings > Voice, then check again." });
  } else {
    add("supertonic", "Supertonic voice", false, stOut?.code === 0 && pyOk, "", python, `Supertonic isn't installed, so videos use your computer's built-in voice. ${identity.name} can install Supertonic for you.`);
  }

  // The captions model is never fetched by a video run (that would be a download mid-run): it is a one-time install.
  // Whatever model is already here is used (small.en from an older setup, or base.en); only base.en is ever installed.
  // With captions turned off ("none") the model isn't needed at all.
  const captionsModel = pickCaptionsModel((m) => e.exists(captionsModelFile(e.home, m, p.join)));
  const needCaptions = e.captions !== "none";
  add("whisper", "Captions model", needCaptions, !!captionsModel, captionsModel ?? "", captionsModel ? captionsModelFile(e.home, captionsModel, p.join) : "",
    needCaptions ? CAPTIONS_MODEL_MESSAGE : `${CAPTIONS_MODEL_MESSAGE} Not needed while captions are off.`);

  const ok = tools.every((t) => t.ok || !t.required);
  const paths: ToolPaths | null = ok
    ? { node: node!, cli: hf!.cli, ffmpeg: ffmpeg!, ffprobe: ffprobe!, chrome, python, narrate, captionsModel }
    : null;
  return { ok, tools, paths, checked_at: e.now().toISOString() };
}
