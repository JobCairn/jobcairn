// Home dashboard analytics. Pure functions over real workspace data (job rows, timeline events,
// the search log and two settings). The services gather the inputs; the mock bridge reuses the
// same functions, so the dev preview and the app compute numbers the same way.
import type { JobSource, JobStatus, WorkRightsLabel, WorkRightsStatus } from "./constants.js";
import { prioritiseSponsorship, showSponsorship, sponsorshipFocus, type SponsorshipFocus } from "./candidate.js";
import { isFinalStatus, WR_LABELS } from "./constants.js";
import { isReply } from "./logic.js";
import { localDate } from "./actions.js";
import type { JobRow } from "./types.js";

const DAY = 86_400_000;

/**
 * Australian 482 visa income thresholds (AUD a year), used only to sort stated salaries into bands.
 * VERIFY EVERY YEAR: Home Affairs indexes them each 1 July. Values below are for 1 Jul 2026 onwards,
 * taken from a secondary source; check the Home Affairs "skills in demand visa" page before relying on them.
 */
export const SALARY_THRESHOLDS = { core: 79_499, specialist: 146_717, from: "2026-07-01" } as const;

/**
 * Superannuation guarantee rate from 1 Jul 2025. A package that "includes super" is compared on its
 * base pay: package / (1 + SUPER_RATE).
 */
export const SUPER_RATE = 0.12;
/** A yearly salary outside this range is not a believable yearly figure (a typo, an hourly rate, a total contract value). */
export const YEARLY_PLAUSIBLE = { min: 20_000, max: 1_000_000 } as const;

/** Days after applying with no reply before a follow-up is due, and after which a follow-up is no longer worth it. */
export const FOLLOW_UP_DAYS = 7;
export const FOLLOW_UP_UNTIL_DAYS = 30;
/** A role posted (or found) more than this many days ago and not applied to is going stale. */
export const STALE_DAYS = 21;
/** Weeks of found/applied bars on Home. */
export const ACTIVITY_WEEKS = 12;
/** Trends only appear once the workspace has this much history. */
export const TREND_MIN_DAYS = 14;

export const FUNNEL_STAGES = ["found", "shortlisted", "applying", "applied", "interview", "offer"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export const FUNNEL_LABEL: Record<FunnelStage, string> = {
  found: "Found", shortlisted: "Shortlisted", applying: "Applying", applied: "Applied", interview: "Interview", offer: "Offer",
};
const STATUS_STAGE: Partial<Record<JobStatus, number>> = { Found: 0, Saved: 1, Applying: 2, Applied: 3, Interview: 4, Offer: 5 };

export interface JobEvent { company_slug: string; job_id: string; at: string; event: string }
export interface SearchLogEntry { at: string; site: string; results: string; kept: string }
export interface HomeGoals { search_deadline: string; weekly_goal: number | null }

export interface FunnelStageView {
  stage: FunnelStage; label: string;
  /** Jobs that reached this stage at some point. */
  reached: number;
  /** Jobs sitting in this stage now. */
  now: number;
  /** reached / previous stage's reached, 0-1, or null for the first stage or an empty previous stage. */
  conversion: number | null;
  /** Median days a job stayed in this stage before moving on (finished stays only). */
  medianDays: number | null;
  /** Jobs that entered this stage in the last 7 days, and the 7 days before. */
  thisWeek: number; lastWeek: number;
}
export interface FunnelView {
  stages: FunnelStageView[];
  historyDays: number; showTrends: boolean;
  /** Applications out (Applied, no reply yet) and when the latest went. */
  awaitingReply: number; lastAppliedAt: string | null; lastAppliedDays: number | null;
}
/** `source`/`source_site` are optional only so existing literal test data (built before
 * SourceBadge existed) keeps compiling; `ref()` always fills them in from the real JobRow. */
export interface JobRef { company_slug: string; id: string; title: string; company_name: string; source?: JobSource; source_site?: string }
export interface MapPoint extends JobRef { fit: number; sponsor: number; wr_label: WorkRightsLabel; status: JobStatus; applied: boolean }
export type NextAction = "score" | "prepare" | "follow_up" | "practise";
export interface RankedJob extends JobRef {
  status: JobStatus; wr_label: WorkRightsLabel; fit: number | null; sponsor: number | null;
  /** Short salary text ("$140k–$160k", "$150k+"), or "" when the ad doesn't say. */
  salary: string;
  /** Days since posted (or since found when the posted date is unknown). */
  ageDays: number | null; ageFrom: "posted" | "found";
  action: NextAction;
  /** Days since applying, for follow-ups. */
  waitingDays: number | null;
}
export interface StaleJob extends JobRef { status: JobStatus; ageDays: number; ageFrom: "posted" | "found" }
export interface WeekBar { week: string; found: number; applied: number }
export interface SourceRow { site: string; seen: number | null; searches: number; kept: number; applied: number }
export interface SalaryJob extends JobRef {
  /** Why this role sits where it does when it isn't obvious ("Package includes super…", "Only an upper limit…"). */
  note?: string;
}
export interface SalaryBand { count: number; jobs: SalaryJob[] }
export interface SalaryCheck {
  thresholds: { core: number; specialist: number; from: string };
  shortlisted: number;
  specialist: SalaryBand; core: SalaryBand; below: SalaryBand; notStated: SalaryBand;
}
export interface TodayView {
  readySponsored: number; followUpsDue: number; interviews: number;
  searchDeadline: string | null; deadlineDays: number | null;
}
export interface HomeAnalytics {
  today: TodayView; funnel: FunnelView;
  map: { points: MapPoint[]; unscored: JobRef[] };
  nextUp: RankedJob[]; nextUpTotal: number;
  weekly: WeekBar[]; weeklyGoal: number | null;
  mix: { label: WorkRightsLabel; count: number }[];
  stale: StaleJob[]; sources: SourceRow[]; salary: SalaryCheck;
  /** How much sponsorship matters to this candidate (candidate.ts). Home shows sponsorship cards only when it isn't "off". */
  sponsorship: SponsorshipFocus;
}

// ---- small helpers -----------------------------------------------------------------------

const ref = (r: JobRow): JobRef => ({ company_slug: r.company_slug, id: r.id, title: r.title, company_name: r.company_name, source: r.source, source_site: r.source_site });
const key = (slug: string, id: string) => `${slug}/${id}`;
const time = (iso: string): number | null => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };
const days = (from: number, to: number) => Math.floor((to - from) / DAY);

/** A local calendar day as a whole number (days since 1970-01-01), so day differences ignore time of day, UTC offsets and DST. */
function localDay(t: number): number {
  const d = new Date(t);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}
/** The day number of a YYYY-MM-DD calendar date, or null when it isn't a real date. */
function dateDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t / DAY : null;
}
const dayIso = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** True for a real calendar date in YYYY-MM-DD form ("2026-02-30" and "2026-13-45" are not). */
export function isCalendarDate(date: string): boolean {
  return dateDay(date) !== null;
}

/** The calendar date at the start of a posted value such as "2026-01-10" or "~2025-12-22 (3 weeks ago)". */
export function postedDate(posted: string): string | null {
  const m = /^\s*~?\s*(\d{4}-\d{2}-\d{2})/.exec(posted ?? "");
  return m && time(`${m[1]}T00:00:00.000Z`) !== null ? m[1]! : null;
}

/** Whole calendar days from today (local date) until a YYYY-MM-DD date: 0 on the day, negative once passed, null when not a real date. */
export function daysUntil(date: string, now: Date): number | null {
  const d = dateDay(date);
  return d === null ? null : d - localDay(now.getTime());
}

/** Age of a job in days: from its posted date when known, else from when it was found. */
export function jobAge(r: Pick<JobRow, "posted" | "found_at">, now: Date): { days: number | null; from: "posted" | "found" } {
  const p = postedDate(r.posted);
  if (p) return { days: Math.max(0, days(Date.parse(`${p}T00:00:00.000Z`), now.getTime())), from: "posted" };
  const f = time(r.found_at);
  return { days: f === null ? null : Math.max(0, days(f, now.getTime())), from: "found" };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---- salary ------------------------------------------------------------------------------

export interface ParsedSalary { min: number | null; max: number | null; period: "year" | "day" | "hour"; includesSuper: boolean }

const plausibleYear = (n: number | null) => n === null || (n >= YEARLY_PLAUSIBLE.min && n <= YEARLY_PLAUSIBLE.max);
/** Drops yearly figures nobody would be paid ("$800", "$95 - $110", "$1.2m"): they read as "not stated". */
function sane(s: ParsedSalary): ParsedSalary | null {
  if (s.min === null && s.max === null) return null;
  return s.period === "year" && !(plausibleYear(s.min) && plausibleYear(s.max)) ? null : s;
}

/**
 * Reads a salary out of ad text: "$140k-$160k + super", "$120,000 – $135,000", "140-160k", "150k+",
 * "up to $180k", "$80 - $95 per hour", "$40/h". Numbers count only with a "$", a "k"/"m" or when they
 * are at least 20,000, so "+ 12% super" or a year in the text is never read as pay. A range shares
 * its unit ("140-160k" is 140k to 160k). Returns null when nothing believable is stated.
 */
export function parseSalary(text: string): ParsedSalary | null {
  const t = (text ?? "").toLowerCase().replace(/(\d),(\d{3})/g, "$1$2").replace(/[–—]/g, "-");
  if (!t.trim()) return null;
  const period: ParsedSalary["period"] = /(per hour|\/\s*h(ou)?r?\b|\bp\.?h\.?\b|hourly|an hour)/.test(t) ? "hour"
    : /(per day|\/\s*day\b|\bp\.?d\.?\b|daily|day rate|a day)/.test(t) ? "day" : "year";
  const tokens = [...t.matchAll(/(\$)?\s*(\d+(?:\.\d+)?)([km](?![a-z]))?/g)].map((m) => ({
    dollar: !!m[1], value: Number(m[2]), unit: (m[3] ?? "") as "" | "k" | "m", start: m.index ?? 0, end: (m.index ?? 0) + m[0].length,
  }));
  // "140-160k", "$140 to 160k": the low end shares the high end's unit.
  tokens.forEach((tok, i) => {
    const next = tokens[i + 1];
    if (tok.unit || !next?.unit || tok.value >= 1_000) return;
    if (/^\s*(-|to)\s*$/.test(t.slice(tok.end, next.start))) tok.unit = next.unit;
  });
  const nums: number[] = [];
  for (const tok of tokens) {
    const n = tok.value * (tok.unit === "k" ? 1_000 : tok.unit === "m" ? 1_000_000 : 1);
    const counts = tok.dollar || !!tok.unit || n >= 20_000;
    if (!counts || !Number.isFinite(n) || n <= 0) continue;
    // A trailing "%" means a rate, not pay.
    if (t.slice(tok.end).trimStart().startsWith("%")) continue;
    nums.push(n);
  }
  if (!nums.length) return null;
  const includesSuper = /(incl(\.|uding|usive of)?\s+(of\s+)?super|package|\bote\b|total remuneration|\btrp\b)/.test(t);
  const upTo = /\bup to\b/.test(t);
  if (upTo && nums.length === 1) return sane({ min: null, max: nums[0]!, period, includesSuper });
  const min = Math.min(...nums.slice(0, 2));
  const max = nums.length > 1 ? Math.max(...nums.slice(0, 2)) : null;
  return sane({ min, max, period, includesSuper });
}

/** A job row's salary: the stored numbers when present, else what the ad text says. */
export function rowSalary(r: Pick<JobRow, "salary_min" | "salary_max" | "salary_text">): ParsedSalary | null {
  if (r.salary_min !== null || r.salary_max !== null) {
    const parsed = parseSalary(r.salary_text);
    return sane({ min: r.salary_min, max: r.salary_max, period: parsed?.period ?? "year", includesSuper: parsed?.includesSuper ?? false });
  }
  return parseSalary(r.salary_text);
}

const k = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m` : n >= 1_000 ? `$${Math.round(n / 1_000)}k` : `$${n}`);
/** "$140k–$160k", "$150k+", "up to $180k", "$90/hr", or "" when nothing is stated. */
export function salaryShort(s: ParsedSalary | null): string {
  if (!s) return "";
  const unit = s.period === "hour" ? "/hr" : s.period === "day" ? "/day" : "";
  if (s.min !== null && s.max !== null && s.max !== s.min) return `${k(s.min)}–${k(s.max)}${unit}`;
  if (s.min !== null) return `${k(s.min)}${unit ? unit : "+"}`;
  if (s.max !== null) return `up to ${k(s.max)}${unit}`;
  return "";
}

// ---- stages ------------------------------------------------------------------------------

/** Stage entries for one job, oldest first: "Found" and status changes, with the funnel stage index (or -1 for an exit). */
function stageEvents(r: JobRow, evs: JobEvent[]): { at: number; stage: number }[] {
  const out: { at: number; stage: number }[] = [];
  let found = false;
  for (const e of evs) {
    const at = time(e.at);
    if (at === null) continue;
    if (e.event === "Found") { out.push({ at, stage: 0 }); found = true; continue; }
    const m = /^Status: (\S.*)$/.exec(e.event);
    if (!m) continue;
    const s = STATUS_STAGE[m[1] as JobStatus];
    out.push({ at, stage: s ?? -1 });
  }
  const fa = time(r.found_at);
  if (!found && fa !== null) out.push({ at: fa, stage: 0 });
  // A repeated entry into the stage a job is already in ("Saved" twice) is not a new stay.
  return out.sort((a, b) => a.at - b.at).filter((e, i, all) => i === 0 || e.stage !== all[i - 1]!.stage);
}

/** The furthest funnel stage a job reached (0 Found … 5 Offer). A rejection, no reply or withdrawal means it was at least applied. */
export function reachedStage(status: JobStatus, entries: { stage: number }[]): number {
  const fromEvents = entries.reduce((m, e) => Math.max(m, e.stage), 0);
  const fromStatus = STATUS_STAGE[status] ?? (status === "Rejected" || status === "No response" || status === "Withdrawn" ? 3 : 0);
  return Math.max(fromEvents, fromStatus);
}

const OPEN: JobStatus[] = ["Found", "Saved", "Applying"];

export function homeAnalytics(input: {
  rows: JobRow[]; events: JobEvent[]; searches: SearchLogEntry[]; goals: Partial<HomeGoals>; now: Date;
  /** The candidate's work-rights status. Missing means unknown, so sponsorship plays no part. */
  status?: WorkRightsStatus;
}): HomeAnalytics {
  const { rows, now } = input;
  const status = input.status ?? "unknown";
  // Sponsorship ranks and counts only for people who need it; scores need a sponsor value only when it is shown.
  const primary = prioritiseSponsorship(status);
  const needsSponsor = showSponsorship(status);
  const nowT = now.getTime();
  const byJob = new Map<string, JobEvent[]>();
  for (const e of input.events) {
    const k2 = key(e.company_slug, e.job_id);
    (byJob.get(k2) ?? byJob.set(k2, []).get(k2)!).push(e);
  }
  const jobEvents = (r: JobRow) => byJob.get(key(r.company_slug, r.id)) ?? [];

  // Funnel.
  const reached = FUNNEL_STAGES.map(() => 0);
  const current = FUNNEL_STAGES.map(() => 0);
  const stays: number[][] = FUNNEL_STAGES.map(() => []);
  const thisWeek = FUNNEL_STAGES.map(() => 0);
  const lastWeek = FUNNEL_STAGES.map(() => 0);
  let earliest = Infinity;
  const reachedOf = new Map<string, number>();
  for (const r of rows) {
    const entries = stageEvents(r, jobEvents(r));
    const top = reachedStage(r.status, entries);
    reachedOf.set(key(r.company_slug, r.id), top);
    for (let s = 0; s <= top; s++) reached[s]!++;
    const cur = STATUS_STAGE[r.status];
    if (cur !== undefined) current[cur]!++;
    entries.forEach((e, i) => {
      earliest = Math.min(earliest, e.at);
      if (e.stage < 0) return;
      const age = nowT - e.at;
      if (age >= 0 && age < 7 * DAY) thisWeek[e.stage]!++;
      else if (age >= 7 * DAY && age < 14 * DAY) lastWeek[e.stage]!++;
      const next = entries[i + 1];
      if (next) stays[e.stage]!.push((next.at - e.at) / DAY);
    });
  }
  const historyDays = Number.isFinite(earliest) ? Math.max(0, days(earliest, nowT)) : 0;
  const stages: FunnelStageView[] = FUNNEL_STAGES.map((stage, i) => {
    const md = median(stays[i]!);
    return {
      stage, label: FUNNEL_LABEL[stage], reached: reached[i]!, now: current[i]!,
      conversion: i === 0 || !reached[i - 1] ? null : reached[i]! / reached[i - 1]!,
      medianDays: md === null ? null : Math.round(md * 10) / 10, thisWeek: thisWeek[i]!, lastWeek: lastWeek[i]!,
    };
  });

  // Applications waiting for a reply.
  const appliedAt = (r: JobRow): number | null => {
    const ts = jobEvents(r).filter((e) => e.event === "Status: Applied").map((e) => time(e.at)).filter((t): t is number => t !== null);
    return ts.length ? Math.max(...ts) : null;
  };
  const replied = (r: JobRow, since: number) => jobEvents(r).some((e) => isReply(e.event) && (time(e.at) ?? 0) > since);
  const waiting = rows.filter((r) => r.status === "Applied").map((r) => {
    const at = appliedAt(r) ?? time(r.last_activity) ?? time(r.found_at);
    return { r, at, replied: at !== null && replied(r, at) };
  }).filter((w) => !w.replied);
  const lastApplied = waiting.reduce<number | null>((m, w) => (w.at !== null && (m === null || w.at > m) ? w.at : m), null);
  const waitDays = (r: JobRow) => { const w = waiting.find((x) => x.r === r); return w?.at != null ? days(w.at, nowT) : null; };
  // The saved follow-up day (set when the status moved to Applied) wins over the default wait.
  const followUpDue = (r: JobRow) => {
    const d = waitDays(r);
    if (d === null || d > FOLLOW_UP_UNTIL_DAYS) return false;
    return r.follow_up_on ? localDate(new Date(nowT)) >= r.follow_up_on : d >= FOLLOW_UP_DAYS;
  };

  const eligible = rows.filter((r) => r.eligible);

  // Next up: interviews, then (for people who need sponsorship) ads that say they sponsor, then follow-ups,
  // then the rest by fit (and sponsor score, when sponsorship matters most).
  // "Visa OK" wording gets no tier of its own: fit decides among the rest.
  const candidates = eligible.filter((r) => OPEN.includes(r.status) || r.status === "Interview" || (r.status === "Applied" && followUpDue(r)));
  const tier = (r: JobRow) => (r.status === "Interview" ? 0 : primary && r.wr_label === "sponsorship_offered" && OPEN.includes(r.status) ? 1 : r.status === "Applied" ? 2 : 3);
  const desc = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);
  const ranked = [...candidates].sort((a, b) => tier(a) - tier(b) || desc(a.fit, b.fit) || (primary ? desc(a.sponsor, b.sponsor) : 0)
    || b.found_at.localeCompare(a.found_at) || a.company_slug.localeCompare(b.company_slug) || a.id.localeCompare(b.id));
  const nextUp: RankedJob[] = ranked.slice(0, 8).map((r) => {
    const age = jobAge(r, now);
    const action: NextAction = r.status === "Interview" ? "practise" : r.status === "Applied" ? "follow_up" : r.fit === null ? "score" : "prepare";
    return {
      ...ref(r), status: r.status, wr_label: r.wr_label, fit: r.fit, sponsor: r.sponsor, salary: salaryShort(rowSalary(r)),
      ageDays: age.days, ageFrom: age.from, action, waitingDays: r.status === "Applied" ? waitDays(r) : null,
    };
  });

  // Opportunity map: open and active roles you can apply for.
  const active = eligible.filter((r) => !isFinalStatus(r.status));
  const points: MapPoint[] = active.filter((r) => r.fit !== null && r.sponsor !== null).map((r) => ({
    ...ref(r), fit: r.fit!, sponsor: r.sponsor!, wr_label: r.wr_label, status: r.status, applied: (reachedOf.get(key(r.company_slug, r.id)) ?? 0) >= 3,
  }));
  const unscored = active.filter((r) => OPEN.includes(r.status) && (r.fit === null || (needsSponsor && r.sponsor === null)))
    .sort((a, b) => (primary ? Number(b.wr_label === "sponsorship_offered") - Number(a.wr_label === "sponsorship_offered") || desc(a.sponsor, b.sponsor) : 0) || b.found_at.localeCompare(a.found_at))
    .map(ref);

  // Weekly activity, in local calendar weeks starting Monday.
  const today = localDay(nowT);
  const firstMonday = today - ((now.getDay() + 6) % 7) - (ACTIVITY_WEEKS - 1) * 7;
  const weekly: WeekBar[] = Array.from({ length: ACTIVITY_WEEKS }, (_, i) => ({ week: dayIso(firstMonday + i * 7), found: 0, applied: 0 }));
  for (const r of rows) {
    for (const e of stageEvents(r, jobEvents(r))) {
      if (e.stage !== 0 && e.stage !== 3) continue;
      const d = localDay(e.at);
      if (d < firstMonday || e.at > nowT) continue;
      const w = weekly[Math.floor((d - firstMonday) / 7)];
      if (!w) continue;
      if (e.stage === 0) w.found++; else w.applied++;
    }
  }

  // Sponsorship mix (every job, so the counts match the Jobs list with "show ineligible").
  const mix = WR_LABELS.map((label) => ({ label, count: rows.filter((r) => r.wr_label === label).length })).filter((m) => m.count > 0);

  // Going stale.
  const stale: StaleJob[] = eligible.filter((r) => OPEN.includes(r.status)).flatMap((r) => {
    const age = jobAge(r, now);
    return age.days !== null && age.days > STALE_DAYS ? [{ ...ref(r), status: r.status, ageDays: age.days, ageFrom: age.from }] : [];
  }).sort((a, b) => b.ageDays - a.ageDays);

  // Sources: what searches saw, what was kept in the workspace, and what was applied for.
  const sites = new Map<string, SourceRow>();
  const site = (name: string) => {
    const label = name.trim() || "Unknown";
    const id = label.toLowerCase();
    return sites.get(id) ?? sites.set(id, { site: label, seen: null, searches: 0, kept: 0, applied: 0 }).get(id)!;
  };
  for (const s of input.searches) {
    const row = site(s.site);
    row.searches++;
    const n = seenCount(s.results);
    if (n !== null) row.seen = (row.seen ?? 0) + n;
  }
  for (const r of rows) {
    const row = site(r.source_site);
    row.kept++;
    if ((reachedOf.get(key(r.company_slug, r.id)) ?? 0) >= 3) row.applied++;
  }
  const sources = [...sites.values()].sort((a, b) => b.kept - a.kept || (b.seen ?? 0) - (a.seen ?? 0) || a.site.localeCompare(b.site));

  // 482 salary bands over shortlisted roles (kept and still open, or already applied).
  const shortlisted = eligible.filter((r) => (reachedOf.get(key(r.company_slug, r.id)) ?? 0) >= 1 && !isFinalStatus(r.status));
  const band = (): SalaryBand => ({ count: 0, jobs: [] });
  const salary: SalaryCheck = { thresholds: { ...SALARY_THRESHOLDS }, shortlisted: shortlisted.length, specialist: band(), core: band(), below: band(), notStated: band() };
  for (const r of shortlisted) {
    const s = rowSalary(r);
    // Only a stated lower end counts: "up to $200k" says nothing about the minimum, so it is never banded.
    const stated = s && s.period === "year" ? s.min : null;
    const yearly = stated !== null && s!.includesSuper ? stated / (1 + SUPER_RATE) : stated;
    const b = yearly === null ? salary.notStated : yearly >= SALARY_THRESHOLDS.specialist ? salary.specialist : yearly >= SALARY_THRESHOLDS.core ? salary.core : salary.below;
    const note = yearly !== null && s!.includesSuper ? `Package includes super, so compared on base pay of about ${k(yearly)}`
      : s && s.period === "year" && s.min === null && s.max !== null ? `Only an upper limit is stated (up to ${k(s.max)})` : undefined;
    b.count++;
    b.jobs.push(note ? { ...ref(r), note } : ref(r));
  }

  const deadline = isCalendarDate(input.goals.search_deadline ?? "") ? input.goals.search_deadline! : null;
  const goal = input.goals.weekly_goal;
  return {
    today: {
      readySponsored: !primary ? 0 : eligible.filter((r) => r.wr_label === "sponsorship_offered" && OPEN.includes(r.status)).length,
      followUpsDue: eligible.filter((r) => r.status === "Applied" && followUpDue(r)).length,
      interviews: eligible.filter((r) => r.status === "Interview").length,
      searchDeadline: deadline, deadlineDays: deadline ? daysUntil(deadline, now) : null,
    },
    funnel: {
      stages, historyDays, showTrends: historyDays >= TREND_MIN_DAYS,
      awaitingReply: waiting.length, lastAppliedAt: lastApplied === null ? null : new Date(lastApplied).toISOString(),
      lastAppliedDays: lastApplied === null ? null : Math.max(0, days(lastApplied, nowT)),
    },
    map: { points, unscored },
    nextUp, nextUpTotal: ranked.length,
    weekly, weeklyGoal: typeof goal === "number" && Number.isFinite(goal) && goal > 0 ? goal : null,
    mix, stale, sources, salary, sponsorship: sponsorshipFocus(status),
  };
}

/**
 * How many results a logged search actually looked at. The log keeps what the agent wrote: a number, or text like
 * "2,000+ (25 read)", "81 (cards 51-81)" or "87 (25 cards p1 read)". What was read wins over the site's total, and
 * the total is its first number ("2,000+" is 2000, "~12" is 12), never every digit run together.
 */
export function seenCount(results: unknown): number | null {
  if (typeof results === "number") return Number.isFinite(results) && results >= 0 ? Math.floor(results) : null;
  const t = String(results ?? "");
  const read = /(\d[\d,]*)\s*(?:cards?\s*(?:p\d+\s*)?)?read\b/i.exec(t);
  if (read) return Number.parseInt(read[1]!.replace(/,/g, ""), 10);
  const range = /cards?\s*(\d+)\s*[-–]\s*(\d+)/i.exec(t);
  if (range) { const a = Number(range[1]), b = Number(range[2]); if (b >= a) return b - a + 1; }
  const lead = /(\d[\d,]*)/.exec(t);
  return lead ? Number.parseInt(lead[1]!.replace(/,/g, ""), 10) : null;
}
