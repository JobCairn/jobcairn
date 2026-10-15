import { BOARD_IDS, BOARD_NAMES, DEFAULT_BOARDS, type BoardFilters, type BoardId, type BoardSignIn, type ExperienceLevel, type JobType, type SignInMatch, type SignInPage, type WorkMode } from "@careeros/contract";

/**
 * The job boards "Search in my Chrome" may visit, the only hosts a run may load for each, and the only pages on
 * those hosts it may open (main only).
 * Ids and names come from the shared job board list (contract); this table is the browse allow-list only.
 */
export interface Board {
  id: BoardId;
  name: string;
  /** The page opened during setup to check whether the person is signed in. Never opened by a run. */
  home: string;
  /** A search address for words and a place; `it` limits it to the board's IT category where the board has one. */
  search(query: string, location: string, it?: boolean): string;
  /** A run opened without search words starts here: a jobs search page, never a feed or a profile. */
  start: string;
  /**
   * The exact hosts a tab may show for this board (no other subdomain: employers.indeed.com, business.linkedin.com
   * and talent.seek.com.au are refused). Includes the board's own sign-in hosts (so a sign-in wall can be shown to
   * the person), never another site.
   */
  hosts: readonly string[];
  /** Search-results pages (paths, any case). Filters, paging and the search box are used only here. */
  searchPages: readonly RegExp[];
  /** One job ad's page. */
  adPages: readonly RegExp[];
  /** Sign-in and check pages: shown to the person (the run pauses), never read or used. Host-only entries match any path. */
  wallPages: readonly { host?: string; path?: RegExp }[];
  /**
   * Names of controls that only show when signed in, matched against the start of each control's name (so
   * "Notifications, 3 new" still counts). `strong` wins over a "Sign in" link elsewhere on the page; `weak` hints
   * (a Profile link some boards show to everyone) count only when nothing on the page says signed out.
   */
  signedIn: { strong?: RegExp; weak?: RegExp };
  /** Pages only a signed-in person stays on (LinkedIn's feed sends everyone else to its sign-in page). Setup only. */
  feedPages?: readonly RegExp[];
  /**
   * Where `get text` takes a page's text, in order: the page's main landmark, then (only where the board has no
   * private overlays) the whole body. LinkedIn reads `main` only, never its nav or messaging overlay.
   */
  readScope: readonly ("main" | "body")[];
}

const q = encodeURIComponent;
const LOGIN_PATH = /^\/(login|signin|sign-in|uas\/login|checkpoint|authwall|account\/login|oauth)(\/|$)/i;

export const BOARDS: Record<BoardId, Board> = {
  linkedin: {
    id: "linkedin", name: BOARD_NAMES.linkedin, home: "https://www.linkedin.com/feed/", start: "https://www.linkedin.com/jobs/search/",
    search: (k, l) => `https://www.linkedin.com/jobs/search/?keywords=${q(k)}&location=${q(l)}`,
    hosts: ["www.linkedin.com", "linkedin.com", "au.linkedin.com"],
    searchPages: [/^\/jobs\/search(-results)?\/?$/i, /^\/jobs\/collections(\/[a-z0-9-]+)?\/?$/i],
    adPages: [/^\/jobs\/view\/([a-z0-9-]+-)?\d+\/?$/i],
    wallPages: [{ path: LOGIN_PATH }],
    signedIn: { strong: /^(me|my network|messaging|notifications|saved items|start a post|view profile)\b/i }, readScope: ["main"],
    feedPages: [/^\/feed\/?$/i],
  },
  seek: {
    id: "seek", name: BOARD_NAMES.seek, home: "https://www.seek.com.au/", start: "https://www.seek.com.au/jobs",
    // SEEK's Information & Communication Technology classification, so "LLM engineer" doesn't bring back civil engineering.
    search: (k, l, it) => `https://www.seek.com.au/jobs${it ? "-in-information-communication-technology" : ""}?keywords=${q(k)}&where=${q(l)}`,
    // www.seek.com.au now redirects to au.seek.com (seen 2026-10-10); both are SEEK Australia.
    hosts: ["www.seek.com.au", "seek.com.au", "au.seek.com", "login.seek.com"],
    // SEEK may rewrite a search to its own path: /jobs-in-<category>/in-<place>, /<words>-jobs-in-<category>/in-<place>.
    searchPages: [/^\/jobs(-in-[a-z0-9-]+)?(\/(in|at|on)-[a-z0-9-]+)*\/?$/i, /^\/[a-z0-9-]+-jobs(-in-[a-z0-9-]+)?(\/(in|at|on)-[a-z0-9-]+)*\/?$/i],
    adPages: [/^\/job\/\d+\/?$/i],
    wallPages: [{ host: "login.seek.com" }, { path: LOGIN_PATH }],
    signedIn: { strong: /^(sign out|profile avatar|saved searches|applied jobs|recommended jobs)\b/i, weak: /^(profile|saved jobs)\b/i }, readScope: ["main", "body"],
  },
  indeed: {
    id: "indeed", name: BOARD_NAMES.indeed, home: "https://au.indeed.com/", start: "https://au.indeed.com/jobs",
    search: (k, l) => `https://au.indeed.com/jobs?q=${q(k)}&l=${q(l)}`,
    hosts: ["au.indeed.com", "secure.indeed.com"],
    searchPages: [/^\/jobs\/?$/i, /^\/q-[a-z0-9 +-]+-jobs\.html$/i, /^\/cmp\/[a-z0-9-]+\/jobs\/?$/i],
    adPages: [/^\/(m\/)?viewjob\/?$/i],
    wallPages: [{ host: "secure.indeed.com", path: /^\/(auth|account\/login)(\/|$)/i }, { path: LOGIN_PATH }],
    // Assumed (not read off the live site): the signed-in header's Messages link. Weak, so a "Sign in" control still wins.
    signedIn: { strong: /^(my jobs|my reviews)\b/i, weak: /^(profile|saved jobs|messages)\b/i }, readScope: ["main", "body"],
  },
  glassdoor: {
    id: "glassdoor", name: BOARD_NAMES.glassdoor, home: "https://www.glassdoor.com.au/", start: "https://www.glassdoor.com.au/Job/index.htm",
    search: (k, l) => `https://www.glassdoor.com.au/Job/jobs.htm?sc.keyword=${q(k)}&locKeyword=${q(l)}`,
    hosts: ["www.glassdoor.com.au", "www.glassdoor.com"],
    searchPages: [/^\/job\/[a-z0-9,._-]*\.htm$/i],
    adPages: [/^\/job-listing\/[a-z0-9,._-]+\.htm$/i],
    wallPages: [{ path: LOGIN_PATH }],
    // Assumed: the signed-in header's profile menu and saved/applied lists. Weak only (see signInState).
    signedIn: { weak: /^(profile|saved jobs|my jobs|applied jobs|user profile|profile menu)$/i }, readScope: ["main", "body"],
  },
  jora: {
    id: "jora", name: BOARD_NAMES.jora, home: "https://au.jora.com/", start: "https://au.jora.com/j",
    search: (k, l) => `https://au.jora.com/j?q=${q(k)}&l=${q(l)}`,
    hosts: ["au.jora.com"],
    searchPages: [/^\/j\/?$/i, /^\/[a-z0-9-]+-jobs(-in-[a-z0-9-]+)?\/?$/i],
    adPages: [/^\/job\/(?!rd(\/|$))[a-z0-9-]+\/?$/i],
    wallPages: [{ path: LOGIN_PATH }],
    // Assumed: the signed-in header's saved and applied lists. Weak only (see signInState).
    signedIn: { weak: /^(profile|saved jobs|saved searches|applied jobs|my jobs)\b/i }, readScope: ["main", "body"],
  },
  careerone: {
    id: "careerone", name: BOARD_NAMES.careerone, home: "https://www.careerone.com.au/", start: "https://www.careerone.com.au/jobs",
    search: (k, l) => `https://www.careerone.com.au/jobs?keywords=${q(k)}&where=${q(l)}`,
    hosts: ["www.careerone.com.au"],
    searchPages: [/^\/jobs(\/[a-z0-9-]+){0,3}\/?$/i],
    adPages: [/^\/jobview\/[a-z0-9-]+\/?$/i],
    wallPages: [{ path: LOGIN_PATH }],
    signedIn: { weak: /^(profile|saved jobs|my account)\b/i }, readScope: ["main", "body"],
  },
  workforce: {
    id: "workforce", name: BOARD_NAMES.workforce, home: "https://www.workforceaustralia.gov.au/individuals/jobs/search",
    start: "https://www.workforceaustralia.gov.au/individuals/jobs/search",
    search: (k, l) => `https://www.workforceaustralia.gov.au/individuals/jobs/search?searchText=${q(k)}&locationText=${q(l)}`,
    hosts: ["www.workforceaustralia.gov.au"],
    searchPages: [/^\/individuals\/jobs\/search\/?$/i],
    adPages: [/^\/individuals\/jobs\/details\/\d+\/?$/i],
    wallPages: [{ path: LOGIN_PATH }],
    signedIn: { strong: /^(my dashboard)\b/i }, readScope: ["main", "body"],
  },
};

export { BOARD_IDS, DEFAULT_BOARDS };

// ---- The boards' own filters in a search address ------------------------------------------------

/**
 * Board address parameters not confirmed from the boards' own pages or their documentation. Kept here, off, so
 * nobody adds them by accident: a wrong one could make a board drop good ads. Turn one on only after checking it
 * on the live site. Every limit is still checked when ads are read, so leaving these off never lets a bad ad in.
 * - LinkedIn "under 10 applicants": the parameter name isn't known.
 * - SEEK work arrangement (on site, hybrid, remote): `workarrangement`, its codes unknown.
 * - SEEK `salarytype=annual` (SEEK treats a range as yearly by default).
 * - Indeed's remote filter (an `sc=` attribute code) and its `jt=casual`.
 */
export const UNVERIFIED_PARAMS = {
  linkedinFewApplicants: null,
  seekWorkArrangement: null as Partial<Record<WorkMode, string>> | null,
  seekSalaryType: false,
  indeedRemote: null as string | null,
  indeedCasual: false,
} as const;

/** The smallest of `steps` at or above `n` (a looser board filter, never a tighter one); null above the largest. */
const atLeast = (n: number, steps: readonly number[]): number | null => steps.find((s) => s >= n) ?? null;
const KM_PER_MILE = 1.609344;

// LinkedIn: f_TPR=r<seconds>, sortBy=DD|R, f_WT 1 on site / 2 remote / 3 hybrid, f_E 1-6, f_JT, f_AL=true, distance in miles.
const LI_WT: Record<WorkMode, string> = { onsite: "1", remote: "2", hybrid: "3" };
const LI_E: Record<ExperienceLevel, string> = { internship: "1", entry: "2", associate: "3", mid_senior: "4", director: "5", executive: "6" };
// Contract work is listed as Contract or Temporary; casual as Part-time or Temporary (looser, never tighter).
const LI_JT: Record<JobType, readonly string[]> = { full_time: ["F"], part_time: ["P"], contract: ["C", "T"], casual: ["P", "T"], internship: ["I"] };
const LI_MILES = [5, 10, 25, 50, 100] as const;
// SEEK: daterange in days (its choices), sortmode, worktype 242 full time / 243 part time / 244 contract or temp / 245 casual, salaryrange min-max.
const SEEK_DAYS = [1, 3, 7, 14, 31] as const;
const SEEK_WT: Partial<Record<JobType, string>> = { full_time: "242", part_time: "243", contract: "244", casual: "245" };
// Indeed (Australia): fromage in days (its choices), sort=date, jt (one type only), radius in km.
const INDEED_DAYS = [1, 3, 7, 14] as const;
const INDEED_JT: Partial<Record<JobType, string>> = { full_time: "fulltime", part_time: "parttime", contract: "contract", internship: "internship", ...(UNVERIFIED_PARAMS.indeedCasual ? { casual: "casual" } : {}) };
const INDEED_KM = [5, 10, 15, 25, 50, 100] as const;

/**
 * The board's own filter parameters for a search, in a fixed order. Only boards whose parameters are known get
 * any (LinkedIn, SEEK, Indeed); the others are searched by words and place only. A filter the board can't express
 * as loosely as asked (a type it has no code for, two types where it takes one) is left out, never narrowed.
 */
export function boardParams(id: BoardId, f: BoardFilters | null | undefined): [string, string][] {
  if (!f) return [];
  const out: [string, string][] = [];
  if (id === "linkedin") {
    if (f.posted_days !== null) out.push(["f_TPR", `r${f.posted_days * 86_400}`]);
    if (f.sort === "recent") out.push(["sortBy", "DD"]);
    if (f.work_modes.length) out.push(["f_WT", f.work_modes.map((m) => LI_WT[m]).join(",")]);
    if (f.experience.length) out.push(["f_E", f.experience.map((e) => LI_E[e]).join(",")]);
    if (f.job_types.length) out.push(["f_JT", [...new Set(f.job_types.flatMap((t) => LI_JT[t]))].join(",")]);
    if (f.easy_apply) out.push(["f_AL", "true"]);
    if (f.radius_km !== null) { const mi = atLeast(f.radius_km / KM_PER_MILE, LI_MILES); if (mi !== null) out.push(["distance", String(mi)]); }
  } else if (id === "seek") {
    const days = f.posted_days === null ? null : atLeast(f.posted_days, SEEK_DAYS);
    if (days !== null) out.push(["daterange", String(days)]);
    if (f.sort === "recent") out.push(["sortmode", "ListedDate"]);
    if (f.job_types.length && f.job_types.every((t) => SEEK_WT[t])) out.push(["worktype", f.job_types.map((t) => SEEK_WT[t]!).join(",")]);
    const wa = UNVERIFIED_PARAMS.seekWorkArrangement;
    if (wa && f.work_modes.length && f.work_modes.every((m) => wa[m])) out.push(["workarrangement", f.work_modes.map((m) => wa[m]!).join(",")]);
    if (f.salary_min !== null && f.salary_min > 0) {
      out.push(["salaryrange", `${Math.round(f.salary_min)}-`]);
      if (UNVERIFIED_PARAMS.seekSalaryType) out.push(["salarytype", "annual"]);
    }
  } else if (id === "indeed") {
    const days = f.posted_days === null ? null : atLeast(f.posted_days, INDEED_DAYS);
    if (days !== null) out.push(["fromage", String(days)]);
    if (f.sort === "recent") out.push(["sort", "date"]);
    if (f.job_types.length === 1 && INDEED_JT[f.job_types[0]!]) out.push(["jt", INDEED_JT[f.job_types[0]!]!]);
    if (f.radius_km !== null) { const km = atLeast(f.radius_km, INDEED_KM); if (km !== null) out.push(["radius", String(km)]); }
    if (UNVERIFIED_PARAMS.indeedRemote && f.work_modes.length === 1 && f.work_modes[0] === "remote") out.push(["sc", UNVERIFIED_PARAMS.indeedRemote]);
  }
  return out;
}

/** A board's search address for words and a place, with the board's own filters (boardParams) added. */
export function searchUrl(id: BoardId, query: string, location: string, it = false, f?: BoardFilters | null): string {
  const base = BOARDS[id].search(query, location, it);
  const extra = boardParams(id, f).map(([k, v]) => `${q(k)}=${q(v)}`).join("&");
  return extra ? `${base}${base.includes("?") ? "&" : "?"}${extra}` : base;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function parse(raw: string): { u: URL; host: string } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || IPV4.test(host) || host.startsWith("[")) return null;
  return { u, host };
}

/**
 * Which ticked board an address belongs to, or null when it may not be opened. Only https, no user name or
 * password, no port, no IP address, and the host must be exactly one of the board's hosts. So
 * `linkedin.com.evil.example`, `evil-linkedin.com`, `business.linkedin.com` and a board name put before an "@" are all refused.
 * This is the host check only: pageKind adds the page rules.
 */
export function boardForUrl(raw: string, boards: readonly BoardId[]): BoardId | null {
  const p = parse(raw);
  if (!p) return null;
  for (const id of boards) {
    const b = BOARDS[id];
    if (b && b.hosts.includes(p.host)) return id;
  }
  return null;
}

/**
 * Path parts that are never a run's business, on any board, whatever the page rules say: applying, editing,
 * settings, messages, the network, notifications, profiles, feeds, accounts, saved lists, and redirectors.
 * Matched against each decoded, lower-cased path part (exact, or as a prefix for the "apply"/"edit"/"settings" families).
 */
const DENY_PARTS = new Set([
  "in", "feed", "messaging", "messages", "inbox", "mynetwork", "notifications", "settings", "mypreferences", "preferences", "psettings",
  "account", "accounts", "profile", "profiles", "edit", "redir", "redirect", "pagead", "share", "post", "posts", "myjobs", "my-jobs",
  "saved", "saved-jobs", "savedjobs", "my-activity", "logout", "signout", "sign-out", "upload", "resume", "resumes", "cv", "premium",
  "payments", "billing", "me", "dashboard", "rd", "clk", "partner", "member", "jobalerts", "job-alerts", "alerts", "apply",
]);
const DENY_PREFIX = /^(apply|edit|settings|easyapply|quickapply|message|logout|signout)/;

/** Percent-decodes until nothing changes (at most a few rounds). Null when it can't, or is still encoded after. */
function decodeFully(s: string): string | null {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    if (!/%[0-9a-f]{2}/i.test(cur)) return cur;
    try { cur = decodeURIComponent(cur); } catch { return null; }
  }
  return /%[0-9a-f]{2}/i.test(cur) ? null : cur;
}

/**
 * The path as the rules read it: each part decoded fully, empty parts dropped. Null when a decoded part hides a
 * slash or backslash (`%2F`, `%5C`, also double-encoded) or is a dot segment, since a front end that decodes
 * before routing could then land somewhere else.
 */
function cleanPath(pathname: string): { path: string; parts: string[] } | null {
  const parts: string[] = [];
  for (const raw of pathname.split("/")) {
    if (!raw) continue;
    const part = decodeFully(raw);
    if (part === null || /[/\\]/.test(part) || part === "." || part === "..") return null;
    parts.push(part);
  }
  return { path: `/${parts.join("/")}${parts.length && pathname.endsWith("/") ? "/" : ""}`, parts };
}

/** True when a path part or a query value points somewhere else (a redirect wrapper) or acts for the person. */
function denied(u: URL, parts: string[]): boolean {
  for (const raw of parts) {
    const part = raw.toLowerCase();
    if (DENY_PARTS.has(part) || DENY_PREFIX.test(part)) return true;
  }
  for (const [k, v] of u.searchParams) {
    for (const x of [k, v]) {
      const val = decodeFully(x)?.trim().toLowerCase();
      if (val === undefined) return true;
      if (/^(https?:|\/\/|\\\\)/.test(val) || val.includes("://")) return true;
    }
  }
  return false;
}

export type PageKind = "search" | "ad" | "wall";

/**
 * What kind of page an address is on a board, or null when a run may not be there:
 * - "search": a search-results page (filters, paging and the search box may be used);
 * - "ad": one job ad (read only);
 * - "wall": the board's own sign-in or check page (the run pauses for the person; it is never read or used).
 * The deny list always wins over the page rules, so apply, edit, settings, messaging, profile, feed, account and
 * redirect pages are refused even on a board's own host. Query values that hold another address are refused.
 */
export function pageKind(raw: string, board: BoardId): PageKind | null {
  const p = parse(raw);
  if (!p) return null;
  const b = BOARDS[board];
  if (!b || !b.hosts.includes(p.host)) return null;
  const clean = cleanPath(p.u.pathname);
  if (!clean) return null;
  const pathname = clean.path;
  for (const w of b.wallPages) {
    const hostOk = !w.host || p.host === w.host;
    const pathOk = !w.path || w.path.test(pathname);
    if (hostOk && pathOk) return "wall";
  }
  // A sign-in host (login.seek.com, secure.indeed.com) is only ever a wall, never a page a run uses.
  if (b.wallPages.some((w) => w.host && p.host === w.host)) return null;
  if (denied(p.u, clean.parts)) return null;
  if (b.searchPages.some((r) => r.test(pathname))) return "search";
  if (b.adPages.some((r) => r.test(pathname))) return "ad";
  return null;
}

/**
 * The address a run opens: rebuilt from the parsed parts (lower-case host without a trailing dot, path and query,
 * no fragment), and only when it is a search-results or job-ad page of the board. Null otherwise.
 */
export function canonicalAddress(raw: string, board: BoardId): string | null {
  const k = pageKind(raw, board);
  const p = parse(raw);
  if (!p || (k !== "search" && k !== "ad")) return null;
  return `https://${p.host}${p.u.pathname}${p.u.search}`;
}

/**
 * Indeed lists results through a click-tracking redirect (`/rc/clk?jk=<id>`, `/pagead/clk?jk=<id>`). A run never
 * follows a redirector; when the job's id is plain, it opens the ad's own page on the same host instead.
 */
export function directAddress(raw: string, board: BoardId): string {
  const p = parse(raw);
  if (!p || board !== "indeed") return raw;
  const jk = p.u.searchParams.get("jk") ?? "";
  if (/^\/(rc|pagead)\/clk\/?$/i.test(p.u.pathname) && /^[0-9a-f]{12,20}$/i.test(jk)) return `https://${p.host}/viewjob?jk=${jk}`;
  return raw;
}

/** Sign-in pages, on any board (LinkedIn's /checkpoint/lg/ and /checkpoint/rm/ are its login forms). */
const LOGIN_LANDING = /^\/(login|signin|sign-in|uas\/login|account\/login|auth|oauth|checkpoint\/(lg|rm))(\/|$)/i;
const AUTHWALL_LANDING = /^\/authwall(\/|$)/i;
/** Security and "is it you?" checks. */
const CHECK_LANDING = /^\/(checkpoint|challenge|captcha|security-check|verify)(\/|$)/i;

/**
 * Where a setup tab ended up, from the final address's host and path (the query is never read, so a sign-in
 * wall's "come back to" parameters can't change the answer). "elsewhere" when it isn't one of the board's hosts.
 */
export function landingPage(raw: string, board: BoardId): Exclude<SignInPage, "no_tab" | ""> {
  const p = parse(raw);
  const b = BOARDS[board];
  if (!p || !b || !b.hosts.includes(p.host)) return "elsewhere";
  const clean = cleanPath(p.u.pathname);
  const path = clean ? clean.path : p.u.pathname;
  if (AUTHWALL_LANDING.test(path)) return "authwall";
  if (LOGIN_LANDING.test(path)) return "login";
  if (CHECK_LANDING.test(path)) return "checkpoint";
  // A sign-in host (login.seek.com, secure.indeed.com) is the sign-in page whatever its path.
  if (b.wallPages.some((w) => w.host === p.host)) return "login";
  if (b.feedPages?.some((r) => r.test(path))) return "feed";
  return "board";
}

/** Controls only a signed-in person sees, on any board: account menus, avatars, sign out, notifications. */
const SIGNED_IN_ANY = /^(sign out|log out|logout|my account|account( menu| settings)?|(open )?(user|account|profile) menu|my profile|your profile|view profile|notifications?|avatar|photo of )\b|\baccount menu$/i;
/** Controls that mean "you're signed out". */
const SIGNED_OUT = /^(sign in|log in|login|sign up|join now|join|register|create (an )?account)( or (register|join|sign up))?$/i;
/** Roles that are controls; page text (headings, paragraphs) never counts. */
const CONTROL = /^\s*- (link|button|menuitem|img|tab) "((?:[^"\\]|\\.)*)"/;

/** The names of the controls in an interactive snapshot (`- button "Me" [ref=e3]`), unescaped and trimmed. */
function controlNames(snapshot: string): string[] {
  const out: string[] = [];
  for (const line of snapshot.split("\n")) {
    const m = CONTROL.exec(line);
    if (m) out.push(m[2]!.replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim());
  }
  return out;
}

/**
 * Reads a board page's controls (never its text): signed in when an account control is there, signed out when a
 * "Sign in" control is, unknown when neither (an empty or half-loaded page included). Strong signs (account menu,
 * Sign out, the board's own nav) win over a "Sign in to see more" link in the page; weak ones only count alone.
 */
/** True when a snapshot lists at least one control (an empty or still-loading page lists none). */
export function hasControls(snapshot: string): boolean {
  return controlNames(snapshot).length > 0 || /\[ref=e\d+/.test(snapshot);
}

export function signInState(board: BoardId, snapshot: string): BoardSignIn {
  return readControls(board, snapshot).state;
}

/**
 * signInState plus which kind of control decided it. The kind is a category ("account", "sign_in", "hint"),
 * never the control's name: an avatar's name can hold the person's own name.
 */
export function readControls(board: BoardId, snapshot: string): { state: BoardSignIn; matched: SignInMatch } {
  const names = controlNames(snapshot);
  if (!names.length && !hasControls(snapshot)) return { state: "unknown", matched: "no_controls" };
  const own = BOARDS[board].signedIn;
  if (names.some((n) => SIGNED_IN_ANY.test(n) || own.strong?.test(n))) return { state: "signed_in", matched: "account" };
  if (names.some((n) => SIGNED_OUT.test(n))) return { state: "signed_out", matched: "sign_in" };
  if (own.weak && names.some((n) => own.weak!.test(n))) return { state: "signed_in", matched: "hint" };
  return { state: "unknown", matched: "none" };
}

/** Keeps known ids, once each, in the registry's order. */
export function cleanBoards(ids: readonly string[]): BoardId[] {
  return BOARD_IDS.filter((id) => ids.includes(id));
}
