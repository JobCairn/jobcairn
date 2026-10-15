import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { ensureCompany, newJob } from "../src/jobs.js";
import { validateWorkspace } from "../src/validate.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }

describe("validateWorkspace", () => {
  it("passes a fresh workspace with a job", () => {
    const root = ws();
    newJob(root, { company: "Acme Corp", title: "AI Engineer", jd_text: "x" }, { now: FIXED });
    expect(validateWorkspace(root)).toEqual([]);
  });
  it("names the broken file and keeps checking the rest", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    fs.writeFileSync(layout(root).jobFile(a.company_slug, a.id), '{ "schema": 1, }');
    fs.writeFileSync(layout(root).profile, '{ "schema": 1, "work_rights": { "status": "alien" } }');
    const issues = validateWorkspace(root);
    expect(issues.map((i) => i.file).sort()).toEqual([
      path.join("companies", "acme-corp", "jobs", "2026-01-15-ai-engineer", "job.json"),
      path.join("settings", "profile.json"),
    ]);
  });
  it("flags records that disagree with their folder, missing files and missing company.json", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const f = layout(root).jobFile(a.company_slug, a.id);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.id = "2026-01-15-other"; j.files = [{ path: "gone.pdf", label: "x", at: "" }];
    fs.writeFileSync(f, JSON.stringify(j));
    fs.mkdirSync(path.join(root, "companies", "orphan"));
    const problems = validateWorkspace(root).flatMap((i) => i.problems).join(" | ");
    expect(problems).toContain("folder name and record disagree");
    expect(problems).toContain("listed file is missing: gone.pdf");
    expect(problems).toContain("missing company.json");
  });
  it("reports folders that resolve outside the workspace and listed files that escape the job folder, without reading them", () => {
    const root = ws();
    const a = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const L = layout(root);
    const f = L.jobFile(a.company_slug, a.id);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.files = [{ path: "../../../../outside.txt", label: "x", at: "" }];
    fs.writeFileSync(f, JSON.stringify(j));
    const outside = tmpDir("careeros-outside-co-");
    fs.writeFileSync(path.join(outside, "company.json"), "{ not json");
    fs.symlinkSync(outside, path.join(root, "companies", "example-labs"));
    const issues = validateWorkspace(root);
    const text = issues.flatMap((i) => i.problems).join(" | ");
    expect(text).toContain("listed file is outside the job folder");
    expect(issues.find((i) => i.file === path.join("companies", "example-labs"))?.problems).toEqual(["outside the workspace"]);
    expect(text).not.toContain("not valid");
  });
  it("reports workspace junk instead of crashing: a dangling symlink and a file where jobs/ belongs (I3)", () => {
    const root = ws();
    newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    // A dangling symlink sitting in companies/.
    fs.symlinkSync(path.join(tmpDir(), "nowhere"), path.join(root, "companies", "ghost"));
    // A real company whose jobs/ has been replaced by a plain file.
    ensureCompany(root, "Weird Co");
    fs.rmSync(layout(root).jobsDir("weird-co"), { recursive: true, force: true });
    fs.writeFileSync(layout(root).jobsDir("weird-co"), "not a folder");

    let issues: ReturnType<typeof validateWorkspace> = [];
    expect(() => { issues = validateWorkspace(root); }).not.toThrow();
    expect(issues.some((i) => i.file.includes("ghost") && i.problems.some((p) => p.includes("broken link")))).toBe(true);
    expect(issues.some((i) => i.file.includes(path.join("weird-co", "jobs")) && i.problems.some((p) => p.includes("not a folder")))).toBe(true);
  });
});
