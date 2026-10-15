import { CancelledError, VideoError } from "./errors.js";
import { cleanEnv, type ProcessRunner } from "./process.js";
import { norm } from "./script.js";
import type { Word } from "./types.js";

// Final-stage QA on the rendered MP4 (Task 18b; render-and-check.md § Final QA). The pipeline only
// pulls the stills; judging them (legibility, banding, which caption word is lit) is done by a
// fresh-context look at the pictures, never by re-reading the composition code.

/** How far a lit caption word may drift from the spoken word and still count as in sync. */
export const SYNC_TOLERANCE_S = 0.12;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** 4 to 6 timestamps spread evenly across the video, each in the middle of its slice, so the
 * first and last frames (often a fade) are never picked. Empty for a missing or zero duration. */
export function qaFrameTimes(duration: number, count = 5): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const n = Math.min(6, Math.max(4, Math.round(Number.isFinite(count) ? count : 5)));
  return Array.from({ length: n }, (_, i) => r3(((i + 0.5) * duration) / n));
}

export interface SyncSample { index: number; word: string; at: number; from: number; to: number }

/** About `count` caption words spread evenly through the transcript, each with its midpoint and
 * the ±120 ms window it must be lit within. Words with broken timings are skipped. */
export function captionSyncSamples(words: readonly Word[], count = 10): SyncSample[] {
  const usable = words
    .map((w, index) => ({ w, index }))
    .filter(({ w }) => w && typeof w.text === "string" && norm(w.text) !== "" && Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end >= w.start);
  const n = Math.max(0, Math.floor(count));
  const picked = usable.length <= n ? usable : Array.from({ length: n }, (_, k) => usable[Math.floor(((k + 0.5) * usable.length) / n)]!);
  return picked.map(({ w, index }) => {
    const at = r3((w.start + w.end) / 2);
    return { index, word: w.text, at, from: r3(Math.max(0, at - SYNC_TOLERANCE_S)), to: r3(at + SYNC_TOLERANCE_S) };
  });
}

/** True when the word seen lit in the frame at `sample.at` is the sample word, or another word
 * whose own timing reaches within ±120 ms of that moment (a lit neighbour that close is in sync). */
export function syncMatches(sample: SyncSample, seen: string | null, words: readonly Word[]): boolean {
  if (!seen || !norm(seen)) return false;
  if (norm(seen) === norm(sample.word)) return true;
  return words.some((w) => norm(w.text) === norm(seen) && w.start - SYNC_TOLERANCE_S <= sample.at && sample.at <= w.end + SYNC_TOLERANCE_S);
}

export interface QaShot { file: string; at: number; kind: "frame" | "sync"; word?: string; from?: number; to?: number }
export interface QaPlan { duration_s: number; tolerance_s: number; shots: QaShot[] }

/** The stills to pull from the final MP4: `qa/frame-N.jpg` across the timeline and
 * `qa/sync-N.jpg` at each sampled caption word's midpoint. */
export function qaPlan(duration: number, words: readonly Word[]): QaPlan {
  const frames = qaFrameTimes(duration).map((at, i): QaShot => ({ file: `qa/frame-${i + 1}.jpg`, at, kind: "frame" }));
  const sync = captionSyncSamples(words)
    .filter((s) => s.at <= duration)
    .map((s, i): QaShot => ({ file: `qa/sync-${i + 1}.jpg`, at: s.at, kind: "sync", word: s.word, from: s.from, to: s.to }));
  return { duration_s: duration, tolerance_s: SYNC_TOLERANCE_S, shots: [...frames, ...sync] };
}

/** Pulls one still per shot with ffmpeg (local file in, local JPEG out; nothing else). `cwd` is the
 * video folder; `video` and each shot's `file` are relative to it. */
export async function extractStills(runner: ProcessRunner, ffmpeg: string, video: string, shots: readonly QaShot[], cwd: string, signal?: AbortSignal): Promise<void> {
  for (const s of shots) {
    const r = await runner.run(ffmpeg, ["-v", "error", "-nostdin", "-ss", s.at.toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "3", "-y", s.file], {
      cwd, signal, timeoutMs: 60_000, env: cleanEnv({}),
    });
    if (r.cancelled || signal?.aborted) throw new CancelledError();
    if (r.timedOut || r.code !== 0) throw new VideoError("qa_stills", "ffmpeg could not take the QA stills.");
  }
}
