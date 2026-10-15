import type { SceneType, VideoType } from "./types.js";

/**
 * How a video's length shapes its plan. A longer video gets more scenes and chapters, never more words per scene:
 * the reading-load budget and the narration pace stay the same at every length.
 * (The length presets themselves live in @careeros/contract's video-lengths.ts; keep IN_DEPTH_FROM_S equal.)
 */

/** Fewest scenes any video has, and the ceiling for the longest (10 minutes). */
export const MIN_SCENES = 2;
export const MAX_SCENES = 60;
/** Up to this length the old 12-scene ceiling still applies. */
const BASE_MAX_SCENES = 12;
/** Scenes run 4 to 15 seconds; slides 4 to 8. Used to turn a length into a scene range. */
const SHORTEST_SCENE_S = 6;
const LONGEST_SCENE_S = 15;
/** Above this average, scenes are too long: split them instead. */
export const MAX_AVG_SCENE_S = 20;
/** From this length a video is split into chapters. Same value as contract IN_DEPTH_FROM_S. */
export const IN_DEPTH_FROM_S = 300;
/** A chapter covers about this much video. */
const CHAPTER_S = 90;
/** The length scene counts in a type file are written for (a Standard video). */
const COUNTS_BASE_S = 150;

/** The most scenes a video of this length may have: 12 up to two minutes, then one per 10 seconds, at most 60. */
export function maxScenes(seconds: number): number {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return Math.min(MAX_SCENES, Math.max(BASE_MAX_SCENES, Math.ceil(s / 10)));
}

/** The scene range to ask the writer for at this length. */
export function sceneRange(seconds: number): { min: number; max: number } {
  const max = Math.min(maxScenes(seconds), Math.max(3, Math.ceil(seconds / SHORTEST_SCENE_S)));
  const min = Math.min(max, Math.max(MIN_SCENES + 1, Math.floor(seconds / LONGEST_SCENE_S)));
  return { min, max };
}

export function isInDepth(seconds: number): boolean { return seconds >= IN_DEPTH_FROM_S; }

/** How many chapters an in-depth video has: about one per minute and a half. 0 below in-depth. */
export function chapterCount(seconds: number): number {
  return isInDepth(seconds) ? Math.max(2, Math.round(seconds / CHAPTER_S)) : 0;
}

/**
 * A type's scene counts at this length. One-off scenes (title, recap card: max 1) stay one-off. Repeatable ones
 * (quiz, comparison) scale with the length from the Standard length the type file is written for: a longer
 * interview prep asks more questions, a Quick one fewer.
 */
export function sceneCountsFor(type: Pick<VideoType, "scene_counts">, seconds: number): Partial<Record<SceneType, { min: number; max: number }>> {
  const f = Number.isFinite(seconds) && seconds > 0 ? seconds / COUNTS_BASE_S : 1;
  const out: Partial<Record<SceneType, { min: number; max: number }>> = {};
  for (const [t, c] of Object.entries(type.scene_counts) as [SceneType, { min: number; max: number }][]) {
    if (c.max <= 1) { out[t] = { ...c }; continue; }
    const min = f < 1 && c.min > 0 ? Math.max(1, Math.min(c.min, Math.round(c.min * f))) : c.min;
    const max = Math.max(min, f > 1 ? Math.round(c.max * f) : c.max);
    out[t] = { min, max };
  }
  return out;
}
