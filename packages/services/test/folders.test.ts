import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileInboxItem, layout, readFiledLog, setLocked } from "@careeros/core";
import { inboxHandlers as I } from "../src/inbox.js";
import { openSample } from "./helpers.js";

describe("drop box overview", () => {
  it("counts files per section and lists what the drop box filed, newest first", () => {
    const { ctx, root } = openSample();
    fs.mkdirSync(path.join(root, "me", "resumes"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "resumes", "alex-example.md"), "# Alex Example\n");
    fs.writeFileSync(path.join(layout(root).inbox, "acme-corp-cover-letter.md"), "Dear team\n");
    fs.writeFileSync(path.join(layout(root).inbox, "notes.md"), "notes\n");
    fileInboxItem(root, "acme-corp-cover-letter.md", { kind: "me", dir: "resumes" }, "tailored", { now: new Date("2026-01-14T00:00:00.000Z") });
    fileInboxItem(root, "notes.md", { kind: "me", dir: "projects" }, "", { now: new Date("2026-01-15T00:00:00.000Z") });
    const o = I["inbox.overview"](ctx);
    const resumes = o.folders.find((f) => f.id === "resumes")!;
    expect(resumes).toMatchObject({ label: "Resumes", rel: "me/resumes", count: 2, locked: false });
    expect(resumes.updated).not.toBe("");
    expect(o.folders.find((f) => f.id === "companies")!.count).toBeGreaterThan(0);
    expect(o.history.map((h) => [h.name, h.to])).toEqual([
      ["notes.md", "me/projects/notes.md"], ["acme-corp-cover-letter.md", "me/resumes/acme-corp-cover-letter.md"],
      ["alex-example-resume.pdf", "me/resumes/alex-example-resume.pdf"],
    ]);
    expect(o.history[1]).toMatchObject({ at: "2026-01-14T00:00:00.000Z", note: "tailored" });
  });

  it("never lists, counts or stats a locked folder", () => {
    const { ctx, root } = openSample();
    fs.mkdirSync(path.join(root, "me", "identity"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "identity", "passport.md"), "fictional\n");
    setLocked(root, "me/identity", true);
    const spies = [vi.spyOn(fs, "readdirSync"), vi.spyOn(fs, "lstatSync"), vi.spyOn(fs, "statSync")];
    try {
      const o = I["inbox.overview"](ctx);
      expect(o.folders.find((f) => f.id === "identity")).toMatchObject({ locked: true, count: null, updated: "" });
      const touched = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
      expect(touched.filter((p) => p.includes(path.join("me", "identity")))).toEqual([]);
    } finally { for (const s of spies) s.mockRestore(); }
  });

  it("never counts or stats the files of a locked folder that was moved into a counted section", () => {
    const { ctx, root } = openSample();
    fs.mkdirSync(path.join(root, "me", "identity"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "identity", "passport.md"), "fictional\n");
    fs.mkdirSync(path.join(root, "me", "projects"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "projects", "demo.md"), "demo\n");
    // Opening recorded the locked folder's identity; now it moves under me/projects (final review I4).
    const moved = path.join(root, "me", "projects", "identity");
    fs.renameSync(path.join(root, "me", "identity"), moved);
    const spies = [vi.spyOn(fs, "readdirSync"), vi.spyOn(fs, "lstatSync"), vi.spyOn(fs, "statSync")];
    try {
      const o = I["inbox.overview"](ctx);
      expect(o.folders.find((f) => f.id === "projects")).toMatchObject({ count: 1, locked: false });
      const touched = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
      // The folder itself may be identified; nothing inside it is listed or stat'ed.
      expect(touched.filter((p) => p.startsWith(moved + path.sep))).toEqual([]);
      expect(spies[0]!.mock.calls.map((c) => String(c[0]))).not.toContain(moved);
    } finally { for (const s of spies) s.mockRestore(); }
  });

  it("reads a missing history as none, and skips lines it can't parse", () => {
    const { root } = openSample();
    fs.rmSync(path.join(layout(root).inbox, "_filed.md"));
    expect(readFiledLog(root)).toEqual([]);
    fs.writeFileSync(path.join(layout(root).inbox, "_filed.md"), "garbage\n- 2026-01-02T00:00:00.000Z | a.pdf -> me/resumes/a.pdf | \n");
    expect(readFiledLog(root)).toEqual([{ at: "2026-01-02T00:00:00.000Z", name: "a.pdf", to: "me/resumes/a.pdf", note: "" }]);
  });
});
