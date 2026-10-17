// Company read model: one row per company in the workspace (company folders, plus employers known only from the
// sponsor list), with what the person has going on there: jobs, best fit, last activity and how far their
// applications got. Sponsorship facts ride along on every row, but screens show them only to people who need
// sponsorship. Pure, so the services and the UI's mock bridge build the exact same rows.
import { FINAL_STATUSES, type JobStatus } from "./constants.js";
import type { CompanyContacts } from "./contacts.js";
import type { FileKind, JobRecord, JobRow, SponsorEvidenceItem, SponsorRow, SponsorStatusKey } from "./types.js";

/** Sponsorship facts for one company. Shown only to people who need sponsorship. */
export interface CompanySponsor {
  status: SponsorStatusKey; score: number; tier: string; reasons: string[];
  /** Oldest first; the latest is last. */
  evidence: SponsorEvidenceItem[]; last_checked: string; qld: boolean | null; ai_relevance: string;
}
export interface CompanyRow {
  /** The route key (`#/company/<key>`): the company's folder slug, or a slug made from the name for a list-only employer. */
  key: string;
  /** The company folder, or null when the employer is known only from the sponsor list. */
  slug: string | null;
  name: string; aliases: string[]; website: string;
  jobs: number; open_jobs: number;
  /** The best fit score among this company's jobs (0-100), or null when none is scored. */
  best_fit: number | null;
  /** The latest job activity or email, as stored (ISO date or instant). "" when there is none. */
  last_activity: string;
  /** How far your applications here got: the furthest status of any job, or null with no jobs. */
  stage: JobStatus | null;
  /** How many jobs are at each status. */
  statuses: Partial<Record<JobStatus, number>>;
  mail: number;
  sponsor: CompanySponsor;
}
export interface CompanyFile { path: string; rel: string; label: string; at: string; size: number; kind: FileKind }
export interface CompanyEvent { at: string; event: string; note: string; job_id: string; job_title: string }
export interface CompanyDetail {
  company: CompanyRow;
  /** Distinct job locations, most common first. */
  locations: string[];
  jobs: JobRow[];
  /** Research and notes in the company folder (not its jobs, emails or videos). */
  files: CompanyFile[];
  /** Every job's timeline, newest first. */
  timeline: CompanyEvent[];
  /** The careers page and published emails from contacts.json (Research company), or null when there are none yet. */
  contacts: CompanyContacts | null;
}
export interface CompanyInput { slug: string; name: string; website: string }
export interface CompanyMailStat { company_slug: string; count: number; last: string }

/** Furthest first. The final statuses rank below every live status. */
export const STAGE_ORDER: readonly JobStatus[] = ["Offer", "Interview", "Applied", "Applying", "Saved", "Found", "Rejected", "No response", "Withdrawn", "Skipped"];
const CLOSED = FINAL_STATUSES;

/** A route-safe slug from a name ("Example Labs Pty Ltd" -> "example-labs-pty-ltd"). Never empty. */
export function nameSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "company";
}

const later = (a: string, b: string) => (b > a ? b : a);

/**
 * One row per company. `sponsors` is buildSponsorRows' output (every company record plus list-only employers);
 * `companies` adds each folder's website; `jobs` and `mail` add the activity columns.
 */
export function buildCompanyRows(sponsors: SponsorRow[], companies: CompanyInput[], jobs: JobRow[], mail: CompanyMailStat[]): CompanyRow[] {
  const bySlug = new Map(companies.map((c) => [c.slug, c]));
  const taken = new Set(sponsors.flatMap((s) => (s.slug ? [s.slug] : [])));
  const rows: CompanyRow[] = [];
  for (const s of sponsors) {
    let key = s.slug ?? nameSlug(s.name);
    if (!s.slug) {
      // A list-only employer never shadows a company folder, or another list-only employer.
      let n = 2;
      const base = key;
      while (taken.has(key)) key = `${base}-${n++}`;
      taken.add(key);
    }
    const mine = s.slug ? jobs.filter((j) => j.company_slug === s.slug) : [];
    const statuses: Partial<Record<JobStatus, number>> = {};
    for (const j of mine) statuses[j.status] = (statuses[j.status] ?? 0) + 1;
    const fits = mine.map((j) => j.fit).filter((f): f is number => typeof f === "number" && Number.isFinite(f));
    const m = s.slug ? mail.find((x) => x.company_slug === s.slug) : undefined;
    let last = m?.last ?? "";
    for (const j of mine) last = later(last, j.last_activity || j.found_at || "");
    rows.push({
      key, slug: s.slug, name: s.name, aliases: s.aliases, website: (s.slug && bySlug.get(s.slug)?.website) || "",
      jobs: mine.length, open_jobs: mine.filter((j) => !CLOSED.includes(j.status)).length,
      best_fit: fits.length ? Math.max(...fits) : null, last_activity: last,
      stage: STAGE_ORDER.find((st) => statuses[st]) ?? null, statuses, mail: m?.count ?? 0,
      sponsor: {
        status: s.status, score: s.score, tier: s.score_tier, reasons: s.score_reasons, evidence: s.evidence,
        last_checked: s.last_checked, qld: s.qld, ai_relevance: s.ai_relevance,
      },
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** The detail for one row: its jobs, locations and merged timeline. `files` and `contacts` come from the company folder. */
export function buildCompanyDetail(row: CompanyRow, jobs: JobRow[], records: JobRecord[], files: CompanyFile[], contacts: CompanyContacts | null = null): CompanyDetail {
  const mine = row.slug ? jobs.filter((j) => j.company_slug === row.slug) : [];
  const counts = new Map<string, number>();
  for (const j of mine) {
    const l = j.location.trim();
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const titles = new Map(mine.map((j) => [j.id, j.title]));
  const timeline: CompanyEvent[] = records
    .filter((r) => row.slug && r.company_slug === row.slug)
    .flatMap((r) => (Array.isArray(r.timeline) ? r.timeline : []).map((e) => ({ at: e.at, event: e.event, note: e.note ?? "", job_id: r.id, job_title: titles.get(r.id) ?? r.title })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 200);
  return {
    company: row,
    locations: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l),
    jobs: [...mine].sort((a, b) => STAGE_ORDER.indexOf(a.status) - STAGE_ORDER.indexOf(b.status) || b.found_at.localeCompare(a.found_at)),
    files, timeline, contacts: row.slug ? contacts : null,
  };
}

/** Top-level names in a company folder that aren't research or notes. contacts.json shows in the Contacts tab instead. */
export const COMPANY_SKIP = new Set(["jobs", "emails", "videos", "company.json", "contacts.json"]);
