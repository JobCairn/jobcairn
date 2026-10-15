// Runs the on-device narrator (plugin/skills/voice/scripts/narrate.py) for read aloud.
// No shell: the command and its arguments are an array. Every run has a timeout, and a cancel or a timeout
// kills the whole process group (python, ffmpeg and `say` children included).
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { findTool, PYTHON, toolPath, whichTool } from "./toolchain.js";
import { INSTALL_PAGE_URL } from "@careeros/contract";
import { DEFAULT_TTS_LANG, TTS_LANG_CODE, type TtsEngine, type TtsLang, type TtsOptions, type TtsStatus } from "@careeros/contract";

export interface ChildLike {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type SpawnFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; detached: boolean; shell: false; stdio: ["ignore", "pipe", "pipe"] }) => ChildLike;

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  /** How long to wait after SIGTERM before SIGKILL. */
  graceMs?: number;
  /** Kills the child and everything it started. Injected in tests. */
  killTree?: (child: ChildLike, signal: NodeJS.Signals) => void;
}
export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; spawnError: string | null }

const KEEP = 64 * 1024;
const tail = (s: string) => (s.length > KEEP ? s.slice(-KEEP) : s);

export function killProcessTree(child: ChildLike, signal: NodeJS.Signals): void {
  // The child leads its own process group (spawned detached), so a negative pid reaches its children too.
  if (child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* group gone or not ours: fall back to the child */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** macOS GUI apps start without Homebrew on PATH (ffmpeg and a new python3 live there): its folders go first. */
export function toolEnv(base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return { ...base, PATH: toolPath(base.PATH, platform) };
}

/** What a narrator child may see: tools, home, locale, the venv and the Hugging Face cache. Nothing else. */
const CHILD_ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "VIRTUAL_ENV", "HF_HOME", "HF_HUB_CACHE", "XDG_CACHE_HOME"] as const;
/** Only the explicit model download may also use the person's proxy and certificate settings. */
const DOWNLOAD_ENV_ALLOW = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"] as const;
export const OFFLINE_ENV = { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } as const;

/**
 * The environment for a narrator child. Read aloud (the default) is offline: HF_HUB_OFFLINE and TRANSFORMERS_OFFLINE
 * are set, so no library can fetch anything. `network` is only for the explicit model download in Setup.
 */
export function ttsChildEnv(base: NodeJS.ProcessEnv = process.env, o: { network?: boolean } = {}): NodeJS.ProcessEnv {
  const withTools = toolEnv({ PATH: base.PATH ?? "" });
  const out: NodeJS.ProcessEnv = {};
  for (const k of [...CHILD_ENV_ALLOW, ...(o.network ? DOWNLOAD_ENV_ALLOW : [])]) if (base[k] !== undefined) out[k] = base[k];
  out.PATH = withTools.PATH;
  return o.network ? out : { ...out, ...OFFLINE_ENV };
}
/** Forces offline on whatever env a caller passed (belt and braces for every non-download run). */
const offline = (env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => ({ ...ttsChildEnv(env ?? process.env), ...OFFLINE_ENV });

export function runProcess(cmd: string, args: string[], o: RunOptions): Promise<RunResult> {
  const spawn = o.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const killTree = o.killTree ?? killProcessTree;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let done = false;
    let child: ChildLike;
    let hard: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: Omit<RunResult, "stdout" | "stderr" | "timedOut" | "cancelled">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (hard) clearTimeout(hard);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ ...r, stdout: tail(stdout), stderr: tail(stderr), timedOut, cancelled });
    };
    const stop = () => {
      killTree(child, "SIGTERM");
      hard = setTimeout(() => killTree(child, "SIGKILL"), o.graceMs ?? 2000);
      hard.unref?.();
    };
    const onAbort = () => { if (!done) { cancelled = true; stop(); } };
    const timer = setTimeout(() => { if (!done) { timedOut = true; stop(); } }, o.timeoutMs);
    timer.unref?.();
    if (o.signal?.aborted) {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, cancelled: true, spawnError: null });
      return;
    }
    try {
      child = spawn(cmd, args, { env: o.env ?? process.env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ code: null, spawnError: (e as Error).message });
      return;
    }
    o.signal?.addEventListener("abort", onAbort);
    child.stdout?.on("data", (d: Buffer | string) => { stdout = tail(stdout + d.toString()); });
    child.stderr?.on("data", (d: Buffer | string) => { stderr = tail(stderr + d.toString()); });
    child.on("error", (e) => finish({ code: null, spawnError: e.message }));
    child.on("close", (code) => finish({ code, spawnError: null }));
  });
}

// ---- the narrator --------------------------------------------------------------------------

export interface NarratorPaths {
  /** $HOME/.careeros/venv/bin/python, when it exists (Supertonic lives there). */
  venvPython: string | null;
  /** A python3 new enough for the voice (toolchain PYTHON), to create the venv and run the `say` fallback. */
  systemPython: string | null;
  /** Any python3 on PATH, never run to check it: only for the macOS `say` fallback when no new one is here. */
  anyPython?: string | null;
  script: string | null;
  say: string | null;
  ffmpeg: string | null;
}

const executable = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

/** Where narrate.py is: CAREEROS_PLUGIN_ROOT, else the repo's plugin/ folder above this module. */
export function findNarratorScript(env: NodeJS.ProcessEnv = process.env, from = import.meta.dirname): string | null {
  const rel = path.join("skills", "voice", "scripts", "narrate.py");
  if (env.CAREEROS_PLUGIN_ROOT) {
    const p = path.join(env.CAREEROS_PLUGIN_ROOT, rel);
    return fs.existsSync(p) ? p : null;
  }
  let dir = from;
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, "plugin", rel);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** $HOME/.careeros/venv: the app's own Python environment for the on-device voice, separate from system Python. */
export function careerosVenvDir(): string {
  return path.join(os.homedir(), ".careeros", "venv");
}

export function narratorPaths(env: NodeJS.ProcessEnv = toolEnv()): NarratorPaths {
  const venv = path.join(careerosVenvDir(), "bin", "python");
  return {
    venvPython: executable(venv) ? venv : null,
    systemPython: findTool(PYTHON, env).tool?.path ?? null,
    anyPython: whichTool("python3", env),
    script: findNarratorScript(env),
    say: whichTool("say", env),
    ffmpeg: whichTool("ffmpeg", env),
  };
}

/** Where the voice's tools are installed in the app: Settings > Voice has the Install buttons. */
const SETUP_HINT = "Set it up in Settings > Voice.";
const REINSTALL_HINT = `Download ${identity.name} again from ${INSTALL_PAGE_URL}.`;
const DOWNLOAD_TEXT = "The Supertonic voice isn't downloaded yet.";
const DOWNLOAD_HINT = "Download it in Settings > Voice. Until then the macOS voice reads aloud.";
const INSTALL_TEXT = "The natural voice (Supertonic) isn't set up on this Mac yet.";
const INSTALL_HINT = "Set it up in Settings > Voice. It installs once, then reads offline for free.";

type EngineState = Omit<TtsStatus, "languages" | "languagesNote">;

/**
 * Which engine reading aloud can use. With the venv, narrate's `--check` loads the model with downloads off (offline
 * env too): exit 0 means the model files are here, 5 means they aren't (Settings offers the download).
 */
export async function engineStatus(p: NarratorPaths, o: Pick<RunOptions, "spawn" | "env" | "killTree"> = {}): Promise<EngineState> {
  if (!p.script) return { engine: "none", text: "The voice isn't installed with this copy of the app.", hint: REINSTALL_HINT };
  if (!p.ffmpeg) return { engine: "none", text: "ffmpeg is missing, so the voice can't run.", hint: "Install ffmpeg in Settings > Voice." };
  let needsDownload = false;
  if (p.venvPython) {
    const r = await runProcess(p.venvPython, [p.script, "--check", "--no-download"], { ...o, env: offline(o.env), timeoutMs: 30_000 });
    if (r.code === 0) return { engine: "supertonic", text: "Supertonic voice is ready. It runs on this Mac, offline.", hint: "" };
    needsDownload = r.code === 5;
  }
  if (needsDownload) {
    return p.say ? { engine: "macos_say", text: DOWNLOAD_TEXT, hint: DOWNLOAD_HINT, needsDownload } : { engine: "none", text: DOWNLOAD_TEXT, hint: "Download it in Settings > Voice.", needsDownload };
  }
  // No venv at all (but Python is on this Mac): offer the in-app installer instead of pointing at the setup script.
  if (p.say && !p.venvPython && p.systemPython) {
    return { engine: "macos_say", text: INSTALL_TEXT, hint: INSTALL_HINT, needsInstall: true };
  }
  if (p.say && (p.venvPython || p.systemPython || p.anyPython)) {
    const hint = p.venvPython ? "For the Supertonic voice, set it up again in Settings > Voice." : `For the Supertonic voice, install ${PYTHON.label} in Settings > Voice, then install the voice.`;
    return { engine: "macos_say", text: "Using the macOS voice. Supertonic isn't set up yet.", hint };
  }
  return { engine: "none", text: "No voice is set up on this computer.", hint: p.say ? `Install ${PYTHON.label} in Settings > Voice.` : SETUP_HINT };
}

/**
 * Reads the supported languages from the installed supertonic package without loading the model: it looks for a
 * list-like attribute (SUPPORTED_LANGUAGES, LANGUAGES, ...) on the package, a few submodules and the TTS class.
 * Never calls anything, so it can't trigger a model download.
 */
export const LANGUAGE_PROBE = [
  "import importlib, json",
  "import supertonic as s",
  "names = ('SUPPORTED_LANGUAGES', 'SUPPORTED_LANGS', 'AVAILABLE_LANGUAGES', 'LANGUAGES', 'LANGS', 'LANGUAGE_CODES', 'supported_languages', 'languages')",
  "objs = [s]",
  "for sub in ('config', 'constants', 'languages', 'utils', 'tts', 'core'):",
  "    try: objs.append(importlib.import_module('supertonic.' + sub))",
  "    except Exception: pass",
  "objs += [getattr(o, 'TTS') for o in list(objs) if isinstance(getattr(o, 'TTS', None), type)]",
  "best = []",
  "for o in objs:",
  "    for n in names:",
  "        v = getattr(o, n, None)",
  "        if isinstance(v, dict): v = list(v.keys())",
  "        if isinstance(v, (list, tuple, set, frozenset)) and v and all(isinstance(x, str) for x in v) and 'en' in v and len(v) > len(best): best = sorted(set(v))",
  "print(json.dumps({'languages': best}))",
].join("\n");

const LANG_FALLBACK_NOTE = "Only English is offered because the voice engine's language list couldn't be read.";

/** The engine's languages, or ["en"] with a note. One short python run; the caller caches the answer. */
export async function probeLanguages(p: NarratorPaths, o: Pick<RunOptions, "spawn" | "env" | "killTree"> = {}): Promise<{ languages: string[]; note: string }> {
  const fallback = { languages: [DEFAULT_TTS_LANG], note: LANG_FALLBACK_NOTE };
  if (!p.venvPython) return { languages: [DEFAULT_TTS_LANG], note: "Only English is offered until the Supertonic voice is set up." };
  const r = await runProcess(p.venvPython, ["-c", LANGUAGE_PROBE], { ...o, env: offline(o.env), timeoutMs: 20_000 });
  if (r.code !== 0) return fallback;
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as { languages?: unknown };
    const langs = Array.isArray(out.languages) ? out.languages.filter((x): x is string => typeof x === "string" && TTS_LANG_CODE.test(x)).slice(0, 200) : [];
    if (!langs.includes(DEFAULT_TTS_LANG)) return fallback;
    return { languages: [DEFAULT_TTS_LANG, ...langs.filter((l) => l !== DEFAULT_TTS_LANG).sort()], note: "" };
  } catch { return fallback; }
}

/** A run stopped on purpose. The default sentence is for the person's own Stop; other causes pass their own. */
export class TtsCancelled extends Error {
  constructor(message = "Reading aloud was stopped.") { super(message); this.name = "Cancelled"; }
}

/**
 * Silence after each read-aloud chunk. Kept tiny: the next chunk starts the moment this one ends, and sentence
 * pauses come from punctuation, so a longer tail would be heard as a gap between chunks.
 */
export const CHUNK_TAIL_S = 0.06;

export interface SynthOptions extends Pick<RunOptions, "spawn" | "env" | "signal" | "killTree" | "graceMs"> {
  timeoutMs?: number;
  /** Speak with the macOS voice even when Supertonic is set up (the person asked for it, or Supertonic is warming up). */
  engine?: "macos_say";
}

/**
 * Speaks one paragraph into `outWav`. With the venv it asks for Supertonic (narrate falls back to `say` by itself);
 * without it, a system python runs narrate with `--engine macos_say`. Throws a plain sentence on failure.
 */
export async function synthesize(p: NarratorPaths, text: string, opts: TtsOptions, outWav: string, o: SynthOptions = {}): Promise<{ engine: TtsEngine; fellBack: boolean }> {
  const python = p.venvPython ?? p.systemPython ?? p.anyPython ?? null;
  if (!p.script || !python) throw new Error(`No voice is set up on this computer. ${SETUP_HINT}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-tts-"));
  try {
    const textFile = path.join(tmp, "text.txt");
    // narrate.py skips lines that start with "#" (script notes); spoken text is one line, so say it instead.
    fs.writeFileSync(textFile, `${text.replace(/\s+/g, " ").replace(/^\s*#\s*/, "number ")}\n`, { mode: 0o600 });
    const args = [p.script, "--text-file", textFile, "--out", outWav, "--timing", path.join(tmp, "timing.json"),
      // Expressions are for videos only; read aloud never downloads (the model comes from Setup).
      "--voice", opts.voice, "--lang", opts.lang, "--no-expressions", "--no-download",
      "--lead", "0", "--gap", "0", "--tail", String(CHUNK_TAIL_S)];
    const forced = o.engine === "macos_say";
    if (!p.venvPython || forced) args.push("--engine", "macos_say");
    const r = await runProcess(python, args, { ...o, env: offline(o.env), timeoutMs: o.timeoutMs ?? 120_000 });
    if (r.cancelled) throw o.signal?.reason instanceof TtsCancelled ? o.signal.reason : new TtsCancelled();
    if (r.timedOut) throw new Error("The voice took too long on this paragraph, so it was stopped.");
    if (r.spawnError) throw new Error(`The voice couldn't start. ${SETUP_HINT}`);
    if (r.code !== 0) {
      if (r.code === 3) throw new Error(`No voice engine is available. ${SETUP_HINT}`);
      throw new Error("The voice couldn't read this paragraph.");
    }
    const line = r.stdout.trim().split("\n").pop() ?? "";
    let out: { ok?: boolean; engine?: string; fell_back?: boolean } = {};
    try { out = JSON.parse(line) as typeof out; } catch { /* checked below */ }
    if (!out.ok || !fs.existsSync(outWav)) throw new Error("The voice couldn't read this paragraph.");
    const engine: TtsEngine = out.engine === "supertonic" ? "supertonic" : "macos_say";
    // A Mac voice the person chose isn't a fallback; one used because Supertonic is missing is.
    return { engine, fellBack: forced ? false : !p.venvPython || !!out.fell_back };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Lower CPU priority for background samples, so read aloud and the rest of the Mac stay quick. */
export const PREVIEW_NICE = 10;

/**
 * Samples for the given preset voices (one process per call) into `outDir` (needs Supertonic). The app asks for one
 * voice at a time, at a low priority, so a sample can be stopped between voices without losing finished work.
 */
export async function generatePreviewFiles(p: NarratorPaths, outDir: string, lang: TtsLang, o: SynthOptions & { voices?: readonly string[] } = {}): Promise<void> {
  if (!p.script || !p.venvPython) throw new Error(`Voice previews need the Supertonic voice. ${SETUP_HINT}`);
  const args = [p.script, "--preview", "--no-download", "--out-dir", outDir, "--lang", lang, "--nice", String(PREVIEW_NICE)];
  if (o.voices?.length) args.push("--voices", o.voices.join(","));
  const r = await runProcess(p.venvPython, args, { ...o, env: offline(o.env), timeoutMs: o.timeoutMs ?? (o.voices?.length ? 3 * 60_000 : 15 * 60_000) });
  if (r.cancelled) throw new TtsCancelled();
  if (r.timedOut) throw new Error("Making the previews took too long, so it was stopped.");
  if (r.code !== 0) throw new Error(`The previews couldn't be made. ${SETUP_HINT}`);
}

/**
 * Downloads the Supertonic model: the one read-aloud run allowed on the network, started only by the person's click
 * in Settings > Voice. Cancellable; 30-minute limit.
 */
export async function downloadModel(p: NarratorPaths, o: SynthOptions = {}): Promise<void> {
  if (!p.script || !p.venvPython) throw new Error(`The Supertonic voice isn't installed. ${SETUP_HINT}`);
  const env = ttsChildEnv(o.env ?? process.env, { network: true });
  const r = await runProcess(p.venvPython, [p.script, "--download"], { ...o, env, timeoutMs: o.timeoutMs ?? 30 * 60_000 });
  if (r.cancelled) throw new TtsCancelled();
  if (r.timedOut) throw new Error("The voice download took too long, so it was stopped. Try again on a faster connection.");
  if (r.code !== 0) throw new Error("The voice couldn't be downloaded. Check the internet connection and try again.");
}

/**
 * The Supertonic Python package itself (not the model: that stays the explicit {@link downloadModel} step).
 * Pinned, not `--upgrade`, so a working setup never changes under the person without them asking.
 */
export const SUPERTONIC_PINNED_VERSION = "1.3.1";

export interface InstallStage { id: "venv" | "package"; text: string }
export const INSTALL_STAGES: readonly InstallStage[] = [
  { id: "venv", text: "Creating a private Python environment for the voice…" },
  { id: "package", text: "Installing the voice engine…" },
];

/**
 * Sets up `~/.careeros/venv`: a fresh virtual environment (system Python, never touched otherwise), then one
 * pinned `pip install` of the Supertonic package into it. Network only for the pip install; the model itself is
 * never fetched here (that is the separate, explicit `downloadModel` step from a click in Settings > Voice).
 * One step at a time, array arguments, no shell; cancellable, with a plain sentence on every failure.
 */
export async function installSupertonic(
  p: Pick<NarratorPaths, "systemPython">,
  o: SynthOptions & { onProgress?: (stage: InstallStage) => void } = {},
): Promise<void> {
  if (!p.systemPython) throw new Error(`The voice needs ${PYTHON.label}. Install it in Settings > Voice, then try again.`);
  const venvDir = careerosVenvDir();
  o.onProgress?.(INSTALL_STAGES[0]!);
  const mk = await runProcess(p.systemPython, ["-m", "venv", venvDir], { ...o, env: offline(o.env), timeoutMs: o.timeoutMs ?? 60_000 });
  if (mk.cancelled) throw new TtsCancelled();
  if (mk.timedOut) throw new Error("Setting up the voice took too long, so it was stopped.");
  if (mk.code !== 0) throw new Error("The private Python environment couldn't be created.");

  o.onProgress?.(INSTALL_STAGES[1]!);
  const pip = path.join(venvDir, "bin", "pip");
  const env = ttsChildEnv(o.env ?? process.env, { network: true });
  const install = await runProcess(pip, ["install", `supertonic==${SUPERTONIC_PINNED_VERSION}`], { ...o, env, timeoutMs: o.timeoutMs ?? 10 * 60_000 });
  if (install.cancelled) throw new TtsCancelled();
  if (install.timedOut) throw new Error("Installing the voice engine took too long, so it was stopped. Try again on a faster connection.");
  if (install.code !== 0) throw new Error("The voice engine couldn't be installed. Check the internet connection and try again.");
}
