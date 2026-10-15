/**
 * Find jobs: the search plan a run starts from (owner, 2026-10-11: "it didn't find related jobs, the rules are too
 * tight"). From the person's roles, related titles and top skills it builds the search words, shortest first; from
 * their places it builds the order to widen in when a place gives too few relevant jobs. Pure, so the prompt, the
 * tests and the plugin's wording agree on the numbers.
 */

import { countriesIn, type SearchPrefs } from "./find-prefs.js";

/** How many queries each search breadth may run. One query is one set of search words in one place, on each ticked board. */
export const BREADTH_QUERIES = { focused: 8, broad: 16 } as const;

/**
 * How many new jobs a search aims to add (filters.max_jobs; owner, 2026-10-15: "don't hardcode 25, let them put a
 * custom number, default 100"). The top is 200: at about a minute of browsing per kept job (open, read, check, save,
 * plus the ads dropped), 200 is over three hours in one run, about as long as a board puts up with one visitor and
 * Claude keeps a search in mind. Past that, run Find jobs again.
 */
export const MAX_JOBS = { min: 1, max: 200, default: 100 } as const;

/**
 * One find-jobs run's limits, scaled with the jobs it aims for so the number is reachable: pages read per board
 * (an ad is a page; so is each page of results), browsing steps, browsing time, Claude's whole run (browsing plus
 * the report), and job_new and search_add calls (job_new also answers "already have"). Never under the old fixed
 * limits, never over BUDGET_MAX. Nothing assumes a number of results per page.
 */
export interface FindBudget { pagesPerBoard: number; actions: number; browseMs: number; claudeMs: number; jobNew: number; searchAdd: number }
const MIN = 60_000;
export const BUDGET_MAX: FindBudget = { pagesPerBoard: 400, actions: 2_500, browseMs: 200 * MIN, claudeMs: 215 * MIN, jobNew: 400, searchAdd: 200 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function findBudget(jobs: number): FindBudget {
  const n = Number.isFinite(jobs) ? clamp(Math.round(jobs), MAX_JOBS.min, MAX_JOBS.max) : MAX_JOBS.default;
  const browseMs = clamp(n * MIN, 15 * MIN, BUDGET_MAX.browseMs);
  return {
    pagesPerBoard: clamp(10 + 3 * n, 25, BUDGET_MAX.pagesPerBoard),
    actions: clamp(100 + 12 * n, 300, BUDGET_MAX.actions),
    browseMs,
    // Browsing stops first; the rest is for saving the last jobs and writing the report.
    claudeMs: Math.min(browseMs + 15 * MIN, BUDGET_MAX.claudeMs),
    jobNew: clamp(2 * n, 50, BUDGET_MAX.jobNew),
    searchAdd: clamp(n, 100, BUDGET_MAX.searchAdd),
  };
}
/** A place that gives fewer relevant results than this is "thin": stop adding words there and widen. */
export const MIN_RELEVANT_PER_PLACE = 5;
/** A job is relevant when its title matches, or its ad names at least this many of the person's core skills. */
export const MIN_SKILL_OVERLAP = 2;
/** The most search words a plan lists, and the most skills it searches on their own. */
export const MAX_SEARCH_WORDS = 12;
const MAX_SKILL_WORDS = 4;

/** Seniority words dropped from a role to get the shortest search words ("Senior AI Engineer" → "AI Engineer"). */
const SENIORITY = /\b(senior|snr|sr|junior|jnr|jr|lead|principal|staff|mid|mid-level|intermediate|graduate|grad|entry[- ]level|experienced)\b\.?/gi;

/** "Senior AI Engineer" → "AI Engineer"; "Software Engineer (LLM)" → "Software Engineer LLM". Keeps the case typed. */
export function searchWords(role: string): string {
  const s = role.replace(/[()[\]]/g, " ").replace(SENIORITY, " ").replace(/\s*[-–,/|]\s*$/g, "").replace(/\s+/g, " ").trim();
  return s || role.trim();
}

/**
 * Titles people use for the same work, by family. Matched against the person's roles; every family that matches
 * adds its titles (after the person's own related titles). Plain lists, deliberately small.
 */
const FAMILIES: { match: RegExp; titles: readonly string[] }[] = [
  {
    match: /\b(ai|a\.i\.|artificial intelligence|machine learning|ml|llm|genai|gen ai|generative|nlp|deep learning|mlops|conversational)\b/i,
    titles: ["AI Engineer", "Machine Learning Engineer", "LLM Engineer", "Generative AI Engineer", "Applied AI Engineer", "AI Developer", "Software Engineer AI", "Data Scientist", "MLOps Engineer"],
  },
  { match: /\bdata (engineer|scientist|analyst)|\banalytics engineer\b/i, titles: ["Data Engineer", "Data Scientist", "Analytics Engineer", "Machine Learning Engineer", "Data Analyst"] },
  { match: /\b(back[- ]?end|api)\b/i, titles: ["Backend Engineer", "Python Developer", "Software Engineer", "API Developer"] },
  { match: /\bfront[- ]?end\b|\b(react|ui) (developer|engineer)\b/i, titles: ["Frontend Developer", "React Developer", "UI Engineer", "Software Engineer"] },
  { match: /\bfull[- ]?stack\b/i, titles: ["Full Stack Developer", "Software Engineer", "Web Developer"] },
  { match: /\b(software|web) (engineer|developer)\b|\bprogrammer\b/i, titles: ["Software Engineer", "Software Developer", "Full Stack Developer", "Backend Engineer"] },
  { match: /\b(devops|cloud|platform|site reliability|sre|infrastructure)\b/i, titles: ["DevOps Engineer", "Cloud Engineer", "Platform Engineer", "Site Reliability Engineer"] },
  { match: /\b(automation|rpa|integration)\b/i, titles: ["Automation Engineer", "Integration Developer", "RPA Developer"] },
  { match: /\b(mobile|ios|android)\b/i, titles: ["Mobile Developer", "iOS Developer", "Android Developer"] },
  { match: /\b(qa|test|quality)\b.*\b(engineer|analyst)\b/i, titles: ["QA Engineer", "Test Analyst", "Automation Test Engineer"] },
];

/**
 * Roles that are IT work, so a board's IT category is searched (SEEK: Information & Communication Technology). Tech
 * phrases only: "Mobile Plant Operator", "Data Entry Clerk" and "QA Inspector" aren't IT work.
 */
const TECH = /\b(ai|a\.i\.|ml|llm|genai|gen ai|machine learning|artificial intelligence|deep learning|nlp|mlops|data (engineer|scientist)|analytics engineer|software|programmer|devops|cloud (engineer|architect)|platform engineer|site reliability|sre|python|java|javascript|typescript|golang|react|node(\.js)?|full[- ]?stack|front[- ]?end|back[- ]?end|web (developer|engineer)|(ios|android|mobile app|app|game|php|\.net) (developer|engineer)|cyber ?security|it support|ict|network engineer|systems (administrator|engineer)|(qa|test automation) engineer|solutions? architect)\b/i;

export const isTechSearch = (roles: readonly string[]): boolean => roles.some((r) => TECH.test(r));

function dedupe(words: readonly string[], max: number): string[] {
  const out: string[] = [];
  for (const w of words) {
    const s = w.replace(/\s+/g, " ").trim();
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The search words, best first: the person's roles cut to their shortest form (shortest first), their own related
 * titles, the titles of the families their roles belong to, then their top skills on their own ("LLM", "Python").
 */
export function planSearchWords(prefs: Pick<SearchPrefs, "roles" | "related_titles">, skills: readonly string[] = []): string[] {
  const roles = prefs.roles.map(searchWords).map((w, i) => ({ w, i })).sort((a, b) => a.w.split(" ").length - b.w.split(" ").length || a.i - b.i).map((x) => x.w);
  const family = FAMILIES.filter((f) => prefs.roles.some((r) => f.match.test(r))).flatMap((f) => f.titles);
  return dedupe([...roles, ...prefs.related_titles.map(searchWords), ...family, ...skills.slice(0, MAX_SKILL_WORDS)], MAX_SEARCH_WORDS);
}

/** Australian cities and state codes, for widening a city search to its state. */
const AU_STATES: { name: string; code: RegExp; cities: RegExp }[] = [
  { name: "Queensland", code: /\bQLD\b/, cities: /\b(brisbane|gold coast|sunshine coast|townsville|cairns|toowoomba|ipswich|logan|mackay|rockhampton)\b/i },
  { name: "New South Wales", code: /\bNSW\b/, cities: /\b(sydney|newcastle|wollongong|parramatta|north sydney|central coast)\b/i },
  { name: "Victoria", code: /\bVIC\b/, cities: /\b(melbourne|geelong|ballarat|bendigo)\b/i },
  { name: "Western Australia", code: /\bWA\b/, cities: /\bperth\b/i },
  { name: "South Australia", code: /\bSA\b/, cities: /\badelaide\b/i },
  { name: "Australian Capital Territory", code: /\bACT\b/, cities: /\bcanberra\b/i },
  { name: "Tasmania", code: /\bTAS\b/, cities: /\bhobart\b/i },
  { name: "Northern Territory", code: /\bNT\b/, cities: /\bdarwin\b/i },
];

/** The Australian state a place is in ("Gold Coast" → "Queensland"), or null. */
export function auStateOf(place: string): string | null {
  const byCode = AU_STATES.find((s) => s.code.test(place));
  if (byCode) return byCode.name;
  return AU_STATES.find((s) => s.cities.test(place))?.name ?? null;
}

/**
 * Where to widen to, in order, after the preferred places: the person's fallback places, then remote in each allowed
 * country (only when they take remote work), then the states their places are in, then each allowed country. Never
 * outside the allowed countries (job_new refuses those), and never a place already listed.
 */
export function planWidenPlaces(prefs: Pick<SearchPrefs, "locations" | "fallback_locations" | "countries" | "work_modes">): string[] {
  const remoteOk = !prefs.work_modes.length || prefs.work_modes.includes("remote");
  const countries = prefs.countries.length ? prefs.countries : [...new Set(prefs.locations.flatMap((l) => countriesIn(l)))];
  const states = countries.includes("Australia") ? prefs.locations.map(auStateOf).filter((s): s is string => !!s) : [];
  const out = dedupe([...prefs.fallback_locations, ...(remoteOk ? countries.map((c) => `Remote ${c}`) : []), ...states, ...countries], 20);
  const taken = new Set(prefs.locations.map((l) => l.toLowerCase()));
  return out.filter((p) => !taken.has(p.toLowerCase()));
}

export interface SearchPlan {
  /** Search words, best first. */
  words: string[];
  /** Places to widen to, in order, after the preferred places. */
  widen: string[];
  /** Search the boards' IT category where a board has one. */
  tech: boolean;
}

export function searchPlan(prefs: SearchPrefs, skills: readonly string[] = []): SearchPlan {
  return { words: planSearchWords(prefs, skills), widen: planWidenPlaces(prefs), tech: isTechSearch([...prefs.roles, ...prefs.related_titles]) };
}
