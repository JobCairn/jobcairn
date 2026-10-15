import type { JobRow } from "./types.js";
import { postedDateOf } from "./posted-text.js";

/**
 * Speed matters: applications sent in the first day or two of an ad are read before the pile builds up. These helpers
 * use only the ad's own posted date. When the ad states none, the job is never called fresh (the day we found it is
 * not the day it was posted).
 */

/** How new an ad must be to show "New · apply today". */
export const FRESH_HOURS = 48;
export const FRESH_TEXT = "New · apply today";

const HOUR = 3_600_000;

/** The ad's own posted time (ms), or null when it states no readable date. */
export function postedTime(r: Pick<JobRow, "posted">): number | null {
  // The stored posted date (posted-text.ts): a board's "3 days ago" was turned into a date when the job was found.
  const p = postedDateOf(r);
  if (!p) return null;
  const t = Date.parse(p);
  return Number.isNaN(t) ? null : t;
}

/** True when the ad says it was posted within FRESH_HOURS before `now` (a date in the future is not fresh). */
export function isFreshPosting(r: Pick<JobRow, "posted">, now: Date): boolean {
  const t = postedTime(r);
  if (t === null) return false;
  const age = now.getTime() - t;
  return age >= 0 && age < FRESH_HOURS * HOUR;
}

/** "Newest posted" (the "fresh" sort): ads with a posted date, newest first, then the rest by the day they were found, newest first. */
export function freshFirst(a: Pick<JobRow, "posted" | "found_at">, b: Pick<JobRow, "posted" | "found_at">): number {
  const ta = postedTime(a);
  const tb = postedTime(b);
  if (ta !== null && tb !== null) return tb - ta;
  if (ta !== null) return -1;
  if (tb !== null) return 1;
  return b.found_at.localeCompare(a.found_at);
}
