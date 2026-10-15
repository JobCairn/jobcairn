import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { ensureCompany, newJob, setStatus } from "../src/jobs.js";
import { buildIndex, openIndex } from "../src/index-db.js";
import { updateRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { appendSearch } from "../src/knowledge.js";
import { FIXED, tmpDir } from "./helpers.js";

function seeded() {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  updateRecord("profile", layout(root).profile, (p) => { p.work_rights.status = "needs_sponsorship"; });
  const a = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: FIXED });
  updateRecord("job", layout(root).jobFile(a.company_slug, a.id), (j) => { j.work_rights.label = "sponsorship_offered"; });
  const b = newJob(root, { company: "Example Labs", title: "Backend Engineer", url: "https://jobs.example.com/2" }, { now: FIXED });
  updateRecord("job", layout(root).jobFile(b.company_slug, b.id), (j) => { j.work_rights.label = "citizen_pr_only"; });
  setStatus(root, b.company_slug, b.id, "Skipped", "", { now: FIXED });
  appendSearch(root, { site: "Greenhouse", query: "ai engineer", location: "Sampletown" }, { now: FIXED });
  return { root, a, b };
}

describe("buildIndex", () => {
  it("indexes jobs, companies, events and searches with eligibility and pinning", () => {
    const { root } = seeded();
    const r = buildIndex(root);
    expect(r).toMatchObject({ jobs: 2, companies: 2, events: 3, searches: 1, skipped: [] });
    const db = openIndex(root);
    const rows = db.prepare("SELECT company_slug, wr_label, eligible, pinned, status FROM jobs ORDER BY pinned, company_slug").all();
    db.close();
    expect(rows).toEqual([
      { company_slug: "acme-corp", wr_label: "sponsorship_offered", eligible: 1, pinned: 0, status: "Found" },
      { company_slug: "example-labs", wr_label: "citizen_pr_only", eligible: 0, pinned: 1, status: "Skipped" },
    ]);
  });
  it("skips a broken job file and still indexes the rest", () => {
    const { root, b } = seeded();
    fs.writeFileSync(layout(root).jobFile(b.company_slug, b.id), '{ "schema": 1, }');
    const r = buildIndex(root);
    expect(r.jobs).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.file).toContain("example-labs");
  });
  it("can be deleted and rebuilt", () => {
    const { root } = seeded();
    buildIndex(root);
    fs.rmSync(layout(root).indexDb);
    expect(buildIndex(root).jobs).toBe(2);
    expect(fs.readdirSync(path.dirname(layout(root).indexDb)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
  it("skips a job folder that is a symlink pointing outside the workspace", () => {
    const { root, b } = seeded();
    const jobDir = layout(root).jobDir(b.company_slug, b.id);
    const outside = tmpDir("careeros-outside-");
    fs.cpSync(jobDir, outside, { recursive: true });
    fs.rmSync(jobDir, { recursive: true, force: true });
    fs.symlinkSync(outside, jobDir, "dir");
    const r = buildIndex(root);
    expect(r.jobs).toBe(1);
    expect(r.skipped).toEqual([{ file: expect.stringContaining("example-labs"), problems: ["outside the workspace"] }]);
    const db = openIndex(root);
    const rows = db.prepare("SELECT company_slug FROM jobs").all();
    db.close();
    expect(rows).toEqual([{ company_slug: "acme-corp" }]);
  });
  it("skips a company folder that is a symlink pointing outside the workspace (I4)", () => {
    const { root, b } = seeded();
    const companyDir = layout(root).companyDir(b.company_slug);
    const outside = tmpDir("careeros-outside-");
    fs.cpSync(companyDir, outside, { recursive: true });
    fs.rmSync(companyDir, { recursive: true, force: true });
    fs.symlinkSync(outside, companyDir, "dir");

    const r = buildIndex(root);
    expect(r.companies).toBe(1);
    expect(r.skipped).toEqual(expect.arrayContaining([{ file: expect.stringContaining(b.company_slug), problems: ["outside the workspace"] }]));
    const db = openIndex(root);
    const rows = db.prepare("SELECT slug FROM companies").all();
    db.close();
    expect(rows).toEqual([{ slug: "acme-corp" }]);
  });
  it("completes and lists workspace junk in skipped instead of crashing (I3)", () => {
    const { root } = seeded();
    // A dangling symlink sitting in companies/.
    fs.symlinkSync(path.join(tmpDir(), "nowhere"), path.join(root, "companies", "ghost"));
    // A real company whose jobs/ has been replaced by a plain file.
    ensureCompany(root, "Weird Co");
    fs.rmSync(layout(root).jobsDir("weird-co"), { recursive: true, force: true });
    fs.writeFileSync(layout(root).jobsDir("weird-co"), "not a folder");

    let r: ReturnType<typeof buildIndex> | undefined;
    expect(() => { r = buildIndex(root); }).not.toThrow();
    expect(r!.jobs).toBe(2);
    expect(r!.skipped.some((s) => s.file.includes(path.join("weird-co", "jobs")))).toBe(true);
  });
});
