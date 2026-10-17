/**
 * How old a company's research is. research.md says when it was researched ("Researched: 2026-09-01", or
 * `researched_on:` front matter); without that line, the file's modified time stands in. Research older than
 * RESEARCH_STALE_DAYS is stale: the Company page offers a refresh, and score and tailor runs don't reuse it as current.
 * Spec: docs/specs/2026-10-17-languages-and-research-refresh.md.
 */

export const RESEARCH_STALE_DAYS = 30;
/** The file Research company writes in the company folder. */
export const RESEARCH_FILE = "research.md";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** The local calendar day of a time (YYYY-MM-DD), as actions.ts localDate. */
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DATED = /^\s*(?:[-*>]\s*)?(?:\*\*|_)?(?:researched(?:[ _]on)?|research date|fetched[ _]on)(?:\*\*|_)?\s*[:=]\s*(?:\*\*|_)?\s*["']?(\d{4}-\d{2}-\d{2})\b/im;

/**
 * The date research.md says it was researched (YYYY-MM-DD), from its first 40 lines, or "" when it doesn't say or the
 * date isn't a real one.
 */
export function researchedOn(md: string): string {
  const head = md.split("\n", 40).join("\n");
  const d = DATED.exec(head)?.[1] ?? "";
  if (!d) return "";
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d ? "" : d;
}

export interface ResearchAge {
  /** When it was researched: a local date (YYYY-MM-DD) from the file, else the file's modified time (ISO). */
  at: string;
  /** Whole days since then, counted in local dates (0 for today; never negative). */
  days: number;
  stale: boolean;
}

/**
 * The research's age on `now`, from the date research.md states, else its modified time. Null when neither reads as a
 * date. A date in the future counts as today.
 */
export function researchAge(md: string, modifiedAt: string, now: Date): ResearchAge | null {
  const stated = researchedOn(md);
  const at = stated || modifiedAt;
  const day = stated || (Number.isNaN(Date.parse(modifiedAt)) ? "" : localDate(new Date(modifiedAt)));
  if (!day) return null;
  const days = Math.max(0, Math.round((Date.parse(`${localDate(now)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY));
  return { at, days, stale: days > RESEARCH_STALE_DAYS };
}

/** "Researched today", "Researched yesterday", "Researched 41 days ago". */
export function researchAgeText(days: number): string {
  return days <= 0 ? "Researched today" : days === 1 ? "Researched yesterday" : `Researched ${days} days ago`;
}

/**
 * The line a score, tailor or interview prep prompt gets about the company research: fresh research is background
 * whose facts keep their URL; stale research isn't reused as current; no research, no line.
 */
export function researchRule(age: ResearchAge | null, file: string): string {
  if (!age) return "";
  if (!age.stale) return `${file} is ${age.days === 0 ? "from today" : `${age.days} day${age.days === 1 ? "" : "s"} old`}. You may use it as background; a fact from it that goes into my documents keeps its source URL.`;
  return `${file} is ${age.days} days old, older than ${RESEARCH_STALE_DAYS} days, so it is stale. Don't reuse its facts as current: leave them out of the score and my documents, and say at the end that I should refresh the company research first.`;
}
