import type { ActionTarget } from "./actions.js";
import type { MakingRate } from "./video-lengths.js";
import { ArgError, arr, int, obj, oneOf, opt, relPath, slug, str, type V } from "./validate.js";

export const VIDEO_SCREENS = ["job", "job.gaps", "job.interview", "company", "apply.review", "learn.topic", "home", "chat", "all"] as const;
export type VideoScreen = (typeof VIDEO_SCREENS)[number];
export const CAPTION_STYLES = ["rail", "pill", "highlight", "none"] as const;
export const VIDEO_STATUSES = ["writing", "checking", "review", "narrating", "rendering", "preview", "done", "failed", "cancelled"] as const;
export const VIDEO_STAGE_IDS = ["request", "sources", "write", "check", "review", "narrate", "captions", "media", "expand", "lint", "draft", "final", "save"] as const;
export const INSTALLABLE_TOOLS = ["ffmpeg", "chrome", "hyperframes", "supertonic", "whisper"] as const;
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
/** Same pattern as core's VIDEO_FOLDER_RE (a test keeps them equal). */
export const VIDEO_FOLDER_RE = new RegExp(`^(?:recaps/\\d{4}-W\\d{2}(?:-\\d{4}-\\d{2}-\\d{2}(?:-\\d{1,2})?)?|(?:learning/${SLUG}|companies/${SLUG}(?:/jobs/${SLUG})?)(?:/[a-z0-9][a-z0-9_-]{0,60}){1,3})$`);
export const RUN_ID_RE = /^vr-[a-z0-9-]{1,60}$/;
export const VIDEO_TYPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const CTRL = /[\u0000-\u001f\u007f]/;

export type VideoSubjectArg =
  | { kind: "job"; company_slug: string; id: string }
  | { kind: "company"; company_slug: string; id?: string }
  | { kind: "topic"; topic: string; company_slug?: string; id?: string }
  | { kind: "week"; week: string };
/**
 * `review`: "always" stops for the person's review once the script is written; "if_problems" (the default for a new
 * request) goes straight on to narrate and render the final video when the script passes its checks, and stops
 * for review only when problems are left.
 */
export interface VideoOptionsArg { length_s?: number; mode?: "practice" | "watch"; note?: string; existing?: "replace" | "keep_copy"; review?: "always" | "if_problems"; sound?: "on" | "off" }
export interface VideoTypeView {
  id: string; label: string; description: string; subject: "job" | "company" | "topic" | "week"; entry_points: VideoScreen[];
  length: { min_s: number; target_s: number; max_s: number }; modes: ("practice" | "watch")[]; writer: "claude" | "template"; origin: "builtin" | "workspace";
  /** The length Make video starts on: the saved default for this type (Settings > Video), else the type's target. */
  default_s?: number;
}
export interface VideoTypesView {
  types: VideoTypeView[]; errors: { file: string; origin: "builtin" | "workspace"; problems: string[] }[];
  /** How long making a video takes here (measured from finished videos, else a cautious default). */
  making?: MakingRate;
}
export interface VideoToolView { id: string; label: string; ok: boolean; required: boolean; version: string; message: string; install: string | null }
export interface VideoToolsView { ok: boolean; tools: VideoToolView[]; checked_at: string; can_install: boolean }
export interface VideoSourcesView {
  files: { rel: string; resolver: string; required: boolean; untrusted: boolean }[];
  missing: { resolver: string; message: string; fix: string }[]; ready: boolean; folder: string;
  /** The video already in that folder (application summary, weekly recap): Make video asks to replace it or keep a copy. */
  existing?: { status: string; has_final: boolean; has_script: boolean } | null;
}
export interface VideoIssue { level: "error" | "warning"; code: string; scene: number | null; path: string; message: string }
export interface VideoStageView { id: (typeof VIDEO_STAGE_IDS)[number]; label: string; status: "pending" | "running" | "done" | "failed" | "skipped" | "cancelled"; pct: number; elapsed_ms: number; message: string }
export interface VideoRunView {
  runId: string; folder: string; type: string; phase: "write" | "build" | "final";
  status: "queued" | "running" | "review" | "preview" | "done" | "failed" | "cancelled"; stages: VideoStageView[]; started_at: string; error: string; queued_behind: number;
  /** The steps this run will take, fixed when it starts (skipped and unused steps left out). Absent: every step not skipped. */
  plan?: (typeof VIDEO_STAGE_IDS)[number][];
  /** About how long each planned step takes here, in ms (`stageEstimates`), and whether that is measured on this computer. */
  estimates?: { ms: Partial<Record<(typeof VIDEO_STAGE_IDS)[number], number>>; measured: boolean };
}
export interface VideoSceneDraft {
  index: number; type: string; headline: string; script: string; shared: boolean;
  fields: { path: string; label: string; value: string; max_words: number }[]; sources: { file: string; quote?: string; url?: string }[]; issues: VideoIssue[];
}
export interface VideoDraftView {
  folder: string; type: string; type_label: string; title: string; status: (typeof VIDEO_STATUSES)[number]; scenes: VideoSceneDraft[]; issues: VideoIssue[];
  estimated_s: number; length: { min_s: number; target_s: number; max_s: number }; sources_md: string; extras: { name: string; text: string }[];
  files: { draft: string | null; final: string | null; contact_sheet: string | null; srt: string | null; vtt: string | null };
  voice: { engine: string; voice: string; fell_back: boolean }; captions_estimated: boolean; locked_facts: { folder: string; granted_at: string }[];
  can_approve: boolean; can_revise: boolean; error: string;
  /** The final video's QA label (Task 18b): "passed", or the number of open issues. Absent or null when there is none. */
  qa?: { status: "passed" | "open_issues"; open_issues: number } | null;
  /** The length asked for in Make video, in seconds. */
  asked_s?: number;
  /** A long video's chapters and where each starts, for the player's chapter list. */
  chapters?: { title: string; start_s: number }[];
  /**
   * What the check fixed on its own: "Claude fixed {claude_fixed} problems" / "{left} problems left". Absent or null
   * before any check. `repairs` are plain-English shape slips fixed in the plan; `claude_passes` is 0 to 2.
   */
  autofix?: { repairs: string[]; claude_passes: number; claude_fixed: number; left: number } | null;
  /**
   * Making the video stopped (status "failed"): the step it stopped at, the plain reason, which render it was making
   * (Try again makes the same one), and whether "Make it without the check" applies. Absent or null otherwise.
   */
  /** What the video check noted but didn't stop for (layout, contrast, motion, or that it was skipped). */
  check_notes?: { area: string; text: string }[];
  stopped?: { stage: (typeof VIDEO_STAGE_IDS)[number]; label: string; reason: string; quality: "draft" | "final"; can_skip_check: boolean } | null;
  /** Where the time went: the last run's total and its slowest steps, most first, each with its parts. */
  timings?: { total_ms: number | null; slowest: { stage: (typeof VIDEO_STAGE_IDS)[number]; label: string; ms: number; parts: { name: string; ms: number }[] }[] } | null;
}
export interface VideoScriptEdits { scenes: { index: number; script?: string; fields?: { path: string; value: string }[] }[] }
export interface VideoListItem {
  folder: string; type: string; type_label: string; title: string; status: (typeof VIDEO_STATUSES)[number]; subject: VideoSubjectArg;
  section: "topics" | "jobs" | "companies" | "recaps"; length_s: number | null; created_at: string; updated_at: string;
  final: string | null; draft: string | null; captions: (typeof CAPTION_STYLES)[number]; used_locked: boolean; context: string;
  /** Why making it stopped (status "failed"), in plain words, for "Didn't finish: <reason>". */
  error?: string;
  /** How long making it took: the sum of its steps' times in video.json. Absent when no step was timed. */
  making_ms?: number;
  /** A still to show for it: the contact sheet or the first QA frame (fixed names only, never a path from the record). */
  poster?: string | null;
  /**
   * An older folder with a script but no video.json (made before videos were built into the app). It can't be opened,
   * rendered or deleted by the pipeline; the UI offers to make it again and to show its folder.
   */
  legacy?: boolean;
}
export interface VideoListFilter { section?: VideoListItem["section"]; company_slug?: string; job_id?: string; topic?: string }
/** A request to open Make video: the type, a subject or note in words, and (from a button or the services) the page's target. */
export interface VideoIntent { type: string; subject: string; target?: ActionTarget }
/** The catalogue's video actions and the video type each one makes. A video action always runs through Make video. */
export const VIDEO_ACTION_TYPES: Readonly<Record<string, string>> = {
  skill_gap_video: "skill-gap-lesson", jd_walkthrough_video: "jd-walkthrough", company_background_video: "company-briefing",
  interview_prep_video: "interview-prep", pitch_video: "pitch", application_summary_video: "application-summary", weekly_recap_video: "weekly-recap",
};

export const videoTypeId = str({ min: 1, max: 40, pattern: VIDEO_TYPE_RE });
export const videoRunId = str({ min: 1, max: 64, pattern: RUN_ID_RE });
export const videoFolder: V<string> = (v, at) => {
  const s = relPath(v, at);
  // Mirrors core's isVideoFolderRel exactly: the regex alone has no upper bound on a slug or
  // learning-topic length, so the 300-char cap is a separate, required check.
  if (s.length > 300 || !VIDEO_FOLDER_RE.test(s)) throw new ArgError(`${at} must be a video folder`);
  return s;
};
const topic: V<string> = (v, at) => {
  const s = str({ min: 1, max: 80 })(v, at);
  if (CTRL.test(s)) throw new ArgError(`${at} contains control characters`);
  return s;
};
const jobSubject = obj({ kind: oneOf(["job"] as const), company_slug: slug, id: slug });
const companySubject = obj({ kind: oneOf(["company"] as const), company_slug: slug, id: opt(slug) });
const topicSubject = obj({ kind: oneOf(["topic"] as const), topic, company_slug: opt(slug), id: opt(slug) });
const weekSubject = obj({ kind: oneOf(["week"] as const), week: str({ min: 8, max: 8, pattern: WEEK_RE }) });
export const videoSubject: V<VideoSubjectArg> = (v, at) => {
  const kind = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined;
  if (kind === "job") {
    if ((v as { id?: unknown }).id === undefined) throw new ArgError(`${at}.id is required`);
    return jobSubject(v, at) as VideoSubjectArg;
  }
  if (kind === "company") return companySubject(v, at) as VideoSubjectArg;
  if (kind === "topic") return topicSubject(v, at) as VideoSubjectArg;
  if (kind === "week") return weekSubject(v, at) as VideoSubjectArg;
  throw new ArgError(`${at}.kind must be job, company, topic or week`);
};
export const videoOptions = obj({
  length_s: opt(int(10, 600)), mode: opt(oneOf(["practice", "watch"] as const)), note: opt(str({ max: 500, multiline: true })),
  existing: opt(oneOf(["replace", "keep_copy"] as const)), review: opt(oneOf(["always", "if_problems"] as const)),
  sound: opt(oneOf(["on", "off"] as const)),
});
const fieldPath: V<string> = (v, at) => {
  const s = str({ min: 1, max: 40, pattern: /^[a-z_]+(\.([a-z_]+|\d{1,2})){0,3}$/ })(v, at);
  if (s.split(".").some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) throw new ArgError(`${at} is not allowed`);
  return s;
};
/** Scenes a video may have (a 10-minute video needs many more than a 1-minute one); matches @careeros/video's ceiling. */
export const MAX_VIDEO_SCENES = 60;
export const videoScriptEdits = obj({
  scenes: arr(obj({
    index: int(0, MAX_VIDEO_SCENES - 1),
    script: opt(str({ max: 4000, multiline: true })),
    fields: opt(arr(obj({ path: fieldPath, value: str({ max: 400 }) }), { max: 40 })),
  }), { max: MAX_VIDEO_SCENES }),
});
export const videoListFilter = obj({
  section: opt(oneOf(["topics", "jobs", "companies", "recaps"] as const)), company_slug: opt(slug), job_id: opt(slug), topic: opt(slug),
});

/** One ISO week rule for the whole app (actions.ts owns it since the merge with develop). */
export { isoWeek } from "./actions.js";

export function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function videoSection(subject: VideoSubjectArg): VideoListItem["section"] {
  return subject.kind === "topic" ? "topics" : subject.kind === "week" ? "recaps" : subject.kind === "company" ? "companies" : "jobs";
}
