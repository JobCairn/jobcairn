import fs from "node:fs";
import path from "node:path";
import { insideRoot } from "@careeros/core";
import { CancelledError, lastLine, oneLine, VideoError } from "./errors.js";
import { OFFLINE_ENV, cleanEnv, type ProcessRunner } from "./process.js";
import type { VoiceType, Word } from "./types.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

export interface NarrationTiming {
  total: number;
  paragraphs: { index: number; text: string; start: number; end: number }[];
  words_estimated: Word[];
  engine: string;
  voice: string;
  fell_back: boolean;
}
/**
 * `textFile`: the script to read, relative to the folder (default script.txt; early narration reads a copy taken
 * when it started, so a fix pass writing script.txt can't change it mid-run). `cacheDir`: a folder (relative to the
 * video folder) where each paragraph's audio is kept, so a re-narration only makes the paragraphs that changed.
 */
export interface NarrateInput { root: string; folder: string; voiceType: VoiceType; signal: AbortSignal; onLine?(line: string): void; textFile?: string; cacheDir?: string }
/** `made` / `reused`: paragraphs synthesised this time, and taken from the cache (absent when unknown). */
export interface NarrateResult { total: number; engine: string; voice: string; fell_back: boolean; made?: number; reused?: number }
/** The paragraph cache folder in a video folder (kept between runs, cleared when the video is replaced). */
export const NARRATION_CACHE = "narration-cache";

/** A relative path inside the folder: not absolute, no "..", not starting with "-". */
function safeRel(rel: string, what: string): string {
  if (!rel || path.isAbsolute(rel) || rel.startsWith("-") || rel.split(/[\\/]/).includes("..")) throw new VideoError("bad_arg", `the ${what} must be a safe relative path.`);
  return rel;
}
export interface Narrator { narrate(i: NarrateInput): Promise<NarrateResult> }

// Documents all 3 of narrate.py's exit codes (Fix round 1, item 8, so the exported map matches
// the brief), but only 2 ("bad input") and 3 ("engine missing") ever have their entry actually
// shown: neither carries any useful diagnostic text worth echoing. 4's entry here is never used -
// see the `code === 4` branch below, which always builds its message from the tool's own last
// line instead, since that's the one failure mode where the real reason is worth showing.
export const NARRATE_EXIT: Record<number, string> = {
  2: "The script has nothing to read aloud. Add some words, then try again.",
  3: "The voice isn't installed. Install Supertonic in Settings > Video, then try again.",
  4: "Narration failed",
};

// Generous cap for narrate.py's own timing JSON, read back and trusted only after this file
// checks it: a 60s video has at most a few hundred words, each a tiny object. Checked before
// JSON.parse ever runs, the same shape as spec.ts's MAX_SPEC_BYTES, so a hostile or corrupted
// timing file can't be parsed unbounded.
const MAX_TIMING_BYTES = 2 * 1024 * 1024;

/** Throws unless `p` lies inside `base` (lexically and after resolving symlinks in its ancestors -
 * `@careeros/core`'s `insideRoot`) and `p` itself is not a symlink, checked with `lstat` so the
 * check can't be fooled by following the very link it exists to refuse. `where` is only for the
 * error message. Re-run immediately before every rename or remove below, not just once up front,
 * to narrow the window a symlink swapped in after an earlier check could exploit (the same pattern
 * expander.ts's `assertSafe` uses). */
function assertSafe(base: string, p: string, label: string, where: string): void {
  if (!insideRoot(base, p)) throw new VideoError("unsafe_path", `refusing to touch ${label}: outside ${where}.`);
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return; } // doesn't exist (yet) - nothing to refuse
  if (st.isSymbolicLink()) throw new VideoError("unsafe_path", `refusing to follow a symlink at ${label}.`);
}

/** `p` must lie inside `root` (the CareerOS workspace, `i.root`) - used for `i.folder` itself and
 * `work/`, which must both live inside the workspace before narrate.py is ever run with them, not
 * just inside each other. Checked on entry and again right before each final rename. */
const assertInWorkspace = (root: string, p: string, label: string): void => assertSafe(root, p, label, "the workspace");

/** `p` must lie inside `folder` (`i.folder`, the per-video folder) - used for every path this file
 * builds from `folder` itself (`work/`, the wav, the timing file, and the two final destinations),
 * so none of them can escape the video's own folder via a symlink even when `folder` and `work/`
 * have already passed `assertInWorkspace`. */
const assertInFolder = (folder: string, p: string, label: string): void => assertSafe(folder, p, label, "the video folder");

/** `fs.lstatSync(p)`, or `null` for anything missing - never following a symlink, so a symlink
 * planted at `p` is reported as itself (a symlink), not as whatever it points at. */
function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch { return null; }
}

/** Removes whatever is at `p` without ever following a symlink: a genuine directory is removed
 * recursively (`rmSync(..., { recursive: true })`, since a plain non-recursive `rmSync` throws on
 * a directory - that used to let debris narrate.py (or a crashed earlier run) left at the wav/
 * timing path turn cleanup itself into a new, unrelated error), while a symlink or a regular file
 * is removed with a plain, non-recursive `rmSync` (which never follows the link). Missing is a
 * no-op either way (Fix round 1, item 3). */
function removeDebris(p: string): void {
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  else fs.rmSync(p, { force: true });
}

function finiteNonNeg(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

const TIMING_BAD = `Narration failed: the voice engine wrote a timing file ${identity.name} doesn't understand.`;

/**
 * Validates narrate.py's own timing JSON shape before anything downstream (buildHtml's caption
 * timing, the duration shown to the person) is allowed to trust it - its output files are
 * untrusted the same way any tool's stdout is. Every time is a finite number >= 0, every `end` is
 * no earlier than its matching `start`, and every paragraph's times fall inside the narration's
 * own `total`. Throws a plain `VideoError` with no raw file content echoed (a hostile timing file
 * can't use its own text to forge a misleading error) if any of that fails.
 */
function assertSaneTiming(t: unknown): asserts t is NarrationTiming {
  const bad = (): never => { throw new VideoError("narrate_failed", TIMING_BAD); };
  if (!t || typeof t !== "object") bad();
  const o = t as Record<string, unknown>;
  if (!finiteNonNeg(o.total)) bad();
  const total = o.total as number;
  if (!Array.isArray(o.paragraphs)) bad();
  for (const p of o.paragraphs as unknown[]) {
    if (!p || typeof p !== "object") bad();
    const po = p as Record<string, unknown>;
    if (typeof po.index !== "number" || !Number.isInteger(po.index) || po.index < 0) bad();
    if (typeof po.text !== "string") bad();
    if (!finiteNonNeg(po.start) || !finiteNonNeg(po.end) || (po.end as number) < (po.start as number)) bad();
    if ((po.start as number) > total || (po.end as number) > total) bad();
  }
  if (!Array.isArray(o.words_estimated)) bad();
  for (const w of o.words_estimated as unknown[]) {
    if (!w || typeof w !== "object") bad();
    const wo = w as Record<string, unknown>;
    if (typeof wo.text !== "string") bad();
    if (!finiteNonNeg(wo.start) || !finiteNonNeg(wo.end) || (wo.end as number) < (wo.start as number)) bad();
    // Fix round 1, item 7: bounded by `total` the same way a paragraph's times are above - a word
    // timed past the narration's own total is just as nonsensical as a paragraph timed past it.
    if ((wo.start as number) > total || (wo.end as number) > total) bad();
  }
  if (typeof o.engine !== "string" || typeof o.voice !== "string" || typeof o.fell_back !== "boolean") bad();
}

/** Reads and validates narrate.py's timing JSON from `p`: capped by byte size before `JSON.parse`
 * ever runs, then checked for shape with `assertSaneTiming`. A malformed or oversized file is a
 * plain `VideoError`, never a thrown `SyntaxError` or an unbounded parse. */
function readTiming(p: string): NarrationTiming {
  let stat: fs.Stats;
  try { stat = fs.statSync(p); } catch { throw new VideoError("narrate_failed", "Narration failed: the voice engine didn't write a timing file."); }
  if (!stat.isFile() || stat.size > MAX_TIMING_BYTES) throw new VideoError("narrate_failed", TIMING_BAD);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch { throw new VideoError("narrate_failed", TIMING_BAD); }
  assertSaneTiming(raw);
  return raw;
}

/**
 * Runs the 3c voice engine (`narrate.py`, spec section 3.4 stage 6) to turn `folder/script.txt` into
 * `folder/narration.wav` and `folder/narration.timing.json`. `narrate.py` reads voice settings
 * from the workspace (`--workspace i.root`) and the per-video-type voice (`--type i.voiceType`),
 * so Settings > Voice applies with no extra code here. It writes into `folder/work/` first; the
 * files only move into the video folder after it exits 0 and this function has validated them, so
 * a cancel or a failure never leaves a half-written `narration.wav` and whatever narration was
 * already in the folder survives untouched.
 */
/** `env`: the host environment (its PATH has Homebrew for an app opened from Finder; final review M6). */
export function narratePy(runner: ProcessRunner, paths: { python: string; narrate: string; ffmpeg: string }, env: NodeJS.ProcessEnv = process.env): Narrator {
  return {
    async narrate(i) {
      // narrate.py calls ffmpeg by name, so ffmpeg's own folder goes first on PATH - built with
      // the platform's path delimiter, and refused unless it's an absolute path, since a relative
      // one would be resolved against this process's own cwd, which has nothing to do with where
      // ffmpeg actually lives.
      if (!path.isAbsolute(paths.ffmpeg)) throw new VideoError("bad_arg", "The ffmpeg path must be absolute.");

      // `i.folder` (and `work/` inside it) must live inside `i.root`, the workspace - checked here
      // on entry, before narrate.py ever runs, and again right before each final rename below (the
      // same way expander.ts's `assertSafe(root, ...)` guards the whole composition folder). A
      // folder outside the workspace, or one that's a symlink, is refused outright.
      assertInWorkspace(i.root, i.folder, "the video folder");
      const work = path.join(i.folder, "work");
      assertInWorkspace(i.root, work, "work/");
      assertInFolder(i.folder, work, "work/");
      fs.mkdirSync(work, { recursive: true });
      const wav = path.join(work, "narration.wav");
      const timing = path.join(work, "narration.timing.json");
      assertInFolder(i.folder, wav, "work/narration.wav");
      assertInFolder(i.folder, timing, "work/narration.timing.json");
      // Fix round 1, item 5: a stale pair left by an earlier run (crashed, or simply never
      // cleaned up) must never be mistaken for this run's own output - if narrate.py this time
      // exits 0 without writing anything new, the post-run checks below would otherwise still find
      // a regular file sitting at `wav` and promote it. Cleared non-following, before narrate.py is
      // ever started.
      removeDebris(wav);
      removeDebris(timing);
      const textFile = path.join(i.folder, i.textFile === undefined ? "script.txt" : safeRel(i.textFile, "script path"));
      assertInFolder(i.folder, textFile, "the script");
      let cacheArgs: string[] = [];
      if (i.cacheDir !== undefined) {
        const cache = path.join(i.folder, safeRel(i.cacheDir, "narration cache"));
        assertInFolder(i.folder, cache, "the narration cache");
        const st = lstatOrNull(cache);
        if (st && !st.isDirectory()) removeDebris(cache);
        fs.mkdirSync(cache, { recursive: true });
        assertInFolder(i.folder, cache, "the narration cache");
        cacheArgs = ["--cache-dir", cache];
      }

      const pathVar = [path.dirname(paths.ffmpeg), env.PATH ?? ""].filter(Boolean).join(path.delimiter);

      // A cancel or a failure must never leave a half-written narration.wav behind - clears
      // whatever narrate.py wrote into work/, re-checking work/ itself for a symlink immediately
      // before touching anything inside it (the same re-check pattern expander.ts uses), and
      // removing debris of any kind (a directory included - see removeDebris) non-following.
      // Fix round 1, item 3: wrapped in its own try/catch - a problem while cleaning up (the very
      // containment check this relies on, or anything else) must never replace the error that's
      // actually being thrown by the caller right after calling this; that original error (a
      // CancelledError, a VideoError, or whatever the try block itself threw) is always what wins.
      const cleanup = (): void => {
        try {
          assertInFolder(i.folder, work, "work/");
          removeDebris(wav);
          removeDebris(timing);
        } catch {
          // best-effort only - see the comment above
        }
      };

      let r;
      try {
        r = await runner.run(paths.python, [
          paths.narrate, "--workspace", i.root, "--type", i.voiceType, "--text-file", textFile,
          "--out", wav, "--timing", timing, "--no-download", ...cacheArgs,
        ], {
          cwd: i.folder, signal: i.signal, timeoutMs: 30 * 60_000, lowPriority: true,
          // Final review I3: offline only. narrate.py never downloads the voice model mid-video (Settings > Voice does).
          env: cleanEnv({ PATH: pathVar, ...OFFLINE_ENV }, env),
          // Any tool output that reaches `onLine` is untrusted: one line at a time (the runner
          // already splits on newlines), with control characters stripped and the result capped,
          // so a hostile narrate.py can't forge a second log line or blow out the UI with it.
          onLine: (l) => i.onLine?.(oneLine(l)),
        });
      } catch (e) {
        cleanup();
        throw e;
      }

      if (r.cancelled) { cleanup(); throw new CancelledError(); }
      if (r.timedOut) { cleanup(); throw new VideoError("timeout", "Narration took too long and was stopped."); }
      if (r.code !== 0) {
        cleanup();
        const base = NARRATE_EXIT[r.code];
        if (r.code !== 4 && base !== undefined) throw new VideoError("narrate_failed", base);
        // Code 4 (or anything unmapped: a crash, a signal, an unknown exit code) - the only raw
        // tool text that ever reaches the message is a single oneLine'd last line, with narrate.py's
        // own "narrate: " prefix stripped.
        const tail = oneLine(lastLine(r.stderr).replace(/^narrate:\s*/, ""));
        throw new VideoError("narrate_failed", `Narration failed: ${tail || `exit code ${r.code}`}`);
      }

      // narrate.py's own output files are untrusted, the same way any tool's stdout is: re-check
      // for a symlink right before reading either of them, require the audio to be a genuine
      // regular file (never a symlink, FIFO, socket or device), and validate the timing JSON's
      // shape before any of it is trusted. Any failure in this block - a symlink, an irregular
      // file, a malformed timing file - cleans up work/ the same way an exit-code or cancel
      // failure does, so nothing half-written is ever left behind.
      const destWav = path.join(i.folder, "narration.wav");
      const destTiming = path.join(i.folder, "narration.timing.json");
      let parsedTiming: NarrationTiming;
      try {
        assertInFolder(i.folder, wav, "work/narration.wav");
        assertInFolder(i.folder, timing, "work/narration.timing.json");
        // Fix round 1, item 6: missing (a buggy engine exiting 0 without writing anything) and
        // "something's there but it's the wrong kind of thing" (a symlink, a directory, ...) are
        // different problems and get different messages - the first was previously folded into
        // the second's misleading "is not a regular file", as if there were something there at all.
        const wavStat = lstatOrNull(wav);
        if (!wavStat) throw new VideoError("narrate_failed", "Narration failed: the voice engine didn't produce any audio.");
        if (!wavStat.isFile()) throw new VideoError("narrate_failed", "Narration failed: the voice engine's audio file is not a regular file.");
        parsedTiming = readTiming(timing);
        // Re-checked right before each of the two final renames: a symlink could have been
        // swapped in for `i.folder` or `work/` itself in the window since narrate.py started.
        assertInWorkspace(i.root, i.folder, "the video folder");
        assertInWorkspace(i.root, work, "work/");
        assertInFolder(i.folder, destWav, "narration.wav");
        fs.renameSync(wav, destWav);
        assertInWorkspace(i.root, i.folder, "the video folder");
        assertInWorkspace(i.root, work, "work/");
        assertInFolder(i.folder, destTiming, "narration.timing.json");
        fs.renameSync(timing, destTiming);
      } catch (e) {
        cleanup();
        throw e;
      }

      // Fix round 1, item 2: the result comes only from `parsedTiming` - already fully validated
      // by `assertSaneTiming` above - never from narrate.py's stdout JSON line. stdout is still
      // untrusted even after a 0 exit (it's tool output like any other), and `parsedTiming` already
      // carries every field `NarrateResult` needs, so there is no "extra info" from stdout worth
      // the risk of using it: a hostile `{"total":-5,"engine":"x\u001b[31m"}` line, or stdout that
      // isn't even an object (`null`, an array, ...), can never reach the result, and nothing here
      // can throw after the renames above have already committed the files.
      const t = parsedTiming as NarrationTiming & { paragraphs_made?: unknown; paragraphs_reused?: unknown };
      const count = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 100_000 ? { ok: true as const, n } : null);
      const made = count(t.paragraphs_made), reused = count(t.paragraphs_reused);
      return {
        total: parsedTiming.total, engine: oneLine(parsedTiming.engine), voice: oneLine(parsedTiming.voice), fell_back: parsedTiming.fell_back,
        ...(made && reused ? { made: made.n, reused: reused.n } : {}),
      };
    },
  };
}
