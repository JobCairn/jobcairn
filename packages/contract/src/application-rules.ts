import type { JobStatus } from "./constants.js";
import type { JobRow } from "./types.js";

/**
 * Rules for applications after they go in (spec 2026-10-17-statuses-followups-mail-rules): quiet applications that
 * can be closed as No response, the follow-up limit, and when to offer a thank-you note. Pure: the app decides, the
 * person confirms.
 */

const DAY = 86_400_000;
type TimelineEvent = { at: string; event: string; note?: string };

// ---- Quiet applications ---------------------------------------------------------------------------------------

/** An Applied job with no activity (status change, note, email) for this many days is offered as No response. */
export const QUIET_DAYS = 60;
/** The timeline note on a job marked No response from the quiet banner. */
export const NO_RESPONSE_NOTE = `No reply for ${QUIET_DAYS} days`;

/**
 * Applied jobs with no activity for `days` days, oldest first. Only Applied counts: a draft never sent is still
 * Applying, so it is never "quiet". Activity is the job's last timeline event (synced mail adds one).
 */
export function quietApplications(rows: readonly JobRow[], now: Date, days = QUIET_DAYS): JobRow[] {
  const cut = now.getTime() - days * DAY;
  return rows
    .filter((r) => r.status === "Applied")
    .filter((r) => { const t = Date.parse(r.last_activity); return !Number.isNaN(t) && t <= cut; })
    .sort((a, b) => a.last_activity.localeCompare(b.last_activity));
}

/** "5 applications have had no reply for 60 days. Mark them No response?" */
export function quietText(n: number, days = QUIET_DAYS): string {
  return n === 1
    ? `1 application has had no reply for ${days} days. Mark it No response?`
    : `${n} applications have had no reply for ${days} days. Mark them No response?`;
}

// ---- Follow-ups -----------------------------------------------------------------------------------------------

/** At most this many follow-ups per application. */
export const MAX_FOLLOW_UPS = 2;
/** A timeline event for a follow-up made another way (a call, LinkedIn), for example from an import. */
export const FOLLOWED_UP_EVENT = "Followed up";

/** A sent email whose subject reads as a follow-up ("Following up: …", "Follow-up", "Checking in"). */
const FOLLOW_UP_SUBJECT = /\b(?:following[\s-]*up|follow[\s-]*up|checking[\s-]+in)\b/i;

/** True for one follow-up on the timeline: a sent follow-up email, or a "Followed up" event. */
export function isFollowUpEvent(e: TimelineEvent): boolean {
  if (e.event === FOLLOWED_UP_EVENT) return true;
  return e.event === "Email sent" && FOLLOW_UP_SUBJECT.test(e.note ?? "");
}

/** The follow-ups sent on an application, oldest first (their times). */
export function followUpTimes(timeline: readonly TimelineEvent[]): number[] {
  return timeline.filter(isFollowUpEvent).map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
}

/** How many follow-ups were sent on an application. */
export const followUpsSent = (timeline: readonly TimelineEvent[]): number => followUpTimes(timeline).length;

/** Why Follow up is off once the limit is reached, or "" while it's still allowed. */
export function followUpLimitText(sent: number): string {
  if (sent < MAX_FOLLOW_UPS) return "";
  return "You've followed up twice. A third follow-up rarely helps: wait for their reply, or mark it No response.";
}

// ---- Thank-you note -------------------------------------------------------------------------------------------

/** A sent email whose subject reads as a thank-you. */
const THANK_YOU_SUBJECT = /\bthank(?:s|\s+you)\b/i;

/**
 * Whether to offer a thank-you note on the job page: the job is at Interview, the interview time (when set) has
 * come, and no thank-you email has gone out since the job moved to Interview.
 */
export function thankYouDue(j: { status: JobStatus; timeline: readonly TimelineEvent[]; interview_at?: string }, now: Date): boolean {
  if (j.status !== "Interview") return false;
  if (j.interview_at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(j.interview_at)) {
    // interview_at is a local time with no zone; the Date constructor reads it as local.
    const at = new Date(j.interview_at).getTime();
    if (!Number.isNaN(at) && at > now.getTime()) return false;
  }
  const since = j.timeline.filter((e) => e.event === "Status: Interview").map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t));
  const from = since.length ? Math.max(...since) : -Infinity;
  return !j.timeline.some((e) => e.event === "Email sent" && THANK_YOU_SUBJECT.test(e.note ?? "") && Date.parse(e.at) >= from);
}
