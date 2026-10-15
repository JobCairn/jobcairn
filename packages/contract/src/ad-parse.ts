/**
 * Reading a job ad's fields from a board's page text. Each big board lays its ad header out its own way:
 * - LinkedIn: company, title, then "Place · 1 week ago · 44 people clicked apply", then pills ("On-site", "Full-time");
 * - SEEK: title, advertiser, place (with "(Hybrid)" when stated), classification, work type, pay, "Posted 3d ago";
 * - Indeed: "<title> - job post", company, rating, place, work setting, "pay - job type".
 * A page title ("Title | Company | LinkedIn") or a JobPosting JSON-LD block, when the read has one, beats the loose
 * text. Anything a board reader can't place falls back to the generic guess (guessFromText). A field the ad doesn't
 * state stays "": pay is never "A$0", and work mode is only set when the ad says Remote, Hybrid or On-site.
 */
import { findSalary, guessFromText, type TextGuess } from "./job-link.js";

export interface AdGuess extends TextGuess {
  /** The day the ad was posted (YYYY-MM-DD), from "3 days ago" and the like; "" when the ad doesn't say. */
  posted: string;
}

/** Extra signals from the page, when the read has them. */
export interface AdMeta {
  /** The page's <title>, for example "AI Engineer | Acme Corp | LinkedIn". */
  pageTitle?: string;
  /** A schema.org JobPosting (parsed JSON-LD), or an array that holds one. */
  jsonLd?: unknown;
}

type Fields = Partial<AdGuess>;
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n).trim();

// ---- shared pieces ------------------------------------------------------------------------------------------

const MODE_LINE = /^(?:fully remote|remote|hybrid|on-?site|in-person|in office|work from home)(?: work)?$/i;
const TYPE_LINE = /^(full[- ]time|part[- ]time|contract(?:\/temp)?|casual(?:\/vacation)?|temporary|permanent|fixed[- ]term|internship)$/i;
const AU_PLACE = /\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT|New South Wales|Victoria|Queensland|Western Australia|South Australia|Tasmania|Australian Capital Territory|Northern Territory|Australia|New Zealand)\b/;
const AGO = /\b(just posted|just now|today|yesterday|(\d+|an?|one)\s*\+?\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|mo)\s+ago)\b/i;

/** "Remote" / "Hybrid" / "On-site" from a stated mode, else "". */
export function modeWord(s: string): string {
  if (/remote|from home|telecommute/i.test(s)) return "Remote";
  if (/hybrid/i.test(s)) return "Hybrid";
  if (/on-?site|in-person|in office/i.test(s)) return "On-site";
  return "";
}
const typeWord = (s: string) => {
  const t = s.replace(/\/.*$/, "").replace(/[-_]/g, " ").toLowerCase().trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
};
/** "Location: Sampletown NSW" → "Sampletown NSW". */
const unlabel = (l: string) => l.replace(/^(location|where|based in|city)\s*[:\-–]\s*/i, "");
const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The posting day for "3 days ago", "1 week ago", "2h ago", "Just posted" or "Yesterday", counted back from now. */
export function postedFrom(text: string, now: Date): string {
  const m = AGO.exec(text);
  if (!m) return "";
  const word = m[1]!.toLowerCase();
  const d = new Date(now.getTime());
  if (/^(just|today)/.test(word)) return day(d);
  if (word === "yesterday") { d.setDate(d.getDate() - 1); return day(d); }
  const n = /^\d+$/.test(m[2]!) ? Number(m[2]) : 1;
  const unit = m[3]!.toLowerCase();
  if (/^(mo|months?)$/.test(unit)) d.setMonth(d.getMonth() - n);
  else if (/^(w|weeks?)$/.test(unit)) d.setDate(d.getDate() - 7 * n);
  else if (/^(d|days?)$/.test(unit)) d.setDate(d.getDate() - n);
  else if (/^(h|hours?|hrs?)$/.test(unit)) d.setHours(d.getHours() - n);
  else d.setMinutes(d.getMinutes() - n);
  return day(d);
}

/** Where the ad itself ends on a board page: the lists of other jobs and the company blurb come after it. */
const PAGE_TAIL = /^(similar jobs|more jobs|people also viewed|jobs you may be interested in|explore similar jobs|people you can reach out to|looking for talent\?|related searches)$/i;
function adOnly(lines: string[]): string[] {
  const i = lines.findIndex((l) => PAGE_TAIL.test(l));
  return i > 0 ? lines.slice(0, i) : lines;
}

/** A board ad's header: the lines before the ad's own text starts ("About the job"), or its first 12 lines. */
const AD_TEXT_START = /^(about the job|job description|full job description|about the role|description|about us|the role)$/i;
function header(lines: string[]): string[] {
  const i = lines.findIndex((l) => AD_TEXT_START.test(l));
  return lines.slice(0, i > 0 ? Math.min(i, 30) : 12);
}

// ---- page title and JSON-LD --------------------------------------------------------------------------------

/** "AI Engineer | Acme Corp | LinkedIn", "Acme Corp hiring AI Engineer in Sampletown | LinkedIn", "AI Engineer Job in Sampletown NSW - SEEK". */
export function fromPageTitle(title: string): Fields {
  const t = clip(title, 400).replace(/^\(\d+\)\s*/, "");
  let m = /^(.+?) hiring (.+?) in (.+?) \| LinkedIn$/i.exec(t);
  if (m) return { company: m[1]!, title: m[2]!, location: m[3]! };
  m = /^(.+?) \| (.+?) \| LinkedIn$/i.exec(t);
  if (m) return { title: m[1]!, company: m[2]! };
  m = /^(.+?) Job in (.+?) - SEEK$/i.exec(t);
  if (m) return { title: m[1]!, location: m[2]! };
  m = /^(.+?) - (.+?) - (.+?) - Indeed\.com$/i.exec(t);
  if (m) return { title: m[1]!, company: m[2]!, location: m[3]! };
  return {};
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" ? clip(v, 200) : typeof v === "number" ? String(v) : "");

function jobPosting(v: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null;
  if (Array.isArray(v)) { for (const x of v) { const j = jobPosting(x, depth + 1); if (j) return j; } return null; }
  const o = rec(v);
  if (!o) return null;
  const type = o["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return o;
  return jobPosting(o["@graph"], depth + 1);
}

/** The fields a schema.org JobPosting states. */
export function fromJsonLd(v: unknown): Fields {
  const j = jobPosting(v);
  if (!j) return {};
  const out: Fields = {};
  out.title = str(j.title);
  const org = rec(j.hiringOrganization);
  out.company = org ? str(org.name) : str(j.hiringOrganization);
  const locs = Array.isArray(j.jobLocation) ? j.jobLocation : [j.jobLocation];
  const addr = rec(rec(locs[0])?.address);
  if (addr) out.location = [str(addr.addressLocality), str(addr.addressRegion)].filter(Boolean).join(", ");
  if (str(j.jobLocationType).toUpperCase() === "TELECOMMUTE") out.work_mode = "Remote";
  const et = Array.isArray(j.employmentType) ? str(j.employmentType[0]) : str(j.employmentType);
  if (et) out.job_type = typeWord(et);
  const pay = rec(j.baseSalary);
  const val = rec(pay?.value);
  const lo = Number(val?.minValue ?? val?.value ?? 0);
  const hi = Number(val?.maxValue ?? 0);
  if (lo > 0 || hi > 0) {
    const cur = str(pay?.currency) || "AUD";
    const sym = cur === "AUD" ? "$" : `${cur} `;
    const n = (x: number) => `${sym}${x.toLocaleString("en-AU")}`;
    const unit = str(val?.unitText).toLowerCase();
    const per = unit === "year" ? " per year" : unit === "hour" ? " per hour" : unit === "day" ? " per day" : unit === "month" ? " per month" : "";
    out.salary = (lo > 0 && hi > lo ? `${n(lo)} – ${n(hi)}` : n(lo || hi)) + per;
  }
  const dp = /^\d{4}-\d{2}-\d{2}/.exec(str(j.datePosted));
  if (dp) out.posted = dp[0];
  return out;
}

// ---- LinkedIn ----------------------------------------------------------------------------------------------

/** "Place · 1 week ago · 44 people clicked apply" (or "· Over 100 applicants"). */
const LI_META = /\s·\s.*(\bago\b|applicants?|clicked apply|just posted)/i;
const LI_NOISE = /^(share|show more options|save|saved|apply|easy apply|apply now|promoted|promoted by hirer|actively reviewing applicants|responses managed off linkedin|see how you compare to \d+ applicants?.*|follow|following|message|show more|show less|.+ logo|try premium.*|retry premium.*|\d+ (school|company) alumni.*|you may be a fit.*|matches your job preferences.*|on-site|hybrid|remote)$/i;

/** True when the text has LinkedIn's "Place · posted · applicants" header line. */
export const looksLikeLinkedIn = (text: string) => text.split("\n").slice(0, 40).some((l) => LI_META.test(l.trim()));

function linkedIn(lines: string[], now: Date): Fields {
  const at = lines.findIndex((l, i) => i < 40 && LI_META.test(l));
  if (at < 0) return {};
  const out: Fields = {};
  const parts = lines[at]!.split(/\s+·\s+/);
  if (parts[0] && !AGO.test(parts[0]) && !/applicants?|clicked apply/i.test(parts[0])) out.location = clip(parts[0], 120);
  out.posted = postedFrom(lines[at]!, now);
  const above = lines.slice(0, at).filter((l) => !LI_NOISE.test(l) && l.length <= 160).reverse();
  if (above[0]) out.title = clip(above[0], 200);
  if (above[1]) out.company = clip(above[1], 120);
  else {
    const logo = lines.slice(0, at).map((l) => /^(.+) logo$/i.exec(l)?.[1]).find(Boolean);
    if (logo) out.company = clip(logo, 120);
  }
  // The pills under the header: "On-site", "Full-time", a pay range. They stop at the ad's own text.
  const end = lines.findIndex((l, i) => i > at && /^(about the job|job description|about the role)$/i.test(l));
  const head = lines.slice(at + 1, end > at ? end : at + 12);
  for (const l of head) {
    for (const bit of l.split(/\s{2,}|\s·\s/)) {
      if (!out.work_mode && MODE_LINE.test(bit.trim())) out.work_mode = modeWord(bit);
      const t = TYPE_LINE.exec(bit.trim());
      if (!out.job_type && t) out.job_type = typeWord(t[1]!);
    }
    const m = /matches your job preferences, workplace type is (on-site|hybrid|remote)/i.exec(l);
    if (!out.work_mode && m) out.work_mode = modeWord(m[1]!);
  }
  return out;
}

// ---- SEEK --------------------------------------------------------------------------------------------------

const SEEK_NOISE = /^(view all jobs|quick apply|apply|save|report this job ad|be careful.*|add expected salary.*|this job is no longer advertised.*|\d(\.\d)?\s*★?|★.*|·?\s*\d+ reviews?|reviews?|more jobs from this company)$/i;

function seek(lines: string[], now: Date): Fields {
  const out: Fields = {};
  const top = header(lines).filter((l) => !SEEK_NOISE.test(l));
  if (top[0]) out.title = clip(top[0], 200);
  if (top[1] && !AU_PLACE.test(top[1]) && !findSalary(top[1])) out.company = clip(top[1], 120);
  for (const l of top.slice(out.company ? 2 : 1, 12)) {
    const paren = /^(.+?)\s*\((remote|hybrid|on-?site)\)$/i.exec(l);
    if (!out.location && (paren || (AU_PLACE.test(l) && l.length <= 80 && !/\(.*&.*\)/.test(l)))) {
      out.location = clip(unlabel(paren ? paren[1]! : l), 120);
      if (paren) out.work_mode = modeWord(paren[2]!);
      continue;
    }
    if (!out.work_mode && MODE_LINE.test(l)) out.work_mode = modeWord(l);
    const t = TYPE_LINE.exec(l);
    if (!out.job_type && t) out.job_type = typeWord(t[1]!);
    if (!out.salary) { const s = findSalary(l); if (s) out.salary = s; }
  }
  const p = lines.slice(0, 40).find((l) => /^(posted|listed)\b/i.test(l) && AGO.test(l));
  if (p) out.posted = postedFrom(p, now);
  return out;
}

// ---- Indeed ------------------------------------------------------------------------------------------------

const INDEED_NOISE = /^(\d(\.\d)?( out of 5 stars?)?|★.*|\d+ reviews?|apply now|apply on company site|save|not interested|report job|easily apply|responsive employer|urgently hiring|hiring multiple candidates|profile insights.*|job details)$/i;

function indeed(lines: string[], now: Date): Fields {
  const out: Fields = {};
  const top = header(lines).filter((l) => !INDEED_NOISE.test(l));
  if (top[0]) out.title = clip(top[0].replace(/\s+-\s+job post$/i, ""), 200);
  if (top[1] && !AU_PLACE.test(top[1]) && !findSalary(top[1])) out.company = clip(top[1], 120);
  for (const l of top.slice(out.company ? 2 : 1, 10)) {
    if (!out.work_mode && MODE_LINE.test(l)) { out.work_mode = modeWord(l); continue; }
    const s = findSalary(l);
    if (s) { if (!out.salary) out.salary = s; }
    for (const bit of l.split(/\s+-\s+/)) {
      const t = TYPE_LINE.exec(bit.trim());
      if (!out.job_type && t) out.job_type = typeWord(t[1]!);
    }
    if (!out.location && !s && !TYPE_LINE.test(l) && (AU_PLACE.test(l) || /^[A-Z][\w .'-]+(,\s*[A-Z][\w .'-]+)?( \d{4})?$/.test(l)) && l.length <= 80) out.location = clip(unlabel(l), 120);
  }
  // "Job details" lists the same facts under their own headings, one value per line.
  const under = (h: RegExp) => { const i = lines.findIndex((l) => h.test(l)); return i >= 0 ? lines[i + 1] ?? "" : ""; };
  if (!out.salary) out.salary = findSalary(under(/^pay$/i));
  if (!out.job_type) { const t = TYPE_LINE.exec(under(/^job type$/i)); if (t) out.job_type = typeWord(t[1]!); }
  const p = lines.slice(0, 60).find((l) => /^(posted|active|just posted|today)\b/i.test(l) && AGO.test(l));
  if (p) out.posted = postedFrom(p, now);
  return out;
}

// ---- putting it together -----------------------------------------------------------------------------------

/** "linkedin" / "seek" / "indeed" from a board id or name ("LinkedIn", "SEEK"), else "". */
function boardOf(site: string): string {
  const s = site.trim().toLowerCase();
  return s === "linkedin" || s === "seek" || s === "indeed" ? s : "";
}

/**
 * The ad's fields from its text, read the way the ad's board lays it out. Order of trust, field by field: JSON-LD,
 * then the page title, then the board's own layout, then the generic guess. The board comes from `site` (the board
 * the link pointed at); text with LinkedIn's header line is read as LinkedIn even when pasted without a link.
 */
export function guessFromAd(text: string, o: { site?: string; now?: Date; meta?: AdMeta } = {}): AdGuess {
  const now = o.now ?? new Date();
  const t = text.replace(/\r\n?/g, "\n").slice(0, 200_000);
  const lines = adOnly(t.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean));
  const body = lines.join("\n");
  let board = boardOf(o.site ?? "");
  if (!board && looksLikeLinkedIn(t)) board = "linkedin";
  const fromBoard = board === "linkedin" ? linkedIn(lines, now) : board === "seek" ? seek(lines, now) : board === "indeed" ? indeed(lines, now) : {};
  // On a board page the generic guess only looks at the header: "remote teams", "contract negotiations" or a
  // "$500 learning budget" in the description are not the job's mode, type or pay. Nor is "Label: value" the header's
  // layout, so its title and company guess would read the wrong lines.
  const generic: AdGuess = { ...guessFromText(board ? header(lines).join("\n") : body), posted: "" };
  if (board) { generic.title = ""; generic.company = ""; }
  const layers: Fields[] = [o.meta?.jsonLd ? fromJsonLd(o.meta.jsonLd) : {}, o.meta?.pageTitle ? fromPageTitle(o.meta.pageTitle) : {}, fromBoard, generic];
  const pick = (k: keyof AdGuess) => layers.map((l) => l[k]?.trim() ?? "").find(Boolean) ?? "";
  const out: AdGuess = {
    title: clip(pick("title"), 200), company: clip(pick("company"), 120), location: clip(pick("location"), 120),
    work_mode: pick("work_mode"), salary: pick("salary"), job_type: pick("job_type"), posted: pick("posted"),
  };
  // The generic guess put an empty-handed board ad's first lines in title and company; a board read never swaps them.
  if (board && !out.title && !out.company) { const g = guessFromText(body); out.title = g.title; out.company = g.company; }
  return out;
}
