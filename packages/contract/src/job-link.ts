/**
 * "Add a job": a person pastes a job link, the ad's text, or drops a file, checks a preview, and saves it as a job.
 * Pure helpers shared by main and the renderer: where a link is read from (routeJobLink), one key per job ad for
 * finding duplicates (jobAdKey), the work-rights wording in an ad (scanWorkRights), and a first guess at the title,
 * company, place and pay from pasted text (guessFromText). Fetching and Chrome reading live in main only.
 */
import { BROWSABLE_BOARD_IDS, type BoardId } from "./chrome.js";
import { WR_LABELS, type WorkRightsLabel } from "./constants.js";
import { hostMatches, hostOf, JOB_BOARDS, jobBoardByHost } from "./job-boards.js";
import { arr, httpsUrl, obj, oneOf, str, type V } from "./validate.js";

/** Applicant systems whose public job API main reads with a plain fetch. */
export const ATS_IDS = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "workday"] as const;
export type AtsId = (typeof ATS_IDS)[number];

/**
 * How a link is read:
 * - "ats": main fetches the applicant system's public job data (no cookies, https only);
 * - "chrome": a job board that blocks scrapers, read in the person's own Chrome when Search in my Chrome is connected;
 * - "paste": anything else. Job sites aren't scraped from the app, so the person pastes the ad's text.
 */
export type LinkRoute =
  | { kind: "ats"; ats: AtsId; site: string }
  | { kind: "chrome"; board: BoardId; site: string }
  | { kind: "paste"; site: string };

/** Where a pasted link is read from, or null when it isn't an https link at all. */
export function routeJobLink(url: string): LinkRoute | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  const host = hostOf(u.toString()) ?? "";
  const board = jobBoardByHost(host);
  if (board && (ATS_IDS as readonly string[]).includes(board.id)) return { kind: "ats", ats: board.id as AtsId, site: board.name };
  if (board && (BROWSABLE_BOARD_IDS as readonly string[]).includes(board.id)) return { kind: "chrome", board: board.id as BoardId, site: board.name };
  return { kind: "paste", site: board?.name ?? "" };
}

const lower = (s: string) => s.toLowerCase();

/**
 * One key per job ad, so the same ad found twice (a search link with currentJobId, tracking parameters, a trailing
 * slash) is seen as the same job. Board and applicant-system ads key on their own ids; anything else on the address
 * without its fragment, tracking parameters and trailing slash. "" for text that isn't an address.
 */
export function jobAdKey(url: string): string {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const host = lower(u.hostname).replace(/\.$/, "");
  const board = jobBoardByHost(host)?.id ?? "";
  const path = u.pathname;
  let m: RegExpExecArray | null;
  switch (board) {
    case "seek": if ((m = /^\/job\/(\d+)/.exec(path))) return `seek:${m[1]}`; if (/^\d+$/.test(u.searchParams.get("jobId") ?? "")) return `seek:${u.searchParams.get("jobId")}`; break;
    case "linkedin": {
      if ((m = /^\/jobs\/view\/(?:[a-z0-9-]+-)?(\d+)/i.exec(path))) return `linkedin:${m[1]}`;
      const cur = u.searchParams.get("currentJobId") ?? "";
      if (/^\d+$/.test(cur)) return `linkedin:${cur}`;
      break;
    }
    case "indeed": { const jk = u.searchParams.get("jk") ?? u.searchParams.get("vjk") ?? ""; if (/^[0-9a-f]{12,20}$/i.test(jk)) return `indeed:${lower(jk)}`; break; }
    case "greenhouse": {
      const gh = /^\/([a-z0-9_-]+)\/jobs\/(\d+)/i.exec(path);
      if (gh) return `greenhouse:${lower(gh[1]!)}:${gh[2]}`;
      break;
    }
    case "lever": if ((m = /^\/([a-z0-9_.-]+)\/([0-9a-f-]{36})/i.exec(path))) return `lever:${lower(m[1]!)}:${lower(m[2]!)}`; break;
    case "ashby": if ((m = /^\/([^/]+)\/([0-9a-f-]{36})/i.exec(path))) return `ashby:${lower(decodeURIComponent(m[1]!))}:${lower(m[2]!)}`; break;
    case "workable": if ((m = /^\/([a-z0-9_-]+)\/j\/([a-z0-9]+)/i.exec(path))) return `workable:${lower(m[1]!)}:${lower(m[2]!)}`; break;
    case "smartrecruiters": if ((m = /^\/([^/]+)\/(\d+)/i.exec(path))) return `smartrecruiters:${lower(m[1]!)}:${m[2]}`; break;
    case "workday": if ((m = /_([A-Za-z0-9-]+)\/?$/.exec(path))) return `workday:${host}:${lower(m[1]!)}`; break;
  }
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|refid$|trk|trackingid$|source$|gh_src$|lever-source)/i.test(k)) u.searchParams.delete(k);
  return `${u.protocol}//${host}${path.replace(/\/+$/, "")}${u.search}`;
}

/** The ad's own page for a board link that names one ad (a LinkedIn search link with currentJobId), else the link. */
export function adAddress(url: string): string {
  const key = jobAdKey(url);
  if (key.startsWith("linkedin:")) return `https://www.linkedin.com/jobs/view/${key.slice(9)}/`;
  if (key.startsWith("seek:")) {
    let host = "www.seek.com.au";
    try { const h = new URL(url).hostname.toLowerCase(); if (h === "au.seek.com" || h === "www.seek.com.au" || h === "seek.com.au") host = h; } catch { /* default */ }
    return `https://${host}/job/${key.slice(5)}`;
  }
  return url.trim();
}

// ---- where a pasted link is from ------------------------------------------------------------------------

/**
 * Where a pasted job link is hosted:
 * - "board": a known job board or applicant system (exact host or a dot-bounded subdomain);
 * - "company": the host names the company ("careers.acme.com.au" for Acme Corp), or is its saved website;
 * - "lookalike": not a known board, but part of the host is a board's name or one letter off it ("seek-jobs.com.au",
 *   "linkedin.com.example.net", "lnkedin.com"): a common trick in fake job ads;
 * - "unknown": anything else, or a link that doesn't parse ("" host).
 */
export type HostKind = "board" | "company" | "lookalike" | "unknown";
export interface HostCheck { kind: HostKind; host: string; board?: { name: string; domain: string } }

/** Words that say nothing about who a company is. */
const COMPANY_FILLER = new Set(["the", "and", "of", "pty", "ltd", "limited", "inc", "llc", "plc", "corp", "corporation", "co", "company", "group", "holdings", "australia", "australian", "services", "solutions", "technologies", "technology", "labs", "global", "international"]);
/** Host parts that are never a name: www, country and generic endings. */
const HOST_FILLER = new Set(["www", "com", "net", "org", "gov", "edu", "co", "io", "au", "nz", "uk", "jobs", "careers", "apply", "job", "career", "work", "hire"]);

/** At most one letter added, dropped or changed. */
function oneOff(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Each board's name as it appears in its hosts ("seek", "linkedin", "myworkdayjobs"), with the board. */
const BOARD_MARKS: { mark: string; name: string; domain: string }[] = JOB_BOARDS.flatMap((b) =>
  b.hostDomains.map((d) => ({ mark: d.split(".")[0]!, name: b.name, domain: d })))
  // "angel" (angel.co) is an everyday word, so it never counts as a board's name.
  .filter((m, i, all) => m.mark.length >= 4 && m.mark !== "angel" && all.findIndex((x) => x.mark === m.mark) === i);

/** A host part that imitates a board: the board's name, the name with a word stuck on, or a long name one letter off. */
function imitates(part: string, mark: string): boolean {
  if (part === mark) return true;
  if (part.startsWith(mark) && /^(jobs?|careers?|au|nz|hire|hiring|work|apply|official|portal|online)$/.test(part.slice(mark.length))) return true;
  if (part.endsWith(mark) && /^(my|au|nz|jobs?|careers?|get|go|apply)$/.test(part.slice(0, part.length - mark.length))) return true;
  return mark.length >= 6 && part.length >= 5 && oneOff(part, mark);
}

/** The words of a company name that identify it ("Acme Corp" → ["acme"]), and the name run together ("examplelabs"). */
function companyMarks(name: string): string[] {
  const words = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const own = words.filter((w) => !COMPANY_FILLER.has(w));
  const joined = words.filter((w) => !["pty", "ltd", "limited", "inc", "llc", "plc"].includes(w)).join("");
  return [...new Set([joined, own.join(""), ...own.filter((w) => w.length >= 4)])].filter((w) => w.length >= 3);
}

/**
 * Where a pasted job link is hosted (see HostKind). `company` is the ad's company name and `website` its saved
 * website, either "" when unknown. Never fetches anything.
 */
export function classifyJobHost(url: string, company = "", website = ""): HostCheck {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return { kind: "unknown", host: "" }; }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { kind: "unknown", host: "" };
  if (u.username || u.password) {
    // "https://seek.com.au@example.net/" goes to example.net, whatever comes before the @.
    const fake = BOARD_MARKS.find((m) => decodeURIComponent(u.username).toLowerCase().includes(m.mark));
    return fake ? { kind: "lookalike", host, board: { name: fake.name, domain: fake.domain } } : { kind: "unknown", host };
  }
  if (jobBoardByHost(host)) return { kind: "board", host };
  const site = website ? hostOf(/^https?:\/\//i.test(website) ? website : `https://${website}`) : null;
  if (site && hostMatches(host, site.replace(/^www\./, ""))) return { kind: "company", host };
  const parts = host.split(/[.-]/).filter(Boolean);
  const fake = BOARD_MARKS.find((m) => parts.some((p) => imitates(p, m.mark)));
  if (fake) return { kind: "lookalike", host, board: { name: fake.name, domain: fake.domain } };
  const named = parts.filter((p) => !HOST_FILLER.has(p));
  const marks = companyMarks(company);
  if (named.some((p) => marks.some((m) => p === m || (m.length >= 4 && p.startsWith(m))))) return { kind: "company", host };
  return { kind: "unknown", host };
}

/** The plain warning Add job shows for a link's host, or "" for a board or the company's own site. Never a refusal. */
export function jobHostWarning(check: HostCheck, company = ""): string {
  const who = company.trim();
  if (check.kind === "lookalike" && check.board) {
    return `This link is on ${check.host}, which looks like ${check.board.name} but isn't ${check.board.name}'s own address (${check.board.domain}). Fake job ads often use look-alike addresses, so check it before you apply or share any details.`;
  }
  if (check.kind === "unknown" && check.host) {
    return `This link is on ${check.host}, which isn't a job board we know or ${who ? `${who}'s` : "the company's"} own site. Check the ad is real before you apply or share any details.`;
  }
  return "";
}

// ---- work rights in the ad --------------------------------------------------------------------------------

/** EEO and boilerplate lines say nothing about this role's work rights. */
const EEO = /\b(regardless of|without regard to|equal (employment )?opportunit|discriminat|all (qualified )?applicants will receive)/i;
const NEGATED = /\b(no|not|unable|cannot|can't|won't|will not|don't|do not|isn't|without)\b[^.;\n]{0,40}$/i;
const SPONSOR = /\b((visa )?sponsorship (is |will be |can be )?(available|offered|provided|considered|possible)|(we|will|can|happy to|able to|open to) (offer |provide )?(visa )?sponsor(ship)?\b|sponsor(ship)? (is )?available|482 (visa )?(sponsorship )?(is )?(available|considered|offered)|sponsor the right (candidate|person))/i;
const CITIZEN = /\b((australian |new zealand |nz )?citizens?( or| and|\/|,)? (australian )?(permanent residents?|pr)\b|must (be|hold|have) (an? )?(australian )?(citizen(ship)?|permanent residen(t|cy))|full (australian )?(working|work) rights|unrestricted (working|work) rights|(permanent|ongoing) (right|rights) to work|right to work in australia without (restriction|sponsorship)|\b(no|not|unable to|cannot|can't|won't|don't|doesn't)\b(\s+\w+){0,3}\s+(visa\s+)?sponsor(ship|s)?\b|sponsorship (is )?not (available|offered|provided))/i;
const CLEARANCE = /\b(baseline (security )?clearance|nv ?1|nv ?2|negative vetting|security clearance|agsva|ts\/sci|top secret clearance)\b/i;
const VISA_OK = /\b(working holiday|visa holders? (are )?(welcome|encouraged|considered)|valid (work(ing)? )?visa|temporary visa holders?)\b/i;

function sentences(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 3 && !EEO.test(s));
}

/** The sentence a match came from, kept short. */
const quote = (s: string) => (s.length > 240 ? `${s.slice(0, 237).trimEnd()}…` : s);

/**
 * What the ad says about work rights: the label and the sentences that say it (at most three). Security clearance
 * first, then citizens or PR only, then sponsorship offered (a negated "sponsorship" counts as citizens or PR),
 * then open to visa holders. EEO lines ("regardless of citizenship") never count. "silent" when nothing matches.
 */
export function scanWorkRights(text: string): { label: WorkRightsLabel; quotes: string[] } {
  const hits: Record<WorkRightsLabel, string[]> = { clearance: [], citizen_pr_only: [], sponsorship_offered: [], visa_ok: [], silent: [] };
  for (const s of sentences(text.slice(0, 200_000))) {
    if (CLEARANCE.test(s)) hits.clearance.push(s);
    if (CITIZEN.test(s)) { hits.citizen_pr_only.push(s); continue; }
    const sp = SPONSOR.exec(s);
    if (sp && !NEGATED.test(s.slice(0, sp.index))) hits.sponsorship_offered.push(s);
    else if (VISA_OK.test(s)) hits.visa_ok.push(s);
  }
  const order: WorkRightsLabel[] = ["clearance", "citizen_pr_only", "sponsorship_offered", "visa_ok"];
  const label = order.find((l) => hits[l].length) ?? "silent";
  return { label, quotes: label === "silent" ? [] : hits[label].slice(0, 3).map(quote) };
}

// ---- a first guess from pasted text ------------------------------------------------------------------------

export interface TextGuess { title: string; company: string; location: string; work_mode: string; salary: string; job_type: string }

const FIELD = (names: string) => new RegExp(`^\\s*(?:${names})\\s*[:\\-–]\\s*(.{1,160})$`, "im");
const PAY_UNIT = String.raw`(?:\s?(?:\+\s?super|per (?:year|annum|hour|day)|p\.?\s?a\.?|\/\s?(?:yr|year|hr|hour|day)|an hour|a year))*`;
const SALARY = new RegExp(String.raw`(?:A?\$|AUD\s?)\s?\d[\d,.]*\s?[kK]?${PAY_UNIT}(?:\s?(?:-|–|to)\s?(?:A?\$|AUD\s?)?\s?\d[\d,.]*\s?[kK]?)?${PAY_UNIT}`, "i");
/** Lines about the site's own offers ("Try Premium for A$0"), never the job's pay. */
const NOT_PAY = /\b(premium|free trial|month free|subscription|try .{0,30} for|cancel anytime)\b/i;

/**
 * The first real pay amount or range in the ad: never a zero ("A$0") and never a line about the site's own offers.
 * "" when the ad states no pay.
 */
export function findSalary(text: string): string {
  for (const l of text.split("\n")) {
    if (NOT_PAY.test(l)) continue;
    const g = new RegExp(SALARY.source, "gi");
    for (let m = g.exec(l); m; m = g.exec(l)) {
      if (!m[0]) { g.lastIndex++; continue; }
      if (/[1-9]/.test(m[0])) return clip(m[0], 120);
    }
  }
  return "";
}
const MODE = /\b(fully remote|remote|hybrid|on-?site|in office|work from home)\b/i;
const TYPE = /\b(full[- ]time|part[- ]time|contract|casual|temporary|permanent|fixed[- ]term|internship)\b/i;
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n).trim();

/**
 * A first guess at the ad's fields from its text: labelled lines ("Location: Sydney") first, then the first short
 * line as the title and "<title> at <company>" or a line after it as the company. Everything is shown for the person
 * to check and edit before anything is saved; a guess is never treated as fact.
 */
export function guessFromText(text: string): TextGuess {
  const t = text.replace(/\r\n?/g, "\n").slice(0, 200_000);
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const field = (names: string) => clip(FIELD(names).exec(t)?.[1] ?? "", 160);
  let title = field("job title|title|role|position");
  let company = field("company|employer|organisation|organization|hiring company|advertiser");
  const location = field("location|where|based in|city");
  if (!title) {
    const first = lines.find((l) => l.length >= 3 && l.length <= 120 && !/^(https?:|about|job description|description)\b/i.test(l)) ?? "";
    const at = /^(.{3,100}?)\s+(?:at|@|-|–|\|)\s+(.{2,80})$/.exec(first);
    if (at && !company) { title = clip(at[1]!, 200); company = clip(at[2]!, 120); } else title = clip(first, 200);
  }
  if (!company) {
    const i = lines.findIndex((l) => clip(l, 200) === title);
    const next = i >= 0 ? lines[i + 1] ?? "" : "";
    if (next && next.length <= 80 && !SALARY.test(next) && !MODE.test(next) && !/[.!?]$/.test(next)) company = clip(next, 120);
  }
  const salary = findSalary(field("salary|pay|remuneration|compensation|package")) || findSalary(t);
  const mode = MODE.exec(field("work mode|workplace|work type|arrangement") || t)?.[1] ?? "";
  const work_mode = /remote|from home/i.test(mode) ? "Remote" : /hybrid/i.test(mode) ? "Hybrid" : mode ? "On-site" : "";
  const type = TYPE.exec(field("job type|employment type|work type") || t)?.[1] ?? "";
  const job_type = type ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase().replace(/[- ]/, " ") : "";
  return { title, company, location, work_mode, salary, job_type };
}

// ---- bridge types ------------------------------------------------------------------------------------------

/** The longest ad text kept, in characters (main also caps it at 200 KB). */
export const MAX_AD_CHARS = 200_000;

/** What the preview shows and the person can edit before saving. */
export interface JobDraft {
  /** The ad's address ("" for pasted text without a link). */
  url: string;
  company: string; title: string; location: string; work_mode: string; job_type: string; salary: string; posted: string;
  /** How to apply (an address or an email), when the ad says. */
  apply_via: string;
  /** Where it came from, by name ("SEEK", "Greenhouse"), or "" for pasted text. */
  source_site: string;
  /** The ad's text. Saved as the job's ad. */
  jd_text: string;
  /** What the ad says about work rights, and the sentences that say it. */
  rights: WorkRightsLabel;
  rights_quotes: string[];
}

export interface JobDuplicate { company_slug: string; id: string; title: string; company_name: string; by: "link" | "title" }

export interface JobPreview {
  draft: JobDraft;
  /** How the ad was read: an applicant system's public data, the person's Chrome, pasted text, or a dropped file. */
  via: "ats" | "chrome" | "text" | "file";
  /** Already one of the person's jobs (same ad, or same company and title). */
  duplicate: JobDuplicate | null;
  /** Plain warnings about the place or the pay (outside the person's search), shown above Save. Never a refusal. */
  warnings: string[];
}

/**
 * Why a link couldn't be read here, with the one thing to do next:
 * - "paste": this site isn't read by the app; paste the ad's text;
 * - "connect_chrome" / "set_up_chrome": the board is read in the person's Chrome, which isn't connected / set up;
 * - "sign_in" / "check": the board showed a sign-in page or a security check in that tab; nothing was read;
 * - "busy": a search is running in Chrome;
 * - "not_found": the address isn't a single job ad, or the ad is gone;
 * - "failed": the site didn't answer in time or sent something else.
 */
export const PREVIEW_NEEDS = ["paste", "connect_chrome", "set_up_chrome", "sign_in", "check", "busy", "not_found", "failed"] as const;
export type PreviewNeed = (typeof PREVIEW_NEEDS)[number];
export type JobPreviewResult = { ok: true; preview: JobPreview } | { ok: false; need: PreviewNeed; text: string; site: string };

export interface JobAdded { company_slug: string; id: string; created: boolean; title: string; company_name: string }

/** What "Add a job" saves: a person's own find, never refused for its place or pay. */
export const JOB_ADD_STATUSES = ["Found", "Saved"] as const;
export type JobAddStatus = (typeof JOB_ADD_STATUSES)[number];

const line = (min: number, max: number) => str({ min, max });
const maybeUrl: V<string> = (v, at) => (v === "" ? "" : httpsUrl(v, at));
export const jobDraftArg: V<JobDraft> = obj({
  url: maybeUrl, company: line(1, 120), title: line(1, 200), location: line(0, 120), work_mode: line(0, 40), job_type: line(0, 40),
  salary: line(0, 120), posted: line(0, 40), apply_via: line(0, 300), source_site: line(0, 80),
  jd_text: str({ max: MAX_AD_CHARS, multiline: true }), rights: oneOf(WR_LABELS), rights_quotes: arr(str({ max: 300 }), { max: 5 }),
}) as V<JobDraft>;
export const jobPreviewInput: V<{ url?: string; text?: string }> = obj({
  url: (v, at) => (v === undefined ? undefined : maybeUrl(v, at)),
  text: (v, at) => (v === undefined ? undefined : str({ max: MAX_AD_CHARS, multiline: true })(v, at)),
}) as V<{ url?: string; text?: string }>;
