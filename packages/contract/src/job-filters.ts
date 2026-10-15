/**
 * The Jobs list's quick filters: how a row reads for each filter (its sponsorship tier, work modes, job type,
 * board, posting date), the preset choices each chip offers, and the live counts ("facets") shown next to every
 * choice. Pure, so the services, the mock bridge and the UI agree. applyJobQuery (logic.ts) uses these.
 */
import { JOB_STATUSES, type JobStatus } from "./constants.js";
import { compareBoardSites, jobBoardBySite } from "./job-boards.js";
import type { JobRow } from "./types.js";
import { postedDateOf } from "./posted-text.js";

const DAY = 86_400_000;

// ---- Sponsorship tiers (the table's traffic light) --------------------------------------------------

export const SPONSOR_TIERS = ["confirmed", "likely", "possible", "low", "unknown"] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];
export const SPONSOR_TIER_WORDS: Record<SponsorTier, string> = {
  confirmed: "Confirmed", likely: "Likely", possible: "Possible", low: "Low", unknown: "Not scored",
};
/**
 * The same cut-offs as the Sponsor cell (sponsorView): the ad offers sponsorship (green, confirmed), 65 and up
 * (green), 45 to 64 (amber), under 45 or ruled out by the ad (red). No score at all is "unknown".
 */
export function sponsorTierOfRow(r: Pick<JobRow, "sponsor" | "wr_label">): SponsorTier {
  if (r.wr_label === "sponsorship_offered") return "confirmed";
  if (r.wr_label === "citizen_pr_only" || r.wr_label === "clearance") return "low";
  if (r.sponsor === null || !Number.isFinite(r.sponsor)) return "unknown";
  return r.sponsor >= 65 ? "likely" : r.sponsor >= 45 ? "possible" : "low";
}

// ---- Work modes -------------------------------------------------------------------------------------

export const JOB_WORK_MODES = ["remote", "hybrid", "onsite"] as const;
export type JobWorkMode = (typeof JOB_WORK_MODES)[number];
export const WORK_MODE_WORDS: Record<JobWorkMode, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On site" };
/** The modes a free-text work mode names ("Hybrid or remote" → hybrid and remote; "On-site" → onsite). */
export function workModesOf(text: string): JobWorkMode[] {
  const s = text.toLowerCase();
  const out: JobWorkMode[] = [];
  if (/\bremote\b|work from home|\bwfh\b/.test(s)) out.push("remote");
  if (/\bhybrid\b/.test(s)) out.push("hybrid");
  if (/\bon[- ]?site\b|\bin[- ]office\b|\boffice[- ]based\b/.test(s)) out.push("onsite");
  return out;
}

// ---- Job types --------------------------------------------------------------------------------------

/** The profile's job types (profile.schema targets.job_types), in its order. */
export const JOB_TYPES = ["full_time", "contract", "part_time", "casual", "internship"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JOB_TYPE_WORDS: Record<JobType, string> = {
  full_time: "Full time", contract: "Contract", part_time: "Part time", casual: "Casual", internship: "Internship or graduate",
};
/** The job type an ad's words name, or "" when it doesn't say (or says something else). */
export function jobTypeOf(text: string): JobType | "" {
  const s = text.toLowerCase().replace(/_/g, " ");
  if (/\bintern(ship)?\b|\bgraduate\b|\bgrad\b/.test(s)) return "internship";
  if (/\bcontract(or)?\b|\bfixed[- ]term\b|\btemp(orary)?\b|\bdaily rate\b/.test(s)) return "contract";
  if (/\bpart[- ]?time\b/.test(s)) return "part_time";
  if (/\bcasual\b/.test(s)) return "casual";
  if (/\bfull[- ]?time\b|\bpermanent\b/.test(s)) return "full_time";
  return "";
}

// ---- Boards -----------------------------------------------------------------------------------------

/** Where a job was found, in words: the board's name, "Pasted by you", the site as recorded, or "Not recorded". */
export function siteOfRow(r: Pick<JobRow, "source" | "source_site">): string {
  const b = jobBoardBySite(r.source_site);
  if (b) return b.name;
  const s = r.source_site.trim();
  if (r.source === "pasted" && (!s || /^pasted/i.test(s))) return "Pasted by you";
  return s || "Not recorded";
}

// ---- Dates ------------------------------------------------------------------------------------------

/** When the ad was posted: its own date when it states one, else the day it was found (for ordering only, never a filter). */
export function postedAtOfRow(r: Pick<JobRow, "posted" | "found_at">): string {
  return postedDateOf(r) || r.found_at;
}

// ---- Presets ----------------------------------------------------------------------------------------

export const POSTED_PRESETS = [1, 3, 7, 14, 30] as const;
export const POSTED_WORDS: Record<number, string> = { 1: "Last 24 hours", 3: "Last 3 days", 7: "Last 7 days", 14: "Last 2 weeks", 30: "Last 30 days" };
/** "Last 2 weeks", "Last 10 days", "This week" (with `week`), or "" for any time. */
export function postedWords(days: number | null, week = false): string {
  if (week) return "This week";
  if (days === null) return "";
  return POSTED_WORDS[days] ?? (days === 1 ? "Last 24 hours" : `Last ${days} days`);
}
export const FIT_PRESETS = [50, 70, 85] as const;
export const SALARY_PRESETS = [80_000, 100_000, 120_000, 150_000, 180_000] as const;

// ---- Predicates and counts --------------------------------------------------------------------------

/** The filter dimensions a quick-filter chip controls. Text search is applied to every count. */
export type FacetDim = "status" | "sponsor" | "mode" | "location" | "salary" | "posted" | "fit" | "site" | "jobType" | "labels" | "sources";

export interface JobFacets {
  statuses: Record<JobStatus, number>;
  sponsor: Record<SponsorTier, number>;
  modes: Record<JobWorkMode, number>;
  jobTypes: Record<JobType | "", number>;
  /** Work-rights labels (what the ad says about who can apply). */
  labels: Record<string, number>;
  /** Boards with their counts, in the one board order. */
  sites: { name: string; count: number }[];
  /** Places with their counts, most common first (at most 12). */
  locations: { name: string; count: number }[];
  postedDays: Record<string, number>;
  /** Rows with no posted date of their own (kept by a Posted filter only while "Include jobs with no posted date" is on). */
  postedUnknown: number;
  fitMin: Record<string, number>;
  salaryMin: Record<string, number>;
}

/** What the filters need from the query (a subset of JobQuery, kept here so this file has no cycle with types.ts). */
export interface FilterQuery {
  text?: string; statuses?: JobStatus[]; labels?: string[]; location?: string; modes?: string[]; salaryMin?: number; sources?: string[];
  fitMin?: number; sponsorMin?: number; since?: string; sponsorTiers?: SponsorTier[]; jobTypes?: string[]; sites?: string[]; postedDays?: number;
  /** With a Posted filter: keep jobs whose ad shows no date (default true, so nothing silently disappears). */
  postedUndated?: boolean;
}

const salaryOk = (r: JobRow, min: number) => (r.salary_min === null && r.salary_max === null) || (r.salary_max ?? r.salary_min ?? 0) >= min;
/** Within the last `days` by the ad's own posted date; a job without one passes only when `undated` (never by found_at). */
const postedOk = (r: JobRow, days: number, now: number, undated = true) => {
  const p = postedDateOf(r);
  if (!p) return undated;
  const t = Date.parse(p.length === 10 ? `${p}T00:00:00` : p);
  return !Number.isNaN(t) && t >= now - days * DAY;
};

/** One predicate per dimension; a dimension the query doesn't set lets every row through. */
export function jobPredicates(q: FilterQuery, now: Date): Record<FacetDim, (r: JobRow) => boolean> {
  const loc = q.location?.trim().toLowerCase();
  // Old saved views hold free text ("remote", "on-site"); read it the same way as a row's mode.
  const modes = new Set(q.modes?.flatMap((m) => ((JOB_WORK_MODES as readonly string[]).includes(m) ? [m] : workModesOf(m))));
  const tiers = q.sponsorTiers?.length ? new Set(q.sponsorTiers) : null;
  const types = q.jobTypes?.length ? new Set(q.jobTypes) : null;
  const sites = q.sites?.length ? new Set(q.sites.map((s) => s.toLowerCase())) : null;
  const t = now.getTime();
  return {
    status: (r) => !q.statuses?.length || q.statuses.includes(r.status),
    labels: (r) => !q.labels?.length || q.labels.includes(r.wr_label),
    sources: (r) => !q.sources?.length || q.sources.includes(r.source),
    location: (r) => !loc || r.location.toLowerCase().includes(loc),
    mode: (r) => !modes.size || workModesOf(r.work_mode).some((m) => modes.has(m)),
    // Unknown salaries stay visible: most ads don't state one.
    salary: (r) => q.salaryMin === undefined || salaryOk(r, q.salaryMin),
    fit: (r) => q.fitMin === undefined || (r.fit ?? -1) >= q.fitMin,
    sponsor: (r) => (q.sponsorMin === undefined || (r.sponsor ?? -1) >= q.sponsorMin) && (!tiers || tiers.has(sponsorTierOfRow(r))),
    posted: (r) => (!q.since || r.found_at >= q.since) && (q.postedDays === undefined || postedOk(r, q.postedDays, t, q.postedUndated !== false)),
    site: (r) => !sites || sites.has(siteOfRow(r).toLowerCase()),
    jobType: (r) => !types || types.has(jobTypeOf(r.job_type ?? "")),
  };
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/**
 * The live counts: for each chip, how many rows each of its choices would show with every other filter as it is
 * (the chip's own filter left out, as faceted search does). `rows` are the rows the text search and the work-rights
 * visibility already allow.
 */
export function jobFacets(rows: readonly JobRow[], q: FilterQuery, now: Date): JobFacets {
  const p = jobPredicates(q, now);
  const dims = Object.keys(p) as FacetDim[];
  const without = (d: FacetDim) => rows.filter((r) => dims.every((x) => x === d || p[x](r)));
  const f: JobFacets = {
    statuses: zero(JOB_STATUSES), sponsor: zero(SPONSOR_TIERS), modes: zero(JOB_WORK_MODES), jobTypes: zero([...JOB_TYPES, ""] as const),
    labels: {}, sites: [], locations: [], postedDays: zero(POSTED_PRESETS.map(String)), postedUnknown: 0, fitMin: zero(FIT_PRESETS.map(String)), salaryMin: zero(SALARY_PRESETS.map(String)),
  };
  for (const r of without("status")) f.statuses[r.status] = (f.statuses[r.status] ?? 0) + 1;
  for (const r of without("sponsor")) f.sponsor[sponsorTierOfRow(r)]++;
  for (const r of without("mode")) for (const m of workModesOf(r.work_mode)) f.modes[m]++;
  for (const r of without("labels")) f.labels[r.wr_label] = (f.labels[r.wr_label] ?? 0) + 1;
  for (const r of without("jobType")) f.jobTypes[jobTypeOf(r.job_type ?? "")]++;
  const sites = new Map<string, number>();
  for (const r of without("site")) { const s = siteOfRow(r); sites.set(s, (sites.get(s) ?? 0) + 1); }
  f.sites = [...sites].map(([name, count]) => ({ name, count })).sort((a, b) => compareBoardSites(a.name, b.name) || a.name.localeCompare(b.name));
  const places = new Map<string, { name: string; count: number }>();
  for (const r of without("location")) {
    const name = r.location.trim();
    if (!name) continue;
    const k = name.toLowerCase();
    const cur = places.get(k);
    if (cur) cur.count++; else places.set(k, { name, count: 1 });
  }
  f.locations = [...places.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 12);
  const t = now.getTime();
  const posted = without("posted");
  for (const d of POSTED_PRESETS) f.postedDays[String(d)] = posted.filter((r) => postedOk(r, d, t, q.postedUndated !== false)).length;
  f.postedUnknown = posted.filter((r) => !postedDateOf(r)).length;
  const fit = without("fit");
  for (const n of FIT_PRESETS) f.fitMin[String(n)] = fit.filter((r) => (r.fit ?? -1) >= n).length;
  const pay = without("salary");
  for (const n of SALARY_PRESETS) f.salaryMin[String(n)] = pay.filter((r) => salaryOk(r, n)).length;
  return f;
}
