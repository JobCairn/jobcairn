/**
 * Job boards: the one shared list of ids, names and how to recognise a board from a job's `source_site` or its
 * address. The UI adds a logo per id (app-ui/src/source/boards.ts, SourceBadge). Main keeps a separate, much
 * narrower table of what "Search in my Chrome" may browse (services/src/chrome/boards.ts): adding a board or a
 * host here for display never widens what a browser run may open.
 */

export interface JobBoard {
  id: string;
  name: string;
  /** Matched against a trimmed, lower-cased `source_site`. */
  siteNames: readonly string[];
  /**
   * Matched against an address's host: the domain itself or a dot-bounded subdomain, never a substring (see
   * hostMatches). Empty for the generic fallbacks, which are never reached through a lookup.
   */
  hostDomains: readonly string[];
}

/**
 * The one canonical board order (owner, 2026-10-11): the big boards (LinkedIn, SEEK, Indeed, Glassdoor, Jora), then
 * the other boards, then ATS sources, then company site and pasted. Every list of boards in the app (Searches' site
 * filter and sort, Settings' board chips, the Find jobs composer and the run strip) follows this array's order;
 * use boardRank / compareBoardSites / sortBoardIds rather than sorting by name.
 */
export const JOB_BOARDS: readonly JobBoard[] = [
  { id: "linkedin", name: "LinkedIn", siteNames: ["linkedin"], hostDomains: ["linkedin.com"] },
  { id: "seek", name: "SEEK", siteNames: ["seek"], hostDomains: ["seek.com.au", "seek.com", "seek.co.nz"] },
  { id: "indeed", name: "Indeed", siteNames: ["indeed"], hostDomains: ["indeed.com"] },
  // glassdoor.com.au isn't a subdomain of glassdoor.com, so it is listed on its own.
  { id: "glassdoor", name: "Glassdoor", siteNames: ["glassdoor"], hostDomains: ["glassdoor.com", "glassdoor.com.au"] },
  { id: "jora", name: "Jora", siteNames: ["jora"], hostDomains: ["jora.com"] },
  // Other boards.
  { id: "careerone", name: "CareerOne", siteNames: ["careerone", "career one"], hostDomains: ["careerone.com.au"] },
  { id: "workforce", name: "Workforce Australia", siteNames: ["workforce australia", "workforce"], hostDomains: ["workforceaustralia.gov.au"] },
  { id: "adzuna", name: "Adzuna", siteNames: ["adzuna"], hostDomains: ["adzuna.com", "adzuna.com.au"] },
  { id: "wellfound", name: "Wellfound", siteNames: ["wellfound", "angellist", "angel.co"], hostDomains: ["wellfound.com", "angel.co"] },
  // ATS sources (employers' own applicant systems).
  { id: "greenhouse", name: "Greenhouse", siteNames: ["greenhouse"], hostDomains: ["greenhouse.io"] },
  { id: "lever", name: "Lever", siteNames: ["lever"], hostDomains: ["lever.co"] },
  { id: "ashby", name: "Ashby", siteNames: ["ashby", "ashbyhq"], hostDomains: ["ashbyhq.com"] },
  { id: "workable", name: "Workable", siteNames: ["workable"], hostDomains: ["workable.com"] },
  { id: "smartrecruiters", name: "SmartRecruiters", siteNames: ["smartrecruiters", "smart recruiters"], hostDomains: ["smartrecruiters.com"] },
  { id: "workday", name: "Workday", siteNames: ["workday"], hostDomains: ["myworkdayjobs.com", "workday.com"] },
  // Generic fallbacks: never reached through siteNames/hostDomains (both empty).
  { id: "company-website", name: "Company website", siteNames: [], hostDomains: [] },
  { id: "pasted", name: "Pasted by you", siteNames: [], hostDomains: [] },
];

/**
 * True when `host` is exactly `domain` or a subdomain of it (a dot-bounded suffix). Never a plain substring or
 * `endsWith` without the dot, so "linkedin.com.evil.example" and "evillinkedin.com" are not LinkedIn. Case and a
 * trailing dot are ignored.
 */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/** The address's host, lower-cased, or null when it doesn't parse. */
export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export function jobBoardById(id: string): JobBoard | undefined {
  return JOB_BOARDS.find((b) => b.id === id);
}

/** A board whose `siteNames` has this site name (trimmed, any case). */
export function jobBoardBySite(site: string): JobBoard | undefined {
  const s = site.trim().toLowerCase();
  if (!s) return undefined;
  return JOB_BOARDS.find((b) => b.siteNames.includes(s));
}

export function jobBoardByHost(host: string): JobBoard | undefined {
  return JOB_BOARDS.find((b) => b.hostDomains.some((d) => hostMatches(host, d)));
}

export function jobBoardByUrl(url: string): JobBoard | undefined {
  const host = hostOf(url);
  return host ? jobBoardByHost(host) : undefined;
}

const GENERIC = new Set(["company-website", "pasted"]);
/** Site names that mean the company's own site or a pasted ad (these sort last, after any unknown site). */
const GENERIC_SITES: Record<string, string> = { "company website": "company-website", "company site": "company-website", company: "company-website", careers: "company-website", pasted: "pasted", "pasted by you": "pasted" };

/**
 * A board's place in the canonical order (JOB_BOARDS), from its id or a `source_site` name (any case). Unknown
 * sites sort after every known board and ATS source, but before company site and pasted.
 */
export function boardRank(idOrSite: string): number {
  const s = idOrSite.trim().toLowerCase();
  const id = JOB_BOARDS.some((b) => b.id === s) ? s : jobBoardBySite(s)?.id ?? GENERIC_SITES[s];
  const known = JOB_BOARDS.length - GENERIC.size;
  if (!id) return known; // unknown: after ATS, before company site and pasted
  const i = JOB_BOARDS.findIndex((b) => b.id === id);
  return GENERIC.has(id) ? i + 1 : i;
}

/** Sorts site names or board ids in the canonical order; ties (two unknown sites) fall back to the name. */
export function compareBoardSites(a: string, b: string): number {
  return boardRank(a) - boardRank(b) || a.localeCompare(b, "en");
}

/** A copy of these ids (or site names) in the canonical board order. */
export function sortBoardIds<T extends string>(ids: readonly T[]): T[] {
  return [...ids].sort(compareBoardSites);
}
