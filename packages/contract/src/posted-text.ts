/**
 * A board's relative posted text ("3d ago", "30+ days ago") turned into a date. Pure: the caller passes the time the
 * ad was found.
 */

const DAY = 86_400_000;

/** A date as YYYY-MM-DD in local time. */
const ymd = (t: Date) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;

export interface PostedGuess {
  /** YYYY-MM-DD. */
  date: string;
  /** True when the board only said roughly when ("2 weeks ago", "30+ days ago"); false for a stated date or "today". */
  approx: boolean;
}

const UNIT: Record<string, number> = { m: 1 / 1440, min: 1 / 1440, minute: 1 / 1440, h: 1 / 24, hr: 1 / 24, hour: 1 / 24, d: 1, day: 1, w: 7, wk: 7, week: 7, mo: 30, month: 30, y: 365, yr: 365, year: 365 };
const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/**
 * When an ad was posted, from what the board shows, relative to when it was found (`found`, an ISO time).
 * - An ISO date ("2026-10-12", "2026-10-12T09:00:00Z") is kept as it is, exact.
 * - "just posted", "today", "new", "5 hours ago", "30m ago": the found day (exact for hours, rough for "new").
 * - "yesterday", "3d ago", "2 weeks ago", "a month ago", "posted 4 days ago", "30+ days ago": that many days before,
 *   approximate. A "+" (30+ days) is a lower bound, so the date is at least that old.
 * Null when the text says nothing usable (the date then stays unknown, never the found day).
 */
export function parsePosted(text: string, found: string): PostedGuess | null {
  const s = text.trim().toLowerCase().replace(/^(posted|listed|added|active|reposted)\s*(on\s*)?:?\s*/, "").trim();
  if (!s) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})(t[\d:.]+(z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (iso && !Number.isNaN(Date.parse(iso[1]!))) return { date: iso[1]!, approx: false };
  const base = new Date(Date.parse(found));
  if (Number.isNaN(base.getTime())) return null;
  const back = (days: number, approx: boolean): PostedGuess => ({ date: ymd(new Date(base.getTime() - Math.round(days) * DAY)), approx });
  if (/^(just (now|posted)|today|new|moments? ago|now|few (seconds|minutes|hours) ago)\b/.test(s)) return back(0, false);
  if (/^yesterday\b/.test(s)) return back(1, false);
  const m = /^(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(\+)?\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo|years?|yrs?|y)(\s*\+)?\s*(ago)?\b/.exec(s);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : WORD_NUM[m[1]!]!;
  const unit = m[3]!.replace(/s$/, "");
  const per = UNIT[unit] ?? UNIT[unit.replace(/s$/, "")];
  if (per === undefined || !Number.isFinite(n)) return null;
  const days = n * per;
  if (days < 1) return back(0, false);
  return back(days, true);
}

/**
 * What to store as a job's posted date: a date (YYYY-MM-DD) when the text can be read, with `approx` when the board
 * only said roughly; otherwise the text as it was, which then counts as no date (it never becomes the found day).
 */
export function storedPosted(raw: string | undefined, found: string): { posted: string; approx: boolean } {
  const text = (raw ?? "").trim();
  if (!text) return { posted: "", approx: false };
  const g = parsePosted(text, found);
  return g ? { posted: g.date, approx: g.approx } : { posted: text, approx: false };
}

/** The ad's own posted date (YYYY-MM-DD...), or "" when it has none that reads as a date. Never the found day. */
export function postedDateOf(r: { posted: string }): string {
  return /^\d{4}-\d{2}-\d{2}/.test(r.posted) && !Number.isNaN(Date.parse(r.posted.slice(0, 10))) ? r.posted : "";
}

/** "Posted today", "Posted 3 days ago", "Posted about 2 weeks ago" (approximate), or "Posted date unknown". */
export function postedAgoText(r: { posted: string; posted_approx?: boolean }, now: Date): string {
  const p = postedDateOf(r);
  if (!p) return "Posted date unknown";
  const [y, m, d] = p.slice(0, 10).split("-").map(Number) as [number, number, number];
  const then = new Date(y, m - 1, d).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.max(0, Math.round((today - then) / DAY));
  const about = r.posted_approx ? "about " : "";
  if (days === 0) return r.posted_approx ? "Posted recently" : "Posted today";
  if (days === 1) return r.posted_approx ? "Posted about a day ago" : "Posted yesterday";
  if (days < 14) return `Posted ${about}${days} days ago`;
  if (days < 60) return `Posted ${about}${Math.round(days / 7)} weeks ago`;
  return `Posted ${about}${Math.round(days / 30)} months ago`;
}
