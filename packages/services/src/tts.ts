// Read aloud: bridge handlers (tts.*) and the careeros-file://tts/ media check.
// Text goes to a local process only. Read aloud always goes first: it speaks through a warm narrator worker
// (tts-worker.ts) and pauses any voice sample being made; samples are made one voice at a time, at a low CPU
// priority, only when asked for, and carry on once read aloud has nothing waiting. The same paragraph asked
// twice shares one run. Audio from a lockable folder (read with a grant) goes to its own folder, .careeros/tts-private/,
// never the shared cache. That folder is wiped on every workspace open and close and on any privacy change (so a
// crash can't leave it behind for long), and its files are served only after a fresh grant check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { insideRoot, LOCKABLE_DIRS, readRecord } from "@careeros/core";
import {
  DEFAULT_TTS_VOICE, speakable, TTS_CACHE_NAME, TTS_PREVIEW_NAME, TTS_PRIVATE_NAME, TTS_VOICES, ttsMediaUrl, voiceLabel,
  type TtsActivity, type TtsEngine, type TtsLang, type TtsOptions, type TtsPreviews, type TtsSpeakResult, type TtsStatus, type TtsVoice,
} from "@careeros/contract";
import { withInstallLock } from "./install-lock.js";
import type { ServiceContext } from "./context.js";
import type { MediaFile } from "./files.js";
import { resolveWorkspaceFile } from "./files.js";
import type { HandlerTable } from "./handlers.js";
import { cacheDirFor, cachedFile, cacheKey, clearCache, ensureCacheDir, ensurePrivateDir, privateDirFor, storeFile, storePrivate, wipePrivate } from "./tts-cache.js";
import {
  downloadModel, engineStatus, generatePreviewFiles, installSupertonic, narratorPaths, probeLanguages, synthesize, ttsChildEnv, TtsCancelled,
  type ChildLike, type NarratorPaths, type SpawnFn,
} from "./tts-runner.js";
import { NarratorWorker, type WorkerOptions } from "./tts-worker.js";
import { settingsFile } from "./settings.js";

export interface TtsDeps {
  paths: () => NarratorPaths;
  spawn?: SpawnFn;
  killTree?: (child: ChildLike, signal: NodeJS.Signals) => void;
  /** The child's environment: an allow-list, offline unless `network` (the explicit model download only). */
  env: (network?: boolean) => NodeJS.ProcessEnv;
  /** How long an engine status answer is reused. */
  statusTtlMs: number;
  synthTimeoutMs?: number;
  /**
   * Starts a warm narrator worker (`narrate.py --serve`). Without it every paragraph is a one-shot process that
   * loads the model again. Tests pass a fake, or nothing for the one-shot path.
   */
  worker?: (o: Pick<WorkerOptions, "python" | "script" | "env" | "onExit">) => NarratorWorker;
  /** How long the first paragraph waits for a cold natural voice before the Mac voice reads it instead. */
  firstChunkMs: number;
}
const DEFAULT_DEPS: TtsDeps = {
  paths: () => narratorPaths(), env: (network) => ttsChildEnv(process.env, { network }), statusTtlMs: 60_000,
  worker: (o) => new NarratorWorker(o), firstChunkMs: 2500,
};
let deps: TtsDeps = DEFAULT_DEPS;
/** Tests only: swap the process layer. Pass nothing to restore the real one. With a fake spawn and no `worker`, speech is one-shot. */
export function setTtsDeps(d?: Partial<TtsDeps>): void { deps = d ? { ...DEFAULT_DEPS, worker: undefined, ...d } : DEFAULT_DEPS; }

/** A voice sample waiting to be made, and who is waiting for it. */
interface PreviewItem { voice: TtsVoice; lang: TtsLang; dir: string; root: string; waiters: { resolve: () => void; reject: (e: Error) => void }[] }
interface Request { ac: AbortController; source: string; locked: boolean }

interface State {
  chain: Promise<unknown>;
  /** Runs in progress by cache key, with their controller (a cancelled run is never joined). */
  inflight: Map<string, { job: Promise<TtsSpeakResult>; ac: AbortController }>;
  requests: Map<string, Request>;
  /** Read-aloud paragraphs being made right now. While any are, voice samples wait. */
  interactive: number;
  worker: NarratorWorker | null;
  /** Voice samples still to make (the first is the one running or next). */
  previewQueue: PreviewItem[];
  previewRun: { item: PreviewItem; ac: AbortController; paused: boolean } | null;
  /** Private audio (key -> the locked-folder file it came from), re-checked against the lock on every serve. */
  priv: Map<string, string>;
  /** A running model download or install (one at a time), stopped by Stop and on workspace close. */
  work: AbortController | null;
  status: { at: number; value: Promise<TtsStatus> } | null;
  /** The engine's language list, read once per venv (it only changes when Supertonic is reinstalled). */
  langs: { venv: string | null; value: Promise<{ languages: string[]; note: string }> } | null;
}
const states = new WeakMap<ServiceContext, State>();
function stateOf(ctx: ServiceContext): State {
  let s = states.get(ctx);
  if (!s) {
    s = { chain: Promise.resolve(), inflight: new Map(), requests: new Map(), interactive: 0, worker: null, previewQueue: [], previewRun: null, priv: new Map(), work: null, status: null, langs: null };
    states.set(ctx, s);
  }
  return s;
}

const PREVIEW_DIR = ["settings", "voice-previews"] as const;
const isLockable = (rel: string) => (LOCKABLE_DIRS as readonly string[]).some((d) => rel === d || rel.startsWith(`${d}/`));

function status(ctx: ServiceContext, fresh = false): Promise<TtsStatus> {
  const s = stateOf(ctx);
  const now = Date.now();
  if (!fresh && s.status && now - s.status.at < deps.statusTtlMs) return s.status.value;
  const paths = deps.paths();
  const run = { spawn: deps.spawn, env: deps.env(), killTree: deps.killTree };
  const value = (async (): Promise<TtsStatus> => {
    const st = await engineStatus(paths, run);
    if (st.engine !== "supertonic") {
      return { ...st, languages: ["en"], languagesNote: st.engine === "none" ? "" : "Only English is offered until the Supertonic voice is set up." };
    }
    if (!s.langs || s.langs.venv !== paths.venvPython) {
      const langs = { venv: paths.venvPython, value: probeLanguages(paths, run) };
      s.langs = langs;
      void langs.value.then((l) => { if (l.note && s.langs === langs) s.langs = null; }); // a failed read is retried next time
    }
    const l = await s.langs.value;
    return { ...st, languages: l.languages, languagesNote: l.note };
  })().catch((): TtsStatus => ({ engine: "none", text: "The voice couldn't be checked.", hint: "Try again in a moment.", languages: ["en"], languagesNote: "" }));
  s.status = { at: now, value };
  return value;
}

/** Runs `fn` after every earlier synthesis in this window has finished (the engine is CPU-heavy). */
function queued<T>(s: State, fn: () => Promise<T>): Promise<T> {
  const run = s.chain.then(fn, fn);
  s.chain = run.catch(() => undefined);
  return run;
}

async function speak(ctx: ServiceContext, text: string, opts: TtsOptions, source: string, requestId: string): Promise<TtsSpeakResult> {
  const root = ctx.requireRoot();
  // The same lock rules as showing the file: a locked folder without a grant is refused.
  if (source) resolveWorkspaceFile(ctx, source, "read");
  const spoken = speakable(text);
  if (!spoken) throw new Error("There's nothing to read aloud here.");
  const st = await status(ctx);
  if (st.engine === "none") throw new Error(`${st.text} ${st.hint}`.trim());
  const s = stateOf(ctx);
  // Text from a lockable folder never touches the shared cache: its audio lives in tts-private/ only.
  const locked = !!source && isLockable(source);
  const forceSay = opts.engine === "macos_say";
  const engine: TtsEngine = forceSay ? "macos_say" : st.engine;
  const voice = { voice: opts.voice, lang: opts.lang };
  const key = cacheKey(spoken, voice, engine);
  const urlFor = (k: string) => ttsMediaUrl(locked ? `private-${k}.wav` : `${k}.wav`);
  const hit = locked ? privateHit(root, s, key) : cachedFile(root, key);
  if (hit) {
    if (locked) s.priv.set(key, source);
    return { url: urlFor(key), cached: true, engine, fellBack: !forceSay && engine !== "supertonic" };
  }
  const flight = `${locked ? "p" : "s"}:${key}`;
  // Join a run for the same audio, unless it was cancelled (e.g. Stop, then Listen again at once): a new request
  // must never inherit someone else's "stopped".
  const running = s.inflight.get(flight);
  if (running && !running.ac.signal.aborted) return running.job;

  const ac = new AbortController();
  s.requests.set(requestId, { ac, source, locked });
  // Read aloud goes first: a voice sample being made stops now and picks up again once nothing is waiting here.
  s.interactive += 1;
  pausePreviews(s);
  const job = (async (): Promise<TtsSpeakResult> => {
    if (ac.signal.aborted) throw cancelReason(ac);
    if (ctx.root !== root) throw new Error("The workspace changed, so reading aloud stopped.");
    const dir = locked ? ensurePrivateDir(root) : ensureCacheDir(root);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-tts-out-"));
    try {
      const out = path.join(tmp, "speech.wav");
      const r = await produce(s, deps.paths(), spoken, voice, out, ac, engine, forceSay);
      // Supertonic was expected but `say` spoke: keep it under the `say` key so a later Supertonic run isn't shadowed.
      const finalKey = r.engine === engine ? key : cacheKey(spoken, voice, r.engine);
      if (r.engine !== engine && !r.warming) s.status = null;
      if (!insideRoot(root, dir)) throw new Error("The read-aloud cache folder is outside the workspace.");
      if (ac.signal.aborted) throw cancelReason(ac); // the lock came back while it was speaking: keep nothing
      if (locked) { storePrivate(root, finalKey, out); s.priv.set(finalKey, source); } else storeFile(root, finalKey, out);
      return { url: urlFor(finalKey), cached: false, engine: r.engine, fellBack: r.fellBack, ...(r.warming ? { warming: true } : {}) };
    } catch (e) {
      throw ac.signal.aborted && e instanceof TtsCancelled ? cancelReason(ac) : e;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
  const entry = { job, ac };
  s.inflight.set(flight, entry);
  try {
    return await job;
  } finally {
    if (s.inflight.get(flight) === entry) s.inflight.delete(flight);
    if (s.requests.get(requestId)?.ac === ac) s.requests.delete(requestId);
    s.interactive -= 1;
    if (s.interactive === 0) runPreviews(ctx);
  }
}

const cancelReason = (ac: AbortController): Error => (ac.signal.reason instanceof TtsCancelled ? ac.signal.reason : new TtsCancelled());

interface Produced { engine: TtsEngine; fellBack: boolean; warming?: boolean }

/**
 * Makes one paragraph's audio. Supertonic goes through the warm worker; if the worker is still loading the model
 * when the first paragraph has waited `firstChunkMs`, the Mac voice reads that paragraph and Supertonic takes over
 * from the next one. The Mac voice (asked for, or the only one set up) and a failed worker use a one-shot run.
 */
async function produce(s: State, p: NarratorPaths, spoken: string, voice: TtsOptions, out: string, ac: AbortController, engine: TtsEngine, forceSay: boolean): Promise<Produced> {
  const run = { spawn: deps.spawn, killTree: deps.killTree, env: deps.env(), signal: ac.signal, timeoutMs: deps.synthTimeoutMs };
  const oneShot = (o: { engine?: "macos_say" } = {}) => queued(s, () => {
    if (ac.signal.aborted) throw cancelReason(ac);
    return synthesize(p, spoken, voice, out, { ...run, ...o });
  });
  if (forceSay) return oneShot({ engine: "macos_say" });
  const w = engine === "supertonic" ? workerFor(s, p) : null;
  if (!w) return oneShot();
  const inner = new AbortController();
  const onAbort = () => inner.abort(ac.signal.reason);
  ac.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const job = w.speak({ text: spoken, voice: voice.voice, lang: voice.lang, out }, inner.signal);
    if (w.state === "starting" && !w.warmFallbackUsed && p.say) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), deps.firstChunkMs); });
      const first = await Promise.race([job, late]).finally(() => clearTimeout(timer));
      if (first) return first;
      if (w.state === "starting" && !w.warmFallbackUsed) {
        // Still loading: the Mac voice reads this paragraph now; the worker keeps warming for the next one.
        w.warmFallbackUsed = true;
        job.catch(() => undefined);
        inner.abort(new TtsCancelled("Replaced by the Mac voice while the natural voice starts."));
        const r = await oneShot({ engine: "macos_say" });
        return { ...r, fellBack: true, warming: true };
      }
    }
    return await job;
  } catch (e) {
    if (ac.signal.aborted || e instanceof TtsCancelled) throw e;
    // The worker failed (crashed, didn't start): one paragraph at a time, the old way.
    return oneShot();
  } finally {
    ac.signal.removeEventListener("abort", onAbort);
  }
}

/** The warm worker for this window, started on first use; null when there's no Supertonic venv. */
function workerFor(s: State, p: NarratorPaths): NarratorWorker | null {
  if (!deps.worker || !p.venvPython || !p.script) return null;
  if (s.worker && s.worker.state !== "stopped") return s.worker;
  let made: NarratorWorker | null = null;
  made = deps.worker({ python: p.venvPython, script: p.script, env: deps.env(), onExit: () => { if (made && s.worker === made) s.worker = null; } });
  s.worker = made.state === "stopped" ? null : made;
  return s.worker;
}

/** A private file for `key`, only when this session made it (a file left by a crash is never reused; open wipes it). */
function privateHit(root: string, s: State, key: string): boolean {
  if (!s.priv.has(key)) return false;
  try { const st = fs.lstatSync(path.join(privateDirFor(root), `${key}.wav`)); return st.isFile() && st.nlink === 1 && st.size > 0; } catch { return false; }
}

function cancel(ctx: ServiceContext, requestId: string): boolean {
  const s = stateOf(ctx);
  const r = s.requests.get(requestId);
  if (!r) return false;
  r.ac.abort(new TtsCancelled());
  s.requests.delete(requestId);
  return true;
}

function previewFile(root: string, voice: string): string { return path.join(root, ...PREVIEW_DIR, `${voice}.wav`); }

function previews(ctx: ServiceContext): TtsPreviews {
  const root = ctx.requireRoot();
  const voices = TTS_VOICES.map((voice) => {
    let ok = false;
    try { const st = fs.lstatSync(previewFile(root, voice)); ok = st.isFile() && st.size > 0; } catch { ok = false; }
    return { voice, label: voiceLabel(voice), url: ok ? ttsMediaUrl(`preview-${voice}.wav`) : null };
  });
  return { voices, missing: voices.filter((v) => !v.url).length };
}

/** settings/voice-previews, made if missing; refuses a link or a file in its place. */
function previewDir(root: string): string {
  const settings = path.join(root, "settings");
  const dir = path.join(settings, PREVIEW_DIR[1]);
  for (const d of [settings, dir]) {
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(d); } catch { st = undefined; }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error("The voice previews folder isn't a real folder.");
    if (!st) fs.mkdirSync(d);
  }
  if (!insideRoot(root, dir)) throw new Error("The voice previews folder is outside the workspace.");
  return dir;
}

const BUSY = "The voice is busy with a setup, download or previews. Wait for it, or stop it first.";
const hasPreview = (root: string, voice: string) => { try { const st = fs.lstatSync(previewFile(root, voice)); return st.isFile() && st.size > 0; } catch { return false; } };

/** Queues one voice's sample (or joins the queued one) and resolves when it is made. */
function queuePreview(ctx: ServiceContext, voice: TtsVoice, lang: TtsLang): Promise<void> {
  const root = ctx.requireRoot();
  if (hasPreview(root, voice)) return Promise.resolve();
  const s = stateOf(ctx);
  if (s.work) return Promise.reject(new Error(BUSY));
  const dir = previewDir(root);
  return new Promise<void>((resolve, reject) => {
    let item = s.previewQueue.find((q) => q.voice === voice && q.root === root);
    if (!item) { item = { voice, lang, dir, root, waiters: [] }; s.previewQueue.push(item); }
    item.waiters.push({ resolve, reject });
    runPreviews(ctx);
  });
}

/** Starts the next sample when read aloud has nothing waiting. One process per voice, at a low CPU priority. */
function runPreviews(ctx: ServiceContext): void {
  const s = stateOf(ctx);
  if (s.previewRun || s.interactive > 0 || s.work || !s.previewQueue.length) return;
  const item = s.previewQueue[0]!;
  if (ctx.root !== item.root) { s.previewQueue.shift(); settle(item, new Error("The workspace changed, so the voice sample wasn't made.")); runPreviews(ctx); return; }
  const run = { item, ac: new AbortController(), paused: false };
  s.previewRun = run;
  void generatePreviewFiles(deps.paths(), item.dir, item.lang, { voices: [item.voice], spawn: deps.spawn, killTree: deps.killTree, env: deps.env(), signal: run.ac.signal })
    .then(() => hasPreview(item.root, item.voice) ? null : new Error("The voice sample couldn't be made."), (e: unknown) => e as Error)
    .then((err) => {
      if (s.previewRun === run) s.previewRun = null;
      // Paused for read aloud: it stays first in the queue and runs again when read aloud is done.
      if (run.paused && err instanceof TtsCancelled) { runPreviews(ctx); return; }
      const i = s.previewQueue.indexOf(item);
      if (i >= 0) s.previewQueue.splice(i, 1);
      settle(item, err instanceof TtsCancelled ? new Error("Making the voice samples was stopped.") : err);
      runPreviews(ctx);
    });
}

function settle(item: PreviewItem, err: Error | null) {
  for (const w of item.waiters.splice(0)) { if (err) w.reject(err); else w.resolve(); }
}

/** Read aloud needs the CPU: stop the running sample now (it is finished or not at all) and run it again later. */
function pausePreviews(s: State): void {
  const r = s.previewRun;
  if (!r || r.paused) return;
  r.paused = true;
  r.ac.abort(new TtsCancelled("Paused for read aloud."));
}

/** Clears every queued and running sample. Returns true if there was any. */
function stopPreviews(s: State, why: Error): boolean {
  const had = !!s.previewRun || s.previewQueue.length > 0;
  const queue = s.previewQueue.splice(0);
  if (s.previewRun) { s.previewRun.paused = false; s.previewRun.ac.abort(new TtsCancelled()); s.previewRun = null; }
  for (const item of queue) settle(item, why);
  return had;
}

/** One voice's sample, made on demand (the Preview button). */
async function previewVoice(ctx: ServiceContext, voice: TtsVoice, lang: TtsLang): Promise<TtsPreviews> {
  await queuePreview(ctx, voice, lang);
  return previews(ctx);
}

/** Samples for the default voice and the chosen read-aloud voice only, never all ten at once. */
async function generatePreviews(ctx: ServiceContext, lang: TtsLang): Promise<TtsPreviews> {
  const root = ctx.requireRoot();
  if (!deps.paths().venvPython) throw new Error("Voice previews need the Supertonic voice. Set it up in Settings > Voice.");
  let chosen: string | undefined;
  try {
    const values = readRecord("integrations", settingsFile(root, "integrations")) as unknown as { read_aloud?: { voice?: string } };
    chosen = values.read_aloud?.voice;
  } catch { chosen = undefined; }
  const voices = [...new Set([DEFAULT_TTS_VOICE, ...((TTS_VOICES as readonly string[]).includes(chosen ?? "") ? [chosen as TtsVoice] : [])])];
  await Promise.all(voices.map((v) => queuePreview(ctx, v, lang)));
  return previews(ctx);
}

function activity(ctx: ServiceContext): TtsActivity {
  const s = stateOf(ctx);
  const w = s.worker && s.worker.state !== "stopped" ? s.worker : null;
  const voice: TtsActivity["voice"] = w ? (w.state === "starting" ? "starting" : w.busy ? "busy" : "ready") : s.interactive > 0 ? "busy" : "off";
  return { voice, previewsLeft: s.previewQueue.length };
}

/** The explicit Setup step: downloads the Supertonic model (network), then checks the engine again. */
async function downloadVoice(ctx: ServiceContext): Promise<TtsStatus> {
  ctx.requireRoot();
  const s = stateOf(ctx);
  if (s.work || s.previewRun || s.previewQueue.length) throw new Error(BUSY);
  const ac = new AbortController();
  s.work = ac;
  try {
    await downloadModel(deps.paths(), { spawn: deps.spawn, killTree: deps.killTree, env: deps.env(true), signal: ac.signal });
  } catch (e) {
    throw e instanceof TtsCancelled ? new Error("The voice download was stopped.") : e;
  } finally { if (s.work === ac) s.work = null; }
  s.langs = null;
  // A new model: the next paragraph starts a fresh worker. A plain error (not a cancel) lets a Listen in progress
  // carry on with a one-shot run instead of stopping.
  s.worker?.stop(new Error("The voice was updated."));
  return status(ctx, true);
}

/** The explicit Setup step: installs the Supertonic package into the app's own venv, then checks the engine again. */
async function installVoice(ctx: ServiceContext): Promise<TtsStatus> {
  ctx.requireRoot();
  const s = stateOf(ctx);
  if (s.work || s.previewRun || s.previewQueue.length) throw new Error(BUSY);
  const ac = new AbortController();
  s.work = ac;
  try {
    await withInstallLock(ctx, "supertonic", "The voice engine", () => installSupertonic(deps.paths(), { spawn: deps.spawn, killTree: deps.killTree, env: deps.env(true), signal: ac.signal }));
  } catch (e) {
    throw e instanceof TtsCancelled ? new Error("Setting up the voice was stopped.") : e;
  } finally { if (s.work === ac) s.work = null; }
  s.langs = null;
  return status(ctx, true);
}

function stopVoiceWork(ctx: ServiceContext): boolean {
  const s = stateOf(ctx);
  const previewsStopped = stopPreviews(s, new Error("Making the voice samples was stopped."));
  if (!s.work) return previewsStopped;
  s.work.abort();
  s.work = null;
  return true;
}

/**
 * Deletes all private audio (made from a lockable folder's text) and stops the read-aloud runs that would make
 * more. With `all` (workspace closing) every run stops; on a privacy change only runs reading a lockable folder
 * stop, so a background job touching privacy settings never cuts off an ordinary Listen.
 */
export function purgeEphemeral(ctx: ServiceContext, root: string | null = ctx.root, o: { all?: boolean } = { all: true }): number {
  const s = stateOf(ctx);
  for (const [id, r] of s.requests) {
    if (!o.all && !r.locked) continue;
    r.ac.abort(new TtsCancelled(o.all ? "The workspace closed, so reading aloud stopped." : "That folder's privacy changed, so reading aloud stopped. Press Listen to read it again."));
    s.requests.delete(id);
  }
  s.priv.clear();
  return root ? wipePrivate(root) : 0;
}

/**
 * Session hooks. Opening a workspace wipes tts-private/ first (a crash or force-quit may have left files there);
 * closing it, and any privacy change (a lock re-engaging, a grant ending), wipe it again and stop running work.
 */
export function installTtsHooks(ctx: ServiceContext): void {
  ctx.onOpen((root) => {
    try { wipePrivate(root); } catch { /* reported by the next speak */ }
    return () => {
      const s = stateOf(ctx);
      s.work?.abort();
      s.work = null;
      stopPreviews(s, new Error("The workspace closed, so the voice sample wasn't made."));
      s.worker?.stop(); // closing the workspace or quitting the app never leaves a narrator running
      s.worker = null;
      purgeEphemeral(ctx, root);
    };
  });
  ctx.onChange((e) => { if (e.areas.includes("privacy")) purgeEphemeral(ctx, ctx.root, { all: false }); });
}

/**
 * careeros-file://tts/<name>: a cache entry (<sha256>.wav) or a voice preview (preview-F4.wav). The name is matched
 * exactly, the file must be a plain, single-named regular file inside the workspace, and it is pinned by dev/ino.
 */
export function resolveTtsMedia(ctx: ServiceContext, name: string): MediaFile {
  const root = ctx.requireRoot();
  let abs: string;
  const preview = TTS_PREVIEW_NAME.exec(name);
  const priv = TTS_PRIVATE_NAME.exec(name);
  if (priv) {
    // Private audio: only what this session made, and only while the folder it came from is still readable.
    const source = stateOf(ctx).priv.get(priv[1]!);
    if (!source) throw new Error("This audio isn't available.");
    try { resolveWorkspaceFile(ctx, source, "read"); } catch { throw new Error("This audio isn't available while the folder is locked."); }
    abs = path.join(privateDirFor(root), `${priv[1]}.wav`);
  } else if (TTS_CACHE_NAME.test(name)) abs = path.join(cacheDirFor(root), name);
  else if (preview && (TTS_VOICES as readonly string[]).includes(preview[1]!)) abs = previewFile(root, preview[1]!);
  else throw new Error("This audio isn't available.");
  let lst: fs.Stats;
  try { lst = fs.lstatSync(abs); } catch { throw new Error("This audio can't be found."); }
  if (lst.isSymbolicLink() || !lst.isFile() || lst.nlink > 1) throw new Error("This audio isn't available.");
  let real: string;
  try { real = fs.realpathSync.native(abs); } catch { throw new Error("This audio can't be opened."); }
  if (!insideRoot(root, real)) throw new Error("This audio isn't available.");
  const st = fs.statSync(real);
  if (st.dev !== lst.dev || st.ino !== lst.ino) throw new Error("This audio isn't available.");
  return { real, dev: st.dev, ino: st.ino };
}

export const ttsHandlers = {
  "tts.status": (ctx: ServiceContext) => status(ctx, true),
  "tts.speak": speak,
  "tts.cancel": cancel,
  "tts.previews": previews,
  "tts.generatePreviews": generatePreviews,
  "tts.previewVoice": previewVoice,
  "tts.activity": activity,
  "tts.clearCache": (ctx: ServiceContext) => { const root = ctx.requireRoot(); stateOf(ctx).priv.clear(); return clearCache(root) + wipePrivate(root); },
  "tts.downloadVoice": downloadVoice,
  "tts.installVoice": installVoice,
  "tts.stopVoiceWork": stopVoiceWork,
} satisfies Partial<HandlerTable>;
