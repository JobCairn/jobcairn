/**
 * Video length choices for Make video: three presets (Quick, Standard, In-depth) and a custom m:ss length,
 * plus the "about N min to make" estimate. Pure functions, shared by the dialog and the services.
 */

export const LENGTH_PRESETS = ["quick", "standard", "in_depth"] as const;
export type LengthPreset = (typeof LENGTH_PRESETS)[number];
export type LengthChoice = LengthPreset | "custom";

/** Seconds each preset asks for. Standard sits in the middle of "2 to 3 minutes", In-depth in the middle of "5 to 8". */
export const PRESET_SECONDS: Readonly<Record<LengthPreset, number>> = { quick: 60, standard: 150, in_depth: 390 };
export const PRESET_LABELS: Readonly<Record<LengthPreset, { label: string; hint: string }>> = {
  quick: { label: "Quick", hint: "About 1 min" },
  standard: { label: "Standard", hint: "2 to 3 min" },
  in_depth: { label: "In-depth", hint: "5 to 8 min, in chapters" },
};
/** Any custom length must sit in 0:30 to 10:00, and inside the type's own range. */
export const CUSTOM_MIN_S = 30;
export const CUSTOM_MAX_S = 600;
/** From this length a video is split into chapters (the scenes that open one have `chapter: true`). */
export const IN_DEPTH_FROM_S = 300;

export interface LengthRange { min_s: number; target_s: number; max_s: number }

/** The presets a type offers: the ones whose length fits inside the type's range. */
export function presetsFor(range: LengthRange): LengthPreset[] {
  return LENGTH_PRESETS.filter((p) => PRESET_SECONDS[p] >= range.min_s && PRESET_SECONDS[p] <= range.max_s);
}

/** The choice that matches a length: its preset when one fits exactly, otherwise "custom". */
export function choiceFor(range: LengthRange, seconds: number): LengthChoice {
  return presetsFor(range).find((p) => PRESET_SECONDS[p] === seconds) ?? "custom";
}

/** "m:ss" for a length in seconds (0:30, 2:30, 10:00). */
export function formatLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Reads a custom length typed as m:ss ("2:30") or whole minutes ("5"). Returns the seconds, or a plain error that
 * names the allowed range: 0:30 to 10:00, narrowed to the type's own range.
 */
export function parseCustomLength(text: string, range?: LengthRange, typeLabel = "This video"): { ok: true; seconds: number } | { ok: false; error: string } {
  const lo = Math.max(CUSTOM_MIN_S, range?.min_s ?? CUSTOM_MIN_S);
  const hi = Math.min(CUSTOM_MAX_S, range?.max_s ?? CUSTOM_MAX_S);
  const rangeText = `${formatLength(lo)} to ${formatLength(hi)}`;
  const t = text.trim();
  if (!t) return { ok: false, error: `Type a length, like 4:30. ${typeLabel} can run ${rangeText}.` };
  let seconds: number;
  const ms = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (ms) seconds = Number(ms[1]) * 60 + Number(ms[2]);
  else if (/^\d{1,2}$/.test(t)) seconds = Number(t) * 60;
  else return { ok: false, error: `Use minutes and seconds, like 4:30. ${typeLabel} can run ${rangeText}.` };
  if (seconds < lo || seconds > hi) return { ok: false, error: `${typeLabel} can run ${rangeText}.` };
  return { ok: true, seconds };
}

/**
 * How long making a video takes on this computer: a fixed part (gathering files, writing and checking the script)
 * plus a rate per second of video (narration, captions, building, draft and final renders). `measured` is true when
 * the rate comes from videos already made here.
 */
export interface MakingRate { fixed_s: number; per_video_s: number; measured: boolean }
/** Used until two videos have been made here. Deliberately on the slow side, so the estimate is rarely short. */
export const DEFAULT_MAKING_RATE: MakingRate = { fixed_s: 120, per_video_s: 2.5, measured: false };
/** The stages that run on the computer for each second of video. The review (a person reading) never counts. */
export const MEASURED_STAGES = ["narrate", "captions", "media", "expand", "lint", "draft", "final"] as const;

/** Making time in seconds for a video of `videoSeconds`. */
export function estimateMakingSeconds(videoSeconds: number, rate: MakingRate = DEFAULT_MAKING_RATE): number {
  const v = Number.isFinite(videoSeconds) && videoSeconds > 0 ? videoSeconds : 0;
  return rate.fixed_s + v * rate.per_video_s;
}

/** "About 9 min to make on this Mac": always "about", rounded up, never "0 min". */
export function makingTimeText(videoSeconds: number, rate: MakingRate = DEFAULT_MAKING_RATE, where = "this computer"): string {
  const mins = Math.max(1, Math.ceil(estimateMakingSeconds(videoSeconds, rate) / 60));
  const span = mins >= 60 ? `${Math.floor(mins / 60)} hr${mins % 60 ? ` ${mins % 60} min` : ""}` : `${mins} min`;
  return `About ${span} to make on ${where}`;
}

/**
 * The making rate from finished videos: each sample is a video's length and how long its computer stages took.
 * Uses the median seconds-per-video-second once there are at least two samples, never faster than half the default
 * (one lucky run must not promise too much).
 */
export function makingRateFrom(samples: { length_s: number; stage_ms: number }[]): MakingRate {
  const rates = samples
    .filter((s) => Number.isFinite(s.length_s) && s.length_s > 0 && Number.isFinite(s.stage_ms) && s.stage_ms > 0)
    .map((s) => s.stage_ms / 1000 / s.length_s)
    .sort((a, b) => a - b);
  if (rates.length < 2) return DEFAULT_MAKING_RATE;
  const mid = rates.length / 2;
  const median = rates.length % 2 ? rates[Math.floor(mid)]! : (rates[mid - 1]! + rates[mid]!) / 2;
  return { fixed_s: DEFAULT_MAKING_RATE.fixed_s, per_video_s: Math.max(DEFAULT_MAKING_RATE.per_video_s / 2, Math.round(median * 100) / 100), measured: true };
}

/**
 * Per-step time estimates. Steps that scale with the video's length are seconds per second of video; the others
 * are fixed seconds. The defaults are deliberately on the slow side (they add up to about DEFAULT_MAKING_RATE).
 */
export const STAGE_TIME_DEFAULTS: Readonly<Record<string, { fixed_s?: number; per_video_s?: number }>> = {
  request: { fixed_s: 1 }, sources: { fixed_s: 2 }, write: { fixed_s: 150 }, check: { fixed_s: 45 },
  narrate: { per_video_s: 0.5 }, captions: { per_video_s: 0.3 }, media: { fixed_s: 5 }, expand: { fixed_s: 3 },
  lint: { fixed_s: 40 }, draft: { per_video_s: 0.6 }, final: { per_video_s: 1.1 }, save: { fixed_s: 2 },
};

/**
 * About how long each step takes for a video of `lengthS`, in ms: the median of the step's own times in earlier
 * videos here (at least two that really ran it, not reused it), else the default. `measured` when any step used
 * this computer's own times. Samples: a video's length and each step's ms.
 */
export function stageEstimates(samples: { length_s: number; stages: Record<string, number> }[], lengthS: number): { ms: Record<string, number>; measured: boolean } {
  const len = Number.isFinite(lengthS) && lengthS > 0 ? lengthS : 60;
  const out: Record<string, number> = {};
  let measured = false;
  for (const [id, d] of Object.entries(STAGE_TIME_DEFAULTS)) {
    const vals = samples
      .filter((s) => Number.isFinite(s.stages[id]) && s.stages[id]! > 0 && (!d.per_video_s || (Number.isFinite(s.length_s) && s.length_s > 0)))
      .map((s) => (d.per_video_s ? s.stages[id]! / s.length_s : s.stages[id]!))
      .sort((a, b) => a - b);
    if (vals.length >= 2) {
      const mid = vals.length / 2;
      const median = vals.length % 2 ? vals[Math.floor(mid)]! : (vals[mid - 1]! + vals[mid]!) / 2;
      out[id] = Math.round(d.per_video_s ? median * len : median);
      measured = true;
    } else {
      out[id] = Math.round(((d.fixed_s ?? 0) + (d.per_video_s ?? 0) * len) * 1000);
    }
  }
  return { ms: out, measured };
}

/**
 * Settings › Video default lengths: `video.lengths.<type id with _>` in integrations settings, in seconds (0 = the
 * type's own target). Built-in types have schema fields; custom (workspace) types are saved at the same path.
 */
export const videoLengthPath = (typeId: string) => `video.lengths.${typeId.replace(/-/g, "_")}`;
export const VIDEO_LENGTH_PATH = /^video\.lengths\.([a-z0-9_]{1,64})$/;
/** A saved default length: whole seconds from 0 (type default) to 10 minutes. */
export const isDefaultLength = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 600;
