import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { newJob } from "../src/jobs.js";
import { layout } from "../src/paths.js";
import { forgetTrash, listTrash, moveToTrash, purgeTrash, restoreFromTrash, TRASH_ID, TrashError, trashableRel } from "../src/trash.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  const a = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: FIXED });
  const b = newJob(root, { company: "Acme Corp", title: "Data Engineer", url: "https://jobs.example.com/2" }, { now: FIXED });
  return { root, a, b };
}
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof TrashError ? e.code : `other: ${(e as Error).message}`; } return "no error"; };

describe("moveToTrash", () => {
  it("moves a job folder into .backup/trash with a manifest, and restores it to the same place", () => {
    const { root, a } = ws();
    const rel = `companies/acme-corp/jobs/${a.id}`;
    const e = moveToTrash(root, { kind: "job", title: "AI Engineer at Acme Corp", rels: [rel] }, { now: FIXED });
    expect(e.id).toMatch(TRASH_ID);
    expect(fs.existsSync(path.join(root, rel))).toBe(false);
    expect(fs.existsSync(path.join(layout(root).backupDir, "trash", e.id, "files", rel, "job.json"))).toBe(true);
    expect(listTrash(root).map((x) => x.title)).toEqual(["AI Engineer at Acme Corp"]);
    restoreFromTrash(root, e.id);
    expect(fs.existsSync(path.join(root, rel, "job.json"))).toBe(true);
    expect(listTrash(root)).toEqual([]);
  });

  it("gives two deletions at the same moment their own entries", () => {
    const { root, a, b } = ws();
    const one = moveToTrash(root, { kind: "job", title: "Same", rels: [`companies/acme-corp/jobs/${a.id}`] }, { now: FIXED });
    const two = moveToTrash(root, { kind: "job", title: "Same", rels: [`companies/acme-corp/jobs/${b.id}`] }, { now: FIXED });
    expect(one.id).not.toBe(two.id);
    expect(listTrash(root)).toHaveLength(2);
  });

  it("refuses paths outside the workspace, app folders and private folders, moving nothing", () => {
    const { root, a } = ws();
    fs.mkdirSync(path.join(root, "me", "identity"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "identity", "passport.pdf"), "x");
    for (const bad of ["../outside", "companies/../../x", "/etc/passwd", "companies", "settings/profile.json", ".backup/trash", ".index/careeros.sqlite", "me/identity", "me/identity/passport.pdf", "me/employment/x", "me", "workspace.json"]) {
      expect(code(() => trashableRel(root, bad)), bad).not.toBe("no error");
    }
    // One bad path in a list: nothing moves.
    const good = `companies/acme-corp/jobs/${a.id}`;
    expect(code(() => moveToTrash(root, { kind: "job", title: "x", rels: [good, "../../etc"] }))).toBe("refused");
    expect(fs.existsSync(path.join(root, good))).toBe(true);
    expect(listTrash(root)).toEqual([]);
  });

  it("refuses a link, so nothing outside the workspace is ever moved", () => {
    const { root } = ws();
    const outside = tmpDir();
    fs.symlinkSync(outside, path.join(root, "learning", "linked"));
    expect(code(() => trashableRel(root, "learning/linked"))).toBe("refused");
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("says when it isn't there any more", () => {
    const { root } = ws();
    expect(code(() => moveToTrash(root, { kind: "job", title: "x", rels: ["companies/acme-corp/jobs/gone"] }))).toBe("not_found");
  });
});

describe("restoreFromTrash", () => {
  it("refuses when something new took the old place, and keeps the entry", () => {
    const { root, a } = ws();
    const rel = `companies/acme-corp/jobs/${a.id}`;
    const e = moveToTrash(root, { kind: "job", title: "AI Engineer", rels: [rel] });
    fs.mkdirSync(path.join(root, rel));
    expect(code(() => restoreFromTrash(root, e.id))).toBe("taken");
    expect(listTrash(root)).toHaveLength(1);
  });

  it("asks for the company first when a job's company was deleted after it", () => {
    const { root, a } = ws();
    const job = moveToTrash(root, { kind: "job", title: "AI Engineer", rels: [`companies/acme-corp/jobs/${a.id}`] });
    const co = moveToTrash(root, { kind: "company", title: "Acme Corp", rels: ["companies/acme-corp"] });
    expect(code(() => restoreFromTrash(root, job.id))).toBe("parent_gone");
    restoreFromTrash(root, co.id);
    restoreFromTrash(root, job.id);
    expect(fs.existsSync(path.join(root, "companies", "acme-corp", "jobs", a.id, "job.json"))).toBe(true);
  });

  it("refuses an id that isn't an entry (no path tricks)", () => {
    const { root } = ws();
    expect(code(() => restoreFromTrash(root, "../../companies"))).toBe("not_found");
    expect(code(() => forgetTrash(root, "../.."))).toBe("not_found");
    expect(fs.existsSync(path.join(root, "companies"))).toBe(true);
  });
});

describe("forgetTrash and purgeTrash", () => {
  it("deletes one entry for good", () => {
    const { root, a } = ws();
    const e = moveToTrash(root, { kind: "job", title: "AI Engineer", rels: [`companies/acme-corp/jobs/${a.id}`] });
    forgetTrash(root, e.id);
    expect(listTrash(root)).toEqual([]);
    expect(fs.readdirSync(path.join(layout(root).backupDir, "trash"))).toEqual([]);
  });

  it("removes only entries deleted more than 30 days ago", () => {
    const { root, a, b } = ws();
    const old = moveToTrash(root, { kind: "job", title: "Old", rels: [`companies/acme-corp/jobs/${a.id}`] }, { now: new Date("2026-01-01T00:00:00Z") });
    const recent = moveToTrash(root, { kind: "job", title: "Recent", rels: [`companies/acme-corp/jobs/${b.id}`] }, { now: new Date("2026-01-20T00:00:00Z") });
    expect(purgeTrash(root, new Date("2026-02-05T00:00:00Z"))).toBe(1);
    expect(listTrash(root).map((e) => e.id)).toEqual([recent.id]);
    expect(old.id).not.toBe(recent.id);
  });

  it("dates an entry by its folder name when its manifest is unreadable", () => {
    const { root, a } = ws();
    const e = moveToTrash(root, { kind: "job", title: "Old", rels: [`companies/acme-corp/jobs/${a.id}`] }, { now: new Date("2026-01-01T00:00:00Z") });
    fs.writeFileSync(path.join(layout(root).backupDir, "trash", e.id, "trash.json"), "{broken");
    expect(purgeTrash(root, new Date("2026-01-10T00:00:00Z"))).toBe(0);
    expect(purgeTrash(root, new Date("2026-03-01T00:00:00Z"))).toBe(1);
  });
});
