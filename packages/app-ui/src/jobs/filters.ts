import {
  JOB_STATUSES, JOB_TYPES, JOB_WORK_MODES, SPONSOR_TIERS, WR_LABELS,
  type JobQuery, type JobStatus, type JobType, type JobWorkMode, type SponsorTier, type WorkRightsLabel,
} from "@careeros/contract";

/**
 * The Jobs list's state: search text, sort, "show ads I can't apply for", and the quick filters. It round-trips
 * through the address (`#/jobs?sp=likely&mode=remote…`, so Back returns to the same list) and is kept per
 * workspace on this computer (so the list looks the same next time). Plain data, no React.
 */
export type JobSort = NonNullable<JobQuery["sort"]>;
export interface JobFilters {
  sponsor: SponsorTier[]; modes: JobWorkMode[]; location: string; salaryMin: number | null; postedDays: number | null;
  /** With a Posted filter: keep jobs whose ad shows no date (on by default, so nothing silently disappears). */
  postedUndated: boolean;
  fitMin: number | null; statuses: JobStatus[]; sites: string[]; jobTypes: (JobType | "")[]; labels: WorkRightsLabel[];
}
export interface JobsForm {
  text: string; sort: JobSort; showIneligible: boolean; filters: JobFilters;
  /** "Hide likely stale": leave out open ads posted over 30 days ago or reposted (contract ghost.ts). */
  hideStale?: boolean;
}

export const NO_FILTERS: JobFilters = {
  sponsor: [], modes: [], location: "", salaryMin: null, postedDays: null, postedUndated: true, fitMin: null, statuses: [], sites: [], jobTypes: [], labels: [],
};
export const EMPTY_FORM: JobsForm = { text: "", sort: "default", showIneligible: false, filters: NO_FILTERS };
const SORTS: readonly JobSort[] = ["default", "fit", "sponsor", "newest", "fresh"];

/** How many quick filters are on (each chip counts once). */
export function activeFilters(f: JobFilters): number {
  return [f.sponsor.length, f.modes.length, f.location.trim(), f.salaryMin !== null, f.postedDays !== null, f.fitMin !== null,
    f.statuses.length, f.sites.length, f.jobTypes.length, f.labels.length].filter(Boolean).length;
}

/** The query the list loads with. Empty filters are left out. */
export function queryFromForm(f: JobsForm): JobQuery {
  const x = f.filters;
  const q: JobQuery = {};
  if (f.text.trim()) q.text = f.text.trim();
  if (x.statuses.length) q.statuses = [...x.statuses];
  if (x.labels.length) q.labels = [...x.labels];
  if (x.location.trim()) q.location = x.location.trim();
  if (x.modes.length) q.modes = [...x.modes];
  if (x.salaryMin !== null) q.salaryMin = x.salaryMin;
  if (x.fitMin !== null) q.fitMin = x.fitMin;
  if (x.sponsor.length) q.sponsorTiers = [...x.sponsor];
  if (x.jobTypes.length) q.jobTypes = [...x.jobTypes];
  if (x.sites.length) q.sites = [...x.sites];
  if (x.postedDays !== null) { q.postedDays = x.postedDays; if (!x.postedUndated) q.postedUndated = false; }
  if (f.showIneligible) q.showIneligible = true;
  if (f.hideStale) q.hideStale = true;
  q.sort = f.sort;
  q.limit = 200;
  return q;
}

/** A saved view's query back as the list's state (old views with free-text modes or a single status still load). */
export function formFromQuery(q: JobQuery): JobsForm {
  const modes = (q.modes ?? []).map((m) => m.toLowerCase().replace(/[^a-z]/g, "")).filter((m): m is JobWorkMode => (JOB_WORK_MODES as readonly string[]).includes(m));
  return {
    text: q.text ?? "", sort: q.sort ?? "default", showIneligible: q.showIneligible ?? false, ...(q.hideStale ? { hideStale: true } : {}),
    filters: {
      sponsor: q.sponsorTiers ?? [], modes, location: q.location ?? "", salaryMin: q.salaryMin ?? null, postedDays: q.postedDays ?? null, postedUndated: q.postedUndated !== false,
      fitMin: q.fitMin ?? null, statuses: q.statuses ?? [], sites: q.sites ?? [], jobTypes: q.jobTypes ?? [], labels: q.labels ?? [],
    },
  };
}

// ---- The address ------------------------------------------------------------------------------------

const list = <T extends string>(v: string | null, allowed: readonly T[]): T[] =>
  [...new Set((v ?? "").split(",").filter((x): x is T => (allowed as readonly string[]).includes(x)))];
const number = (v: string | null, min: number, max: number, whole = false): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max && (!whole || Number.isInteger(n)) ? n : null;
};
const text = (v: string | null, max: number) => (v ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, max);

/** The list's state from the address's parameters. Anything unknown or out of range is dropped. */
export function formFromParams(p: URLSearchParams): JobsForm {
  const sort = p.get("sort");
  return {
    text: text(p.get("q"), 200),
    sort: sort && (SORTS as readonly string[]).includes(sort) ? (sort as JobSort) : "default",
    showIneligible: p.get("all") === "1",
    ...(p.get("fresh") === "1" ? { hideStale: true } : {}),
    filters: {
      sponsor: list(p.get("sp"), SPONSOR_TIERS),
      modes: list(p.get("mode"), JOB_WORK_MODES),
      location: text(p.get("loc"), 120),
      salaryMin: number(p.get("pay"), 0, 10_000_000),
      postedDays: number(p.get("posted"), 1, 365, true),
      postedUndated: p.get("undated") !== "0",
      fitMin: number(p.get("fit"), 0, 100),
      // The list writes "st" and "wr"; Home's one-filter links use "status" and "label" (both are read).
      statuses: list(p.get("st") ?? p.get("status"), JOB_STATUSES),
      sites: [...new Set((p.get("site") ?? "").split(",").map((s) => text(s, 60)).filter(Boolean))].slice(0, 20),
      jobTypes: list(p.get("type"), [...JOB_TYPES, "none"] as const).map((t) => (t === "none" ? "" : t)) as (JobType | "")[],
      labels: list(p.get("wr") ?? p.get("label"), WR_LABELS),
    },
  };
}

/** The list's state as address parameters, in a fixed order, leaving out anything at its default. */
export function paramsFromForm(f: JobsForm): URLSearchParams {
  const p = new URLSearchParams();
  const x = f.filters;
  const set = (k: string, v: string | number | null | readonly string[]) => {
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) return;
    p.set(k, Array.isArray(v) ? v.join(",") : String(v));
  };
  set("st", x.statuses);
  set("wr", x.labels);
  set("sp", x.sponsor);
  set("mode", x.modes);
  set("loc", x.location.trim());
  set("pay", x.salaryMin);
  set("posted", x.postedDays);
  if (x.postedDays !== null && !x.postedUndated) p.set("undated", "0");
  set("fit", x.fitMin);
  set("site", x.sites);
  set("type", x.jobTypes.map((t) => t || "none"));
  set("q", f.text.trim());
  if (f.sort !== "default") p.set("sort", f.sort);
  if (f.showIneligible) p.set("all", "1");
  if (f.hideStale) p.set("fresh", "1");
  return p;
}

/** Every address parameter the list reads. */
export const KNOWN_PARAMS = ["st", "wr", "status", "label", "sp", "mode", "loc", "pay", "posted", "undated", "fit", "site", "type", "q", "sort", "all", "fresh"] as const;

// ---- Kept per workspace -----------------------------------------------------------------------------

export const filtersKey = (workspace: string, view: "jobs" | "apply") => `careeros.jobs.filters:${view}:${workspace}`;

export function readKept(workspace: string, view: "jobs" | "apply"): JobsForm | null {
  try {
    const s = localStorage.getItem(filtersKey(workspace, view));
    return s === null ? null : formFromParams(new URLSearchParams(s));
  } catch { return null; }
}

export function writeKept(workspace: string, view: "jobs" | "apply", f: JobsForm): void {
  try { localStorage.setItem(filtersKey(workspace, view), paramsFromForm(f).toString()); } catch { /* storage off: the list starts clean next time */ }
}
