/**
 * Find jobs: what the person is looking for, in one place, and the checks a found job must pass.
 *
 * Roles, the minimum salary and the preferred places (in order, each with its work modes) live in the profile;
 * the rest lives under `filters` in settings/search.json. Settings › Search and Find jobs' chips both edit these same
 * saved fields, so there is one copy of every filter. Older
 * workspaces may still hold a separate `filters.locations` list: it's read first, then the profile's places
 * (migration 3 merges the two into the profile). Pure, so main (prompt, engine gate, job_new), the UI and the
 * mock bridge read the same thing.
 */

import { JOB_TYPES, type JobType } from "./job-filters.js";
import { daysSinceMonday } from "./posted-date.js";
import { defaultOptions, optionsFor, type RequestChoices } from "./request.js";
import { MAX_JOBS } from "./find-plan.js";
import type { WorkRightsStatus } from "./constants.js";
import { arr, bool, int, num as vNum, obj as vObj, oneOf, opt, str, type V } from "./validate.js";

export type WorkMode = "onsite" | "hybrid" | "remote";
/** How many searches Claude runs: focused (a few, on the closest roles) or broad (more, with related titles). */
export type SearchBreadth = "focused" | "broad";
export const SEARCH_BREADTHS: readonly SearchBreadth[] = ["focused", "broad"];
export const WORK_MODES: readonly WorkMode[] = ["onsite", "hybrid", "remote"];
/** Which results a board lists first: its best matches, or the newest ads. */
export type SearchSort = "relevance" | "recent";
export const SEARCH_SORTS: readonly SearchSort[] = ["relevance", "recent"];
/** Experience levels, as LinkedIn names them (the only board with this filter in its address). */
export type ExperienceLevel = "internship" | "entry" | "associate" | "mid_senior" | "director" | "executive";
export const EXPERIENCE_LEVELS: readonly ExperienceLevel[] = ["internship", "entry", "associate", "mid_senior", "director", "executive"];
export const EXPERIENCE_WORDS: Record<ExperienceLevel, string> = {
  internship: "Internship", entry: "Entry level", associate: "Associate", mid_senior: "Mid-senior", director: "Director", executive: "Executive",
};
export const SORT_WORDS: Record<SearchSort, string> = { relevance: "Best match", recent: "Newest first" };
/** Distances a board's search may cover around a place, in km. */
export const RADIUS_PRESETS = [10, 25, 50, 100] as const;

export interface SearchPrefs {
  /** Target roles (profile targets.roles). */
  roles: string[];
  /** Other titles worth searching for the same work (filters.related_titles). */
  related_titles: string[];
  /** Preferred places, most preferred first (the profile's locations; an old filters.locations list goes first). */
  locations: string[];
  /** Work modes the person takes; empty means any (filters.work_modes, else the profile locations' modes). */
  work_modes: WorkMode[];
  /** Searched only when the preferred places give too few matches (filters.fallback_locations). */
  fallback_locations: string[];
  /** Fewer matches than this in the preferred places means also search the fallbacks (filters.min_results). */
  min_results: number;
  /** Countries a kept job must be in (or be remote and open to): filters.countries, else read off the places. */
  countries: string[];
  /** Where `countries` came from: "settings", "locations" (read off the places), or "" (none known). */
  countries_from: "settings" | "locations" | "";
  salary_min: number | null;
  salary_max: number | null;
  currency: string;
  /** Job types to keep (profile targets.job_types); empty means any. */
  job_types: JobType[];
  /** Only ads posted in the last this many days (filters.posted_within_days); null means any age. */
  posted_days: number | null;
  /** "This week" (filters.posted_this_week): posted_days is then the days since Monday, worked out when read. */
  posted_week: boolean;
  /** Employers to skip (profile skip_companies). */
  exclude_companies: string[];
  /** Words that rule an ad out (filters.exclude_keywords). */
  exclude_keywords: string[];
  /** Keep only ads that say they offer sponsorship (filters.sponsor_only). Used only when the work rights call for it. */
  sponsor_only: boolean;
  /** How many searches Claude runs (filters.breadth). */
  breadth: SearchBreadth;
  /** This run's own words from "Describe the jobs you want" that weren't read as a filter; "" when none (never saved). */
  free_text: string;
  /** Which results the boards list first (filters.sort). */
  sort: SearchSort;
  /** Experience levels to keep; empty means any (filters.experience). A hint: only clearly other levels are skipped. */
  experience: ExperienceLevel[];
  /** LinkedIn only: list only Easy Apply jobs (filters.easy_apply). */
  easy_apply: boolean;
  /** How far around each place a board searches, in km; null means the board's own default (filters.radius_km). */
  radius_km: number | null;
  /** How many new jobs a run aims to add (filters.max_jobs): MAX_JOBS.default when unset. The run's limits scale with it. */
  max_jobs: number;
}

export const DEFAULT_MIN_RESULTS = 10;
const MAX_ITEMS = 20;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const clean = (v: unknown, max = 80): string => (typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
function list(v: unknown, max = MAX_ITEMS): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const s = clean(x);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Builds the search preferences from the profile and settings/search.json records (any shape; bad parts are dropped). */
export function searchPrefsFrom(profile: unknown, search: unknown, now: Date = new Date()): SearchPrefs {
  const p = obj(profile), f = obj(obj(search).filters);
  const t = obj(p.targets), sal = obj(p.salary);
  const profLocs = (Array.isArray(p.locations) ? p.locations : []).map(obj);
  const own = list(f.locations);
  const locations = list([...own, ...profLocs.map((l) => l.place)]);
  const modesOf = (v: unknown) => (Array.isArray(v) ? v.filter((m): m is WorkMode => (WORK_MODES as readonly unknown[]).includes(m)) : []);
  let work_modes = modesOf(f.work_modes);
  if (!work_modes.length && !own.length) work_modes = [...new Set(profLocs.flatMap((l) => modesOf(l.modes)))];
  if (work_modes.length === WORK_MODES.length) work_modes = [];
  const set = list(f.countries).map((c) => canonicalCountry(c) ?? c);
  const read = [...new Set(locations.flatMap((l) => countriesIn(l)))];
  const minRaw = num(f.min_results);
  const jobsRaw = num(f.max_jobs);
  return {
    roles: list(t.roles),
    related_titles: list(f.related_titles),
    locations,
    work_modes: work_modes.sort((a, b) => WORK_MODES.indexOf(a) - WORK_MODES.indexOf(b)),
    fallback_locations: list(f.fallback_locations),
    min_results: minRaw !== null && Number.isInteger(minRaw) && minRaw >= 1 ? Math.min(minRaw, 200) : DEFAULT_MIN_RESULTS,
    countries: set.length ? set : read,
    countries_from: set.length ? "settings" : read.length ? "locations" : "",
    salary_min: num(sal.min),
    salary_max: num(f.salary_max),
    currency: clean(sal.currency, 8) || "AUD",
    job_types: (Array.isArray(t.job_types) ? t.job_types : []).filter((x, i, a): x is JobType => (JOB_TYPES as readonly unknown[]).includes(x) && a.indexOf(x) === i),
    posted_days: f.posted_this_week === true ? daysSinceMonday(now) : postedDays(f.posted_within_days),
    posted_week: f.posted_this_week === true,
    exclude_companies: list(p.skip_companies, 40),
    exclude_keywords: list(f.exclude_keywords, 30),
    sponsor_only: f.sponsor_only === true,
    breadth: (SEARCH_BREADTHS as readonly unknown[]).includes(f.breadth) ? (f.breadth as SearchBreadth) : "focused",
    free_text: "",
    sort: (SEARCH_SORTS as readonly unknown[]).includes(f.sort) ? (f.sort as SearchSort) : "relevance",
    experience: levels(f.experience),
    easy_apply: f.easy_apply === true,
    radius_km: radius(f.radius_km),
    max_jobs: jobsRaw !== null && Number.isInteger(jobsRaw) && jobsRaw >= MAX_JOBS.min ? Math.min(jobsRaw, MAX_JOBS.max) : MAX_JOBS.default,
  };
}

const levels = (v: unknown): ExperienceLevel[] => EXPERIENCE_LEVELS.filter((l) => Array.isArray(v) && v.includes(l));
const radius = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 500 ? v : null);

/** The find-jobs request options that are saved search settings, not choices made per run. */
export const SAVED_SEARCH_OPTIONS = ["breadth", "sponsor_only", "max_jobs"] as const;

/**
 * A find-jobs request with its saved-setting options (breadth, sponsorship only, jobs to find) taken from the search settings, so
 * every run, preview and one-click prompt uses the one saved copy. Options the candidate isn't offered (sponsorship
 * only, for someone who doesn't need sponsorship) are left out. With no request yet, the
 * other options take their defaults.
 */
export function withSavedSearchOptions(choices: RequestChoices | null, p: Pick<SearchPrefs, "breadth" | "sponsor_only" | "max_jobs">, status: WorkRightsStatus = "unknown"): RequestChoices | null {
  const offered = new Set(optionsFor("find_jobs", status).map((o) => o.key));
  const saved: Record<string, boolean | string | number> = {};
  if (offered.has("breadth")) saved.breadth = p.breadth;
  if (offered.has("max_jobs")) saved.max_jobs = p.max_jobs;
  if (offered.has("sponsor_only")) saved.sponsor_only = p.sponsor_only;
  if (!Object.keys(saved).length) return choices;
  const options = { ...(choices?.options ?? defaultOptions("find_jobs", status)) };
  for (const k of SAVED_SEARCH_OPTIONS) delete options[k];
  return { options: { ...options, ...saved }, note: choices?.note ?? "" };
}

const postedDays = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 365 ? v : null);

// ---- One search's own choices (Find jobs' quick filters) --------------------------------------------

/**
 * What one find-jobs run changes from the saved preferences, chosen in the composer without saving them as the
 * default. Every field is optional; a field that's present replaces the saved one for that run only. Main checks
 * it (searchOverride) and passes it to the prompt, the start check and job_new, so all three agree.
 */
export interface SearchOverride {
  roles?: string[]; locations?: string[]; fallback_locations?: string[]; countries?: string[]; work_modes?: WorkMode[];
  salary_min?: number | null; salary_max?: number | null; job_types?: JobType[]; posted_days?: number | null; posted_week?: boolean;
  exclude_companies?: string[]; exclude_keywords?: string[];
  /** Find jobs' "Describe the jobs you want": words the reader didn't understand, for Claude to apply (this run only). */
  free_text?: string;
  /** This run only: skip top-tier big tech, or keep only ads offering sponsorship (when offered to the person). */
  skip_big_tech?: boolean; sponsor_only?: boolean;
  sort?: SearchSort; experience?: ExperienceLevel[]; easy_apply?: boolean; radius_km?: number | null;
}
const OVERRIDE_KEYS = ["roles", "locations", "fallback_locations", "countries", "work_modes", "salary_min", "salary_max", "job_types", "posted_days", "posted_week", "exclude_companies", "exclude_keywords", "sort", "experience", "easy_apply", "radius_km", "free_text", "skip_big_tech", "sponsor_only"] as const;

const line = str({ min: 1, max: 80 });
const words = (max: number) => opt(arr(line, { max }));
const orNull = <T>(inner: V<T>): V<T | null | undefined> => (v, at) => (v === undefined ? undefined : v === null ? null : inner(v, at));
/** The IPC and command-line check for a run's own search choices. */
export const searchOverride: V<SearchOverride> = vObj({
  roles: words(MAX_ITEMS), locations: words(MAX_ITEMS), fallback_locations: words(MAX_ITEMS), countries: words(10),
  work_modes: opt(arr(oneOf(WORK_MODES), { max: 3 })), salary_min: orNull(vNum(0, 10_000_000)), salary_max: orNull(vNum(0, 10_000_000)),
  job_types: opt(arr(oneOf(JOB_TYPES), { max: JOB_TYPES.length })), posted_days: orNull(int(1, 365)), posted_week: opt(bool),
  exclude_companies: words(40), exclude_keywords: words(30),
  free_text: opt(str({ max: 300 })), skip_big_tech: opt(bool), sponsor_only: opt(bool),
  sort: opt(oneOf(SEARCH_SORTS)), experience: opt(arr(oneOf(EXPERIENCE_LEVELS), { max: EXPERIENCE_LEVELS.length })), easy_apply: opt(bool), radius_km: orNull(int(1, 500)),
}) as unknown as V<SearchOverride>;

/** The preferences for one run: the saved ones with the run's own choices on top. Lists are cleaned as when read. */
export function applySearchOverride(p: SearchPrefs, o: SearchOverride | undefined | null, now: Date = new Date()): SearchPrefs {
  if (!o) return p;
  const out: SearchPrefs = { ...p };
  if (o.roles) out.roles = list(o.roles);
  if (o.locations) out.locations = list(o.locations);
  if (o.fallback_locations) out.fallback_locations = list(o.fallback_locations);
  if (o.work_modes) out.work_modes = o.work_modes.length === WORK_MODES.length ? [] : WORK_MODES.filter((m) => o.work_modes!.includes(m));
  if (o.salary_min !== undefined) out.salary_min = num(o.salary_min);
  if (o.salary_max !== undefined) out.salary_max = num(o.salary_max);
  if (o.job_types) out.job_types = JOB_TYPES.filter((t) => o.job_types!.includes(t));
  if (o.posted_days !== undefined) { out.posted_days = postedDays(o.posted_days); out.posted_week = false; }
  if (o.posted_week === true) { out.posted_days = daysSinceMonday(now); out.posted_week = true; }
  else if (o.posted_week === false && p.posted_week && o.posted_days === undefined) { out.posted_days = null; out.posted_week = false; }
  if (o.exclude_companies) out.exclude_companies = list(o.exclude_companies, 40);
  if (o.exclude_keywords) out.exclude_keywords = list(o.exclude_keywords, 30);
  if (o.sort && SEARCH_SORTS.includes(o.sort)) out.sort = o.sort;
  if (o.free_text !== undefined) out.free_text = clean(o.free_text, 300);
  if (o.sponsor_only === true) out.sponsor_only = true;
  if (o.experience) out.experience = levels(o.experience);
  if (o.easy_apply !== undefined) out.easy_apply = o.easy_apply === true;
  if (o.radius_km !== undefined) out.radius_km = radius(o.radius_km);
  if (o.countries) {
    const set = list(o.countries).map((c) => canonicalCountry(c) ?? c);
    const read = [...new Set(out.locations.flatMap((l) => countriesIn(l)))];
    out.countries = set.length ? set : read;
    out.countries_from = set.length ? "settings" : read.length ? "locations" : "";
  } else if (o.locations && p.countries_from !== "settings") {
    // The country follows the run's places when it was read off the places.
    const read = [...new Set(out.locations.flatMap((l) => countriesIn(l)))];
    out.countries = read;
    out.countries_from = read.length ? "locations" : "";
  }
  return out;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/**
 * The run's own choices: the fields where `draft` differs from the saved `saved` preferences, or undefined when they
 * don't differ at all. Used by the composer to send only what this run changes.
 */
export function overrideBetween(saved: SearchPrefs, draft: SearchPrefs): SearchOverride | undefined {
  const o: SearchOverride = {};
  const lists = ["roles", "locations", "fallback_locations", "work_modes", "job_types", "exclude_companies", "exclude_keywords", "experience"] as const;
  for (const k of lists) if (!sameList(saved[k], draft[k])) (o as Record<string, unknown>)[k] = [...draft[k]];
  if (draft.countries_from === "settings" && (saved.countries_from !== "settings" || !sameList(saved.countries, draft.countries))) o.countries = [...draft.countries];
  else if (draft.countries_from !== "settings" && saved.countries_from === "settings") o.countries = [];
  for (const k of ["salary_min", "salary_max", "radius_km"] as const) if (saved[k] !== draft[k]) o[k] = draft[k];
  if (saved.posted_week !== draft.posted_week || (!draft.posted_week && saved.posted_days !== draft.posted_days)) {
    if (draft.posted_week) o.posted_week = true;
    else { o.posted_days = draft.posted_days; if (saved.posted_week) o.posted_week = false; }
  }
  if (saved.sort !== draft.sort) o.sort = draft.sort;
  if (saved.easy_apply !== draft.easy_apply) o.easy_apply = draft.easy_apply;
  return OVERRIDE_KEYS.some((k) => k in o) ? o : undefined;
}

/** One preferred place as the profile stores it. */
export interface ProfileLocation { place: string; modes: WorkMode[]; will_relocate: boolean }

/**
 * The profile's locations list for these places, in this order: a place already in the list keeps its work modes
 * and relocation choice; a new one gets `modes` (all modes when empty). Blank and repeated places are dropped.
 */
export function profileLocationsFor(places: readonly string[], existing: unknown, modes: readonly WorkMode[] = []): ProfileLocation[] {
  const old = (Array.isArray(existing) ? existing : []).map(obj);
  const fresh: WorkMode[] = modes.length ? [...modes] : [...WORK_MODES];
  return list(places).map((place) => {
    const hit = old.find((l) => clean(l.place).toLowerCase() === place.toLowerCase());
    if (!hit) return { place, modes: [...fresh], will_relocate: false };
    const m = Array.isArray(hit.modes) ? hit.modes.filter((x): x is WorkMode => (WORK_MODES as readonly unknown[]).includes(x)) : fresh;
    return { place, modes: m.length ? m : [...fresh], will_relocate: hit.will_relocate === true };
  });
}

/** What's missing before a find-jobs run may start: at least one role and one place. */
export function prefsMissing(p: Pick<SearchPrefs, "roles" | "locations">): ("roles" | "locations")[] {
  const out: ("roles" | "locations")[] = [];
  if (!p.roles.length) out.push("roles");
  if (!p.locations.length) out.push("locations");
  return out;
}

/** Plain words for the engine and the composer when a search can't start yet. */
export function prefsMissingText(missing: readonly ("roles" | "locations")[]): string {
  if (!missing.length) return "";
  const what = missing.length === 2 ? "a role and a location" : missing[0] === "roles" ? "a role" : "a location";
  return `Set what you're looking for first: add ${what}, so Claude doesn't search blind (and bring back jobs from the wrong country).`;
}

/**
 * One-click defaults from what the app already knows: the profile's roles, else Claude's suggested roles from the
 * resume; the profile's places, else the profile's city. Nothing is invented: empty when nothing is known.
 */
export function prefsDefaults(profile: unknown, suggestedRoles: readonly string[] = []): { roles: string[]; locations: string[] } {
  const p = obj(profile);
  const roles = list(obj(p.targets).roles);
  const places = list((Array.isArray(p.locations) ? p.locations : []).map((l) => obj(l).place));
  const city = clean(obj(p.contact).city);
  return { roles: roles.length ? roles : list(suggestedRoles, 3), locations: places.length ? places : city ? [city] : [] };
}

// ---- Countries ----------------------------------------------------------------------------------

/**
 * How a place names its country. Country names first, then unambiguous state or province codes (only in their
 * own case, after a comma or space), then big cities. Deliberately small: anything it can't place is "unknown",
 * which flags a job for a look rather than refusing it. The city names are plain lists, so the place picker
 * (PLACE_SUGGESTIONS) offers the same places this check knows.
 */
interface CountryDef { name: string; names: RegExp; codes?: RegExp; cities?: readonly string[]; alsoMatch?: readonly string[] }
const COUNTRY_DEFS: CountryDef[] = [
  {
    name: "Australia", names: /\b(australia|australian)\b/i, codes: /(^|[\s,(])(NSW|VIC|QLD|TAS|ACT|AU|AUS)(?=$|[\s,)])/,
    cities: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Canberra", "Hobart", "Darwin", "Gold Coast", "Sunshine Coast", "Geelong", "Wollongong", "Parramatta", "North Sydney"],
    alsoMatch: ["newcastle nsw"],
  },
  { name: "New Zealand", names: /\bnew zealand\b|\baotearoa\b/i, codes: /(^|[\s,(])NZ(?=$|[\s,)])/, cities: ["Auckland", "Wellington", "Christchurch"] },
  {
    name: "Canada", names: /\bcanada\b/i, codes: /,\s*(ON|BC|AB|QC|MB|NS|SK)(?=$|[\s,)])/,
    cities: ["Toronto", "Vancouver", "Montreal", "Montréal", "Calgary", "Ottawa", "Edmonton", "Winnipeg", "Waterloo", "Mississauga"],
  },
  {
    name: "United States", names: /\b(united states|usa)\b/i, codes: /(^|[\s,(])(US|U\.S\.|USA)(?=$|[\s,).])/,
    cities: ["New York", "San Francisco", "Seattle", "Austin", "Boston", "Chicago", "Los Angeles", "Denver", "Atlanta", "San Jose", "Palo Alto", "Mountain View"],
  },
  { name: "United Kingdom", names: /\b(united kingdom|england|scotland|wales)\b/i, codes: /(^|[\s,(])UK(?=$|[\s,)])/, cities: ["London", "Manchester", "Edinburgh", "Bristol", "Glasgow"], alsoMatch: ["cambridge, uk"] },
  { name: "Ireland", names: /\bireland\b/i, cities: ["Dublin"] },
  { name: "India", names: /\bindia\b/i, cities: ["Bangalore", "Bengaluru", "Hyderabad", "Pune", "Mumbai", "Delhi", "Chennai", "Gurgaon", "Gurugram", "Noida"] },
  { name: "Singapore", names: /\bsingapore\b/i },
  { name: "Germany", names: /\bgermany\b/i, cities: ["Berlin", "Munich", "Hamburg"] },
  { name: "Philippines", names: /\bphilippines\b/i, cities: ["Manila"] },
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const COUNTRIES: { name: string; names: RegExp; codes?: RegExp; cities?: RegExp }[] = COUNTRY_DEFS.map((c) => {
  const parts = [...(c.cities ?? []), ...(c.alsoMatch ?? [])].map((x) => escapeRe(x.toLowerCase()));
  return { name: c.name, names: c.names, codes: c.codes, cities: parts.length ? new RegExp(`\\b(${parts.join("|")})\\b`, "i") : undefined };
});

/**
 * Places to suggest while typing a preferred location: each country's big cities, then "Remote <country>", then
 * the country itself. Suggestions only: any place can be typed.
 */
export const PLACE_SUGGESTIONS: readonly string[] = Object.freeze([
  // Spelling variants (Montréal, Bengaluru, Gurugram) match but aren't offered twice.
  ...COUNTRY_DEFS.flatMap((c) => (c.cities ?? []).filter((x) => !["Montréal", "Bengaluru", "Gurugram"].includes(x))),
  ...COUNTRY_DEFS.map((c) => `Remote ${c.name}`),
  ...COUNTRY_DEFS.map((c) => c.name),
]);

/** Suggestions for what's typed so far: starts-with matches first, then contains, at most `max`, case-insensitive. */
export function suggestPlaces(typed: string, max = 8, extra: readonly string[] = []): string[] {
  const q = typed.trim().toLowerCase();
  const all = [...new Set([...extra, ...PLACE_SUGGESTIONS])];
  if (!q) return all.slice(0, max);
  const starts = all.filter((p) => p.toLowerCase().startsWith(q) || p.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
  const has = all.filter((p) => !starts.includes(p) && p.toLowerCase().includes(q));
  return [...starts, ...has].filter((p) => p.toLowerCase() !== q).slice(0, max);
}

/** "australia", "AU", "aus" → "Australia"; unknown names → null. */
export function canonicalCountry(name: string): string | null {
  const s = name.trim();
  if (!s) return null;
  const c = COUNTRIES.find((x) => x.name.toLowerCase() === s.toLowerCase() || x.names.test(s) || x.codes?.test(` ${s.toUpperCase()} `));
  return c?.name ?? null;
}

/**
 * The countries a place names. "London, ON" is Canada (the province code wins over the city). A place naming two
 * countries returns both; an unknown place returns [].
 */
export function countriesIn(place: string): string[] {
  const s = place.trim();
  if (!s) return [];
  const named = COUNTRIES.filter((c) => c.names.test(s) || c.codes?.test(s)).map((c) => c.name);
  if (named.length) return named;
  return COUNTRIES.filter((c) => c.cities?.test(s)).map((c) => c.name);
}

// ---- Checking a found job -----------------------------------------------------------------------

export interface PlaceCheck {
  /** "ok" keep; "flag" keep, with a note to check the place; "refuse" don't save. */
  verdict: "ok" | "flag" | "refuse";
  /** Plain words (shown to Claude and on the job's timeline). "" when ok with nothing to say. */
  why: string;
}

const REMOTE = /\b(remote|work from home|wfh|anywhere)\b/i;
const OPEN_WORLD = /\b(anywhere|worldwide|global(ly)?|any country|all countries)\b/i;
const REGION: Record<string, RegExp> = { Australia: /\b(apac|asia[- ]pacific|anz)\b/i, "New Zealand": /\b(apac|asia[- ]pacific|anz)\b/i };

/**
 * Is this job somewhere the person's search allows? A job in an allowed country is fine. A job clearly elsewhere is
 * refused unless it's remote and its ad says people in an allowed country can take it. A job whose place can't be
 * read (blank, just "Remote", or a place this list doesn't know) is kept but flagged for the person to check.
 */
export function checkJobPlace(p: Pick<SearchPrefs, "countries">, job: { location?: string; work_mode?: string; jd_text?: string }): PlaceCheck {
  const allowed = p.countries;
  if (!allowed.length) return { verdict: "ok", why: "" };
  const place = (job.location ?? "").trim();
  const found = countriesIn(place);
  if (found.some((c) => allowed.includes(c))) return { verdict: "ok", why: "" };
  const remote = REMOTE.test(`${place} ${job.work_mode ?? ""}`);
  const text = `${place}\n${(job.jd_text ?? "").slice(0, 64_000)}`;
  const openTo = allowed.find((c) => new RegExp(`\\b${c}\\b`, "i").test(text) || REGION[c]?.test(text)) ?? (OPEN_WORLD.test(text) ? allowed[0] : undefined);
  const where = allowed.join(" or ");
  if (found.length) {
    if (remote && openTo) return { verdict: "flag", why: `This job is based in ${found.join(" and ")} but is remote and looks open to people in ${openTo}. Check before applying.` };
    return { verdict: "refuse", why: `This job is in ${found.join(" and ")}, and your search is limited to ${where}. Skip it unless it's remote and the ad says people in ${where} can apply.` };
  }
  if (!place) return { verdict: "flag", why: `The ad didn't say where the job is. Check it's in ${where}.` };
  if (remote) return { verdict: "flag", why: `Remote, but the ad doesn't say which countries. Check it's open to people in ${where}.` };
  return { verdict: "flag", why: `Couldn't tell which country "${place.slice(0, 60)}" is in. Check it's in ${where}.` };
}

/**
 * The top of the yearly pay an ad states, or null when it states none or it isn't yearly (an hourly or daily
 * rate). "$120k-$140k + super" → 140000; "$95,000" → 95000; "$80 per hour" → null.
 */
export function salaryTop(text: string): number | null {
  const s = text.toLowerCase();
  if (!s.trim() || /\b(per|an?|p\/?)\s*(hour|hr|h|day|d|week|wk)\b|\/\s*(hour|hr|h|day|d|week)\b|\bhourly\b|\bdaily\b|\bweekly\b/.test(s)) return null;
  const nums: number[] = [];
  for (const m of s.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?/g)) {
    let n = Number(m[1]!.replace(/,/g, ""));
    if (m[2]) n *= 1000;
    if (n >= 1000) nums.push(n);
  }
  return nums.length ? Math.max(...nums) : null;
}

/** When the ad states yearly pay whose top is under the person's minimum, plain words why; else "". */
export function salaryBelowFloor(p: Pick<SearchPrefs, "salary_min" | "currency">, salaryText: string): string {
  if (p.salary_min === null || p.salary_min <= 0) return "";
  const top = salaryTop(salaryText);
  if (top === null || top >= p.salary_min) return "";
  return `The ad's pay tops out at ${top.toLocaleString("en-AU")}, under your minimum of ${p.salary_min.toLocaleString("en-AU")} ${p.currency}.`;
}

// ---- Filters a board's own search address can carry -------------------------------------------

/**
 * The search choices a board's own search address may carry (boards.ts searchUrl), so the board lists fewer
 * unwanted ads. Written by main into the run file for the browser command; never taken from Claude. Every limit is
 * still checked again when ads are read (the prompt's rules and job_new), so a board that ignores one is harmless.
 */
export interface BoardFilters {
  posted_days: number | null;
  sort: SearchSort;
  work_modes: WorkMode[];
  job_types: JobType[];
  experience: ExperienceLevel[];
  easy_apply: boolean;
  radius_km: number | null;
  salary_min: number | null;
}

/** The board filters for a run's preferences. */
export function boardFiltersOf(p: Pick<SearchPrefs, keyof BoardFilters | "posted_week">): BoardFilters {
  return {
    posted_days: p.posted_days, sort: p.sort, work_modes: [...p.work_modes], job_types: [...p.job_types], experience: [...p.experience],
    easy_apply: p.easy_apply, radius_km: p.radius_km, salary_min: p.salary_min,
  };
}

/** Board filters read back from a file (any shape): only known values survive; null when it isn't an object. */
export function cleanBoardFilters(v: unknown): BoardFilters | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const f = v as Record<string, unknown>;
  const pick = <T extends string>(all: readonly T[], x: unknown): T[] => all.filter((a) => Array.isArray(x) && x.includes(a));
  const sal = num(f.salary_min);
  return {
    posted_days: postedDays(f.posted_days),
    sort: f.sort === "recent" ? "recent" : "relevance",
    work_modes: pick(WORK_MODES, f.work_modes),
    job_types: pick(JOB_TYPES, f.job_types),
    experience: levels(f.experience),
    easy_apply: f.easy_apply === true,
    radius_km: radius(f.radius_km),
    salary_min: sal !== null && sal <= 10_000_000 ? Math.round(sal) : null,
  };
}
