import { describe, expect, it } from "vitest";
import {
  ACTIONS, actionPaths, buildActionPrompt, DEFAULT_RESUME_STYLE, diffLines, diffWords, pagesFor, parseResumeStyle, parseResume, resumeTheme,
  rewriteOptions, rewriteOptionsFor, sectionSlug, studioOutputs, studioRewriteOptions, STUDIO_DIR, SUGGESTED_NAME, validateArgs, validateRequest,
  outputNames, type ActionId, type ActionTarget,
} from "../src/index.js";

const ACME: ActionTarget = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };

describe("rewrite request ids", () => {
  const M = "# Alex Example\n\n- header bullet\n\n## Summary\n\nText.\n\n## Work **Experience**\n\n### Role\n\n- First **one**.\n- Second.\n";
  it("maps editor nodes to positions; the header has none", () => {
    const m = parseResume(M);
    const exp = m.sections[1]!;
    const second = exp.blocks.flatMap((b) => (b.kind === "text" ? [] : b.bullets))[1]!;
    const head = m.header.blocks.flatMap((b) => (b.kind === "text" ? [] : b.bullets))[0]!;
    expect(rewriteOptionsFor(m, exp.id)).toEqual({ scope: "section", section_id: "s1" });
    expect(rewriteOptionsFor(m, second.id)).toEqual({ scope: "bullet", section_id: "s1", bullet_id: "b1" });
    expect(rewriteOptionsFor(m, head.id)).toBeNull();
    expect(rewriteOptionsFor(m, "nope")).toBeNull();
  });

  it("maps positions to the catalogue's ids against a fresh parse of the saved file", () => {
    const fresh = parseResume(M); // different node ids, same positions
    expect(studioRewriteOptions(fresh, { scope: "resume" })).toEqual({ scope: "resume", section_id: "", bullet_id: "" });
    expect(studioRewriteOptions(fresh, { scope: "section", section_id: "s1" })).toEqual({ scope: "section", section_id: "work-experience", bullet_id: "" });
    expect(studioRewriteOptions(fresh, { scope: "bullet", section_id: "s1", bullet_id: "b1" })).toEqual({ scope: "bullet", section_id: "work-experience", bullet_id: "work-experience-2" });
    expect(() => studioRewriteOptions(fresh, { scope: "section", section_id: "s9" })).toThrow(/changed/);
    expect(() => studioRewriteOptions(fresh, { scope: "bullet", section_id: "s1", bullet_id: "b7" })).toThrow(/changed/);
    // The mapped ids pass the catalogue's own checks.
    expect(() => validateRequest("rewrite_resume", { options: studioRewriteOptions(fresh, { scope: "bullet", section_id: "s1", bullet_id: "b0" }) }, outputNames("rewrite_resume"))).not.toThrow();
  });

  it("slugs headings the catalogue's way and refuses ones that can't name a section", () => {
    expect(sectionSlug("Projects & Open Source")).toBe("projects-open-source");
    expect(sectionSlug("Expérience")).toBe("experience");
    const twin = parseResume("# A\n\n## Skills\n\n- x\n\n## skills\n\n- y\n");
    expect(() => studioRewriteOptions(twin, { scope: "section", section_id: "s0" })).toThrow(/same heading/);
    const blank = parseResume("# A\n\n## ***\n\n- x\n");
    expect(() => studioRewriteOptions(blank, { scope: "section", section_id: "s0" })).toThrow(/plain heading/);
  });

  it("checks the positional options", () => {
    const ok = (o: unknown) => () => rewriteOptions(o, "options");
    expect(ok({ scope: "resume" })).not.toThrow();
    expect(ok({ scope: "bullet", section_id: "s1", bullet_id: "b0" })).not.toThrow();
    expect(ok({ scope: "bullet", section_id: "s1" })).toThrow();
    expect(ok({ scope: "section" })).toThrow();
    expect(ok({ scope: "section", section_id: "experience" })).toThrow();
    expect(ok({ scope: "section", section_id: "header" })).toThrow();
    expect(ok({ scope: "resume", section_id: "s1" })).toThrow();
  });
});

describe("rewrite_resume and the studio folder", () => {
  it("writes its suggestion to application/.studio/resume.suggested.md", () => {
    const out = actionPaths("rewrite_resume", ACME, {}).outputs;
    expect(out).toEqual([`companies/acme-corp/jobs/2026-01-12-ai-engineer/application/${STUDIO_DIR}/${SUGGESTED_NAME}`]);
    expect(studioOutputs("rewrite_resume", out)).toEqual(out);
  });

  it("gives the .studio exception to no other action and no other path", () => {
    const studio = "companies/acme-corp/jobs/2026-01-12-ai-engineer/application/.studio/resume.suggested.md";
    for (const id of Object.keys(ACTIONS) as ActionId[]) if (id !== "rewrite_resume") expect(studioOutputs(id, [studio]), id).toEqual([]);
    expect(studioOutputs("rewrite_resume", [
      "companies/acme-corp/jobs/2026-01-12-ai-engineer/application/.studio/other.md",
      "companies/acme-corp/jobs/2026-01-12-ai-engineer/.studio/resume.suggested.md",
      "companies/acme-corp/jobs/x/application/.studio/../../x/application/.studio/resume.suggested.md",
      "companies/acme-corp/.git/application/.studio/resume.suggested.md",
      ".studio/resume.suggested.md",
    ])).toEqual([]);
  });

  it("never adds visa text unless the candidate needs sponsorship and the note asks for it", () => {
    const no = "Don't add anything about visas, sponsorship or work rights.";
    const p = (work_rights: "citizen" | "needs_sponsorship" | "unknown", note: string) =>
      buildActionPrompt("rewrite_resume", ACME, { title: "AI Engineer", company: "Acme Corp", now: "2026-10-10T00:00:00.000Z", work_rights }, { options: { scope: "resume" }, note });
    expect(p("citizen", "Mention my visa")).toContain(no);
    expect(p("unknown", "Mention my visa")).toContain(no);
    expect(p("needs_sponsorship", "Tighten the summary")).toContain(no);
    expect(p("needs_sponsorship", "Say I need sponsorship")).not.toContain(no);
    expect(p("needs_sponsorship", "Say I need sponsorship")).toContain("Mention visas or sponsorship only where my note asks for it");
    expect(buildActionPrompt("rewrite_resume", ACME, { title: "AI Engineer", company: "Acme Corp", now: "2026-10-10T00:00:00.000Z" })).toContain(no);
  });
});

describe("style", () => {
  it("falls back to defaults for anything unknown", () => {
    expect(parseResumeStyle({ layout: "x", accent: "red;}body{", hidden: ["Skills", 3, "a\nb"] })).toEqual({ ...DEFAULT_RESUME_STYLE, hidden: ["Skills"] });
    expect(parseResumeStyle(null)).toEqual(DEFAULT_RESUME_STYLE);
  });
  it("maps choices to a theme", () => {
    const t = resumeTheme({ ...DEFAULT_RESUME_STYLE, accent: "navy", density: "tight", page: "letter" });
    expect(t.accent).toBe("#1f3a5f");
    expect(t.page.css).toBe("Letter");
    expect(t.basePt).toBeLessThan(resumeTheme(DEFAULT_RESUME_STYLE).basePt);
  });
  it("counts pages", () => {
    expect(pagesFor(0, DEFAULT_RESUME_STYLE)).toBe(1);
    expect(pagesFor(900, DEFAULT_RESUME_STYLE)).toBe(1);
    expect(pagesFor(1000, DEFAULT_RESUME_STYLE)).toBe(2);
    expect(pagesFor(2500, DEFAULT_RESUME_STYLE)).toBe(3);
  });
  it("validates style and scope arguments at the bridge", () => {
    const style = { ...DEFAULT_RESUME_STYLE };
    const d = "a".repeat(64);
    expect(() => validateArgs("resume.save", [{ kind: "job", company_slug: "acme-corp", id: "x" }, "resume.md", "# A\n", style, d, false])).not.toThrow();
    expect(() => validateArgs("resume.save", [{ kind: "job", company_slug: "acme-corp", id: "x" }, "../resume.md", "# A\n", style, d, false])).toThrow();
    expect(() => validateArgs("resume.save", [{ kind: "job", company_slug: "acme-corp", id: "x" }, "resume.md", "# A\n", { ...style, accent: "#ff0000" }, d, false])).toThrow();
    const sg = (d: unknown) => () => validateArgs("resume.suggestion", [{ kind: "job", company_slug: "acme-corp", id: "x" }, "resume.md", d, "a".repeat(64)]);
    expect(sg("accept")).not.toThrow();
    expect(sg("keep")).not.toThrow();
    expect(sg("accept all")).toThrow();
    expect(() => validateArgs("resume.download", [{ kind: "job", company_slug: "acme-corp", id: "x" }, "resume.md", "exe"])).toThrow();
  });
});

describe("diff", () => {
  it("diffs lines and words", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([{ op: "same", text: "a" }, { op: "del", text: "b" }, { op: "add", text: "B" }, { op: "same", text: "c" }]);
    expect(diffWords("Wrote tests.", "Wrote unit tests.")).toEqual([{ op: "same", text: "Wrote " }, { op: "add", text: "unit " }, { op: "same", text: "tests." }]);
  });
});
