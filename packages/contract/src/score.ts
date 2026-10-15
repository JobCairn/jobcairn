import { arr, int, obj, oneOf, opt, str, type V } from "./validate.js";

/**
 * A job's structured score: what the score_record MCP tool takes at the end of a "Score this job" run, what
 * services save as score.json beside the write-up (score.md), and what the Job › Score card shows.
 */

/** The career skill's recommendation tiers (plugin/skills/career/references/job-scoring-rubric.md), worst first. */
export const SCORE_TIERS = ["Definite No Go", "Nah", "Meh", "Good Fit", "Freaking Apply Now"] as const;
export type ScoreTier = (typeof SCORE_TIERS)[number];
export const MUST_HAVE_STATUSES = ["met", "partial", "not_met"] as const;
export type MustHaveStatus = (typeof MUST_HAVE_STATUSES)[number];

export interface ScoreItem { text: string; status: MustHaveStatus; evidence: string }
export interface ScoreResult {
  fit: number | null;
  interview_odds: number | null;
  tier: ScoreTier | "";
  recommendation: string;
  summary: string;
  must_haves: ScoreItem[];
  nice_to_haves: ScoreItem[];
  /** "What would change this": things that would move the score. */
  changes: string[];
  scored_at: string;
  /** structured: score.json; record: the job record's scores only; legacy: a number read from an older write-up. */
  source: "structured" | "record" | "legacy";
}

/** Limits shared by the MCP tool's JSON Schema and its validator. */
export const SCORE_LIMITS = { item: 200, evidence: 400, items: 40, changes: 12, change: 300, recommendation: 300, summary: 2000 } as const;

const line = (max: number) => str({ min: 1, max });
const item = obj({ text: line(SCORE_LIMITS.item), status: oneOf(MUST_HAVE_STATUSES), evidence: opt(str({ max: SCORE_LIMITS.evidence, multiline: true })) });
const shape = {
  fit: int(0, 100), interview_odds: int(0, 100), tier: oneOf(SCORE_TIERS), recommendation: line(SCORE_LIMITS.recommendation),
  must_haves: arr(item, { max: SCORE_LIMITS.items }), nice_to_haves: opt(arr(item, { max: SCORE_LIMITS.items })),
  changes: opt(arr(line(SCORE_LIMITS.change), { max: SCORE_LIMITS.changes })), summary: opt(str({ max: SCORE_LIMITS.summary, multiline: true })),
};
export type ScoreRecordArgs = Omit<ScoreResult, "scored_at" | "source" | "fit" | "interview_odds" | "tier"> & { fit: number; interview_odds: number; tier: ScoreTier };

const items = (xs: { text: string; status: MustHaveStatus; evidence?: string }[] | undefined): ScoreItem[] =>
  (xs ?? []).map((x) => ({ text: x.text, status: x.status, evidence: x.evidence ?? "" }));

/** Validates score_record's arguments. Optional lists default to empty. Unknown keys (a "path", say) are refused. */
export const scoreRecordArgs: V<ScoreRecordArgs> = (v, at) => {
  const a = obj(shape)(v, at);
  return {
    fit: a.fit, interview_odds: a.interview_odds, tier: a.tier, recommendation: a.recommendation,
    must_haves: items(a.must_haves), nice_to_haves: items(a.nice_to_haves), changes: a.changes ?? [], summary: a.summary ?? "",
  };
};

/** JSON Schema for one must-have or nice-to-have, as shown to Claude. */
export const SCORE_ITEM_SCHEMA = {
  type: "object", additionalProperties: false, required: ["text", "status"],
  properties: {
    text: { type: "string", description: "What the ad asks for, in its words", maxLength: SCORE_LIMITS.item },
    status: { type: "string", enum: [...MUST_HAVE_STATUSES] },
    evidence: { type: "string", description: "One plain sentence: what shows it (your resume, your profile, the job ad). Never a file path.", maxLength: SCORE_LIMITS.evidence },
  },
} as const;

// ---- plain words -----------------------------------------------------------------------------------------------

/** Workspace files by name: what a person would call them. */
const BY_NAME: Record<string, string> = {
  "jd.md": "the job ad", "score.md": "the score write-up", "score.json": "the score", "resume.md": "your tailored resume",
  "cover-letter.md": "your cover letter", "claims.json": "the claim sources", "answers.md": "your application answers",
  "research.md": "the company research", "questions.md": "the interview questions", "guide.md": "the study guide",
  "profile.md": "your profile", "profile.json": "your profile", "job.json": "the job record", "company.json": "the company record",
};
const ME = "resumes|history|identity|employment|education|projects";
const ROOTS = "companies|application|knowledge|learning|settings|interview|recaps";
const EXT = "md|pdf|json|jsonl|docx|txt";
const NAMES = Object.keys(BY_NAME).map((n) => n.replace(/[.-]/g, "\\$&")).join("|");
/**
 * A workspace path, not inside a URL or another path: anything under one of the me/ folders, a file with a document
 * extension under another workspace folder, or a bare known file name. "application/json" and "me/us" stay as they are.
 */
const PATH_RE = new RegExp(
  `(?<![\\w/.:@~\\\\-])(?:me/(?:${ME})(?:/[\\w.-]*\\w)*|(?:${ROOTS})(?:/[\\w.-]*\\w)*/[\\w.-]*\\.(?:${EXT})|(?:${NAMES}))(?![\\w/-]|\\.\\w)`,
  "g",
);

/** A friendly name for one workspace path. */
export function friendlyPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (parts[0] === "me") {
    if (parts[1] === "resumes") return "your resume";
    if (parts[1] === "history") return name === "profile.md" ? "your profile" : "your career history";
    if (parts[1] === "identity" || parts[1] === "employment") return "your private documents";
    if (parts[1] === "education") return "your education records";
    if (parts[1] === "projects") return "your projects";
    return "your files";
  }
  if (BY_NAME[name]) return BY_NAME[name]!;
  switch (parts[0]) {
    case "settings": return "your settings";
    case "knowledge": return "your notes";
    case "learning": return "your study notes";
    case "application": return "your application";
    case "interview": return "your interview notes";
    case "recaps": return "your weekly recap";
    case "companies": return parts.includes("application") ? "your application" : parts.includes("interview") ? "your interview notes" : "the job's files";
    default: return "a file";
  }
}

const LABELS: [RegExp, string][] = [
  [/\s*\((?:career skill,?\s*)?workflow\s*\d+[^)]*\)/gi, ""],
  [/\bRubric A(?:\s*[—–:-]\s*Ideal Job Match)?\b/g, "Fit"],
  [/\bRubric B(?:\s*[—–:-]\s*Interview Odds)?\b/g, "Interview odds"],
  [/\bMatch A\b/g, "Fit"], [/\bOdds B\b/g, "Interview odds"],
  [/\s\((?:A|B)\)(?=[\s:.,]|$)/g, ""],
];

/** Claude output in plain words: workspace paths become friendly names and internal labels go. */
export function plainPaths(text: string): string {
  let out = text.replace(PATH_RE, (m) => friendlyPath(m));
  for (const [re, to] of LABELS) out = out.replace(re, to);
  return out;
}

// ---- reading a saved score -----------------------------------------------------------------------------------------

const clean = (s: string) => plainPaths(s).trim();
const cleanItems = (xs: ScoreItem[]) => xs.map((x) => ({ text: clean(x.text), status: x.status, evidence: clean(x.evidence) }));

/** A saved score.json as a result, or null when it doesn't read as one. Text is put in plain words again. */
export function scoreResultFrom(raw: unknown): ScoreResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { scored_at, ...rest } = raw as Record<string, unknown>;
  try {
    const a = scoreRecordArgs(rest, "score");
    return {
      fit: a.fit, interview_odds: a.interview_odds, tier: a.tier, recommendation: clean(a.recommendation), summary: clean(a.summary),
      must_haves: cleanItems(a.must_haves), nice_to_haves: cleanItems(a.nice_to_haves), changes: a.changes.map(clean),
      scored_at: typeof scored_at === "string" ? scored_at : "", source: "structured",
    };
  } catch { return null; }
}

const LABEL_KEYS = ["text", "skill", "item", "name"] as const;
function recordItem(m: unknown): ScoreItem | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const label = LABEL_KEYS.map((k) => o[k]).find((x): x is string => typeof x === "string" && x.trim() !== "");
  if (!label) return null;
  const st = String(o.status ?? "").toLowerCase();
  const status: MustHaveStatus | null = (MUST_HAVE_STATUSES as readonly string[]).includes(st) ? (st as MustHaveStatus)
    : st === "partly" || st === "partially met" ? "partial"
    : o.met === true || st === "yes" ? "met"
    : o.met === false || ["missing", "gap", "no", "not met"].includes(st) ? "not_met" : null;
  if (!status) return null;
  return { text: clean(label).slice(0, SCORE_LIMITS.item), status, evidence: typeof o.evidence === "string" ? clean(o.evidence) : "" };
}

/** The job record's own scores as a result, or null when the record holds no score. */
export function scoreFromRecord(scores: {
  fit: { value: number | null; must_haves: unknown[]; nice_to_haves: unknown[] };
  career: { match: number | null; odds: number | null; tier: string; scored_at: string };
}): ScoreResult | null {
  const fit = scores.fit.value ?? scores.career.match;
  if (fit === null && scores.career.odds === null) return null;
  const tier = (SCORE_TIERS as readonly string[]).includes(scores.career.tier) ? (scores.career.tier as ScoreTier) : "";
  const pick = (xs: unknown[]) => xs.map(recordItem).filter((x): x is ScoreItem => x !== null);
  return {
    fit, interview_odds: scores.career.odds, tier, recommendation: "", summary: "",
    must_haves: pick(scores.fit.must_haves), nice_to_haves: pick(scores.fit.nice_to_haves), changes: [],
    scored_at: scores.career.scored_at, source: "record",
  };
}

const OUT_OF_100 = String.raw`[^\d]{0,40}?(\d{1,3})\s*\/\s*100\b`;
const FIT_RE = new RegExp(String.raw`\b(?:fit(?:\s*score)?|rubric\s*a|ideal\s+job\s+match|match\s*score)\b` + OUT_OF_100, "i");
const ODDS_RE = new RegExp(String.raw`\b(?:interview\s*odds|rubric\s*b)\b` + OUT_OF_100, "i");
const TIER_RE = new RegExp(String.raw`\b(${[...SCORE_TIERS].sort((a, b) => b.length - a.length).join("|")})\b`);

/**
 * Best-effort reading of an older write-up with no score.json: "Fit score … NN / 100" (and interview odds and a tier
 * when named). Null when no clear fit out of 100 is there, so nothing is guessed.
 */
export function parseLegacyScore(md: string): { fit: number; interview_odds?: number; tier?: ScoreTier } | null {
  const text = md.slice(0, 200_000);
  const f = FIT_RE.exec(text);
  const fit = f ? Number(f[1]) : NaN;
  if (!(fit >= 0 && fit <= 100)) return null;
  const out: { fit: number; interview_odds?: number; tier?: ScoreTier } = { fit };
  const o = ODDS_RE.exec(text);
  const odds = o ? Number(o[1]) : NaN;
  if (odds >= 0 && odds <= 100) out.interview_odds = odds;
  const t = TIER_RE.exec(text);
  if (t) out.tier = t[1] as ScoreTier;
  return out;
}

/** The result for a legacy write-up: only what could be read from it. */
export function legacyScoreResult(md: string, scoredAt = ""): ScoreResult | null {
  const p = parseLegacyScore(md);
  if (!p) return null;
  return {
    fit: p.fit, interview_odds: p.interview_odds ?? null, tier: p.tier ?? "", recommendation: "", summary: "",
    must_haves: [], nice_to_haves: [], changes: [], scored_at: scoredAt, source: "legacy",
  };
}

/**
 * The score to show for a job, from what is on disk: the parsed score.json, else the record's scores, else a fit
 * read from score.md. The scored time falls back to the last "Scored" timeline event. Shared by services and the
 * mock bridge.
 */
export function pickScore(i: {
  json: unknown; md: string; timeline: readonly { at: string; event: string }[];
  scores: Parameters<typeof scoreFromRecord>[0];
}): ScoreResult | null {
  const event = [...i.timeline].reverse().find((e) => /^scored\b/i.test(e.event))?.at ?? "";
  const json = i.json === null || i.json === undefined ? null : scoreResultFrom(i.json);
  if (json) return { ...json, scored_at: json.scored_at || event };
  const rec = scoreFromRecord(i.scores);
  if (rec) return { ...rec, scored_at: rec.scored_at || event };
  return legacyScoreResult(i.md, event);
}
