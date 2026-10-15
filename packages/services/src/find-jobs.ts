import fs from "node:fs";
import { layout, readRecord, updateRecord, addEvent } from "@careeros/core";
import {
  applySearchOverride, buildSponsorRows, checkJobPlace, IMPORT_SPONSOR_REASON, salaryBelowFloor, searchPrefsFrom, sponsorKey,
  type SearchOverride, type SearchPrefs, type SponsorJobInput,
} from "@careeros/contract";

/**
 * Find jobs, main side: the person's search preferences, the checks a found job must pass before it's saved, and
 * the sponsor score a new job gets at import. Used by the engine (prompt, gate) and the MCP job_new tool.
 */

/**
 * The person's search preferences (profile plus Settings › Search), or empty ones when the files can't be read.
 * `over`: one run's own choices from the Find jobs composer, on top of the saved ones.
 */
export function readSearchPrefs(root: string, over?: SearchOverride | null): SearchPrefs {
  const L = layout(root);
  let p: unknown = {}, s: unknown = {};
  try { p = readRecord("profile", L.profile); } catch { /* no profile yet */ }
  try { s = readRecord("search", L.search); } catch { /* defaults */ }
  return applySearchOverride(searchPrefsFrom(p, s), over);
}

export interface FoundJobCheck { refuse: string; flag: string }

/**
 * Before job_new saves a job: refuse one clearly outside the allowed countries (unless remote and open to them) or
 * whose stated yearly pay tops out under the minimum; flag one whose place can't be read. Plain words either way.
 */
export function checkFoundJob(root: string, job: { location?: string; work_mode?: string; salary?: string; jd_text?: string }, over?: SearchOverride | null): FoundJobCheck {
  const prefs = readSearchPrefs(root, over);
  const place = checkJobPlace(prefs, job);
  if (place.verdict === "refuse") return { refuse: `Not saved: ${place.why}`, flag: "" };
  const pay = salaryBelowFloor(prefs, job.salary ?? "");
  if (pay) return { refuse: `Not saved: ${pay}`, flag: "" };
  return { refuse: "", flag: place.verdict === "flag" ? place.why : "" };
}


/**
 * Gives a new job the employer's sponsor score, computed exactly as the Sponsors screen does (buildSponsorRows over
 * the company record and the sponsor cache). Its first reason marks it as the employer's, so the Sponsors screen
 * never credits it to the ad later. Leaves a job that already has a score alone. Best effort: a failure leaves the
 * score empty ("Unknown").
 */
export function scoreSponsorAtImport(root: string, slug: string, id: string): void {
  const L = layout(root);
  try {
    const c = readRecord("company", L.companyFile(slug)) as unknown as { name: string; sponsor: { status: string; evidence: unknown[]; last_checked: string } };
    let employers: unknown[] = [];
    try { employers = (readRecord("sponsors", L.sponsors) as unknown as { employers: unknown[] }).employers ?? []; } catch { employers = []; }
    // The employer's other jobs count too (an ad that offered sponsorship lifts the employer), as on the Sponsors screen.
    const jobs: SponsorJobInput[] = [];
    const dir = L.jobsDir(slug);
    for (const other of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (other === id) continue;
      try {
        const j = readRecord("job", L.jobFile(slug, other));
        jobs.push({ company_slug: slug, id: j.id, title: j.title, status: j.status, sponsor: j.scores.sponsor });
      } catch { /* unreadable jobs are reported by validate */ }
    }
    const rows = buildSponsorRows([{ name: c.name, slug, sponsor: { status: c.sponsor.status, evidence: c.sponsor.evidence, last_checked: c.sponsor.last_checked } }], employers, jobs);
    const row = rows.find((r) => r.slug === slug) ?? rows.find((r) => sponsorKey(r.name) === sponsorKey(c.name));
    if (!row || typeof row.score !== "number") return;
    updateRecord("job", L.jobFile(slug, id), (j) => {
      if (typeof j.scores.sponsor.value === "number") return;
      j.scores.sponsor = { ...j.scores.sponsor, value: row.score, tier: row.score_tier, reasons: [IMPORT_SPONSOR_REASON, ...row.score_reasons].slice(0, 6) };
    });
  } catch { /* leave it Unknown */ }
}

/** A flagged job's timeline note: "Check the location". */
export function flagFoundJob(root: string, slug: string, id: string, why: string): void {
  try { addEvent(root, slug, id, "Check the location", why); } catch { /* the job is saved either way */ }
}
