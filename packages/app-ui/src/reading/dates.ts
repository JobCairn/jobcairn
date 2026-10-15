// TODO(lane-B): move to format.ts. Date-only values never get an invented time.
import { fmtDateTime } from "../format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

/** "2026-01-12" (or an ISO timestamp) → a local Date at midnight for date-only values. */
export function parseDay(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!m) return null;
  if (s.trim().length > 10) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}
/** "17 Sep 2026" */
export function fmtDay(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
/** "today", "yesterday", "3 days ago", "3 weeks ago", "4 months ago", "in 2 days". */
export function relativeDay(d: Date, now: Date): string {
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((b - a) / DAY);
  const ago = (n: number, unit: string) => (days >= 0 ? `${n} ${unit}${n === 1 ? "" : "s"} ago` : `in ${n} ${unit}${n === 1 ? "" : "s"}`);
  const n = Math.abs(days);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  if (n < 14) return ago(n, "day");
  if (n < 60) return ago(Math.round(n / 7), "week");
  if (n < 365 * 2) return ago(Math.round(n / 30.4), "month");
  return ago(Math.round(n / 365), "year");
}

/**
 * True when a value carries no real time of day: "2026-10-08" (legacy timelines import like this)
 * or a zone-less local midnight such as "2026-10-08T00:00:00".
 */
export function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T00:00(?::00(?:\.0+)?)?)?$/.test(s.trim());
}

/**
 * A timeline moment: "8 Oct 2026" for a date-only value (never an invented "10:00 am"), otherwise
 * the date with its time. Empty for junk.
 */
export function fmtWhen(s: string): string {
  const d = parseDay(s);
  if (!d) return "";
  return isDateOnly(s) ? fmtDay(d) : fmtDateTime(s);
}

/** The day of a value, date-only or timestamp: "8 Oct 2026", or "" for junk. */
export function fmtDayOf(s: string): string {
  const d = parseDay(s);
  return d ? fmtDay(d) : "";
}
