// Sponsor read model: one row per employer, merged from the company records and the sponsor
// cache (knowledge/sponsors.json), scored with the same likelihood rules the job-hunt scripts
// use (a port of `likelihood()` in the legacy check_sponsor.py). Pure, so the services and the
// UI's mock bridge build the exact same rows.
import type { JobStatus } from "./constants.js";
import type { SponsorEvidenceItem, SponsorJobRef, SponsorRow, SponsorStatusKey } from "./types.js";

export const SPONSOR_STATUSES: readonly SponsorStatusKey[] = ["verified", "to_verify", "checked_none", "sanctioned", "unknown"];

/** "checked-none" (cache) and "checked_none" (record) are the same status. Anything unknown is "unknown". */
export function normalizeSponsorStatus(s: unknown): SponsorStatusKey {
  const k = String(s ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  return (SPONSOR_STATUSES as readonly string[]).includes(k) ? (k as SponsorStatusKey) : "unknown";
}

// Mirrors the Python SUFFIXES/norm(): legal suffixes, regional/corporate words, and "the" as a
// whole word anywhere in the name (round 2 ruling: match the Python reference exactly, not just
// a leading "the").
const LEGAL = /\b(pty|ltd|limited|inc|incorporated|llc|plc|corp|corporation|co|company|group|holdings|australia|australian|aust|au|anz|apac|asia pacific|services|technologies|technology|the)\b/g;
/** Matching key for employer names: ignores case, legal/regional suffixes, "the" and punctuation. */
export function sponsorKey(name: string): string {
  return name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(LEGAL, " ").replace(/\s+/g, " ").trim();
}

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** Merges evidence lists: drops malformed items, dedupes on date + note + url, oldest first (latest last). */
export function mergeEvidence(...lists: unknown[][]): SponsorEvidenceItem[] {
  const seen = new Map<string, SponsorEvidenceItem>();
  for (const list of lists) {
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      // The url is kept exactly as stored: trimming could turn " https://x" into a clickable link.
      const e = { date: str(o.date).trim(), note: str(o.note).trim(), url: str(o.url) };
      if (!e.note && !e.url.trim()) continue;
      const k = `${e.date}|${e.note}|${e.url.trim()}`;
      if (!seen.has(k)) seen.set(k, e);
    }
  }
  return [...seen.values()].map((e, i) => ({ e, i })).sort((a, b) => a.e.date.localeCompare(b.e.date) || a.i - b.i).map((x) => x.e);
}

export interface SponsorFacts {
  name: string; status: SponsorStatusKey; evidence: SponsorEvidenceItem[]; ai_relevance: string; qld: boolean | null; last_checked: string;
}
/** What a job ad says, when scoring for a specific ad. Omit for the employer on its own. */
export interface SponsorLead { sponsorship?: "Explicit" | "Likely" | "No" | "Unknown"; likely_sponsor?: boolean; sponsor_reason?: string }
export interface SponsorScore { score: number; tier: string; reasons: string[] }

/** The sponsor-likelihood tier words for a 0-100 score (also what the Sponsors and Jobs screens show). */
export const sponsorTierOf = (n: number): string => (n >= 85 ? "Very high" : n >= 65 ? "High" : n >= 45 ? "Medium" : n >= 20 ? "Low" : "Very low");

/**
 * 0-100 likelihood that this employer sponsors, with reasons. Same rules and numbers as the
 * job-hunt script: ad says sponsorship 95 (100 if also verified), verified with role evidence
 * 70 (+10 AI/software, +5 tech), verified on the 2024 FOI list only 55, to-verify 50, likely
 * sponsor 40, nothing known 20, checked and none found 15, ad needs full work rights 5,
 * sanctioned 0.
 */
export function sponsorLikelihood(sp: SponsorFacts, lead?: SponsorLead): SponsorScore {
  const stated = lead?.sponsorship ?? "Unknown";
  const why: string[] = [];
  if (sp.status === "sanctioned") return { score: 0, tier: "Avoid", reasons: ["on the sanctioned-sponsors register"] };
  if (stated === "No") return { score: 5, tier: "Very low", reasons: ["ad requires citizenship/PR/full working rights"] };
  let score: number;
  if (stated === "Explicit") {
    score = 95;
    why.push("ad says sponsorship is available");
  } else if (sp.status === "verified") {
    const role = sp.evidence.filter((e) => !e.note.includes("FOI FA 24"));
    if (role.length) {
      score = 70;
      why.push(`evidence they sponsor: ${role.at(-1)!.note.slice(0, 90)}`);
      if (sp.ai_relevance === "High") { score += 10; why.push("has sponsored AI/software roles"); }
      else if (sp.ai_relevance === "Medium") { score += 5; why.push("has sponsored tech roles"); }
    } else {
      score = 55;
      why.push("accredited sponsor in the Jan 2024 FOI list; no evidence for a specific role");
    }
  } else if (sp.status === "to_verify") {
    score = 50;
    why.push("on the to-verify list, no evidence yet");
  } else if (sp.status === "checked_none" && !lead?.likely_sponsor) {
    score = 15;
    why.push(`checked ${sp.last_checked || "before"}: no sponsorship evidence found`);
  } else if (lead?.likely_sponsor || stated === "Likely") {
    score = 40;
    why.push(`likely sponsor: ${lead?.sponsor_reason || "large or international employer"}`);
  } else {
    score = 20;
    why.push(lead ? "no sponsorship signal; ad is silent" : "no sponsorship evidence yet");
  }
  if (stated === "Explicit" && sp.status === "verified") { score = 100; why.push("also on the verified sponsor list"); }
  if (sp.qld) why.push("QLD presence");
  return { score, tier: sponsorTierOf(score), reasons: why };
}

/** The first reason on a job's sponsor score copied from its employer when the job was added (not from the ad). */
export const IMPORT_SPONSOR_REASON = "Employer's sponsor score when this job was added";

export interface SponsorCompanyInput { name: string; slug: string; sponsor: { status: string; evidence: unknown[]; last_checked: string } }
export interface SponsorJobInput { company_slug: string; id: string; title: string; status: JobStatus; sponsor: { value: number | null; tier: string; reasons: string[] } }

const CLOSED_JOB: JobStatus[] = ["Rejected", "Skipped"];

function qldOf(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  const s = str(v).toLowerCase();
  return s === "yes" || s === "true" ? true : s === "no" || s === "false" ? false : null;
}
const later = (a: string, b: string) => (b > a ? b : a);

// Rank precedence for merging statuses: sanctioned > verified > to-verify > checked-none > unknown.
// Mirrors legacy `add()`'s rank table: a fresh checked-none never downgrades a verified sponsor,
// and the winner is whichever status outranks the current winner, not whichever record is newest.
const STATUS_RANK: Record<SponsorStatusKey, number> = { sanctioned: 4, verified: 3, to_verify: 2, checked_none: 1, unknown: 0 };
/** A cache entry with no `status` field at all defaults to "to-verify", like the Python check(). */
function cacheStatus(e: Record<string, unknown>): SponsorStatusKey {
  return e.status === undefined ? "to_verify" : normalizeSponsorStatus(e.status);
}

/**
 * One row per employer: every company record, plus every cache entry that matches no company.
 * A company that also has a cache entry gets the cache's evidence, aliases, QLD and AI relevance,
 * and the more recent status (a sanctioned finding always wins). Every row is scored.
 */
export function buildSponsorRows(companies: SponsorCompanyInput[], employers: unknown[], jobs: SponsorJobInput[]): SponsorRow[] {
  const cache = (Array.isArray(employers) ? employers : []).filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !!str((e as Record<string, unknown>).name).trim());
  const keysOf = (e: Record<string, unknown>) => [str(e.name), ...(Array.isArray(e.aliases) ? e.aliases.map(str) : [])].map(sponsorKey).filter(Boolean);
  const used = new Set<Record<string, unknown>>();
  const rows: SponsorRow[] = [];

  const finish = (name: string, slug: string | null, facts: Omit<SponsorFacts, "name">, aliases: string[]): SponsorRow => {
    const mine = slug ? jobs.filter((j) => j.company_slug === slug) : [];
    const refs: SponsorJobRef[] = mine.map((j) => ({ company_slug: j.company_slug, id: j.id, title: j.title, status: j.status, open: !CLOSED_JOB.includes(j.status) }));
    let best = sponsorLikelihood({ name, ...facts });
    if (facts.status !== "sanctioned") {
      for (const j of mine) {
        const v = j.sponsor.value;
        // A score copied from the employer when the job was added says nothing new about the ad: skip it, so a
        // stale copy is never credited to the ad.
        if (j.sponsor.reasons[0] === IMPORT_SPONSOR_REASON) continue;
        if (typeof v === "number" && Number.isFinite(v) && v > best.score) {
          best = { score: v, tier: j.sponsor.tier || sponsorTierOf(v), reasons: [`From the ad for ${j.title}`, ...j.sponsor.reasons] };
        }
      }
    }
    return {
      name, slug, status: facts.status, evidence: facts.evidence, last_checked: facts.last_checked,
      score: best.score, score_tier: best.tier, score_reasons: best.reasons,
      jobs: refs.length, open_jobs: refs.filter((r) => r.open).length, job_refs: refs,
      aliases, qld: facts.qld, ai_relevance: facts.ai_relevance,
    };
  };

  for (const c of companies) {
    const key = sponsorKey(c.name);
    const hits = cache.filter((e) => !used.has(e) && keysOf(e).includes(key));
    hits.forEach((e) => used.add(e));
    let status = normalizeSponsorStatus(c.sponsor.status);
    let checked = str(c.sponsor.last_checked);
    for (const e of hits) {
      const s = cacheStatus(e);
      // Compare the candidate against the current winner, not the original record, so the
      // result never depends on which order the cache entries happen to arrive in.
      if (STATUS_RANK[s] > STATUS_RANK[status]) status = s;
    }
    for (const e of hits) checked = later(checked, str(e.last_checked));
    const aliases = [...new Set(hits.flatMap((e) => [str(e.name), ...(Array.isArray(e.aliases) ? e.aliases.map(str) : [])]))]
      .filter((a) => a.trim() && a.trim().toLowerCase() !== c.name.trim().toLowerCase());
    const first = (f: (e: Record<string, unknown>) => unknown) => hits.map(f).find((v) => v !== undefined && v !== null && v !== "");
    rows.push(finish(c.name, c.slug, {
      status, last_checked: checked, evidence: mergeEvidence(c.sponsor.evidence, ...hits.map((e) => e.evidence as unknown[])),
      qld: qldOf(first((e) => e.qld)), ai_relevance: str(first((e) => e.ai_relevance)),
    }, aliases));
  }

  for (const e of cache) {
    if (used.has(e)) continue;
    used.add(e);
    rows.push(finish(str(e.name).trim(), null, {
      status: cacheStatus(e), last_checked: str(e.last_checked), evidence: mergeEvidence(e.evidence as unknown[]),
      qld: qldOf(e.qld), ai_relevance: str(e.ai_relevance),
    }, Array.isArray(e.aliases) ? e.aliases.map(str).filter((a) => a.trim()) : []));
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
