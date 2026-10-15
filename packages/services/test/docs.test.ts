import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { layout, readRecord } from "@careeros/core";
import { dispatch } from "../src/dispatch.js";
import { docsHandlers as X, MAX_EXPORT_RUNS } from "../src/docs.js";
import { strFromU8, unzipSync } from "fflate";
import { DEFAULT_RESUME_STYLE, TEMPLATE_PRESETS, type ResumeLayout } from "@careeros/contract";
import { renderResume } from "../src/resume.js";
import { openSample, tmpDir } from "./helpers.js";
import { RESUME } from "./print-fixtures.js";

const LABS = ["example-labs", "2026-01-12-backend-engineer-llm"] as const;
const appDir = (root: string) => path.join(layout(root).jobDir(...LABS), "application");

function withFiles() {
  const x = openSample();
  fs.mkdirSync(appDir(x.root), { recursive: true });
  fs.writeFileSync(path.join(appDir(x.root), "resume.md"), RESUME);
  fs.writeFileSync(path.join(appDir(x.root), "cover-letter.md"), "Dear hiring team,\n\nI would like to apply for this role (fictional).\n");
  return x;
}

// Exports parse in a worker thread; on a loaded machine that alone can take seconds.
describe("docs export", { timeout: 60_000 }, () => {
  it("reports sources and export files before anything is written", () => {
    const { ctx } = openSample();
    const s = X["docs.state"](ctx, ...LABS);
    expect(s.sources.map((x) => [x.source, x.exists])).toEqual([["resume", false], ["cover-letter", false]]);
    expect(s.files.map((f) => [f.name, f.exists])).toEqual([["resume.pdf", false], ["resume.docx", false], ["cover-letter.pdf", false], ["cover-letter.docx", false]]);
  });

  it("needs Claude's Markdown first", async () => {
    const { ctx } = openSample();
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["pdf"], false)).rejects.toThrow("application/resume.md isn't there yet. Prepare the application first.");
  });

  it("writes PDF and Word into application/export and logs it", async () => {
    const { ctx, root, host } = withFiles();
    const s = await X["docs.export"](ctx, ...LABS, ["resume", "cover-letter"], ["pdf", "docx"], false);
    expect(s.files.every((f) => f.exists && (f.size ?? 0) > 0)).toBe(true);
    const dir = path.join(appDir(root), "export");
    expect(fs.readdirSync(dir).sort()).toEqual(["cover-letter.docx", "cover-letter.pdf", "resume.docx", "resume.pdf"]);
    expect(fs.readFileSync(path.join(dir, "resume.pdf")).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(fs.readFileSync(path.join(dir, "resume.docx")).subarray(0, 2).toString("latin1")).toBe("PK");
    expect(host.printer.html[0]).toContain("Built retrieval pipelines with <strong>Python</strong>");
    expect(host.printer.html[0]).toContain("<title>Alex Example - Resume</title>");
    expect(host.printer.html[0]).not.toContain("tracker.example.com");
    expect(readRecord("job", layout(root).jobFile(...LABS)).timeline.at(-1)).toMatchObject({ event: "Exported", note: "resume.pdf, resume.docx, cover-letter.pdf, cover-letter.docx" });
  });

  it("refuses to replace files without overwrite, then replaces them", async () => {
    const { ctx } = withFiles();
    await X["docs.export"](ctx, ...LABS, ["resume"], ["pdf"], false);
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["pdf", "docx"], false)).rejects.toThrow("Already exported: resume.pdf. Choose Replace to write them again.");
    const s = await X["docs.export"](ctx, ...LABS, ["resume"], ["pdf", "docx"], true);
    expect(s.files.filter((f) => f.exists).map((f) => f.name)).toEqual(["resume.pdf", "resume.docx"]);
  });

  it("refuses a linked export folder, and writes nothing when the printer returns junk", async () => {
    const { ctx, root, host } = withFiles();
    fs.symlinkSync(tmpDir(), path.join(appDir(root), "export"));
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).rejects.toThrow(/application\/export must be a plain folder/);
    fs.rmSync(path.join(appDir(root), "export"));
    host.printer.toPdf = async () => new TextEncoder().encode("<html>not a pdf</html>");
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["pdf"], false)).rejects.toThrow("The PDF export failed. Nothing was written for it.");
    expect(fs.existsSync(path.join(appDir(root), "export", "resume.pdf"))).toBe(false);
  });

  it("makes Word files without a printer, but not PDFs", async () => {
    const { ctx } = withFiles();
    delete ctx.host.printer;
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["pdf"], false)).rejects.toThrow("PDF export isn't available here.");
    expect((await X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).files.find((f) => f.name === "resume.docx")?.exists).toBe(true);
  });

  it("is validated and announced through dispatch", async () => {
    const { ctx } = withFiles();
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    await expect(dispatch(ctx, "docs.export", [...LABS, ["resume"], ["html"], false])).rejects.toThrow(/must be one of: pdf, docx/);
    await dispatch(ctx, "docs.export", [...LABS, ["resume"], ["docx"], false]);
    expect(seen).toEqual([["jobs"]]);
  });

  it("refuses an application or export folder that is a link or a file", async () => {
    const { ctx, root } = withFiles();
    const exp = path.join(appDir(root), "export");
    fs.writeFileSync(exp, "not a folder");
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).rejects.toThrow(/application\/export must be a plain folder/);
    fs.rmSync(exp);
    // A linked application folder: the real one moves away and a link takes its place.
    const real = path.join(tmpDir(), "application");
    fs.renameSync(appDir(root), real);
    fs.symlinkSync(real, appDir(root));
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).rejects.toThrow(/application\/resume\.md isn't there yet|application must be a plain folder/);
    expect(fs.existsSync(path.join(real, "export"))).toBe(false);
  });

  it("refuses to write into a locked folder that was moved to where the export folder goes", async () => {
    const { ctx, root, host } = withFiles();
    expect(host.state.value.lockIds?.[root]?.["me/identity"]).toBeTruthy();
    const exp = path.join(appDir(root), "export");
    fs.renameSync(path.join(root, "me", "identity"), exp);
    const before = fs.readdirSync(exp).sort();
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).rejects.toThrow(/application\/export must be a plain folder/);
    expect(fs.readdirSync(exp).sort()).toEqual(before);
  });

  it("reads the sources only through the workspace read checks", async () => {
    const { ctx, root } = withFiles();
    const resume = path.join(appDir(root), "resume.md");
    // A second name for a file (it could be a locked file under another name) is refused.
    fs.rmSync(resume);
    fs.writeFileSync(path.join(root, "me", "identity", "notes.md"), "# Private (fictional)\n");
    fs.linkSync(path.join(root, "me", "identity", "notes.md"), resume);
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).rejects.toThrow(/is locked|linked to another file/);
    // A symbolic link is not a resume.
    fs.rmSync(resume);
    fs.symlinkSync(path.join(root, "me", "identity", "notes.md"), resume);
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).rejects.toThrow("application/resume.md isn't there yet.");
    expect(fs.existsSync(path.join(appDir(root), "export", "resume.docx"))).toBe(false);
  });

  it("refuses sources that are too large or have too many blocks", async () => {
    const { ctx, root } = withFiles();
    const resume = path.join(appDir(root), "resume.md");
    fs.writeFileSync(resume, "a".repeat(512 * 1024 + 1));
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).rejects.toThrow("application/resume.md is larger than 512 KB, so it wasn't exported.");
    fs.writeFileSync(resume, "- x\n".repeat(2001));
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).rejects.toThrow("application/resume.md has more than 2000 headings, paragraphs and bullets, so it wasn't exported.");
    expect(fs.existsSync(path.join(appDir(root), "export", "resume.docx"))).toBe(false);
  });

  it("writes nothing at all, and logs nothing, when one print fails", async () => {
    const { ctx, root, host } = withFiles();
    const events = readRecord("job", layout(root).jobFile(...LABS)).timeline.length;
    let n = 0;
    host.printer.toPdf = async () => new TextEncoder().encode(n++ === 0 ? "%PDF-1.7 ok" : "junk");
    await expect(X["docs.export"](ctx, ...LABS, ["resume", "cover-letter"], ["pdf", "docx"], false)).rejects.toThrow("The PDF export failed.");
    expect(fs.readdirSync(path.join(appDir(root), "export"))).toEqual([]);
    expect(readRecord("job", layout(root).jobFile(...LABS)).timeline).toHaveLength(events);
  });

  it("writes owner-only files", async () => {
    const { ctx, root } = withFiles();
    await X["docs.export"](ctx, ...LABS, ["cover-letter"], ["pdf", "docx"], false);
    for (const f of ["cover-letter.pdf", "cover-letter.docx"]) expect(fs.statSync(path.join(appDir(root), "export", f)).mode & 0o777).toBe(0o600);
  });

  it("refuses a document with more inline runs than the cap, and exports one at the cap", async () => {
    const { ctx, root } = withFiles();
    const at = Array.from({ length: MAX_EXPORT_RUNS / 2 }, () => "a **b**").join(" ");
    fs.writeFileSync(path.join(appDir(root), "resume.md"), `${at} a`);
    await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).rejects.toThrow("application/resume.md is too complex to export. Simplify its formatting and try again.");
    fs.writeFileSync(path.join(appDir(root), "resume.md"), at);
    expect((await X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false)).files.find((f) => f.name === "resume.docx")?.exists).toBe(true);
  });

  it("is all or nothing: a failure on the second file leaves no new files and no event", async () => {
    const { ctx, root } = withFiles();
    const dir = path.join(appDir(root), "export");
    const events = () => readRecord("job", layout(root).jobFile(...LABS)).timeline.length;
    const before = events();
    const realLink = fs.linkSync;
    const spy = vi.spyOn(fs, "linkSync").mockImplementation((src, dest) => {
      if (String(dest).endsWith(`${path.sep}resume.docx`)) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return realLink(src, dest);
    });
    try {
      await expect(X["docs.export"](ctx, ...LABS, ["resume", "cover-letter"], ["pdf", "docx"], false)).rejects.toThrow();
    } finally { spy.mockRestore(); }
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(events()).toBe(before);
  });

  it("keeps the earlier files when a replacing export fails part way", async () => {
    const { ctx, root, host } = withFiles();
    const dir = path.join(appDir(root), "export");
    await X["docs.export"](ctx, ...LABS, ["resume"], ["pdf", "docx"], false);
    const old = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
    const events = readRecord("job", layout(root).jobFile(...LABS)).timeline.length;
    host.printer.toPdf = async () => new TextEncoder().encode("%PDF-1.7 a different print");
    const realLink = fs.linkSync;
    const spy = vi.spyOn(fs, "linkSync").mockImplementation((src, dest) => {
      if (String(dest).endsWith(`${path.sep}resume.docx`)) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return realLink(src, dest);
    });
    try {
      await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["pdf", "docx"], true)).rejects.toThrow();
    } finally { spy.mockRestore(); }
    expect(fs.readdirSync(dir).sort()).toEqual(["resume.docx", "resume.pdf"]);
    for (const [f, bytes] of Object.entries(old)) expect(fs.readFileSync(path.join(dir, f)).equals(bytes)).toBe(true);
    expect(readRecord("job", layout(root).jobFile(...LABS)).timeline).toHaveLength(events);
  });

  it("refuses a folder at an export name, with or without Replace, and leaves it alone", async () => {
    const { ctx, root } = withFiles();
    const dir = path.join(appDir(root), "export");
    fs.mkdirSync(path.join(dir, "resume.pdf"), { recursive: true });
    fs.writeFileSync(path.join(dir, "resume.pdf", "note.txt"), "keep me (fictional)");
    const st = X["docs.state"](ctx, ...LABS);
    expect(st.files.find((f) => f.name === "resume.pdf")).toMatchObject({ exists: false, problem: "application/export/resume.pdf is a folder or link. Move it and try again." });
    expect(st.files.find((f) => f.name === "resume.docx")?.problem).toBeNull();
    for (const overwrite of [false, true]) {
      await expect(X["docs.export"](ctx, ...LABS, ["resume"], ["pdf", "docx"], overwrite)).rejects.toThrow("application/export/resume.pdf is a folder or link. Move it and try again.");
      expect(fs.readFileSync(path.join(dir, "resume.pdf", "note.txt"), "utf8")).toBe("keep me (fictional)");
      expect(fs.readdirSync(dir).sort()).toEqual(["resume.pdf"]);
    }
  });

  it("refuses a link or a dangling link at an export name, and names no internal file", async () => {
    const { ctx, root } = withFiles();
    const dir = path.join(appDir(root), "export");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(tmpDir(), "elsewhere.pdf");
    fs.writeFileSync(target, "outside (fictional)");
    for (const [name, to] of [["resume.pdf", target], ["resume.docx", path.join(tmpDir(), "gone.docx")]] as const) {
      fs.symlinkSync(to, path.join(dir, name));
      for (const overwrite of [false, true]) {
        const err = await X["docs.export"](ctx, ...LABS, ["resume"], ["pdf", "docx"], overwrite).then(() => null, (e: Error) => e);
        expect(err?.message).toMatch(/^application\/export\/resume\.(pdf|docx) is a folder or link\. Move it and try again\.$/);
        expect(err?.message).not.toMatch(/\.tmp|export-/);
      }
      expect(fs.readlinkSync(path.join(dir, name))).toBe(to);
      fs.rmSync(path.join(dir, name));
    }
    expect(fs.readFileSync(target, "utf8")).toBe("outside (fictional)");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("sweeps only another run's leftover temp and backup files from application/export", async () => {
    const { ctx, root } = withFiles();
    const dir = path.join(appDir(root), "export");
    fs.mkdirSync(dir, { recursive: true });
    const other = process.pid + 1;
    const stale = [`.resume.pdf.export-${other}-0a1b2c3d.tmp`, `.cover-letter.docx.backup-${other}-deadbeef`];
    for (const f of stale) fs.writeFileSync(path.join(dir, f), "leftover");
    const keep = [
      `.resume.pdf.export-${process.pid}-0a1b2c3d.tmp`, // this process: maybe in use
      `.resume.pdf.export-${other}-0a1b2c3.tmp`, // not the exact pattern (7 hex digits)
      `.notes.md.export-${other}-0a1b2c3d.tmp`,
      "notes.txt",
    ];
    for (const f of keep) fs.writeFileSync(path.join(dir, f), "user");
    fs.mkdirSync(path.join(dir, `.resume.docx.backup-${other}-0a1b2c3d`)); // a folder: never touched
    fs.writeFileSync(path.join(dir, `.resume.docx.backup-${other}-0a1b2c3d`, "inside.txt"), "user");
    const outside = path.join(tmpDir(), "outside.txt");
    fs.writeFileSync(outside, "user");
    fs.symlinkSync(outside, path.join(dir, `.cover-letter.pdf.export-${other}-0a1b2c3d.tmp`)); // a link: never touched
    const linked = path.join(tmpDir(), "linked.txt");
    fs.writeFileSync(linked, "user");
    fs.linkSync(linked, path.join(dir, `.cover-letter.pdf.backup-${other}-11112222`)); // a second name: never touched
    await X["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false);
    const left = fs.readdirSync(dir).sort();
    for (const f of stale) expect(left).not.toContain(f);
    expect(left).toEqual([...keep, `.resume.docx.backup-${other}-0a1b2c3d`, `.cover-letter.pdf.export-${other}-0a1b2c3d.tmp`, `.cover-letter.pdf.backup-${other}-11112222`, "resume.docx"].sort());
    expect(fs.readFileSync(path.join(dir, `.resume.docx.backup-${other}-0a1b2c3d`, "inside.txt"), "utf8")).toBe("user");
    expect(fs.readFileSync(outside, "utf8")).toBe("user");
  });

  describe("with a Resume Studio style", () => {
    const REF = { kind: "job", company_slug: LABS[0], id: LABS[1] } as const;
    // Short sections (skills, education) so two-column templates fill their side column.
    const STYLED_RESUME = [
      "# Alex Example", "", "AI Engineer", "", "Sampletown NSW · alex@example.com · 0491 570 006", "",
      "## Summary", "", "AI engineer who builds retrieval pipelines (fictional).", "",
      "## Experience", "", "### AI Engineer, Example Labs", "*2024 to now*", "", "- Built a retrieval pipeline.", "- Wrote tests.", "",
      "### Developer, Acme Corp", "*2021 to 2024*", "", "- Shipped an internal tool.", "",
      "## Skills", "", "- **Languages:** Python, TypeScript", "- **Tools:** Docker, Postgres", "",
      "## Education", "", "### BSc Computer Science, Example University", "*2020*", "",
    ].join("\n");
    function styled(layout: ResumeLayout) {
      const x = withFiles();
      fs.writeFileSync(path.join(appDir(x.root), "resume.md"), STYLED_RESUME);
      const studio = path.join(appDir(x.root), ".studio");
      fs.mkdirSync(studio, { recursive: true });
      fs.writeFileSync(path.join(studio, "resume.style.json"), JSON.stringify({ ...DEFAULT_RESUME_STYLE, ...TEMPLATE_PRESETS[layout], layout, accent: "navy" }));
      return x;
    }
    const wordParts = (bytes: Uint8Array) => {
      const z = unzipSync(bytes);
      return [strFromU8(z["word/document.xml"]!), strFromU8(z["word/styles.xml"]!), strFromU8(z["word/numbering.xml"] ?? new Uint8Array())];
    };

    it.each(["scholar", "banner", "sidebar"] as const)("exports %s exactly as the Studio downloads it", async (layout) => {
      const { ctx, root, host } = styled(layout);
      await X["docs.export"](ctx, ...LABS, ["resume"], ["pdf", "docx"], false);
      const studioPdf = await renderResume(ctx, REF, "resume.md", "pdf");
      const studioDocx = await renderResume(ctx, REF, "resume.md", "docx");
      expect(host.printer.html).toHaveLength(2);
      expect(host.printer.html[0]).toBe(host.printer.html[1]);
      expect(host.printer.html[0]).toContain('class="name');
      const exported = new Uint8Array(fs.readFileSync(path.join(appDir(root), "export", "resume.docx")));
      expect(wordParts(exported)).toEqual(wordParts(studioDocx.bytes));
      expect(studioPdf.bytes.length).toBeGreaterThan(0);
    });

    it("uses the two-column layout for a two-column template", async () => {
      const { ctx, host } = styled("sidebar");
      await X["docs.export"](ctx, ...LABS, ["resume"], ["pdf", "docx"], false);
      expect(host.printer.html[0]).toMatch(/class="main"/);
      expect(host.printer.html[0]).toMatch(/class="side"/);
    });

    it("keeps the plain one-column page when there is no style file, and the cover letter on the Markdown path", async () => {
      const { ctx, host } = withFiles();
      await X["docs.export"](ctx, ...LABS, ["resume", "cover-letter"], ["pdf"], false);
      expect(host.printer.html[0]).toContain("@page { size: A4; }");
      const s = styled("scholar");
      await X["docs.export"](s.ctx, ...LABS, ["resume", "cover-letter"], ["pdf"], false);
      expect(s.host.printer.html[1]).toContain("@page { size: A4; }");
      expect(s.host.printer.html[1]).not.toContain('class="name');
    });
  });
});
