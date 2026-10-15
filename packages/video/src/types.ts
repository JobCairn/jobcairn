import type { CaptionStyle, VideoStatus } from "@careeros/core";
export type { CaptionStyle } from "@careeros/core";

/** The visual scenes (spec version 3): pictures first, at most SCENE_WORD_CAP words on screen. */
export const VISUAL_SCENE_TYPES = ["icon-grid", "logo-row", "diagram", "match", "checklist", "timeline", "chart", "quote", "company-card", "map-pin", "kinetic", "matrix"] as const;
export const SCENE_TYPES = ["title", "bullet-build", "code-typing", "code-highlight", "code-morph", "code-diff", "flowchart", "sequence", "comparison", "stat", "quiz", "recap-card", ...VISUAL_SCENE_TYPES] as const;
export type SceneType = (typeof SCENE_TYPES)[number];
export type VisualSceneType = (typeof VISUAL_SCENE_TYPES)[number];
/** The video-slides skill writes only these (plugin/skills/video-slides/SKILL.md). */
export const SLIDE_SCENE_TYPES: readonly SceneType[] = ["title", "stat", "comparison", "bullet-build", "flowchart", "sequence", "recap-card", ...VISUAL_SCENE_TYPES];
/** Most words a scene shows (primary and secondary text; kickers, labels and source lines aside). Narration carries the rest. */
export const SCENE_WORD_CAP = 12;
/** Scenes the cap never applies to: a quiz question and code need their words. */
export const WORD_CAP_EXEMPT: readonly SceneType[] = ["quiz", "code-typing", "code-highlight", "code-morph", "code-diff"];
export const ENTRY_POINTS = ["job", "job.gaps", "job.interview", "company", "apply.review", "learn.topic", "home", "chat"] as const;
export type EntryPoint = (typeof ENTRY_POINTS)[number];
export const SUBJECT_KINDS = ["job", "company", "topic", "week"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export const VOICE_TYPES = ["guide", "interview", "slides"] as const;
export type VoiceType = (typeof VOICE_TYPES)[number];
export const SOURCE_RESOLVERS = ["gap", "job.jd", "job.must_haves", "job.score", "history", "profile", "company.research", "company.record", "interview.questions", "application.files", "index.stats", "learning.guide"] as const;
export type SourceResolver = (typeof SOURCE_RESOLVERS)[number];
export const STAGE_IDS = ["request", "sources", "write", "check", "review", "narrate", "captions", "media", "expand", "lint", "draft", "final", "save"] as const;
export type StageId = (typeof STAGE_IDS)[number];
export const STAGE_LABELS: Record<StageId, string> = {
  request: "Saving the request", sources: "Gathering your files", write: "Writing the script", check: "Checking facts",
  review: "Your review", narrate: "Narrating", captions: "Captioning", media: "Pictures and sound", expand: "Building scenes",
  lint: "Checking the video", draft: "Draft render", final: "Final render", save: "Saving",
};
export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";
export type RunStatus = "queued" | "running" | "review" | "preview" | "done" | "failed" | "cancelled";
export type VideoMode = "practice" | "watch";

export interface TypeSource { resolver: SourceResolver; required: boolean; glob?: string }
export interface VideoType {
  id: string; label: string; description: string; version: number; entry_points: EntryPoint[]; subject: SubjectKind;
  writer: "claude" | "template"; skill: "video-explainer" | "video-slides"; voice_type: VoiceType;
  length: { min_s: number; target_s: number; max_s: number }; scene_types: SceneType[];
  scene_counts: Partial<Record<SceneType, { min: number; max: number }>>; sources: TypeSource[]; brief_template: string;
  rules: string[]; facts: "strict" | "teaching"; extras: string[]; output: string; media: "none" | "offline" | "free";
  modes: VideoMode[]; origin: "builtin" | "workspace"; file: string;
}

export type VideoSubject =
  | { kind: "job"; company_slug: string; id: string }
  | { kind: "company"; company_slug: string; id?: string }
  | { kind: "topic"; topic: string; company_slug?: string; id?: string }
  | { kind: "week"; week: string };
export interface VideoOptions {
  length_s?: number; mode?: VideoMode; note?: string;
  /** Sound effects for this video: "off" leaves them out. Absent: the Settings > Videos choice (subtle by default). */
  sound?: "on" | "off";
  /**
   * "always": stop for the person's review after the script is written. "if_problems": when the script passes its
   * checks, go straight on to narrate and render the final video; stop for review only when problems are left.
   * `start()` stores "if_problems" when it is absent; a stored request without it is read as "always".
   */
  review?: "always" | "if_problems";
  /** When the folder already holds a video (fixed-folder types): replace it, or keep it as a dated copy. Never stored. */
  existing?: "replace" | "keep_copy";
}

// ---- scene spec v2 (plugin/skills/video-explainer/references/scene-spec.md plus `sources`) ----
export interface SourceCite { file: string; quote?: string; url?: string }
/** How much an on-screen text item matters (scene-spec.md § Roles). Optional: each field has a default. */
export const TEXT_ROLES = ["primary", "secondary", "support", "decorative"] as const;
export type TextRole = (typeof TEXT_ROLES)[number];
export interface CuedItem { text: string; cue: string; sources?: SourceCite[]; role?: TextRole }
export interface Mark { type: "underline" | "circle" | "arrow" | "highlight"; target: string; cue: string }
export interface SceneBase { cue: string; marks?: Mark[]; chapter?: boolean; hold?: number; sources?: SourceCite[] }
export interface TitleScene extends SceneBase { type: "title"; kicker: string; title: string; subtitle?: string; underline?: string }
export interface BulletScene extends SceneBase { type: "bullet-build"; headline: string; items: CuedItem[]; numbered?: boolean }
export interface CodeTypingScene extends SceneBase { type: "code-typing"; lang: string; code: string; headline?: string; label?: string; cue_done?: string }
export interface CodeHighlightScene extends SceneBase { type: "code-highlight"; lang: string; code: string; headline?: string; steps: { lines: [number, number]; note: string; cue: string; role?: TextRole }[] }
export interface CodeMorphScene extends SceneBase { type: "code-morph"; lang: string; from: string; to: string; headline?: string; cue_morph: string }
export interface CodeDiffScene extends SceneBase { type: "code-diff"; lang: string; before: string; after: string; headline?: string; note: string }
export interface FlowNode { id: string; label: string; sub?: string; cue: string; sources?: SourceCite[]; role?: TextRole }
export interface FlowchartScene extends SceneBase { type: "flowchart"; headline: string; direction: "lr" | "tb"; nodes: FlowNode[]; edges: [string, string, string?][] }
export interface SequenceScene extends SceneBase { type: "sequence"; headline: string; actors: string[]; messages: { from: string; to: string; label: string; cue: string; role?: TextRole }[] }
export interface ComparisonScene extends SceneBase {
  type: "comparison"; headline: string; left: { label: string; items: string[]; role?: TextRole }; right: { label: string; items: string[]; role?: TextRole };
  cue_left: string; cue_right: string; verdict?: string;
}
export interface StatScene extends SceneBase { type: "stat"; value: number; prefix?: string; suffix?: string; decimals?: number; label: string; source: string }
export interface QuizScene extends SceneBase {
  type: "quiz"; kind: "behavioural" | "technical" | "system-design"; question: string; think_seconds: number;
  beats: { label: string; text: string; cue: string; role?: TextRole }[]; strong: string[]; weak: string[]; prompt: string; cue_review: string;
}
export interface RecapScene extends SceneBase { type: "recap-card"; headline: string; items: CuedItem[]; closing: string }

// ---- visual scenes (spec version 3; scene-spec.md § Visual scenes) ----
/** A picture for an item: `logo` names a technology in the logo pack, `icon` names an icon in the icon pack. Neither:
 * the expander picks one from the label's words, else shows the label's initials. */
export interface Pictured { icon?: string; logo?: string }
export interface IconGridScene extends SceneBase { type: "icon-grid"; headline?: string; items: (Pictured & { label: string; cue: string; sources?: SourceCite[] })[] }
export interface LogoRowScene extends SceneBase { type: "logo-row"; headline?: string; items: { name: string; cue: string; sources?: SourceCite[] }[] }
export const DIAGRAM_KINDS = ["architecture", "userflow", "pipeline", "mesh"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];
/** `kind`: an architecture node kind (packs/architecture.json), or in a user flow "screen", "decision", "start" or "end". */
export interface DiagramNode extends Pictured { id: string; label: string; kind?: string; group?: string; cue: string; sources?: SourceCite[] }
export interface DiagramScene extends SceneBase {
  type: "diagram"; kind: DiagramKind; headline?: string; nodes: DiagramNode[];
  edges: { from: string; to: string; label?: string }[]; groups?: { id: string; label: string }[];
}
export const MATCH_STATUS = ["match", "partial", "gap"] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];
export interface MatchScene extends SceneBase { type: "match"; headline?: string; left_label?: string; right_label?: string; rows: (Pictured & { ask: string; status: MatchStatus; cue: string; sources?: SourceCite[] })[] }
export const CHECK_STATES = ["yes", "partial", "no"] as const;
export type CheckState = (typeof CHECK_STATES)[number];
export interface ChecklistScene extends SceneBase { type: "checklist"; headline?: string; items: { text: string; state: CheckState; cue: string; sources?: SourceCite[] }[] }
export interface TimelineScene extends SceneBase { type: "timeline"; headline?: string; steps: (Pictured & { label: string; when?: string; cue: string; sources?: SourceCite[] })[] }
export interface ChartScene extends SceneBase {
  type: "chart"; kind: "bar" | "ring"; headline?: string; bars?: { label: string; value: number; cue: string }[];
  value?: number; of?: number; label?: string; suffix?: string; source: string;
}
export interface QuoteScene extends SceneBase { type: "quote"; text: string; by: string }
export interface CompanyCardScene extends SceneBase { type: "company-card"; name: string; location?: string; size?: string; detail?: string }
export interface MapPinScene extends SceneBase { type: "map-pin"; city: string; region?: string; label?: string }
export interface KineticScene extends SceneBase { type: "kinetic"; lines: { text: string; cue: string }[]; emphasis?: string }
export interface MatrixScene extends SceneBase { type: "matrix"; headline?: string; cols: string[]; rows: { label: string; cells: CheckState[]; cue: string }[] }
export type VisualScene =
  | IconGridScene | LogoRowScene | DiagramScene | MatchScene | ChecklistScene | TimelineScene | ChartScene | QuoteScene
  | CompanyCardScene | MapPinScene | KineticScene | MatrixScene;
export type Scene =
  | TitleScene | BulletScene | CodeTypingScene | CodeHighlightScene | CodeMorphScene | CodeDiffScene
  | FlowchartScene | SequenceScene | ComparisonScene | StatScene | QuizScene | RecapScene | VisualScene;
export interface SceneSpec {
  version: 1 | 2 | 3; title: string; voice_type: VoiceType; audio?: string; words?: string; captions?: CaptionStyle; format?: "1920x1080"; scenes: Scene[];
}

/** One problem found by spec validation, the fact check or the timeline. `scene` is 0-based; messages say "Scene N" 1-based. */
export interface Issue { level: "error" | "warning"; code: string; scene: number | null; path: string; message: string }
export interface Word { text: string; start: number; end: number }

// ---- sources ----
export interface PackFile { rel: string; resolver: SourceResolver; required: boolean; bytes: number; extract: string; untrusted: boolean }
export type FixAction = "score-job" | "research-company" | "save-jd" | "add-history" | "prepare-application" | "pick-topic" | "none";
/** `blocked` is true only when the resolver's target genuinely exists but sits inside a
 * lockable folder (me/identity or me/employment) - reached through a symlink or alias, since
 * no built-in resolver targets those folders directly. Distinct from an ordinary "missing":
 * the writer prompt must never say "add this" for a blocked source, only that it is
 * unavailable, with the 3c request_access rule (Task 15, carried from Task 7). */
export interface MissingSource { resolver: SourceResolver; message: string; fix: FixAction; blocked: boolean }
export interface WeekStats {
  week: string; from: string; to: string; found: number; applied: number; replies: number; interviews: number;
  sponsorship: { sponsorship_offered: number; visa_ok: number; silent: number; citizen_pr_only: number; clearance: number };
  next_steps: { title: string; company: string; action: string }[];
}
export interface PackFacts { name: string; role: string; company: string; gap: string; week: string; stats: WeekStats | null }
/** `cautions`: the candidate's own "do not claim" list from me/history (sources.ts doNotClaim). Absent or empty: none. */
export interface SourcePack { files: PackFile[]; missing: MissingSource[]; facts: PackFacts; candidateTerms: string[]; cautions?: string[] }

// ---- runs and review ----
export interface StageView { id: StageId; label: string; status: StageStatus; pct: number; elapsed_ms: number; message: string }
export interface RunView {
  runId: string; folder: string; type: string; phase: "write" | "build" | "final"; status: RunStatus; stages: StageView[];
  started_at: string; error: string; queued_behind: number;
  /** The steps this run will take, in order, fixed when it starts (skipped and unused ones left out). */
  plan: StageId[];
}
export type VideoEvent =
  | { kind: "stage"; runId: string; folder: string; stage: StageId; status: StageStatus; pct: number; message: string; elapsed_ms: number }
  | { kind: "run"; runId: string; folder: string; status: RunStatus; error: string };
export interface EditableField { path: string; label: string; value: string; max_words: number }
export interface SceneDraft {
  index: number; type: SceneType; headline: string; script: string; shared: boolean; fields: EditableField[];
  sources: SourceCite[]; issues: Issue[];
}
export interface VideoDraft {
  folder: string; type: string; type_label: string; title: string; status: VideoStatus; scenes: SceneDraft[]; issues: Issue[];
  estimated_s: number; length: { min_s: number; target_s: number; max_s: number }; sources_md: string; extras: { name: string; text: string }[];
  files: { draft: string | null; final: string | null; contact_sheet: string | null; srt: string | null; vtt: string | null };
  voice: { engine: string; voice: string; fell_back: boolean }; captions_estimated: boolean;
  locked_facts: { folder: string; granted_at: string }[]; can_approve: boolean; can_revise: boolean; error: string;
  /** The final video's QA label (Task 18b), or null when there is none. Only the count of open issues travels. */
  qa: { status: "passed" | "open_issues"; open_issues: number } | null;
  /** The length the person asked for, in seconds (absent for a record that can't be read). */
  asked_s?: number;
  /** Chapters of a long video, with where each starts in the rendered video. Empty when there are none. */
  chapters: { title: string; start_s: number }[];
  /**
   * What the check fixed on its own, for "Claude fixed N problems" / "N problems left". Null before any check.
   * `repairs`: plain-English shape slips repaired in spec.json. `claude_passes`: times Claude was asked to fix
   * problems (0 to 2). `claude_fixed`: problems those passes removed. `left`: errors still open now.
   */
  autofix: { repairs: string[]; claude_passes: number; claude_fixed: number; left: number } | null;
  /**
   * Making the video stopped at `stage` (status "failed"): the plain reason, which render it was making, and whether
   * "Make it without the check" applies (the video check stopped it). Null when it didn't stop.
   */
  /** What the video check noted but didn't stop for: "Delivered with N notes". `area`: layout, contrast, motion or check. */
  check_notes: { area: string; text: string }[];
  stopped: { stage: StageId; label: string; reason: string; quality: "draft" | "final"; can_skip_check: boolean } | null;
  /** Where the time went: the last run's total, and the slowest steps (most first) with their parts. */
  timings: VideoTimingsView;
}
export interface VideoTimingsView {
  total_ms: number | null;
  slowest: { stage: StageId; label: string; ms: number; parts: { name: string; ms: number }[] }[];
}
export interface ScriptEdits { scenes: { index: number; script?: string; fields?: { path: string; value: string }[] }[] }
/** `motion`: "reduced" keeps reveals to short fades (no pans, zooms or drift). `sound`: "off" leaves out the sound
 * effects. `music`: a quiet bed under the narration. All optional: absent means full motion, subtle sound, no music. */
export interface VideoSettings { captions: CaptionStyle; lengths: Record<string, number>; motion?: "full" | "reduced"; sound?: "subtle" | "off"; music?: boolean }
