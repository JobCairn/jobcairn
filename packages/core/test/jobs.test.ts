import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { addEvent, attachFile, ensureCompany, findJobByUrl, listJobs, newJob, normalizeUrl, setStatus } from "../src/jobs.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }

describe("normalizeUrl", () => {
  it("drops tracking params, hash and trailing slash", () => {
    expect(normalizeUrl("https://Jobs.Example.com/view/123/?utm_source=x&refId=9&id=4#top")).toBe("https://jobs.example.com/view/123?id=4");
  });
  it("returns non-URLs trimmed", () => {
    expect(normalizeUrl("  not a url ")).toBe("not a url");
  });
});

describe("companies and jobs", () => {
  it("creates a company once and splits recruiter clients", () => {
    const root = ws();
    expect(ensureCompany(root, "Acme Recruiting (client Example University)")).toEqual({ slug: "acme-recruiting", created: true, client: "Example University" });
    expect(ensureCompany(root, "Acme Recruiting").created).toBe(false);
    expect(readRecord("company", layout(root).companyFile("acme-recruiting")).name).toBe("Acme Recruiting");
  });
  it("creates a job with a Found event and jd.md", () => {
    const root = ws();
    const r = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1", source: "ats", source_site: "Greenhouse", jd_text: "Build agents." }, { now: FIXED });
    expect(r).toEqual({ company_slug: "acme-corp", id: "2026-01-15-ai-engineer", created: true });
    const j = readRecord("job", layout(root).jobFile(r.company_slug, r.id));
    expect(j.timeline).toEqual([{ at: "2026-01-15T09:30:00.000Z", event: "Found", note: "Greenhouse" }]);
    expect(j.files.map((f) => f.path)).toEqual(["jd.md"]);
    expect(fs.readFileSync(path.join(layout(root).jobDir(r.company_slug, r.id), "jd.md"), "utf8")).toBe("Build agents.\n");
  });
  it("dedupes by URL even with tracking params", () => {
    const root = ws();
    newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: FIXED });
    const again = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1/?utm_source=mail" }, { now: FIXED });
    expect(again.created).toBe(false);
    expect(listJobs(root)).toHaveLength(1);
    expect(findJobByUrl(root, "https://jobs.example.com/1#x")?.id).toBe("2026-01-15-ai-engineer");
  });
  it("suffixes same-day same-title jobs in different places", () => {
    const root = ws();
    newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1", location: "Sampletown NSW" }, { now: FIXED });
    const b = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/2", location: "Exampleville VIC" }, { now: FIXED });
    expect(b.id).toBe("2026-01-15-ai-engineer-2");
  });
  it("records events and status changes, rejecting unknown statuses", () => {
    const root = ws();
    const { company_slug, id } = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    addEvent(root, company_slug, id, "Email sent", "asked about sponsorship", { now: FIXED });
    const j = setStatus(root, company_slug, id, "Applied", "", { now: FIXED });
    expect(j.status).toBe("Applied");
    expect(j.timeline.map((e) => e.event)).toEqual(["Found", "Email sent", "Status: Applied"]);
    expect(() => setStatus(root, company_slug, id, "Ghosted")).toThrow(/unknown status/);
  });
  it("attaches files into allowed subfolders without overwriting", () => {
    const root = ws();
    const { company_slug, id } = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const src = path.join(tmpDir(), "resume.md");
    fs.writeFileSync(src, "# Alex Example\n");
    expect(attachFile(root, company_slug, id, src, { label: "Tailored resume", subdir: "application" }, { now: FIXED })).toBe("application/resume.md");
    expect(attachFile(root, company_slug, id, src, { label: "Tailored resume v2", subdir: "application" }, { now: FIXED })).toBe("application/resume-2.md");
    expect(fs.existsSync(src)).toBe(true);
  });
  it("rejects path traversal in company or job ids", () => {
    const root = ws();
    expect(() => addEvent(root, "../..", "etc", "x")).toThrow(/unsafe/);
    expect(() => setStatus(root, "acme-corp", "../../../passwd", "Applied")).toThrow(/unsafe/);
    expect(() => attachFile(root, "acme-corp", "a/b", "/tmp/x", { label: "x" })).toThrow(/unsafe/);
  });
  it("rejects a blank title", () => {
    expect(() => newJob(ws(), { company: "Acme Corp", title: "   " })).toThrow(/title is required/);
  });
});

describe("attachFile symlink safety", () => {
  it("refuses a symlink src for both copy and move, leaving the symlink and src untouched", () => {
    const root = ws();
    const { company_slug, id } = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });

    const outsideDir = tmpDir("careeros-outside-");
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "outside secret\n");
    const link = path.join(tmpDir(), "link-to-secret.txt");
    fs.symlinkSync(outsideFile, link);

    expect(() => attachFile(root, company_slug, id, link, { label: "x", subdir: "application" })).toThrow(/not a regular file/);
    expect(() => attachFile(root, company_slug, id, link, { label: "x", subdir: "application", move: true })).toThrow(/not a regular file/);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(outsideFile)).toBe(true);
    const appDir = path.join(layout(root).jobDir(company_slug, id), "application");
    expect(fs.existsSync(appDir) ? fs.readdirSync(appDir) : []).toEqual([]);
  });

  it("refuses to write when the job folder is replaced by a symlink to a dir outside the workspace", () => {
    const root = ws();
    const { company_slug, id } = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const jobDir = layout(root).jobDir(company_slug, id);
    const jobJson = fs.readFileSync(path.join(jobDir, "job.json"));
    fs.rmSync(jobDir, { recursive: true, force: true });

    const outsideJobDir = tmpDir("careeros-outside-job-");
    fs.writeFileSync(path.join(outsideJobDir, "job.json"), jobJson);
    fs.symlinkSync(outsideJobDir, jobDir);

    const src = path.join(tmpDir(), "resume.md");
    fs.writeFileSync(src, "# Alex Example\n");

    expect(() => attachFile(root, company_slug, id, src, { label: "Resume", subdir: "application" }))
      .toThrow(/refusing to write outside/);
    expect(fs.existsSync(path.join(outsideJobDir, "application"))).toBe(false);
  });

  it("refuses setStatus and addEvent through a job folder symlinked outside the workspace", () => {
    const root = ws();
    const { company_slug, id } = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const jobDir = layout(root).jobDir(company_slug, id);
    const jobJson = fs.readFileSync(path.join(jobDir, "job.json"));
    fs.rmSync(jobDir, { recursive: true, force: true });
    const outsideJobDir = tmpDir("careeros-outside-job-");
    fs.writeFileSync(path.join(outsideJobDir, "job.json"), jobJson);
    fs.symlinkSync(outsideJobDir, jobDir);

    expect(() => setStatus(root, company_slug, id, "Applied")).toThrow(/refusing to write outside the workspace/);
    expect(() => addEvent(root, company_slug, id, "Note", "x")).toThrow(/refusing to write outside the workspace/);
    expect(fs.readFileSync(path.join(outsideJobDir, "job.json"))).toEqual(jobJson);
  });

  it("falls back to copy+unlink when renameSync throws EXDEV, leaving src gone and dest populated", () => {
    const root = ws();
    const { company_slug, id } = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const src = path.join(tmpDir(), "resume.md");
    fs.writeFileSync(src, "# Alex Example\n");

    const originalRename = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      // Only the attach's own src->dest rename should see EXDEV; store.ts's
      // atomic tmp-file renames (same dir) must keep working normally.
      if (oldPath === src) {
        const err = new Error("cross-device link") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      return originalRename(oldPath, newPath);
    });
    try {
      const rel = attachFile(root, company_slug, id, src, { label: "Resume", subdir: "application", move: true });
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.readFileSync(path.join(layout(root).jobDir(company_slug, id), rel), "utf8")).toBe("# Alex Example\n");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("attachFile lock check", () => {
  it("never attaches from a locked folder, however the path is written", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root);
    const { company_slug, id } = newJob(root, { company: "Acme Corp", title: "AI Engineer" });
    const secret = path.join(root, "me", "identity", "visa.txt");
    fs.writeFileSync(secret, "Visa grant for Alex Example (fictional)");
    for (const src of [secret, path.join(root, "me", ".", "identity", "visa.txt"), path.join(root, "companies", "..", "me", "identity", "visa.txt")]) {
      expect(() => attachFile(root, company_slug, id, src, { label: "x" }), src).toThrow(/locked/);
    }
  });
});
