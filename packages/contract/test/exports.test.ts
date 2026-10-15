import { describe, expect, it } from "vitest";
import { actionPaths, EXPORT_FORMATS, EXPORT_SOURCES, exportRel, exportSourceRel, relPath, validateArgs } from "../src/index.js";

describe("exports", () => {
  it("names the sources and the export files inside the job's application folder", () => {
    expect(exportSourceRel("acme-corp", "2026-01-12-ai-engineer", "cover-letter")).toBe("companies/acme-corp/jobs/2026-01-12-ai-engineer/application/cover-letter.md");
    expect(exportRel("acme-corp", "2026-01-12-ai-engineer", "resume", "pdf")).toBe("companies/acme-corp/jobs/2026-01-12-ai-engineer/application/export/resume.pdf");
    for (const s of EXPORT_SOURCES) for (const f of EXPORT_FORMATS) expect(() => relPath(exportRel("acme-corp", "x", s, f), "path")).not.toThrow();
  });
  it("validates export calls", () => {
    expect(validateArgs("docs.export", ["acme-corp", "2026-01-12-ai-engineer", ["resume"], ["pdf", "docx"], false])).toHaveLength(5);
    expect(() => validateArgs("docs.export", ["acme-corp", "x", ["resume"], ["html"], false])).toThrow(/must be one of: pdf, docx/);
    expect(() => validateArgs("docs.export", ["acme-corp", "x", ["../../me/identity/passport"], ["pdf"], false])).toThrow(/must be one of: resume, cover-letter/);
    expect(() => validateArgs("docs.export", ["acme-corp", "x", [], ["pdf"], false])).toThrow(/at least 1/);
    expect(() => validateArgs("docs.export", ["acme-corp", "x", ["resume"], ["pdf"], "yes"])).toThrow(/true or false/);
    expect(() => validateArgs("docs.state", ["acme-corp"])).toThrow(/expected 2 argument/);
  });
  it("exports exactly the Markdown the tailor action asks Claude to write", () => {
    const job = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
    const outputs = actionPaths("tailor_application", job, { title: "AI Engineer", company: "Acme Corp", now: "2026-01-15T09:00:00.000Z" }).outputs;
    for (const s of EXPORT_SOURCES) expect(outputs).toContain(exportSourceRel(job.company_slug, job.id, s));
    expect(outputs.filter((o) => o.endsWith(".md"))).toEqual(EXPORT_SOURCES.map((s) => exportSourceRel(job.company_slug, job.id, s)));
  });
});

