/**
 * "Repeat this search": when a saved Find jobs search runs again on its own, while the app is open. Pure: the
 * scheduler in main passes the clock. Times are the computer's local time.
 */

export type ScheduleMode = "off" | "hours" | "daily";
export const SCHEDULE_MODES: readonly ScheduleMode[] = ["off", "hours", "daily"];
export const SCHEDULE_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
export const WEEKDAY_WORDS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface SearchSchedule {
  mode: ScheduleMode;
  /** "hours": run every this many hours. */
  every_hours: number;
  /** "hours": stop after this many runs; null means until stopped. */
  times: number | null;
  /** "daily": the time of day, "HH:MM" (24 hours). */
  at: string;
  /** "daily": the days it runs, 0 Sunday to 6 Saturday. */
  days: number[];
  /** When the schedule was turned on or last changed (ISO), the start of the first wait. */
  since: string;
  /** When it last started a search (ISO), or "". */
  last_run_at: string;
  /** How many searches it has started since it was turned on (a skipped one doesn't count). */
  runs: number;
  /** When a scheduled search last actually ran (ISO), or "": the next one asks for ads posted since then. */
  searched_at: string;
  /** What happened to the last few scheduled searches, newest first (at most SCHEDULE_HISTORY). */
  history: ScheduleEvent[];
}

/** One line of a schedule's history: when, and what happened ("3 new jobs found", "Skipped: Chrome wasn't allowed"). */
export interface ScheduleEvent { at: string; text: string }
export const SCHEDULE_HISTORY = 10;
/** A scheduled search that needs Chrome and wasn't allowed to connect in time: skipped, never searched on the web. */
export const SKIPPED_NOT_ALLOWED = "Skipped: Chrome wasn't allowed";

export const DEFAULT_SCHEDULE: SearchSchedule = { mode: "off", every_hours: 24, times: null, at: "08:00", days: [1, 2, 3, 4, 5], since: "", last_run_at: "", runs: 0, searched_at: "", history: [] };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isoOr = (v: unknown): string => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : "");

/** A schedule read from the search settings (any shape): bad parts fall back to the defaults, "off" when unsure. */
export function cleanSchedule(v: unknown): SearchSchedule {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...DEFAULT_SCHEDULE, days: [...DEFAULT_SCHEDULE.days], history: [] };
  const s = v as Record<string, unknown>;
  const mode = (SCHEDULE_MODES as readonly unknown[]).includes(s.mode) ? (s.mode as ScheduleMode) : "off";
  const every = typeof s.every_hours === "number" && Number.isInteger(s.every_hours) && s.every_hours >= 1 && s.every_hours <= 168 ? s.every_hours : DEFAULT_SCHEDULE.every_hours;
  const times = typeof s.times === "number" && Number.isInteger(s.times) && s.times >= 1 && s.times <= 100 ? s.times : null;
  const at = typeof s.at === "string" && TIME.test(s.at) ? s.at : DEFAULT_SCHEDULE.at;
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => Array.isArray(s.days) && s.days.includes(d));
  const runs = typeof s.runs === "number" && Number.isInteger(s.runs) && s.runs >= 0 ? Math.min(s.runs, 100_000) : 0;
  const history = (Array.isArray(s.history) ? s.history : [])
    .filter((e): e is ScheduleEvent => !!e && typeof e === "object" && isoOr((e as ScheduleEvent).at) !== "" && typeof (e as ScheduleEvent).text === "string")
    .slice(0, SCHEDULE_HISTORY).map((e) => ({ at: e.at, text: e.text.slice(0, 200) }));
  const last = isoOr(s.last_run_at);
  // Saved before searched_at existed: every start was a search.
  const searched = "searched_at" in s ? isoOr(s.searched_at) : last;
  return { mode, every_hours: every, times, at, days: Array.isArray(s.days) ? days : [...DEFAULT_SCHEDULE.days], since: isoOr(s.since), last_run_at: last, runs, searched_at: searched, history };
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The first daily slot strictly after `after`, or null when no day is chosen. */
function nextDaily(s: SearchSchedule, after: Date): Date | null {
  if (!s.days.length) return null;
  const [h, m] = s.at.split(":").map(Number) as [number, number];
  for (let i = 0; i <= 7; i++) {
    const d = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, h, m, 0, 0);
    if (d.getTime() > after.getTime() && s.days.includes(d.getDay())) return d;
  }
  return null;
}

/**
 * When the schedule next runs, or null when it's off or finished. Counted from the last run (else from when it was
 * turned on, else now). A time already past means "due now": after sleep or a closed app, it catches up once, and
 * the next one is counted from that run, so missed runs never pile up.
 */
export function nextRun(s: SearchSchedule, now: Date): Date | null {
  if (s.mode === "off") return null;
  const from = new Date(Date.parse(s.last_run_at || s.since) || now.getTime());
  if (s.mode === "hours") {
    if (s.times !== null && s.runs >= s.times) return null;
    return new Date(from.getTime() + s.every_hours * HOUR);
  }
  return nextDaily(s, from);
}

/** True when the schedule should start a search now. */
export function isDue(s: SearchSchedule, now: Date): boolean {
  const n = nextRun(s, now);
  return n !== null && n.getTime() <= now.getTime();
}

/** "Posted within" for a scheduled search: the whole days since the last run, at least 1, at most 30. */
export function postedDaysSince(lastRunAt: string, now: Date, fallback = 7): number {
  const t = Date.parse(lastRunAt);
  if (Number.isNaN(t)) return fallback;
  return Math.max(1, Math.min(30, Math.ceil((now.getTime() - t) / DAY)));
}

/** The schedule after it started a search at `now`. */
export function afterRun(s: SearchSchedule, now: Date): SearchSchedule {
  return { ...s, last_run_at: now.toISOString(), searched_at: now.toISOString(), runs: s.runs + 1 };
}

/**
 * The schedule after the search it just started (`afterRun(before, now)`) was skipped: the slot is used, so it tries
 * again at the next one, but the skip doesn't count as one of its N times and the next search still asks for ads
 * since the last real one.
 */
export function afterSkip(before: SearchSchedule, now: Date, text: string): SearchSchedule {
  return withEvent({ ...before, last_run_at: now.toISOString() }, now, text);
}

/** Adds a line to the history (newest first, at most SCHEDULE_HISTORY). */
export function withEvent(s: SearchSchedule, at: Date, text: string): SearchSchedule {
  return { ...s, history: [{ at: at.toISOString(), text: text.slice(0, 200) }, ...s.history].slice(0, SCHEDULE_HISTORY) };
}

/** What Find jobs shows: the schedule, when it next runs (ISO, "" when off or finished), and "Open at login" (null: not offered). */
export interface ScheduleView { schedule: SearchSchedule; next_run_at: string; open_at_login: boolean | null }

/** Plain words: "Every 6 hours, 3 times", "Daily at 08:00 on Mon, Tue", "Off". */
export function scheduleWords(s: SearchSchedule): string {
  if (s.mode === "off") return "Off";
  if (s.mode === "hours") return `Every ${s.every_hours === 1 ? "hour" : `${s.every_hours} hours`}${s.times !== null ? `, ${s.times} ${s.times === 1 ? "time" : "times"}` : " until stopped"}`;
  const all = s.days.length === 7;
  const weekdays = s.days.length === 5 && [1, 2, 3, 4, 5].every((d) => s.days.includes(d));
  return `At ${s.at} ${all ? "every day" : weekdays ? "on weekdays" : `on ${s.days.map((d) => WEEKDAY_WORDS[d]).join(", ")}`}`;
}
