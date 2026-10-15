import fs from "node:fs";
import path from "node:path";
import { insideRoot, layout, mergeAgency, readAgency, readRecord, type Clock } from "@careeros/core";
import { adContacts, localDate } from "@careeros/contract";

// Kept apart from recruiters.ts (which reads mail): the MCP server runs this when Claude saves a job.

const AD_MAX_BYTES = 256 * 1024;

/**
 * After a job is saved: when its ad came from a recruiter (the company is marked a recruiter, or the ad names a client
 * it is hiring for), link the job to that agency (same slug as the company) and keep any contact details the ad
 * itself publishes, with the ad's https link as their source. Never fails the save: a problem here is skipped.
 */
export function captureAdRecruiter(root: string, companySlug: string, jobId: string, c?: Clock): boolean {
  try {
    const L = layout(root);
    const job = readRecord("job", L.jobFile(companySlug, jobId));
    const company = readRecord("company", L.companyFile(companySlug));
    if (!job.client && company.type !== "recruiter") return false;
    const jd = path.join(L.jobDir(companySlug, jobId), "jd.md");
    let text = "";
    try {
      const st = fs.lstatSync(jd);
      if (st.isFile() && st.size <= AD_MAX_BYTES && insideRoot(root, jd)) text = fs.readFileSync(jd, "utf8");
    } catch { /* no ad text */ }
    const today = localDate(c?.now ?? new Date());
    const found = adContacts(text, job.url, today);
    const ref = `${companySlug}/${jobId}`;
    const known = readAgency(root, companySlug);
    if (known?.job_refs.includes(ref)) return false;
    mergeAgency(root, {
      slug: companySlug, name: company.name, job_refs: [ref], contacts: found.contacts,
      people: found.person ? [{ name: found.person, source_url: job.url, job_refs: [ref], email: found.contacts.find((x) => x.kind === "email")?.value ?? "", phone: found.contacts.find((x) => x.kind === "phone")?.value ?? "" }] : [],
    }, { event: "Advertised a job", note: job.title }, c);
    return true;
  } catch { return false; }
}
