import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { fileInboxItem, listInbox } from "../src/inbox.js";
import { newJob } from "../src/jobs.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }
const drop = (root: string, name: string) => fs.writeFileSync(path.join(layout(root).inbox, name), "x");

describe("inbox", () => {
  it("lists dropped files only", () => {
    const root = ws();
    drop(root, "cv.pdf"); drop(root, ".DS_Store");
    expect(listInbox(root)).toEqual(["cv.pdf"]);
  });
  it("files into me/ folders, avoids overwrite, and logs it", () => {
    const root = ws();
    fs.writeFileSync(path.join(layout(root).me("resumes"), "cv.pdf"), "old");
    drop(root, "cv.pdf");
    const r = fileInboxItem(root, "cv.pdf", { kind: "me", dir: "resumes" }, "resume from 2025", { now: FIXED });
    expect(r.to).toBe(path.join("me", "resumes", "cv-2.pdf"));
    expect(listInbox(root)).toEqual([]);
    expect(fs.readFileSync(path.join(layout(root).inbox, "_filed.md"), "utf8")).toContain("cv.pdf -> me/resumes/cv-2.pdf | resume from 2025");
  });
  it("files into a sub-folder of me/ and into a job", () => {
    const root = ws();
    drop(root, "visa-grant.pdf");
    expect(fileInboxItem(root, "visa-grant.pdf", { kind: "me", dir: "identity", sub: "visa" }).to).toBe(path.join("me", "identity", "visa", "visa-grant.pdf"));
    const j = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    drop(root, "offer.pdf");
    fileInboxItem(root, "offer.pdf", { kind: "job", company_slug: j.company_slug, id: j.id, subdir: "emails" }, "", { now: FIXED });
    expect(readRecord("job", layout(root).jobFile(j.company_slug, j.id)).files.map((f) => f.path)).toContain("emails/offer.pdf");
  });
  it("rejects traversal, hidden names, the log file and missing files", () => {
    const root = ws();
    for (const bad of ["../workspace.json", "a/b.pdf", ".env", "_filed.md"]) {
      expect(() => fileInboxItem(root, bad, { kind: "me", dir: "resumes" })).toThrow(/not an inbox file/);
    }
    expect(() => fileInboxItem(root, "nope.pdf", { kind: "me", dir: "resumes" })).toThrow(/not in the inbox/);
    drop(root, "x.pdf");
    expect(() => fileInboxItem(root, "x.pdf", { kind: "me", dir: "resumes", sub: "../../.." })).toThrow(/unsafe/);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a source that is a symlink in inbox/ pointing outside the workspace", () => {
    const root = ws();
    const outside = tmpDir("careeros-outside-");
    const outsideFile = path.join(outside, "secret.pdf");
    fs.writeFileSync(outsideFile, "secret");
    const link = path.join(layout(root).inbox, "link.pdf");
    fs.symlinkSync(outsideFile, link);

    expect(() => fileInboxItem(root, "link.pdf", { kind: "me", dir: "resumes" })).toThrow(/not in the inbox/);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("secret");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("refuses a source that is a directory in inbox/", () => {
    const root = ws();
    fs.mkdirSync(path.join(layout(root).inbox, "folder"));
    expect(() => fileInboxItem(root, "folder", { kind: "me", dir: "resumes" })).toThrow(/not in the inbox/);
  });

  it("refuses a me/ dest dir that is a symlink to outside the workspace", () => {
    const root = ws();
    const outside = tmpDir("careeros-outside-");
    fs.rmdirSync(layout(root).me("resumes"));
    fs.symlinkSync(outside, layout(root).me("resumes"));
    drop(root, "cv.pdf");

    expect(() => fileInboxItem(root, "cv.pdf", { kind: "me", dir: "resumes" })).toThrow(/refusing to file outside/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a job target whose destination subdir is a symlink to outside the workspace", () => {
    const root = ws();
    const outside = tmpDir("careeros-outside-");
    const j = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const jobDir = path.dirname(layout(root).jobFile(j.company_slug, j.id));
    fs.symlinkSync(outside, path.join(jobDir, "emails"));
    drop(root, "offer.pdf");

    expect(() =>
      fileInboxItem(root, "offer.pdf", { kind: "job", company_slug: j.company_slug, id: j.id, subdir: "emails" }),
    ).toThrow(/refusing to file outside/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("falls back to copy+unlink on EXDEV, and leaves the source in place if the copy also fails", () => {
    const root = ws();
    drop(root, "cv.pdf");
    const src = path.join(layout(root).inbox, "cv.pdf");
    const exdev = () => {
      const e = new Error("cross-device link") as NodeJS.ErrnoException;
      e.code = "EXDEV";
      return e;
    };

    vi.spyOn(fs, "renameSync").mockImplementation((from) => {
      if (from === src) throw exdev();
      throw new Error(`unexpected renameSync(${String(from)})`);
    });

    const r = fileInboxItem(root, "cv.pdf", { kind: "me", dir: "resumes" });
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(path.join(root, r.to), "utf8")).toBe("x");
    vi.restoreAllMocks();

    drop(root, "cv2.pdf");
    const src2 = path.join(layout(root).inbox, "cv2.pdf");
    vi.spyOn(fs, "renameSync").mockImplementation((from) => {
      if (from === src2) throw exdev();
      throw new Error(`unexpected renameSync(${String(from)})`);
    });
    vi.spyOn(fs, "copyFileSync").mockImplementation((from) => {
      if (from === src2) throw new Error("copy failed");
      throw new Error(`unexpected copyFileSync(${String(from)})`);
    });

    expect(() => fileInboxItem(root, "cv2.pdf", { kind: "me", dir: "resumes" })).toThrow(/copy failed/);
    expect(fs.existsSync(src2)).toBe(true);
  });

  it("refuses to append through a symlinked _filed.md log pointing outside the workspace (I1)", () => {
    const root = ws();
    const outside = tmpDir("careeros-outside-");
    const outsideFile = path.join(outside, "_filed.md");
    fs.writeFileSync(outsideFile, "EXISTING\n");
    fs.symlinkSync(outsideFile, path.join(layout(root).inbox, "_filed.md"));
    drop(root, "cv.pdf");

    expect(() => fileInboxItem(root, "cv.pdf", { kind: "me", dir: "resumes" })).toThrow();
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("EXISTING\n");
  });

  it("refuses when inbox/ itself is replaced by a symlink to an outside folder (I2)", () => {
    const root = ws();
    const outside = tmpDir("careeros-outside-");
    fs.writeFileSync(path.join(outside, "secret.pdf"), "secret");
    fs.rmSync(layout(root).inbox, { recursive: true, force: true });
    fs.symlinkSync(outside, layout(root).inbox);

    expect(listInbox(root)).toEqual([]);
    expect(() => fileInboxItem(root, "secret.pdf", { kind: "me", dir: "resumes" })).toThrow(/outside the workspace/);
    expect(fs.existsSync(path.join(outside, "secret.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(root, "me", "resumes", "secret.pdf"))).toBe(false);
  });

  it("rejects a name containing a newline, and flattens a note's newlines to one log line", () => {
    const root = ws();
    expect(() => fileInboxItem(root, "a\nb.pdf", { kind: "me", dir: "resumes" })).toThrow(/not an inbox file/);

    drop(root, "cv.pdf");
    fileInboxItem(root, "cv.pdf", { kind: "me", dir: "resumes" }, "line one\nline two", { now: FIXED });
    const log = fs.readFileSync(path.join(layout(root).inbox, "_filed.md"), "utf8");
    const lines = log.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("line one line two");
  });
});
