import { topicSlug } from "./constants.js";
import { CONTEXT_WINDOW, SKILL_KEYWORDS, type SkillKeyword } from "./config/skill-keywords.js";
import type { LearnData, LearnItem } from "./types.js";

export { SKILL_KEYWORDS, type SkillKeyword } from "./config/skill-keywords.js";

/**
 * Learn hub: shared logic for the services and the MockBridge. Pure functions only; the callers
 * read the files (and skip locked folders) before handing text in here.
 */

export const LEARN_PROGRESS = ["not_started", "in_progress", "done"] as const;
export type LearnProgress = (typeof LEARN_PROGRESS)[number];
export type LearnType = "guide" | "video" | "interview";

export interface LearnSource { company_slug: string; id: string; title: string; company_name: string }
export interface LearnEntry {
  path: string; title: string; type: LearnType;
  /** The learning topic folder (learning/<topic>/...), or null for job-linked prep and recaps. */
  topic: string | null;
  source: LearnSource | null;
  /** When the file was last written (ISO), or "" when unknown. */
  at: string;
  progress: LearnProgress;
  /** When the progress last changed (ISO), or "". For "done" this is the completion time. */
  progress_at: string;
}
export interface SkillSuggestion {
  skill: string; slug: string;
  /** Saved jobs that mention it, out of `total`. */
  jobs: number; total: number;
  /** True when a study guide for it already exists in learning/. */
  started: boolean;
}
export interface JobToLearn extends LearnSource { gaps: string[] }
export interface LearnHub {
  entries: LearnEntry[];
  suggestions: SkillSuggestion[];
  /** Scored jobs whose score lists gaps (each opens on its Gaps tab). */
  scored: JobToLearn[];
  /** Jobs with no score yet (the first few). */
  unscored: JobToLearn[];
  /** How many jobs have no score yet in all, which can be more than `unscored` lists. */
  unscored_total: number;
  jobs: number;
}
export type ProgressMap = Record<string, { state: LearnProgress; at: string }>;

/** How many skill suggestions Learn shows. */
export const MAX_SUGGESTIONS = 8;
const MAX_JOB_LIST = 8;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** Whole-word match: the alias may not sit inside a longer word (so "java" never matches "javascript"). */
function aliasRe(alias: string): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}+#])${escape(alias.toLowerCase())}(?=$|[^\\p{L}\\p{N}+#])`, "u");
}
const cache = new Map<string, RegExp>();
const re = (a: string) => { let r = cache.get(a); if (!r) { r = aliasRe(a); cache.set(a, r); } return r; };

const reAll = (a: string) => new RegExp(re(a).source, "gu");

/** A weak word counts only when a context word sits within CONTEXT_WINDOW characters of it. */
function weakHit(t: string, k: SkillKeyword): boolean {
  if (!k.weak?.length || !k.context?.length) return false;
  for (const w of k.weak) {
    for (const m of t.matchAll(reAll(w))) {
      const at = (m.index ?? 0) + m[1]!.length;
      const near = t.slice(Math.max(0, at - CONTEXT_WINDOW), at + w.length + CONTEXT_WINDOW);
      if (k.context.some((c) => re(c).test(near))) return true;
    }
  }
  return false;
}

/**
 * Labels of the keywords that `text` mentions. With `declared`, the text is a list of skills the person
 * named themselves (profile keywords), so an ambiguous word like "agents" counts without context.
 */
export function skillsIn(text: string, keywords: readonly SkillKeyword[] = SKILL_KEYWORDS, opts: { declared?: boolean } = {}): Set<string> {
  const t = text.toLowerCase();
  const out = new Set<string>();
  const words = (k: SkillKeyword) => (opts.declared ? [...k.aliases, ...(k.weak ?? [])] : k.aliases);
  for (const k of keywords) if (words(k).some((a) => re(a).test(t)) || (!opts.declared && weakHit(t, k))) out.add(k.label);
  return out;
}

/**
 * Skills the saved jobs ask for that the person's own material doesn't mention, most-asked first.
 * `jobs` is one text per saved job (its title and ad); `have` is text from the person's own documents;
 * `declared` is the skills they listed themselves (profile keywords). Each job counts once per skill.
 */
export function skillGaps(input: {
  jobs: string[]; have: string[]; declared?: string[]; keywords?: readonly SkillKeyword[]; limit?: number; started?: (slug: string) => boolean;
}): SkillSuggestion[] {
  const keywords = input.keywords ?? SKILL_KEYWORDS;
  const owned = skillsIn(input.have.join("\n"), keywords);
  for (const d of input.declared ?? []) for (const s of skillsIn(d, keywords, { declared: true })) owned.add(s);
  const counts = new Map<string, number>();
  for (const text of input.jobs) for (const s of skillsIn(text, keywords)) if (!owned.has(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, input.limit ?? MAX_SUGGESTIONS)
    .map(([skill, n]) => ({ skill, slug: topicSlug(skill), jobs: n, total: input.jobs.length, started: input.started?.(topicSlug(skill)) ?? false }));
}

/** Only valid entries survive: a hand-edited or damaged progress file can't break Learn. */
export function sanitizeProgress(raw: unknown): ProgressMap {
  const out: ProgressMap = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype" || typeof v !== "object" || v === null) continue;
    const { state, at } = v as { state?: unknown; at?: unknown };
    if (typeof state === "string" && (LEARN_PROGRESS as readonly string[]).includes(state)) {
      out[k] = { state: state as LearnProgress, at: typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : "" };
    }
  }
  return out;
}

/** Interview drills, pitches and prep notes are "interview"; other job videos are "video". */
function jobType(it: LearnItem, path: string): LearnType {
  if (it.kind === "guide") return "interview";
  return /\/interview\//.test(path) ? "interview" : "video";
}

/**
 * Every guide, video and interview-prep item as one flat list with its progress, newest first.
 * `at(path)` gives the file's modified time ("" when unknown).
 */
export function learnEntries(data: LearnData, progress: ProgressMap, at: (path: string) => string): LearnEntry[] {
  const p = (path: string) => progress[path] ?? { state: "not_started" as const, at: "" };
  const make = (it: LearnItem, type: LearnType, topic: string | null, source: LearnSource | null): LearnEntry => ({
    path: it.path, title: it.title, type, topic, source, at: at(it.path), progress: p(it.path).state, progress_at: p(it.path).at,
  });
  const out: LearnEntry[] = [
    ...data.topics.flatMap((t) => t.items.map((it) => make(it, it.kind === "video" ? "video" : "guide", t.slug, null))),
    ...data.interviewPrep.flatMap((j) => j.items.map((it) => make(it, jobType(it, it.path), null, {
      company_slug: j.company_slug, id: j.id, title: j.title, company_name: j.company_name,
    }))),
    ...(data.recaps ?? []).map((it) => make(it, "video", null, null)),
  ];
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.title.localeCompare(b.title));
}

/** Completed items, most recently finished first. */
export function learnHistory(entries: LearnEntry[]): LearnEntry[] {
  return entries.filter((e) => e.progress === "done").sort((a, b) => b.progress_at.localeCompare(a.progress_at));
}

/** Jobs split into scored-with-gaps and not scored yet, at most a handful of each. */
export function jobsToLearn(jobs: (JobToLearn & { scored: boolean })[]): { scored: JobToLearn[]; unscored: JobToLearn[]; unscored_total: number } {
  const strip = ({ scored: _s, ...j }: JobToLearn & { scored: boolean }): JobToLearn => j;
  const unscored = jobs.filter((j) => !j.scored);
  return {
    scored: jobs.filter((j) => j.scored && j.gaps.length).slice(0, MAX_JOB_LIST).map(strip),
    unscored: unscored.slice(0, MAX_JOB_LIST).map(strip),
    unscored_total: unscored.length,
  };
}

// -- Getting started ----------------------------------------------------------

export const GUIDE_STEPS = ["profile", "find_jobs", "score_job", "prepare", "learn", "email"] as const;
export type GuideStepId = (typeof GUIDE_STEPS)[number];
export interface GuideJob { company_slug: string; id: string; title: string; company_name: string }
/** What the workspace holds, read by the services (or the mock). The checklist is computed from this. */
export interface GuideFacts {
  /** The profile has a name. */
  profile: boolean;
  /** me/resumes holds at least one file. */
  resume: boolean;
  /** Search preferences are set: at least one target role and one place (find-prefs prefsMissing is empty). */
  prefs: boolean;
  jobs: number;
  scored: number;
  /** A job worth scoring next, if any. */
  nextToScore: GuideJob | null;
  /** Jobs being prepared or already applied for. */
  preparing: number;
  /** A job worth preparing next, if any. */
  nextToPrepare: GuideJob | null;
  /** Guides, videos and prep items in Learn. */
  learning: number;
  /** Gmail is connected in this workspace. Absent: this app has no mail, so the step is listed but can't be done. */
  email?: boolean;
}
export interface GuideStep { id: GuideStepId; done: boolean; available: boolean }
/** `skipped`: Set up steps the person chose to skip (`.careeros/guide.json`), only ever the skippable ones. */
export interface GuideState { facts: GuideFacts; steps: GuideStep[]; done: number; total: number; dismissed: boolean; skipped: SetupStepId[] }

// -- Set up JobCairn: the first-run steps before the first week -----------------

/** What a new workspace needs before Claude can find and score jobs, in the order they're best done. */
export const SETUP_STEPS = ["claude", "chrome", "profile", "search_prefs", "find_jobs", "score_job"] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];
/** Steps a person may skip. Chrome: without it Claude searches the web instead of their signed-in job boards. */
export const SKIPPABLE_SETUP: readonly SetupStepId[] = ["chrome"];
export const isSkippableSetup = (id: unknown): id is SetupStepId => (SKIPPABLE_SETUP as readonly unknown[]).includes(id);

/**
 * What only the app knows right now, checked live in the window rather than read from the folder.
 * `claude`: Claude Code is set up and ready (null while it's checked). `chrome`: the browser helper is installed and
 * Chrome's remote control is on (null while it's checked; absent when this copy of the app can't drive Chrome).
 */
export interface SetupLive { claude: boolean | null; chrome?: boolean | null }
export interface SetupStep { id: SetupStepId; done: boolean; skipped: boolean; optional: boolean; available: boolean }
/** `done` counts steps done or skipped, out of `total` that can be done; `complete` when nothing's left or being checked. */
export interface SetupState { steps: SetupStep[]; done: number; total: number; complete: boolean }

export function setupState(f: GuideFacts, live: SetupLive, skipped: readonly SetupStepId[]): SetupState {
  const done: Record<SetupStepId, boolean> = {
    claude: live.claude === true, chrome: live.chrome === true, profile: f.profile && f.resume, search_prefs: f.prefs,
    find_jobs: f.jobs > 0, score_job: f.scored > 0,
  };
  const steps = SETUP_STEPS.map((id): SetupStep => {
    const optional = isSkippableSetup(id);
    return { id, done: done[id], skipped: optional && !done[id] && skipped.includes(id), optional, available: id !== "chrome" || live.chrome !== undefined };
  });
  const counted = steps.filter((s) => s.available);
  const n = counted.filter((s) => s.done || s.skipped).length;
  return { steps, done: n, total: counted.length, complete: n === counted.length };
}

export function guideSteps(f: GuideFacts): GuideStep[] {
  const done: Record<GuideStepId, boolean> = {
    profile: f.profile && f.resume, find_jobs: f.jobs > 0, score_job: f.scored > 0, prepare: f.preparing > 0, learn: f.learning > 0, email: f.email === true,
  };
  // Without mail in this app, Email is listed so people know it's coming, but it can't be done.
  return GUIDE_STEPS.map((id) => ({ id, done: done[id], available: id !== "email" || f.email !== undefined }));
}

export function guideState(facts: GuideFacts, dismissed: boolean, skipped: readonly SetupStepId[] = []): GuideState {
  const steps = guideSteps(facts);
  const live = steps.filter((s) => s.available);
  return { facts, steps, done: live.filter((s) => s.done).length, total: live.length, dismissed, skipped: skipped.filter(isSkippableSetup) };
}
