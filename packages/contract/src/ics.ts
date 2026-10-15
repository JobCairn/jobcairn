// "Add to Calendar": one event as an iCalendar file (RFC 5545) the computer's calendar app opens. Interview times
// are floating local times (no time zone: the event sits at that clock time wherever the calendar is), follow-ups
// are all-day dates. Pure: services write the file and open it.
import { followUpOn } from "./logic.js";
import type { JobRecord } from "./types.js";

/** An interview time as the job stores it: a local date and time, "2026-10-21T14:30". */
export const INTERVIEW_AT = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/;
/** How long an interview event lasts when nothing else is known. */
export const INTERVIEW_MINUTES = 60;
export const CALENDAR_KINDS = ["interview", "follow_up"] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

export interface IcsEvent {
  uid: string;
  /** When the file was made (DTSTAMP, written in UTC). */
  stamp: Date;
  summary: string;
  description?: string;
  location?: string;
  /** A timed event: local "YYYY-MM-DDTHH:MM" (floating) and its length. */
  start?: string; minutes?: number;
  /** An all-day event: "YYYY-MM-DD". */
  date?: string;
}

/** TEXT values: backslash, semicolon, comma and line breaks escaped (RFC 5545 3.3.11). Control characters go. */
export function icsText(s: string): string {
  return (s ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

const encoder = new TextEncoder();
/**
 * Folds a content line at 75 octets (RFC 5545 3.1): each continuation starts with CRLF and one space. Splits only
 * between characters, so a multi-byte character is never cut.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    const limit = parts.length ? 74 : 75; // a continuation's leading space counts
    if (bytes + n > limit) { parts.push(cur); cur = ""; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const pad = (n: number) => String(n).padStart(2, "0");
const utcStamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const compactDate = (date: string) => date.replace(/-/g, "");

/** A calendar date plus days, as YYYY-MM-DD (calendar arithmetic in UTC, so no DST surprises). */
export function addDays(date: string, days: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** A floating local date-time plus minutes, as "YYYYMMDDTHHMMSS". */
function floatingPlus(start: string, minutes: number): string {
  const [d, t] = start.split("T") as [string, string];
  const total = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + minutes;
  const day = addDays(d, Math.floor(total / 1440));
  const m = ((total % 1440) + 1440) % 1440;
  return `${compactDate(day)}T${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
}

/** One VEVENT in a VCALENDAR, with CRLF line ends and folded lines. Throws on a malformed start or date. */
export function buildIcs(e: IcsEvent): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//jobcairn//Calendar export//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${e.uid.replace(/[^\x21-\x7e]/g, "")}`, `DTSTAMP:${utcStamp(e.stamp)}`];
  if (e.start !== undefined) {
    if (!INTERVIEW_AT.test(e.start)) throw new Error("The interview time isn't a date and time.");
    lines.push(`DTSTART:${floatingPlus(e.start, 0)}`, `DTEND:${floatingPlus(e.start, e.minutes ?? INTERVIEW_MINUTES)}`);
  } else if (e.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(e.date)}`, `DTEND;VALUE=DATE:${compactDate(addDays(e.date, 1))}`);
  } else {
    throw new Error("A calendar event needs a date.");
  }
  lines.push(`SUMMARY:${icsText(e.summary)}`);
  if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
  lines.push("TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/**
 * When to follow up on an application, or null: the one rule the app uses (logic.ts followUpOn), so the date saved
 * when it moved to Applied wins, else FOLLOW_UP_DAYS after; none once there's a reply.
 */
export function followUpDate(job: Pick<JobRecord, "status" | "timeline"> & { custom?: Record<string, unknown> }): string | null {
  return followUpOn(job) || null;
}

/** The event for a job's interview or follow-up, or null when the job has no such date. */
export function jobCalendarEvent(job: Pick<JobRecord, "id" | "company_slug" | "title" | "status" | "timeline" | "location" | "url"> & { interview_at?: string; custom?: Record<string, unknown> },
  companyName: string, kind: CalendarKind, stamp: Date): IcsEvent | null {
  const uid = `${kind.replace("_", "-")}-${job.company_slug}-${job.id}.jobcairn`;
  const ad = job.url.startsWith("https://") ? `\nThe ad: ${job.url}` : "";
  if (kind === "interview") {
    if (!job.interview_at || !INTERVIEW_AT.test(job.interview_at)) return null;
    return { uid, stamp, summary: `Interview: ${job.title} at ${companyName}`, description: `Interview for ${job.title} at ${companyName}.${ad}`, location: job.location || undefined, start: job.interview_at, minutes: INTERVIEW_MINUTES };
  }
  const date = followUpDate(job);
  if (!date) return null;
  return { uid, stamp, summary: `Follow up: ${job.title} at ${companyName}`, description: `No reply yet to my application for ${job.title} at ${companyName}. Send a short, polite follow-up.${ad}`, date };
}
