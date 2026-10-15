import { CancelledError } from "./errors.js";
import { cleanEnv, type ProcessRunner } from "./process.js";
import { parseScript, tokens } from "./script.js";
import type { Word } from "./types.js";

/**
 * Caption timing that follows the real narration audio (fix/caption-sync).
 *
 * The bug this exists for: whisper (HyperFrames transcribe) doesn't place words well across long silences. A drill
 * script's "[pause 8]" think time is 8 s of digital silence, and whisper spreads the words on either side of it
 * evenly across the gap, so captions and scene changes ran up to 7.6 s early. Even the 0.45 s gap between ordinary
 * paragraphs pulled a paragraph's first word 0.4 to 1.1 s early. Three steps fix it:
 *
 * 1. `listenPlan` / `condenseArgs`: whisper hears a copy of the narration with every long gap cut short, and
 *    `toRealTime` puts each heard word back on the real timeline with its paragraph's offset.
 * 2. `fitWords`: narrate.py knows exactly where each paragraph's audio sits (sample-exact), and ffmpeg's
 *    silencedetect knows where the voice is actually sounding. Each paragraph's words are kept inside its own
 *    speech, and no word starts or ends inside a silence.
 * 3. `captionDrift`: after the render, every caption that follows a silence is compared with the moment the voice
 *    starts again, and a drift over `DRIFT_LIMIT_S` is reported in plain words.
 */

export interface Span { start: number; end: number }
/** `[from, to)` of the real narration, played at `at` in the condensed copy whisper hears. */
export interface Segment { from: number; to: number; at: number }

/** Whisper smears words across any silence much longer than a breath (measured: 1.4 s between two paragraphs puts
 * the next paragraph's first word 1.1 to 1.5 s early; an 8 s think pause, 7 to 9 s). So in the copy it hears, every
 * silence longer than `MAX_LISTEN_GAP` is cut down to `KEEP_HEAD` s of its start plus `KEEP_TAIL` s of its end. */
export const MAX_LISTEN_GAP = 0.6;
export const KEEP_HEAD = 0.1;
export const KEEP_TAIL = 0.25;
/** Silencedetect settings: narrate.py writes digital silence between paragraphs and loudness-normalises speech
 * to -16 LUFS, so -40 dB separates the two cleanly. Shorter silences than this are breaths, not gaps. */
export const SILENCE_DB = -40;
export const MIN_SILENCE_S = 0.2;
/** How far a caption may start from the voice and still count as in sync (the owner's 150 ms). */
export const DRIFT_LIMIT_S = 0.15;

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const sane = (s: Span) => finite(s.start) && finite(s.end) && s.start >= 0 && s.end >= s.start;

/** The stretches to cut from what whisper hears: the middle of each detected silence longer than `MAX_LISTEN_GAP`. */
export function cutsFromSilences(silences: readonly Span[]): Span[] {
  return silences.filter((s) => sane(s) && s.end - s.start > MAX_LISTEN_GAP).map((s) => ({ start: r3(s.start + KEEP_HEAD), end: r3(s.end - KEEP_TAIL) }));
}
/** Without silencedetect: the middle of each gap between paragraphs longer than `MAX_LISTEN_GAP` (narrate.py's
 * gaps are digital silence, so this is exact; it only misses the voice engine's own quiet lead-in and tail). */
export function cutsFromParagraphs(paragraphs: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (let i = 1; i < paragraphs.length; i++) {
    const a = paragraphs[i - 1]!, b = paragraphs[i]!;
    if (sane(a) && sane(b) && b.start - a.end > MAX_LISTEN_GAP) out.push({ start: r3(a.end + KEEP_HEAD), end: r3(b.start - KEEP_TAIL) });
  }
  return out;
}

/** The parts of the narration whisper should hear: everything except `cuts` (sorted, non-overlapping stretches
 * inside [0, total]). Null when there's nothing to cut: whisper can hear the file as it is. */
export function listenPlan(cuts: readonly Span[], total: number): Segment[] | null {
  if (!finite(total) || total <= 0) return null;
  const cs = cuts.filter((c) => sane(c) && c.end - c.start > 0.05 && c.start < total).sort((a, b) => a.start - b.start);
  if (!cs.length) return null;
  const segs: Segment[] = [];
  let from = 0, at = 0;
  for (const c of cs) {
    if (c.start < from) return null;
    segs.push({ from: r3(from), to: r3(c.start), at: r3(at) });
    at += c.start - from;
    from = Math.min(total, c.end);
  }
  segs.push({ from: r3(from), to: r3(total), at: r3(at) });
  return segs;
}

/** ffmpeg arguments that write the condensed copy: each segment trimmed out of `input` and joined, 16 kHz mono
 * (what whisper wants), PCM WAV. Paths are relative to the run's cwd and must not start with "-". */
export function condenseArgs(input: string, output: string, segs: readonly Segment[]): string[] {
  const parts = segs.map((s, i) => `[0:a]atrim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},asetpts=PTS-STARTPTS[s${i}]`);
  const join = `${segs.map((_, i) => `[s${i}]`).join("")}concat=n=${segs.length}:v=0:a=1[out]`;
  return ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", input, "-filter_complex", `${parts.join(";")};${join}`,
    "-map", "[out]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output];
}

/** A time in the condensed copy, back on the real timeline: inside a segment it moves by that segment's offset; in
 * the (tiny) seam between two segments it snaps to the next segment's start. */
export function realTime(t: number, segs: readonly Segment[]): number {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    if (t >= s.at) return r3(Math.min(s.to, s.from + (t - s.at)));
  }
  return r3(segs[0]?.from ?? t);
}

/** Every heard word moved back to the real timeline (start and end each mapped on their own). */
export function toRealTime(words: readonly Word[], segs: readonly Segment[] | null): Word[] {
  if (!segs) return words.slice();
  return words.map((w) => {
    const start = realTime(w.start, segs);
    return { ...w, start, end: Math.max(start, realTime(w.end, segs)) };
  });
}

/** Silences from ffmpeg silencedetect's stderr, inside [0, total]. A silence still open at the end of the file
 * closes at `total`. Lines that aren't silencedetect output are ignored. */
export function parseSilences(stderr: string, total: number): Span[] {
  const out: Span[] = [];
  let open: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+(?:e-?\d+)?)/g)) {
    const t = Number(m[2]);
    if (!Number.isFinite(t)) continue;
    if (m[1] === "start") open = Math.max(0, t);
    else if (open !== null) { if (t > open) out.push({ start: r3(open), end: r3(Math.min(t, total)) }); open = null; }
  }
  if (open !== null && total > open) out.push({ start: r3(open), end: r3(total) });
  return out;
}

/** Runs silencedetect on `audioRel` (relative to `cwd`). Null when ffmpeg fails: callers then fall back to the
 * paragraph spans alone, never to failing the video. Cancelling still cancels. */
export async function detectSilences(runner: ProcessRunner, ffmpeg: string, cwd: string, audioRel: string, total: number, signal?: AbortSignal): Promise<Span[] | null> {
  try {
    const r = await runner.run(ffmpeg, ["-hide_banner", "-nostdin", "-nostats", "-i", audioRel, "-af", `silencedetect=noise=${SILENCE_DB}dB:d=${MIN_SILENCE_S}`, "-f", "null", "-"], {
      cwd, signal, timeoutMs: 5 * 60_000, env: cleanEnv({}), lowPriority: true,
    });
    if (r.cancelled || signal?.aborted) throw new CancelledError();
    if (r.timedOut || r.code !== 0) return null;
    const out = parseSilences(r.stderr ?? "", total);
    return out.length ? out : null;
  } catch (e) {
    if (e instanceof CancelledError || signal?.aborted) throw e instanceof CancelledError ? e : new CancelledError();
    return null;
  }
}

/** Where the voice sounds inside `p`: from the end of the silence covering its start to the start of the silence
 * covering its end. Without silences (or if they'd leave nothing), the paragraph's own span. */
export function speechSpan(p: Span, silences: readonly Span[] | null): Span {
  let start = p.start, end = p.end;
  for (const s of silences ?? []) {
    if (s.start <= start + 0.02 && s.end > start) start = s.end;
    if (s.start < end && s.end >= end - 0.02) end = Math.min(end, s.start);
  }
  return end - start > 0.05 ? { start: r3(start), end: r3(end) } : { start: p.start, end: p.end };
}

/** For each word of the script's caption tokens (`tokens(parseScript(script))`, the order `alignWords` returns),
 * the index of the narrated paragraph it belongs to. Pause blocks aren't paragraphs, so they're skipped in the
 * count, exactly as narrate.py does. Null when the script and the timing disagree on how many paragraphs there are. */
export function paragraphOfTokens(script: string, paragraphCount: number): number[] | null {
  const blocks = parseScript(script);
  const toPara = new Map<number, number>();
  blocks.forEach((b, i) => { if (b.kind === "speech") toPara.set(i, toPara.size); });
  if (toPara.size !== paragraphCount) return null;
  return tokens(blocks).map((t) => toPara.get(t.block) ?? -1);
}

/** The paragraph each word sits in by time (for narrate.py's estimated words, which never leave their paragraph). */
export function paragraphOfTimes(words: readonly Word[], paragraphs: readonly Span[]): number[] {
  return words.map((w) => {
    const mid = (w.start + w.end) / 2;
    const k = paragraphs.findIndex((p) => mid >= p.start - 0.05 && mid <= p.end + 0.05);
    return k;
  });
}

/** Share of a paragraph's words that had to move more than this far before the paragraph is re-spread instead. */
const MOVED_FAR_S = 0.75;
const TOO_MANY_MOVED = 0.4;

/** Spreads words `idx` of `out` over [from, to] by length (narrate.py's own rough estimate, used where the heard
 * times can't be trusted). */
function spread(out: Word[], idx: readonly number[], from: number, to: number): void {
  const weights = idx.map((i) => out[i]!.text.length + 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  let t = from;
  idx.forEach((i, n) => {
    const d = ((to - from) * weights[n]!) / sum;
    out[i]!.start = t; out[i]!.end = t + d * 0.92; t += d;
  });
}

/**
 * Puts every word back where the voice actually is.
 *
 * - `para[i]` says which paragraph word i belongs to (-1: unknown, the word is only checked against silences).
 * - `remap`: the words came from narrate.py's estimate (spread over the whole paragraph, leading and trailing
 *   silence included), so each paragraph is first scaled from its span onto its speech span.
 * - Each word is kept inside its paragraph's speech span, and the paragraph's first word starts exactly where the
 *   span starts (so scene starts come from the narration's paragraph offsets, not from whisper). If that moves too many of a paragraph's words a long way
 *   (whisper put the paragraph somewhere else entirely), the paragraph's words are spread over its speech span by
 *   length instead: a little rough, but never seconds out.
 * - No word starts inside a silence (it moves to where the voice comes back) and none ends inside one (it ends where
 *   the voice stopped).
 * - The result never goes backwards: each start is at or after the previous start, and each end at or after its start.
 */
export function fitWords(words: readonly Word[], para: readonly number[], paragraphs: readonly Span[], silences: readonly Span[] | null, o: { remap?: boolean } = {}): Word[] {
  const out = words.map((w) => ({ ...w }));
  const speech = paragraphs.map((p) => speechSpan(p, silences));
  paragraphs.forEach((p, k) => {
    const idx = out.map((_, i) => i).filter((i) => para[i] === k);
    if (!idx.length) return;
    const sp = speech[k]!;
    if (o.remap) {
      const scale = p.end > p.start ? (sp.end - sp.start) / (p.end - p.start) : 0;
      for (const i of idx) {
        const w = out[i]!;
        w.start = sp.start + (w.start - p.start) * scale;
        w.end = sp.start + (w.end - p.start) * scale;
      }
    }
    const moved: boolean[] = [];
    for (const i of idx) {
      const w = out[i]!;
      const s = Math.min(sp.end, Math.max(sp.start, w.start));
      const e = Math.min(sp.end, Math.max(sp.start, w.end));
      moved.push(Math.abs(s - w.start) > MOVED_FAR_S || Math.abs(e - w.end) > MOVED_FAR_S);
      w.start = s; w.end = e;
    }
    const far = moved.filter(Boolean).length;
    if (idx.length >= 3 && far / idx.length > TOO_MANY_MOVED) { spread(out, idx, sp.start, sp.end); return; }
    // A run of words that had to move far would otherwise sit stacked on the edge of the voice: spread the run
    // (and the word before it, so there is room) between its neighbours instead.
    for (let a = 0; a < idx.length; a++) {
      if (!moved[a]) continue;
      let b = a;
      while (b + 1 < idx.length && moved[b + 1]) b++;
      const from = a > 0 ? a - 1 : a;
      const lo = a > 0 ? out[idx[a - 1]!]!.start : sp.start;
      const hi = b + 1 < idx.length ? out[idx[b + 1]!]!.start : sp.end;
      if (hi > lo) spread(out, idx.slice(from, b + 1), lo, hi);
      a = b;
    }
    // The paragraph's first word starts where its voice starts (narrate.py's sample-exact span, trimmed to the voice
    // by silencedetect), never where whisper heard it: scene starts hang off these words, so a scene opens with its
    // paragraph and a quiz think pause keeps its full length. Whisper only orders the words inside the paragraph.
    const first = out[idx[0]!]!;
    first.start = sp.start;
    first.end = Math.max(first.end, sp.start);
  });
  const gaps = (silences ?? []).filter((s) => s.end - s.start >= MIN_SILENCE_S);
  for (const w of out) {
    for (const s of gaps) {
      if (w.start > s.start + 0.02 && w.start < s.end) w.start = s.end;
      if (w.end > s.start && w.end < s.end - 0.02 && w.start < s.start) w.end = s.start;
    }
  }
  let prev = 0;
  return out.map((w) => {
    const start = r3(Math.max(prev, w.start));
    const end = r3(Math.max(start, w.end));
    prev = start;
    return { text: w.text, start, end };
  });
}

/**
 * The full caption timing: heard words (already on the real timeline) or narrate.py's estimate, fitted to the
 * narration's paragraphs and silences. `estimated`: `words` came from narrate.py, not from listening.
 */
export function timeWords(i: { script: string; words: readonly Word[]; estimated: boolean; paragraphs: readonly Span[] | undefined; silences: readonly Span[] | null }): Word[] {
  const paragraphs = (i.paragraphs ?? []).filter(sane);
  if (!paragraphs.length || paragraphs.length !== (i.paragraphs ?? []).length) return fitWords(i.words, i.words.map(() => -1), [], i.silences);
  const para = i.estimated ? paragraphOfTimes(i.words, paragraphs) : paragraphOfTokens(i.script, paragraphs.length);
  if (!para || para.length !== i.words.length) return fitWords(i.words, i.words.map(() => -1), [], i.silences);
  return fitWords(i.words, para, paragraphs, i.silences, { remap: i.estimated });
}

export interface DriftPoint { kind: "start" | "end" | "pause"; at: number; cue: number; drift: number }
export interface DriftReport { points: DriftPoint[]; max_ms: number; ok: boolean; message: string }

/** Whisper's own word timing inside a sentence is only good to a few hundred ms (measured against each paragraph
 * transcribed on its own), so a pause checkpoint only counts as drift past this. */
export const PAUSE_LIMIT_S = 0.5;

/**
 * After the render: do the captions start when the voice does? Three kinds of checkpoint, all measured against the
 * voice track (silencedetect on the narration the final mix is built on):
 * - `start`: each paragraph's first caption word against the moment its voice starts (early or late counts).
 * - `end`: each paragraph's last caption word against the moment its voice stops (only running on past it counts:
 *   whisper drags a paragraph's tail words into a long pause).
 * - `pause`: inside a paragraph, each silence of at least `minPause` s: the caption word starting nearest to where
 *   the voice comes back, against that moment. These don't depend on the paragraph spans at all. Over `pauseLimit`.
 * `drift` is cue - at (negative: the caption is early). `max_ms` is the worst drift that counts.
 */
export function captionDrift(i: { words: readonly Word[]; para: readonly number[] | null; paragraphs: readonly Span[]; silences: readonly Span[] | null }, o: { minPause?: number; limit?: number; pauseLimit?: number } = {}): DriftReport {
  const minPause = o.minPause ?? MIN_SILENCE_S, limit = o.limit ?? DRIFT_LIMIT_S, pauseLimit = o.pauseLimit ?? PAUSE_LIMIT_S;
  const ws = i.words.filter((w) => finite(w.start) && finite(w.end));
  const points: DriftPoint[] = [];
  const speech = i.paragraphs.map((p) => speechSpan(p, i.silences));
  if (i.para && i.para.length === i.words.length) {
    speech.forEach((sp, k) => {
      const mine = i.words.filter((_, n) => i.para![n] === k);
      const first = mine[0], last = mine.at(-1);
      if (first && finite(first.start)) points.push({ kind: "start", at: sp.start, cue: first.start, drift: r3(first.start - sp.start) });
      if (last && finite(last.end)) points.push({ kind: "end", at: sp.end, cue: last.end, drift: r3(last.end - sp.end) });
    });
  }
  for (const s of i.silences ?? []) {
    if (s.end - s.start < minPause || !speech.some((sp) => s.start > sp.start && s.end < sp.end)) continue;
    let best: Word | null = null;
    for (const w of ws) if (!best || Math.abs(w.start - s.end) < Math.abs(best.start - s.end)) best = w;
    if (best) points.push({ kind: "pause", at: s.end, cue: best.start, drift: r3(best.start - s.end) });
  }
  // How far each point is out, by the rule for its kind (an early paragraph end is fine; a pause has more slack).
  const over = (p: DriftPoint) => (p.kind === "end" ? Math.max(0, p.drift) - limit : Math.abs(p.drift) - (p.kind === "pause" ? pauseLimit : limit));
  const counted = (p: DriftPoint) => (p.kind === "end" ? Math.max(0, p.drift) : Math.abs(p.drift));
  const worst = points.reduce<DriftPoint | null>((a, p) => (!a || over(p) > over(a) ? p : a), null);
  const max_ms = Math.round(points.reduce((m, p) => Math.max(m, p.kind === "pause" ? 0 : counted(p)), 0) * 1000);
  const ok = !worst || over(worst) <= 0.0005;
  const at = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const message = !points.length ? "Caption timing could not be checked against the voice."
    : ok ? `Captions match the voice (within ${max_ms} ms).`
      : `Captions are ${counted(worst!).toFixed(1)} s ${worst!.drift < 0 ? "ahead of" : "behind"} the voice at ${at(worst!.at)}. Make the captions again to fix it.`;
  return { points, max_ms, ok, message };
}
