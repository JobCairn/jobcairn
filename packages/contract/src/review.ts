/**
 * The second-pass review Claude writes after tailoring (application/review.json): the edits it made to its own
 * drafts and why, the bullets that are a stretch, and new facts the person stated in their note. Read leniently: bad
 * items are skipped, and anything that isn't an object reads as no review. See docs/specs/2026-10-17-resume-checks.md.
 */

export const REVIEW_REASONS = ["keyword", "company", "reframing", "style", "grounding"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  keyword: "Keyword", company: "Company angle", reframing: "Reframing", style: "Style", grounding: "Grounding",
};
/** The files a review may point at: the two drafts the person sends. */
export const REVIEW_FILES = ["resume.md", "cover-letter.md"] as const;
export type ReviewFileName = (typeof REVIEW_FILES)[number];
/** What happened to a stretch bullet: still open, or the person kept, softened or dropped it. */
export const STRETCH_STATES = ["open", "kept", "softened", "dropped"] as const;
export type StretchState = (typeof STRETCH_STATES)[number];
export const STRETCH_CHOICES = ["keep", "soften", "drop"] as const;
export type StretchChoice = (typeof STRETCH_CHOICES)[number];

export interface ReviewEdit { file: ReviewFileName; old: string; new: string; reason: ReviewReason; why: string }
export interface ReviewStretch { file: ReviewFileName; text: string; why: string; soften: string; state: StretchState }
export interface ReviewFact { fact: string; source: string; saved: boolean }
export interface ApplicationReview { edits: ReviewEdit[]; stretch: ReviewStretch[]; facts: ReviewFact[]; notes: string }

export const REVIEW_LIMITS = { items: 60, text: 2000, fact: 500, notes: 2000 } as const;
export const REVIEW_REL = "review.json";

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.slice(0, REVIEW_LIMITS.items).map(obj).filter((x): x is Record<string, unknown> => !!x) : []);
/** A bullet's text without its list marker ("- ", "* ", "1. "): the marker stays in the draft when the text is softened. */
const unbullet = (s: string) => s.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
const fileOf = (v: unknown): ReviewFileName => (REVIEW_FILES as readonly unknown[]).includes(v) ? v as ReviewFileName : "resume.md";

/** review.json as the app shows it, or null when it isn't a review at all. */
export function parseReview(v: unknown): ApplicationReview | null {
  const o = obj(v);
  if (!o) return null;
  const T = REVIEW_LIMITS.text;
  const edits = list(o.edits).flatMap((e): ReviewEdit[] => {
    const reason = (REVIEW_REASONS as readonly unknown[]).includes(e.reason) ? e.reason as ReviewReason : null;
    const old = str(e.old, T);
    const neu = typeof e.new === "string" ? e.new.trim().slice(0, T) : null;
    return reason && old && neu !== null ? [{ file: fileOf(e.file), old, new: neu, reason, why: str(e.why, T) }] : [];
  });
  const stretch = list(o.stretch).flatMap((s): ReviewStretch[] => {
    const text = unbullet(str(s.text, T));
    if (!text) return [];
    const state = (STRETCH_STATES as readonly unknown[]).includes(s.state) ? s.state as StretchState : "open";
    return [{ file: fileOf(s.file), text, why: str(s.why, T), soften: unbullet(str(s.soften, T)), state }];
  });
  const facts = list(o.facts).flatMap((f): ReviewFact[] => {
    const fact = str(f.fact, REVIEW_LIMITS.fact);
    return fact ? [{ fact, source: str(f.source, 200), saved: f.saved === true }] : [];
  });
  return { edits, stretch, facts, notes: str(o.notes, REVIEW_LIMITS.notes) };
}

/**
 * The draft with a stretch bullet softened (its text replaced by `soften`) or dropped (its whole line removed). Null
 * when the text isn't in the draft any more (edited since), so nothing is changed by guesswork.
 */
export function applyStretch(draft: string, item: Pick<ReviewStretch, "text" | "soften">, choice: Exclude<StretchChoice, "keep">): string | null {
  const at = draft.indexOf(item.text);
  if (at < 0) return null;
  const replacement = choice === "soften" ? item.soften : "";
  if (replacement) return draft.slice(0, at) + replacement + draft.slice(at + item.text.length);
  // Drop (or soften to nothing): the whole line goes, bullet marker and all, when the text was all of it.
  const start = draft.lastIndexOf("\n", at - 1) + 1;
  const endNl = draft.indexOf("\n", at + item.text.length);
  const end = endNl === -1 ? draft.length : endNl + 1;
  const rest = (draft.slice(start, at) + draft.slice(at + item.text.length, endNl === -1 ? draft.length : endNl)).replace(/^\s*(?:[-*+]|\d+[.)])?\s*/, "").trim();
  if (rest) return draft.slice(0, at) + draft.slice(at + item.text.length);
  return draft.slice(0, start) + draft.slice(end);
}

/** A claim as a plain fact for me/history: no list marker, no bold or italic marks, one line. */
export function plainFact(text: string): string {
  return unbullet(text.trim())
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)(.+?)\*(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ").trim();
}

