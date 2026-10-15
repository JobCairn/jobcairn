import fs from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { layout, readRecord } from "@careeros/core";
import { DEFAULT_RESUME_STYLE, type ResumeStyle } from "@careeros/contract";
import { dispatch } from "../src/dispatch.js";
import { renderDocx } from "../src/print/docx.js";
import { renderHtml } from "../src/print/html.js";
import { parseMarkdown } from "../src/print/markdown.js";
import { applyHandlers as A } from "../src/apply.js";
import { resumeHandlers as R, sha256, studioRequest } from "../src/resume.js";
import { minutes, openSample, tmpDir } from "./helpers.js";

const JOB = ["acme-corp", "2026-01-12-ai-engineer"] as const;
const REF = { kind: "job", company_slug: JOB[0], id: JOB[1] } as const;
const MD = [
  "# Alex Example", "", "AI Engineer · Sampletown NSW", "",
  "## Summary", "", "AI engineer who builds retrieval pipelines (fictional).", "",
  "## Experience", "", "### AI Engineer, Example Labs", "*2024 to now*", "",
  "- Built a retrieval pipeline.", "- Wrote tests.", "",
  "## Skills", "", "- Python, TypeScript", "",
].join("\n");

const appDir = (root: string) => path.join(layout(root).jobDir(...JOB), "application");
function withResume(opts: Parameters<typeof openSample>[0] = {}) {
  const x = openSample(opts);
  fs.mkdirSync(appDir(x.root), { recursive: true });
  fs.writeFileSync(path.join(appDir(x.root), "resume.md"), MD);
  return x;
}
const style = (over: Partial<ResumeStyle> = {}): ResumeStyle => ({ ...DEFAULT_RESUME_STYLE, ...over });
const studio = (root: string) => path.join(appDir(root), ".studio");
const sugPath = (root: string) => path.join(studio(root), "resume.suggested.md");
const writeSuggested = (root: string, text: string) => { fs.mkdirSync(studio(root), { recursive: true }); fs.writeFileSync(sugPath(root), text); };
const SUGGESTED = MD.replace("- Built a retrieval pipeline.", "- Built a retrieval pipeline for support answers.");

describe("resume load and autosave", () => {
  it("loads the Markdown, a default style and no versions", () => {
    const { ctx } = withResume();
    const s = R["resume.load"](ctx, REF, "resume.md");
    expect(s).toMatchObject({ markdown: MD, digest: sha256(MD), style: DEFAULT_RESUME_STYLE, versions: [], suggestion: null, suggestion_problem: null, title: "AI Engineer" });
  });

  it("saves atomically into the job's application folder, with the style beside it", () => {
    const { ctx, root } = withResume();
    const s0 = R["resume.load"](ctx, REF, "resume.md");
    const next = MD.replace("Wrote tests.", "Wrote unit tests.");
    const s1 = R["resume.save"](ctx, REF, "resume.md", next, style({ accent: "navy", hidden: ["skills"] }), s0.digest);
    expect(fs.readFileSync(path.join(appDir(root), "resume.md"), "utf8")).toBe(next);
    expect(JSON.parse(fs.readFileSync(path.join(studio(root), "resume.style.json"), "utf8"))).toMatchObject({ accent: "navy", hidden: ["skills"] });
    expect(s1.versions.map((v) => v.kind)).toEqual(["original"]);
    expect(fs.readdirSync(appDir(root)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(s1.digest).toBe(sha256(next));
  });

  it("refuses to save over a file that changed since it was loaded", () => {
    const { ctx, root } = withResume();
    const s0 = R["resume.load"](ctx, REF, "resume.md");
    fs.writeFileSync(path.join(appDir(root), "resume.md"), `${MD}\nClaude wrote this.\n`);
    expect(() => R["resume.save"](ctx, REF, "resume.md", "# Mine\n", style(), s0.digest)).toThrow(/changed outside the studio/);
    expect(fs.readFileSync(path.join(appDir(root), "resume.md"), "utf8")).toContain("Claude wrote this.");
  });

  it("writes only inside the job folder: names are validated, links and locked folders are refused", async () => {
    const { ctx, root } = withResume();
    const d = sha256(MD);
    await expect(dispatch(ctx, "resume.save", [REF, "../../jd.md", "x", style(), d, false])).rejects.toThrow(/invalid format/);
    await expect(dispatch(ctx, "resume.save", [REF, "resume.md", "x", { ...style(), accent: "red;}" }, d, false])).rejects.toThrow();
    // A resume.md that is a link to a file elsewhere is never read or written through.
    const outside = path.join(tmpDir(), "elsewhere.md");
    fs.writeFileSync(outside, MD);
    fs.rmSync(path.join(appDir(root), "resume.md"));
    fs.symlinkSync(outside, path.join(appDir(root), "resume.md"));
    expect(() => R["resume.load"](ctx, REF, "resume.md")).toThrow(/plain file/);
    expect(() => R["resume.save"](ctx, REF, "resume.md", "# Hacked\n", style(), d)).toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe(MD);
  });

  it("refuses an application folder that is a link out of the workspace", () => {
    const { ctx, root } = withResume();
    const elsewhere = tmpDir();
    fs.writeFileSync(path.join(elsewhere, "resume.md"), MD);
    fs.rmSync(appDir(root), { recursive: true });
    fs.symlinkSync(elsewhere, appDir(root));
    expect(() => R["resume.load"](ctx, REF, "resume.md")).toThrow(/isn't a plain folder/);
    expect(() => R["resume.save"](ctx, REF, "resume.md", "# Hacked\n", style(), sha256(MD))).toThrow(/isn't a plain folder/);
    expect(fs.readFileSync(path.join(elsewhere, "resume.md"), "utf8")).toBe(MD);
  });

  it("refuses a hard-linked resume (it could be a second name for a locked file)", () => {
    const { ctx, root } = withResume();
    const other = path.join(root, "me", "history", "copy.md");
    fs.linkSync(path.join(appDir(root), "resume.md"), other);
    expect(() => R["resume.load"](ctx, REF, "resume.md")).toThrow(/plain file/);
  });

  it("refuses a resume larger than 512 KB", () => {
    const { ctx, root } = withResume();
    fs.writeFileSync(path.join(appDir(root), "resume.md"), "x".repeat(513 * 1024));
    expect(() => R["resume.load"](ctx, REF, "resume.md")).toThrow(/512 KB/);
  });
});

describe("versions", () => {
  it("keeps the original, versions manual saves at most every 10 minutes, and restores", () => {
    const { ctx, root, setNow } = withResume();
    let s = R["resume.load"](ctx, REF, "resume.md");
    s = R["resume.save"](ctx, REF, "resume.md", `${MD}one\n`, style(), s.digest);
    setNow(minutes(5));
    s = R["resume.save"](ctx, REF, "resume.md", `${MD}two\n`, style(), s.digest);
    expect(s.versions.map((v) => v.kind)).toEqual(["original"]);
    setNow(minutes(11));
    s = R["resume.save"](ctx, REF, "resume.md", `${MD}three\n`, style(), s.digest);
    expect(s.versions.map((v) => v.kind)).toEqual(["manual", "original"]);
    expect(s.versions[0]!.at).toBe(minutes(11).toISOString());
    const original = s.versions[1]!.id;
    expect(R["resume.version"](ctx, REF, "resume.md", original)).toBe(MD);

    setNow(minutes(12));
    s = R["resume.restore"](ctx, REF, "resume.md", original, s.digest);
    expect(s.markdown).toBe(MD);
    expect(s.versions[0]!.kind).toBe("restore");
    expect(readRecord("job", layout(root).jobFile(...JOB)).timeline.at(-1)!.event).toBe("Resume restored");
    // Versions are hidden from the file list and read only through the services.
    expect(fs.readdirSync(path.join(appDir(root), ".versions", "resume.md")).length).toBe(3);
  });

  it("keeps an outside rewrite as a version when the person replaces it with their edits", () => {
    const { ctx, root, setNow } = withResume();
    let s = R["resume.load"](ctx, REF, "resume.md");
    s = R["resume.save"](ctx, REF, "resume.md", `${MD}mine\n`, style(), s.digest);
    const claude = "# Alex Example\n\n## Summary\n\nClaude rewrote this.\n";
    fs.writeFileSync(path.join(appDir(root), "resume.md"), claude);
    const after = R["resume.load"](ctx, REF, "resume.md");
    setNow(minutes(1));
    s = R["resume.save"](ctx, REF, "resume.md", `${MD}mine, kept\n`, style(), after.digest, true);
    expect(s.markdown).toBe(`${MD}mine, kept\n`);
    const replaced = s.versions.find((v) => v.kind === "replaced")!;
    expect(replaced).toBeTruthy();
    expect(R["resume.version"](ctx, REF, "resume.md", replaced.id)).toBe(claude);
  });

  it("says plainly when a version is gone", () => {
    const { ctx } = withResume();
    expect(() => R["resume.version"](ctx, REF, "resume.md", "20260115t090000000z-manual")).toThrow("That version isn't there any more.");
  });
});

describe("Claude's suggested rewrite", () => {
  it("shows application/.studio/resume.suggested.md as a suggestion for resume.md only", () => {
    const { ctx, root } = withResume();
    writeSuggested(root, SUGGESTED);
    const s = R["resume.load"](ctx, REF, "resume.md");
    expect(s.suggestion).toMatchObject({ markdown: SUGGESTED, older: false });
    expect(s.markdown).toBe(MD);
    fs.writeFileSync(path.join(appDir(root), "cover-letter.md"), "Dear team\n");
    expect(R["resume.load"](ctx, REF, "cover-letter.md").suggestion).toBeNull();
  });

  it("accepts it as the resume, versioned, and removes the suggestion", () => {
    const { ctx, root } = withResume();
    writeSuggested(root, SUGGESTED);
    const s0 = R["resume.load"](ctx, REF, "resume.md");
    expect(() => R["resume.suggestion"](ctx, REF, "resume.md", "accept", sha256("other"))).toThrow(/changed outside/);
    const s = R["resume.suggestion"](ctx, REF, "resume.md", "accept", s0.digest);
    expect(s.markdown).toBe(SUGGESTED);
    expect(s.versions.map((v) => v.kind)).toEqual(["ai", "original"]);
    expect(s.suggestion).toBeNull();
    expect(fs.existsSync(sugPath(root))).toBe(false);
    expect(readRecord("job", layout(root).jobFile(...JOB)).timeline.some((e) => e.event === "Resume updated")).toBe(true);
  });

  it("keep my edits saves Claude's version under Versions first; reject just deletes it", () => {
    const { ctx, root } = withResume();
    writeSuggested(root, SUGGESTED);
    let s = R["resume.load"](ctx, REF, "resume.md");
    s = R["resume.suggestion"](ctx, REF, "resume.md", "keep", s.digest);
    expect(s.markdown).toBe(MD);
    const replaced = s.versions.find((v) => v.kind === "replaced")!;
    expect(R["resume.version"](ctx, REF, "resume.md", replaced.id)).toBe(SUGGESTED);
    expect(s.suggestion).toBeNull();
    writeSuggested(root, SUGGESTED);
    s = R["resume.suggestion"](ctx, REF, "resume.md", "reject", s.digest);
    expect(s.markdown).toBe(MD);
    expect(s.versions.filter((v) => v.kind === "replaced")).toHaveLength(1);
    expect(fs.existsSync(sugPath(root))).toBe(false);
    expect(() => R["resume.suggestion"](ctx, REF, "resume.md", "reject", s.digest)).toThrow(/isn't there any more/);
  });

  it("says when the resume was saved after Claude wrote the suggestion", () => {
    const { ctx, root } = withResume();
    writeSuggested(root, SUGGESTED);
    fs.utimesSync(sugPath(root), minutes(0), minutes(0));
    fs.utimesSync(path.join(appDir(root), "resume.md"), minutes(5), minutes(5));
    expect(R["resume.load"](ctx, REF, "resume.md").suggestion!.older).toBe(true);
  });

  it("won't read a suggestion through a link", () => {
    const { ctx, root } = withResume();
    fs.mkdirSync(studio(root), { recursive: true });
    const outside = path.join(tmpDir(), "elsewhere.md");
    fs.writeFileSync(outside, "# Not the resume\n");
    fs.symlinkSync(outside, sugPath(root));
    const s = R["resume.load"](ctx, REF, "resume.md");
    expect(s.suggestion).toBeNull();
    expect(s.suggestion_problem).toMatch(/plain file/);
    expect(() => R["resume.suggestion"](ctx, REF, "resume.md", "accept", s.digest)).toThrow(/plain file/);
  });
});

describe("rewrite requests by position (studioRequest, used by the engine)", () => {
  const T = { kind: "job", company_slug: JOB[0], id: JOB[1] } as const;
  it("maps positions to the catalogue's ids against the saved file", () => {
    const { ctx, root } = withResume();
    expect(studioRequest(ctx, root, T, { options: { scope: "bullet", section_id: "s1", bullet_id: "b1" }, note: "RAG" }))
      .toEqual({ options: { scope: "bullet", section_id: "experience", bullet_id: "experience-2" }, note: "RAG" });
    expect(studioRequest(ctx, root, T, { options: { scope: "section", section_id: "s2" } }).options).toEqual({ scope: "section", section_id: "skills", bullet_id: "" });
    expect(studioRequest(ctx, root, T, {})).toEqual({});
  });

  it("refuses ids that no longer point at anything, or that aren't positions", () => {
    const { ctx, root } = withResume();
    expect(() => studioRequest(ctx, root, T, { options: { scope: "bullet", section_id: "s1", bullet_id: "b9" } })).toThrow(/changed/);
    expect(() => studioRequest(ctx, root, T, { options: { scope: "section", section_id: "s7" } })).toThrow(/changed/);
    expect(() => studioRequest(ctx, root, T, { options: { scope: "section", section_id: "experience" } })).toThrow(/Resume Studio/);
  });
});

describe("studio files stay out of the application (D1)", () => {
  it("keeps style and Claude's suggestion in application/.studio, so Apply lists only real files", () => {
    const { ctx, root } = withResume();
    for (const f of ["cover-letter.md", "answers.md"]) fs.writeFileSync(path.join(appDir(root), f), "x\n");
    fs.writeFileSync(path.join(appDir(root), "claims.json"), "[]");
    const s = R["resume.load"](ctx, REF, "resume.md");
    R["resume.save"](ctx, REF, "resume.md", MD, style({ accent: "navy", hidden: ["skills"] }), s.digest);
    writeSuggested(root, SUGGESTED);
    // Stray studio files left at the top level are still not application files.
    fs.writeFileSync(path.join(appDir(root), "resume-suggestions.json"), "[]");
    fs.writeFileSync(path.join(appDir(root), "resume.suggested.md"), SUGGESTED);
    expect(fs.existsSync(path.join(appDir(root), "resume.style.json"))).toBe(false);
    expect(fs.existsSync(path.join(studio(root), "resume.style.json"))).toBe(true);
    const names = A["apply.state"](ctx, ...JOB).files.map((f) => f.path).sort();
    expect(names).toEqual(["application/answers.md", "application/claims.json", "application/cover-letter.md", "application/resume.md"]);
  });
});

describe("downloads", { timeout: 60_000 }, () => {
  it("saves plain text through the save dialog: ATS-safe, hidden sections left out", async () => {
    const { ctx, host } = withResume();
    const s = R["resume.load"](ctx, REF, "resume.md");
    R["resume.save"](ctx, REF, "resume.md", MD.replace("- Wrote tests.", "• Wrote **unit** tests."), style({ hidden: ["skills"] }), s.digest);
    const r = await R["resume.download"](ctx, REF, "resume.md", "txt");
    expect(r).toEqual({ saved: true, name: "Alex Example - Acme Corp - Resume.txt" });
    const txt = new TextDecoder().decode(host.shell.saved[0]!.bytes);
    expect(txt).toContain("EXPERIENCE\n\nAI Engineer, Example Labs\n2024 to now\n- Built a retrieval pipeline.\n- Wrote unit tests.");
    expect(txt).not.toMatch(/[•*#]/);
    expect(txt).not.toContain("SKILLS");
  });

  it("says nothing was saved when the person cancels", async () => {
    const { ctx, host } = withResume();
    host.shell.saveAnswer = false;
    expect(await R["resume.download"](ctx, REF, "resume.md", "md")).toMatchObject({ saved: false });
  });

  it("prints the PDF with the style: page size, accent, layout and font", async () => {
    const { ctx, host } = withResume();
    const s = R["resume.load"](ctx, REF, "resume.md");
    R["resume.save"](ctx, REF, "resume.md", MD, style({ page: "letter", accent: "teal", font: "serif", layout: "modern", hidden: ["skills"] }), s.digest);
    await R["resume.download"](ctx, REF, "resume.md", "pdf");
    const html = host.printer.html[0]!;
    expect(html).toContain("@page { size: Letter;");
    expect(html).toContain("#0f4f54");
    // Dates sit on the entry's line, and an entry's head is kept with its first bullet.
    expect(html).toContain('<div class="keep">');
    expect(html).not.toContain("monospace");
    expect(html).toContain('font-family: "Instrument Serif"');
    expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:">');
    expect(html).not.toContain("Python, TypeScript");
    expect(host.shell.saved[0]!.name).toBe("Alex Example - Acme Corp - Resume.pdf");
  });

  it("copies Markdown or text to the clipboard", () => {
    const { ctx, host } = withResume();
    expect(R["resume.copy"](ctx, REF, "resume.md", "txt")).toBe(true);
    expect(host.shell.copied[0]).toContain("ALEX EXAMPLE");
  });

  it("docs.export follows resume.style.json too", async () => {
    const { ctx, host } = withResume();
    const s = R["resume.load"](ctx, REF, "resume.md");
    R["resume.save"](ctx, REF, "resume.md", MD, style({ page: "letter", hidden: ["skills"] }), s.digest);
    await dispatch(ctx, "docs.export", [...JOB, ["resume"], ["pdf"], false]);
    expect(host.printer.html[0]).toContain("size: Letter");
    expect(host.printer.html[0]).not.toContain("Python, TypeScript");
  });
});

describe("style in the renderers", () => {
  const doc = () => parseMarkdown(MD, "Alex Example - Resume");
  it("leaves the unstyled HTML as it was", () => {
    expect(renderHtml(doc(), null)).toContain("@page { size: A4; }");
    expect(renderHtml(doc(), null, style({ page: "letter" }))).toContain("@page { size: Letter; }");
    expect(renderHtml(doc(), null, style({ layout: "classic" }))).toContain("text-transform: uppercase");
    expect(renderHtml(doc(), null, style({ layout: "modern", headings: "plain" }))).not.toContain("text-transform: uppercase");
  });

  it("honours page size, accent and heading style in Word", async () => {
    const files = unzipSync(await renderDocx(doc(), style({ page: "letter", accent: "wine", font: "serif", density: "tight" })));
    const xml = strFromU8(files["word/document.xml"]!);
    const styles = strFromU8(files["word/styles.xml"]!);
    expect(xml).toContain('w:w="12240"');
    expect(xml).toContain('w:h="15840"');
    expect(xml).toContain("6b1e2e");
    expect(styles).toContain("Georgia");
    expect(styles).toContain("<w:caps/>");
    expect(styles).toContain('<w:sz w:val="20"/>'); // 10 pt body in half-points
    expect(xml).not.toMatch(/<w:tbl\b|<w:drawing\b/);
  });
});
