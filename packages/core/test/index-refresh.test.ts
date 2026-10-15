import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { newJob, setStatus } from "../src/jobs.js";
import { buildIndex, openIndex, planRefresh, refreshIndex } from "../src/index-db.js";
import { updateRecord, writeRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { appendSearch } from "../src/knowledge.js";
import { FIXED, tmpDir } from "./helpers.js";

function seeded() {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  updateRecord("profile", layout(root).profile, (p) => { p.work_rights.status = "needs_sponsorship"; });
  const a = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: FIXED });
  const b = newJob(root, { company: "Example Labs", title: "Backend Engineer", url: "https://jobs.example.com/2" }, { now: FIXED });
  buildIndex(root);
  return { root, a, b, L: layout(root) };
}
const rows = (root: string, sql: string) => { const db = openIndex(root); const r = db.prepare(sql).all(); db.close(); return r; };

describe("planRefresh", () => {
  it("maps changed paths to the smallest refresh", () => {
    const p = planRefresh(["companies/acme-corp/jobs/2026-01-15-ai-engineer/job.json", "companies/example-labs/company.json", "knowledge/search-log.jsonl", "inbox/cv.pdf"]);
    expect(p.full).toBe(false);
    expect([...p.jobs]).toEqual(["acme-corp/2026-01-15-ai-engineer"]);
    expect([...p.companies]).toEqual(["example-labs"]);
    expect(p.searches).toBe(true);
    expect(planRefresh(["settings/profile.json"]).full).toBe(true);
    expect(planRefresh(["workspace.json"]).full).toBe(true);
    expect([...planRefresh(["companies/new-co"]).companyJobs]).toEqual(["new-co"]);
  });
});

describe("refreshIndex", () => {
  it("does a full build when there is no index yet", () => {
    const { root, L } = seeded();
    fs.rmSync(L.indexDb);
    expect(refreshIndex(root, [L.profile]).mode).toBe("full");
  });
  it("re-reads only the changed job", () => {
    const { root, a } = seeded();
    setStatus(root, a.company_slug, a.id, "Applied", "", { now: FIXED });
    const r = refreshIndex(root, [layout(root).jobFile(a.company_slug, a.id)]);
    expect(r).toMatchObject({ mode: "incremental", jobs: 1, skipped: [] });
    expect(rows(root, "SELECT company_slug, status FROM jobs ORDER BY company_slug")).toEqual([
      { company_slug: "acme-corp", status: "Applied" }, { company_slug: "example-labs", status: "Found" },
    ]);
    expect(rows(root, "SELECT count(*) AS n FROM events WHERE company_slug = 'acme-corp'")).toEqual([{ n: 2 }]);
  });
  it("drops a deleted job and its events", () => {
    const { root, b, L } = seeded();
    fs.rmSync(L.jobDir(b.company_slug, b.id), { recursive: true });
    refreshIndex(root, [L.jobDir(b.company_slug, b.id)]);
    expect(rows(root, "SELECT company_slug FROM jobs")).toEqual([{ company_slug: "acme-corp" }]);
    expect(rows(root, "SELECT count(*) AS n FROM events WHERE company_slug = 'example-labs'")).toEqual([{ n: 0 }]);
  });
  it("renames a company on its job rows", () => {
    const { root, a, L } = seeded();
    updateRecord("company", L.companyFile(a.company_slug), (c) => { c.name = "Acme Corporation"; });
    refreshIndex(root, ["companies/acme-corp/company.json"]);
    expect(rows(root, "SELECT company_name FROM jobs WHERE company_slug = 'acme-corp'")).toEqual([{ company_name: "Acme Corporation" }]);
  });
  it("reports a broken job file, removes its row and does not throw", () => {
    const { root, b, L } = seeded();
    fs.writeFileSync(L.jobFile(b.company_slug, b.id), '{ "schema": 1, }');
    const r = refreshIndex(root, [L.jobFile(b.company_slug, b.id)]);
    expect(r.skipped[0]?.file).toContain("example-labs");
    expect(rows(root, "SELECT company_slug FROM jobs")).toEqual([{ company_slug: "acme-corp" }]);
  });
  it("rebuilds everything when the profile changes eligibility", () => {
    const { root, b, L } = seeded();
    updateRecord("job", L.jobFile(b.company_slug, b.id), (j) => { j.work_rights.label = "citizen_pr_only"; });
    refreshIndex(root, [L.jobFile(b.company_slug, b.id)]);
    expect(rows(root, "SELECT eligible FROM jobs WHERE company_slug = 'example-labs'")).toEqual([{ eligible: 0 }]);
    updateRecord("profile", L.profile, (p) => { p.work_rights.status = "citizen"; });
    expect(refreshIndex(root, [L.profile]).mode).toBe("full");
    expect(rows(root, "SELECT eligible FROM jobs WHERE company_slug = 'example-labs'")).toEqual([{ eligible: 1 }]);
  });
  it("refreshes the search log and ignores unrelated paths", () => {
    const { root, L } = seeded();
    appendSearch(root, { site: "Greenhouse", query: "ai engineer", location: "Sampletown" }, { now: FIXED });
    expect(refreshIndex(root, [L.searchLog]).searches).toBe(1);
    expect(refreshIndex(root, [path.join(L.inbox, "cv.pdf")])).toMatchObject({ mode: "incremental", jobs: 0, companies: 0, searches: 0 });
  });
  it("skips a job folder that became a symlink to outside the workspace", () => {
    const { root, b, L } = seeded();
    const jobDir = L.jobDir(b.company_slug, b.id);
    const outside = tmpDir("careeros-outside-");
    fs.cpSync(jobDir, outside, { recursive: true });
    fs.rmSync(jobDir, { recursive: true });
    fs.symlinkSync(outside, jobDir, "dir");
    const r = refreshIndex(root, [jobDir]);
    expect(r.skipped).toEqual([{ file: expect.stringContaining("example-labs"), problems: ["outside the workspace"] }]);
    expect(rows(root, "SELECT company_slug FROM jobs")).toEqual([{ company_slug: "acme-corp" }]);
  });
  it("matches a fresh buildIndex after a mixed set of edits applied to the sample workspace", () => {
    const SAMPLE = path.resolve(import.meta.dirname, "../../../samples/alex-example");
    const root = path.join(tmpDir(), "alex");
    fs.cpSync(SAMPLE, root, { recursive: true });
    const L0 = layout(root);
    // Seed an email sidecar on a job that no other edit below touches, so editing
    // it in place is the only reason that job gets re-read.
    const emailFile = path.join(L0.jobEmailsDir("example-labs", "2026-01-12-backend-engineer-llm"), "2026-01-12-note-eeeeee.json");
    writeRecord("email", emailFile, {
      schema: 1, message_id: "<e1@example.org>", direction: "in", subject: "Note", date: "2026-01-12T09:00:00.000Z",
      from: { address: "talent@example.org" },
    });
    buildIndex(root);
    const L = layout(root);

    // edit one job's fields
    setStatus(root, "acme-corp", "2026-01-12-ai-engineer", "Applied", "", { now: FIXED });
    // delete one job folder
    fs.rmSync(L.jobDir("acme-recruiting", "2026-01-12-ai-developer"), { recursive: true });
    // add a new job under an existing company
    const added = newJob(root, { company: "Example Labs", title: "Platform Engineer", url: "https://jobs.example.com/9" }, { now: FIXED });
    // edit company.json
    updateRecord("company", L.companyFile("example-labs"), (c) => { c.name = "Example Labs Group"; });
    // append a search-log line
    appendSearch(root, { site: "Greenhouse", query: "platform engineer", location: "Sampletown" }, { now: FIXED });
    // edit an email sidecar in place (job's own emails folder, not its job.json)
    updateRecord("email", emailFile, (e) => { e.subject = "Note (edited)"; });

    const changed = [
      L.jobFile("acme-corp", "2026-01-12-ai-engineer"),
      L.jobDir("acme-recruiting", "2026-01-12-ai-developer"),
      L.jobFile(added.company_slug, added.id),
      L.companyFile("example-labs"),
      L.searchLog,
      emailFile,
    ];
    const r = refreshIndex(root, changed);
    expect(r.mode).toBe("incremental");

    // A fresh build of the exact same final file state (a separate copy, so the two
    // index files don't collide) must agree row-for-row with the incremental refresh.
    const rebuiltRoot = path.join(tmpDir(), "alex-rebuilt");
    fs.cpSync(root, rebuiltRoot, { recursive: true });
    buildIndex(rebuiltRoot);

    const dump = (r2: string) => {
      const db = openIndex(r2);
      const all = (table: string, order: string) => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
      const out = {
        jobs: all("jobs", "company_slug, id"),
        companies: all("companies", "slug"),
        events: all("events", "company_slug, job_id, at, event"),
        searches: all("searches", "at, site, query, location"),
        emails: all("emails", "company_slug, job_id, file"),
      };
      db.close();
      return out;
    };
    expect(dump(root)).toEqual(dump(rebuiltRoot));
    expect(dump(root).emails.find((e: { file: string }) => e.file === path.relative(root, emailFile).split(path.sep).join("/")))
      .toMatchObject({ subject: "Note (edited)" });
  });
});
