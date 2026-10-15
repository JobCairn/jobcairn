import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { listJobs, newJob, setStatus } from "../src/jobs.js";
import { adKey, companyKey, findDuplicateJob, placesCompatible, titleKey } from "../src/dedupe.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }
const later = { now: new Date("2026-02-03T09:00:00.000Z") };

describe("adKey", () => {
  it("matches the different shapes of one SEEK, LinkedIn and Indeed ad", () => {
    expect(adKey("https://www.seek.com.au/job/90000001?type=standard&ref=search#sol=abc")).toBe("seek:90000001");
    expect(adKey("https://www.seek.com.au/ai-engineer-jobs/in-Brisbane?jobId=90000001")).toBe("seek:90000001");
    expect(adKey("https://au.seek.com/job/90000001/")).toBe("seek:90000001");
    expect(adKey("https://www.linkedin.com/jobs/view/4000000001/?trk=public")).toBe("linkedin:4000000001");
    expect(adKey("https://au.linkedin.com/jobs/view/ai-engineer-at-acme-corp-4000000001")).toBe("linkedin:4000000001");
    expect(adKey("https://www.linkedin.com/jobs/search/?currentJobId=4000000001&keywords=ai")).toBe("linkedin:4000000001");
    expect(adKey("https://au.indeed.com/viewjob?jk=0123456789abcdef&from=serp")).toBe("indeed:0123456789abcdef");
    expect(adKey("https://au.indeed.com/jobs?q=ai&vjk=0123456789ABCDEF")).toBe("indeed:0123456789abcdef");
  });
  it("strips query tracking, fragment and trailing slash from other links; empty for non-links", () => {
    expect(adKey("https://Jobs.Example.com/ai-engineer/?utm_source=x#apply")).toBe("https://jobs.example.com/ai-engineer");
    expect(adKey("https://jobs.example.com/ai-engineer?id=4")).toBe("https://jobs.example.com/ai-engineer?id=4");
    expect(adKey("")).toBe("");
    expect(adKey("not a link")).toBe("");
  });
});

describe("name, title and place keys", () => {
  it("ignores case, legal suffixes, Australia and recruiter clients in company names", () => {
    expect(companyKey("Acme Corp Pty Ltd")).toBe(companyKey("ACME CORP"));
    expect(companyKey("Example Labs Australia")).toBe(companyKey("Example Labs"));
    expect(companyKey("Acme Recruiting (client Example University)")).toBe("acme recruiting");
  });
  it("ignores case, punctuation, & and brackets in titles but keeps the words inside brackets", () => {
    expect(titleKey("AI Engineer (Brisbane)")).toBe(titleKey("ai engineer - brisbane"));
    expect(titleKey("AI Automation & Integrations Specialist")).toBe(titleKey("AI automation and integrations specialist"));
    expect(titleKey("AI Engineer (Brisbane)")).not.toBe(titleKey("AI Engineer (Sydney)"));
  });
  it("treats empty or vague places as compatible and different cities as not", () => {
    expect(placesCompatible("Brisbane QLD", "Brisbane City, Queensland 4000")).toBe(true);
    expect(placesCompatible("", "Brisbane QLD")).toBe(true);
    expect(placesCompatible("Remote", "Brisbane QLD")).toBe(true);
    expect(placesCompatible("Brisbane QLD", "Sydney NSW")).toBe(false);
    expect(placesCompatible("Gold Coast QLD", "Sunshine Coast QLD")).toBe(false);
    expect(placesCompatible("Gold Coast QLD", "Gold Coast")).toBe(true);
    expect(placesCompatible("Brisbane", "Fortitude Valley, Brisbane QLD 4006")).toBe(true);
    expect(placesCompatible("North Sydney NSW", "North Ryde NSW")).toBe(false);
  });
});

describe("newJob duplicates", () => {
  it("returns the existing job for the same SEEK ad in another URL shape", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://www.seek.com.au/job/90000001" }, { now: FIXED });
    const b = newJob(root, { company: "Acme Corp", title: "Machine Learning Engineer", url: "https://www.seek.com.au/ai-jobs?jobId=90000001&type=standard" }, later);
    expect(b).toMatchObject({ company_slug: a.company_slug, id: a.id, created: false, duplicate: true });
    expect(listJobs(root)).toHaveLength(1);
  });

  it("matches an ad found again without its link by company, title and place, and fills in what was missing", () => {
    const root = ws();
    const a = newJob(root, { company: "Example Labs", title: "AI Automation & Integrations Specialist", location: "Brisbane QLD", source_site: "SEEK" }, { now: FIXED });
    const b = newJob(root, {
      company: "Example Labs Pty Ltd", title: "AI automation and integrations specialist", location: "Brisbane City QLD", source: "browser", source_site: "SEEK",
      url: "https://www.seek.com.au/job/90000002", salary_text: "$120k - $140k", posted: "2026-02-01",
    }, later);
    expect(b).toMatchObject({ id: a.id, created: false, duplicate: true, filled: ["link", "pay", "posted date"] });
    expect(listJobs(root)).toHaveLength(1);
    const j = readRecord("job", layout(root).jobFile(a.company_slug, a.id));
    expect(j.url).toBe("https://www.seek.com.au/job/90000002");
    expect(j.salary.text).toBe("$120k - $140k");
    expect(j.posted).toBe("2026-02-01");
    expect(j.timeline.at(-1)).toMatchObject({ event: "Seen again", note: "Seen again on SEEK 2026-02-03. Added the link, pay, posted date." });
  });

  it("matches the reverse case: the old job has the link, the new find has none (the Find jobs bug)", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Recruiting", title: "AI Engineer (Brisbane)", url: "https://www.seek.com.au/job/90000003", location: "Brisbane QLD" }, { now: FIXED });
    const b = newJob(root, { company: "Acme Recruiting Australia", title: "AI Engineer (Brisbane)", location: "Brisbane QLD", source: "browser", source_site: "SEEK" }, later);
    expect(b).toMatchObject({ id: a.id, duplicate: true, filled: [] });
    expect(listJobs(root)).toHaveLength(1);
    expect(readRecord("job", layout(root).jobFile(a.company_slug, a.id)).timeline.at(-1)).toMatchObject({ event: "Seen again", note: "Seen again on SEEK 2026-02-03" });
  });

  it("never overwrites values the job already has, and notes a repeat sighting once per site and day", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1", salary_text: "$150k", posted: "2026-01-10" }, { now: FIXED });
    const again = { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/2", salary_text: "$90k", posted: "2026-02-01", source_site: "Example Jobs" };
    newJob(root, again, later);
    newJob(root, again, later);
    const j = readRecord("job", layout(root).jobFile(a.company_slug, a.id));
    expect(j.url).toBe("https://jobs.example.com/1");
    expect(j.salary.text).toBe("$150k");
    expect(j.posted).toBe("2026-01-10");
    expect(j.timeline.filter((e) => e.event === "Seen again")).toHaveLength(1);
  });

  it("adds a same-title job in a different place", () => {
    const root = ws();
    newJob(root, { company: "Acme Corp", title: "AI Engineer", location: "Brisbane QLD" }, { now: FIXED });
    const b = newJob(root, { company: "Acme Corp", title: "AI Engineer", location: "Sydney NSW" }, later);
    expect(b.created).toBe(true);
    expect(listJobs(root)).toHaveLength(2);
  });

  it("adds a new posting when the old job with that title is closed, but never the same ad twice", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://www.seek.com.au/job/90000004", location: "Brisbane QLD" }, { now: FIXED });
    setStatus(root, a.company_slug, a.id, "Rejected", "", { now: FIXED });
    const b = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://www.seek.com.au/job/90000005", location: "Brisbane QLD" }, later);
    expect(b.created).toBe(true);
    const c = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://www.seek.com.au/job/90000004" }, later);
    expect(c).toMatchObject({ id: a.id, duplicate: true });
    expect(listJobs(root)).toHaveLength(2);
  });

  it("finding a duplicate changes nothing; match url ignores titles", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const file = layout(root).jobFile(a.company_slug, a.id);
    const before = JSON.stringify(readRecord("job", file));
    expect(findDuplicateJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/9" })).toMatchObject({ id: a.id, by: "title", company_name: "Acme Corp" });
    expect(JSON.stringify(readRecord("job", file))).toBe(before);
    expect(findDuplicateJob(root, { company: "Acme Corp", title: "AI Engineer" }, { match: "url" })).toBeNull();
    expect(newJob(root, { company: "Acme Corp", title: "AI Engineer" }, later, { match: "url" }).created).toBe(true);
  });
});
