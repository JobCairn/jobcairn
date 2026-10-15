/**
 * Applicant systems' public job data (main only). For a pasted link, `atsRequest` reads the ids out of the address
 * and builds the system's own public API address on a fixed host; the pasted address itself is never fetched.
 * `parseAts` turns the answer into the preview's fields. The answer shapes follow each system's public docs; every
 * field is read defensively (a missing or odd field is just left empty for the person to fill in).
 */
import { type AtsId, type JobDraft } from "@careeros/contract";
import { htmlToText } from "./html.js";

export interface AtsRequest { ats: AtsId; api: string; /** Ids from the address, for systems whose answer lists more than one job. */ want: string; /** The employer's id in the address, as a fallback name. */ org: string }

const seg = (s: string) => { try { return decodeURIComponent(s); } catch { return ""; } };
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The API address for a pasted applicant-system link, or null when the link isn't one job ad. */
export function atsRequest(ats: AtsId, url: string): AtsRequest | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean).map(seg);
  switch (ats) {
    case "greenhouse": {
      let board = "", id = "";
      if (parts[0] === "embed" && parts[1] === "job_app") { board = u.searchParams.get("for") ?? ""; id = u.searchParams.get("token") ?? ""; }
      else if (parts[1] === "jobs") { board = parts[0] ?? ""; id = parts[2] ?? ""; }
      if (!SAFE.test(board) || !/^\d{1,20}$/.test(id)) return null;
      const api = host.includes(".eu.") ? "boards-api.eu.greenhouse.io" : "boards-api.greenhouse.io";
      return { ats, api: `https://${api}/v1/boards/${board}/jobs/${id}?pay_transparency=true`, want: id, org: board };
    }
    case "lever": {
      const [org = "", id = ""] = parts;
      if (!SAFE.test(org) || !UUID.test(id)) return null;
      const api = host.includes(".eu.") ? "api.eu.lever.co" : "api.lever.co";
      return { ats, api: `https://${api}/v0/postings/${org}/${id}`, want: id, org };
    }
    case "ashby": {
      const [org = "", id = ""] = parts;
      if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,99}$/.test(org) || !UUID.test(id)) return null;
      return { ats, api: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`, want: id.toLowerCase(), org };
    }
    case "workable": {
      const [org = "", j = "", code = ""] = parts;
      if (j !== "j" || !SAFE.test(org) || !/^[A-Za-z0-9]{4,20}$/.test(code)) return null;
      return { ats, api: `https://apply.workable.com/api/v2/accounts/${org}/jobs/${code}`, want: code, org };
    }
    case "smartrecruiters": {
      const [org = "", posting = ""] = parts;
      const id = /^(\d{6,20})/.exec(posting)?.[1] ?? "";
      if (!SAFE.test(org) || !id) return null;
      return { ats, api: `https://api.smartrecruiters.com/v1/companies/${org}/postings/${id}`, want: id, org };
    }
    case "workday": {
      // <tenant>.wd<N>.myworkdayjobs.com/[<locale>/]<site>/job/<location>/<title>_<id>
      const m = /^([a-z0-9-]+)\.wd\d{1,3}\.myworkdayjobs\.com$/.exec(host);
      if (!m) return null;
      const rest = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "") ? parts.slice(1) : parts;
      const i = rest.indexOf("job");
      const site = rest[0] ?? "";
      if (i !== 1 || !SAFE.test(site) || rest.length < 3 || rest.slice(2).some((p) => !p || /[/\\]/.test(p) || p === "..")) return null;
      const path = rest.slice(2).map(encodeURIComponent).join("/");
      return { ats, api: `https://${host}/wday/cxs/${m[1]}/${site}/job/${path}`, want: rest.at(-1) ?? "", org: m[1]! };
    }
  }
}

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const s = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** "acme-corp" → "Acme Corp": a stand-in employer name from the address, for the person to correct. */
export function nameFromSlug(slug: string): string {
  return slug.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 120);
}

const MODES: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site", on_site: "On-site", "on-site": "On-site", office: "On-site", in_office: "On-site" };
const mode = (v: string) => MODES[v.toLowerCase().replace(/\s+/g, "_")] ?? "";
const words = (v: string) => v.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().replace(/^\w/, (c) => c.toUpperCase()).replace(/ (\w)/g, (m) => m.toLowerCase());

function money(min: number | null, max: number | null, currency: string, per: string): string {
  if (min === null && max === null) return "";
  const f = (x: number) => (x >= 1000 ? `${Math.round(x / 1000)}k` : String(Math.round(x)));
  const cur = currency && currency !== "USD" && currency !== "AUD" ? `${currency} ` : "";
  const sym = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";
  const range = min !== null && max !== null && max !== min ? `${sym}${f(min)}–${sym}${f(max)}` : `${sym}${f((min ?? max)!)}`;
  const p = /hour/i.test(per) ? " per hour" : /day/i.test(per) ? " per day" : /month/i.test(per) ? " per month" : /year|annual|salary/i.test(per) ? " per year" : "";
  return `${cur}${range}${p}`.slice(0, 120);
}

const date = (v: unknown): string => {
  const x = typeof v === "number" ? new Date(v) : typeof v === "string" ? new Date(v) : null;
  return x && !Number.isNaN(x.getTime()) ? x.toISOString().slice(0, 10) : "";
};

const join = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
const section = (title: string, html: string) => { const t = htmlToText(html); return t ? (title ? `${title}\n\n${t}` : t) : ""; };

export type AtsFields = Omit<JobDraft, "url" | "rights" | "rights_quotes" | "source_site">;

/** The preview's fields from one system's answer, or null when it isn't the one job asked for. */
export function parseAts(req: AtsRequest, body: unknown): AtsFields | null {
  const j = o(body);
  const empty: AtsFields = { company: nameFromSlug(req.org), title: "", location: "", work_mode: "", job_type: "", salary: "", posted: "", apply_via: "", jd_text: "" };
  switch (req.ats) {
    case "greenhouse": {
      if (s(j.id) !== req.want || !s(j.title)) return null;
      const pay = o(a(j.pay_input_ranges)[0]);
      const cents = (v: unknown) => { const x = n(v); return x === null ? null : x / 100; };
      return {
        ...empty, company: s(j.company_name) || empty.company, title: s(j.title), location: s(o(j.location).name),
        salary: money(cents(pay.min_cents), cents(pay.max_cents), s(pay.currency_type), s(pay.title) || "year"),
        posted: date(j.first_published ?? j.updated_at), apply_via: s(j.absolute_url), jd_text: htmlToText(s(j.content)),
      };
    }
    case "lever": {
      if (s(j.id) !== req.want || !s(j.text)) return null;
      const c = o(j.categories);
      const sr = o(j.salaryRange);
      const lists = a(j.lists).map((x) => section(s(o(x).text), `<ul>${s(o(x).content)}</ul>`));
      return {
        ...empty, title: s(j.text), location: s(c.location), work_mode: mode(s(j.workplaceType)), job_type: s(c.commitment),
        salary: money(n(sr.min), n(sr.max), s(sr.currency), s(sr.interval)), posted: date(j.createdAt), apply_via: s(j.applyUrl) || s(j.hostedUrl),
        jd_text: join(s(j.descriptionPlain) || htmlToText(s(j.description)), ...lists, s(j.additionalPlain) || htmlToText(s(j.additional))),
      };
    }
    case "ashby": {
      const job = o(a(j.jobs).find((x) => s(o(x).id).toLowerCase() === req.want));
      if (!s(job.title)) return null;
      const comp = o(job.compensation);
      const wm = mode(s(job.workplaceType)) || (job.isRemote === true ? "Remote" : "");
      return {
        ...empty, title: s(job.title), location: s(job.location), work_mode: wm, job_type: words(s(job.employmentType)),
        salary: (s(comp.scrapeableCompensationSalarySummary) || s(comp.compensationTierSummary)).slice(0, 120), posted: date(job.publishedAt),
        apply_via: s(job.applyUrl) || s(job.jobUrl), jd_text: s(job.descriptionPlain) || htmlToText(s(job.descriptionHtml)),
      };
    }
    case "workable": {
      if (s(j.shortcode).toLowerCase() !== req.want.toLowerCase() || !s(j.title)) return null;
      const loc = o(j.location);
      const place = [s(loc.city), s(loc.region), s(loc.country)].filter(Boolean).join(", ");
      return {
        ...empty, title: s(j.title), location: place, work_mode: mode(s(j.workplace)) || (j.remote === true ? "Remote" : ""), job_type: words(s(j.type)),
        posted: date(j.published), apply_via: `https://apply.workable.com/${req.org}/j/${req.want}/`,
        jd_text: join(section("", s(j.description)), section("Requirements", s(j.requirements)), section("Benefits", s(j.benefits))),
      };
    }
    case "smartrecruiters": {
      if (s(j.id) !== req.want || !s(j.name)) return null;
      const loc = o(j.location);
      const secs = o(o(j.jobAd).sections);
      const part = (k: string) => { const x = o(secs[k]); return section(s(x.title), s(x.text)); };
      return {
        ...empty, company: s(o(j.company).name) || empty.company, title: s(j.name),
        location: s(loc.fullLocation) || [s(loc.city), s(loc.region), s(loc.country).toUpperCase()].filter(Boolean).join(", "),
        work_mode: loc.remote === true ? "Remote" : loc.hybrid === true ? "Hybrid" : "", job_type: s(o(j.typeOfEmployment).label),
        posted: date(j.releasedDate), apply_via: s(j.applyUrl) || s(j.postingUrl),
        jd_text: join(part("companyDescription"), part("jobDescription"), part("qualifications"), part("additionalInformation")),
      };
    }
    case "workday": {
      const p = o(j.jobPostingInfo);
      if (!s(p.title)) return null;
      return {
        ...empty, company: s(o(j.hiringOrganization).name) || empty.company, title: s(p.title), location: s(p.location),
        work_mode: mode(s(p.remoteType)), job_type: s(p.timeType), posted: date(p.startDate), apply_via: s(p.externalUrl),
        jd_text: htmlToText(s(p.jobDescription)),
      };
    }
  }
}
