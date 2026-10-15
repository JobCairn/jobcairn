import { CancelledError, VideoError } from "./errors.js";
import { cleanEnv, type ProcessRunner } from "./process.js";

/** One tile of the contact sheet: a 16:9 frame this wide (the sheet is about 4 tiles across). */
export const SHEET_TILE = { w: 480, h: 270 } as const;
const MAX_FRAMES = 24;
const BG = "0x0e1116";

/** Columns and rows for `n` frames: up to 4 across, as many rows as needed. */
export function sheetGrid(n: number): { cols: number; rows: number } {
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(n)));
  const cols = Math.min(4, count);
  return { cols, rows: Math.ceil(count / cols) };
}

/** The frame times to use: finite, zero or later, inside the video, at most MAX_FRAMES (spread evenly when more). */
export function sheetTimes(times: readonly number[], duration: number): number[] {
  const ok = times.filter((t) => Number.isFinite(t) && t >= 0 && (!Number.isFinite(duration) || duration <= 0 || t < duration));
  if (ok.length <= MAX_FRAMES) return ok;
  return Array.from({ length: MAX_FRAMES }, (_, i) => ok[Math.floor(((i + 0.5) * ok.length) / MAX_FRAMES)]!);
}

/**
 * The contact sheet (one frame per scene, in a grid) built from the rendered MP4 with ffmpeg, instead of starting
 * Chrome a second time for HyperFrames' snapshot. One fast seek per frame into `workRel`, then one tile pass. A
 * partial last row is filled with plain background tiles, so the tile filter always gets a whole grid.
 * `cwd` is the video folder; `video`, `workRel` and `outRel` are relative to it.
 */
export async function contactSheet(
  runner: ProcessRunner, ffmpeg: string, o: { cwd: string; video: string; times: number[]; duration: number; workRel: string; outRel: string; signal?: AbortSignal },
): Promise<void> {
  const times = sheetTimes(o.times, o.duration);
  if (!times.length) throw new VideoError("sheet_failed", "There are no frames to put on the contact sheet.");
  const { cols, rows } = sheetGrid(times.length);
  const run = async (args: string[]) => {
    const r = await runner.run(ffmpeg, ["-v", "error", "-nostdin", ...args], { cwd: o.cwd, signal: o.signal, timeoutMs: 60_000, env: cleanEnv({}), lowPriority: true });
    if (r.cancelled || o.signal?.aborted) throw new CancelledError();
    if (r.timedOut || r.code !== 0) throw new VideoError("sheet_failed", "ffmpeg could not make the contact sheet.");
  };
  const scale = `scale=${SHEET_TILE.w}:${SHEET_TILE.h}:force_original_aspect_ratio=decrease,pad=${SHEET_TILE.w}:${SHEET_TILE.h}:(ow-iw)/2:(oh-ih)/2:color=${BG}`;
  const tile = (i: number) => `${o.workRel}/sheet-${String(i).padStart(2, "0")}.jpg`;
  for (let i = 0; i < times.length; i++) {
    await run(["-ss", times[i]!.toFixed(3), "-i", o.video, "-frames:v", "1", "-vf", scale, "-q:v", "3", "-y", tile(i)]);
  }
  for (let i = times.length; i < cols * rows; i++) {
    await run(["-f", "lavfi", "-i", `color=c=${BG}:s=${SHEET_TILE.w}x${SHEET_TILE.h}`, "-frames:v", "1", "-q:v", "3", "-y", tile(i)]);
  }
  await run([
    "-framerate", "1", "-start_number", "0", "-i", `${o.workRel}/sheet-%02d.jpg`,
    "-vf", `tile=${cols}x${rows}:padding=8:margin=8:color=${BG}`, "-frames:v", "1", "-q:v", "3", "-y", o.outRel,
  ]);
}
