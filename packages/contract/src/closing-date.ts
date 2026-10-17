import { parseJd } from "./jd-text.js";
import type { JobStatus } from "./constants.js";

/**
 * When applications close, from the ad's own words. Pure: the caller passes when the ad was found, so a date without
 * a year can be placed. Never a guess: an ad that states no readable closing date has none.
 */

const DAY = 86_400_000;
/** "Closes in N days" is shown up to this many days out; further out the date itself is shown. */
export const CLOSING_DAYS_SHOWN = 60;
/** Closing within this many days (or today) shows in the warm accent tone. */
export const CLOSING_SOON_DAYS = 7;
/** A date without a year that would fall more than this many days before the ad was found is read as next year's. */
const YEARLESS_BACK_DAYS = 60;
/** Open jobs, where a closing date matters: nothing has been sent yet (same as ghost.ts GHOST_OPEN). */
const OPEN: readonly JobStatus[] = ["Found", "Saved", "Applying"];

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const ORD = "(?:st|nd|rd|th)?";
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const NUMERIC = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/;
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})${ORD}(?:\\s+of)?[\\s-]+${MONTH}(?:,?[\\s-]+(\\d{4}))?\\b`, "i");
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?\\b`, "i");

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** A real calendar date as YYYY-MM-DD, or null (31 February, month 13). */
function real(y: number, m: number, d: number): string | null {
  if (!(y >= 2000 && y <= 2999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? ymd(y, m, d) : null;
}

/** The local day an ISO time falls on, or null. */
function refDay(found: string): Date | null {
  const t = Date.parse(found);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** A day and month with no year: the year it was found in, or the next one when that is long before it was found. */
function placeYear(m: number, d: number, found: string): string | null {
  const ref = refDay(found);
  if (!ref) return null;
  const y = ref.getFullYear();
  const here = real(y, m, d);
  if (!here) return real(y + 1, m, d);
  return new Date(y, m - 1, d).getTime() < ref.getTime() - YEARLESS_BACK_DAYS * DAY ? real(y + 1, m, d) : here;
}

const fullYear = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));

/**
 * The first date written in `value`, as YYYY-MM-DD: "2026-10-31", "31/10/2026" (day first, as in Australia; month
 * first only when the first number can't be a month), "31 October 2026", "31st Oct", "October 31, 2026". A date
 * without a year is placed by `found` (see placeYear). Null when no readable date is there.
 */
export function parseClosingDate(value: string, found: string): string | null {
  const s = (value ?? "").slice(0, 300);
  const hits: { at: number; date: string | null }[] = [];
  const iso = ISO_DATE.exec(s);
  if (iso) hits.push({ at: iso.index, date: real(Number(iso[1]), Number(iso[2]), Number(iso[3])) });
  const num = NUMERIC.exec(s);
  if (num && (!iso || num.index !== iso.index)) {
    const a = Number(num[1]), b = Number(num[2]), y = fullYear(num[3]!);
    hits.push({ at: num.index, date: a > 12 || b <= 12 ? real(y, b, a) : real(y, a, b) });
  }
  const dm = DAY_MONTH.exec(s);
  if (dm) {
    const m = MONTHS[dm[2]!.toLowerCase()]!, d = Number(dm[1]);
    hits.push({ at: dm.index, date: dm[3] ? real(Number(dm[3]), m, d) : placeYear(m, d, found) });
  }
  const md = MONTH_DAY.exec(s);
  if (md) {
    const m = MONTHS[md[1]!.toLowerCase()]!, d = Number(md[2]);
    hits.push({ at: md.index, date: md[3] ? real(Number(md[3]), m, d) : placeYear(m, d, found) });
  }
  const first = hits.filter((h) => h.date).sort((x, y) => x.at - y.at)[0];
  return first?.date ?? null;
}

const FACT_KEYS = new Set(["closes", "closing date", "applications close", "deadline", "apply by"]);
/** Words in an ad that introduce its closing date. */
const CLOSING_WORDS = /\b(?:applications?\s+(?:will\s+)?(?:close|closing)s?|closing\s+date(?:\s+for\s+applications)?|closes|apply\s+(?:by|before)|applications?\s+(?:are\s+)?due(?:\s+(?:by|on))?|(?:application\s+)?deadline|submit\s+(?:your\s+application\s+)?by)\b/gi;

/**
 * The ad's closing date (YYYY-MM-DD), or null when it states none. A "Closes:" line in the saved ad's header wins;
 * otherwise the first closing phrase in the text followed closely by a readable date ("Applications close 5pm Friday
 * 31 October 2026").
 */
export function closingDateFromAd(text: string, found: string): string | null {
  if (!text) return null;
  for (const f of parseJd(text).facts) {
    if (!FACT_KEYS.has(f.key)) continue;
    const d = parseClosingDate(f.value, found);
    if (d) return d;
  }
  const body = text.slice(0, 200 * 1024);
  for (const m of body.matchAll(CLOSING_WORDS)) {
    // The date must follow soon after the words ("on", a weekday, a time and a timezone fit in 60 characters).
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 60).split(/\n\s*\n/)[0]!;
    const d = parseClosingDate(after, found);
    if (d) return d;
  }
  return null;
}

/**
 * What to store as a job's closing date: Claude's or the person's own value when it reads as a date, else the date
 * the ad text states, else "" (none). `found` is when the ad was found (an ISO time).
 */
export function storedClosing(raw: string | undefined, adText: string | undefined, found: string): string {
  const given = (raw ?? "").trim();
  return (given ? parseClosingDate(given, found) : null) ?? closingDateFromAd(adText ?? "", found) ?? "";
}

export interface ClosingState {
  /** YYYY-MM-DD. */
  date: string;
  /** Local days from today to the closing day: 0 today, negative once it has passed. */
  days: number;
  closed: boolean;
  /** Closing within CLOSING_SOON_DAYS (and not yet closed). */
  soon: boolean;
  /** "Closes today", "Closes in 5 days", "Closes 12 Dec", "Closed". */
  text: string;
  /** A sentence with the full date, for a tooltip. */
  why: string;
}

const dayLabel = (y: number, m: number, d: number, withYear: boolean) =>
  new Date(y, m - 1, d).toLocaleDateString("en-AU", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" as const } : {}) });

/**
 * How long until applications close, in local days, for an open job (Found, Saved, Applying). The closing day itself
 * still reads "Closes today"; "Closed" starts the day after. Null when the job has no readable closing date, or has
 * moved past applying.
 */
export function closingState(r: { closes_on?: string; status: JobStatus }, now: Date): ClosingState | null {
  if (!OPEN.includes(r.status)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.closes_on ?? "");
  if (!m || !real(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((new Date(y, mo - 1, d).getTime() - today) / DAY);
  const full = dayLabel(y, mo, d, true);
  const date = r.closes_on!;
  if (days < 0) return { date, days, closed: true, soon: false, text: "Closed", why: `The ad said applications closed on ${full}.` };
  const text = days === 0 ? "Closes today" : days === 1 ? "Closes tomorrow" : days <= CLOSING_DAYS_SHOWN ? `Closes in ${days} days`
    : `Closes ${dayLabel(y, mo, d, y !== now.getFullYear())}`;
  return { date, days, closed: false, soon: days <= CLOSING_SOON_DAYS, text, why: `Applications close on ${full}, as the ad says.` };
}
