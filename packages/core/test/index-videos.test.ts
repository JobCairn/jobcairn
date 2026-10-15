import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, openIndex, planRefresh, refreshIndex } from "../src/index-db.js";
import { newJob } from "../src/jobs.js";
import { defaults } from "../src/schema.js";
import { writeRecord } from "../src/store.js";
import { initWorkspace } from "../src/workspace.js";
import { FIXED, tmpDir } from "./helpers.js";

function seeded() {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  const a = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: FIXED });
  return { root, a };
}
function addVideo(root: string, rel: string, over: Record<string, unknown> = {}) {
  writeRecord("video", path.join(root, rel, "video.json"), defaults("video", {
    type: "jd-walkthrough", subject: { kind: "job", company_slug: "acme-corp", id: "x" }, created_at: FIXED.toISOString(), title: "What Acme Corp asks for", ...over,
  }));
}
const rows = (root: string) => { const db = openIndex(root); const r = db.prepare("SELECT folder, type, status, company_slug, used_locked FROM videos ORDER BY folder").all(); db.close(); return r; };

describe("videos index table", () => {
  it("indexes every video record on a full build", () => {
    const { root, a } = seeded();
    const rel = `companies/acme-corp/jobs/${a.id}/videos/jd-walkthrough-1`;
    addVideo(root, rel, { status: "done", locked_facts: [{ folder: "me/identity", granted_at: FIXED.toISOString() }] });
    addVideo(root, "recaps/2026-W03", { type: "weekly-recap", subject: { kind: "week", week: "2026-W03" } });
    const report = buildIndex(root);
    expect(report.skipped).toEqual([]);
    expect(rows(root)).toEqual([
      { folder: rel, type: "jd-walkthrough", status: "done", company_slug: "acme-corp", used_locked: 1 },
      { folder: "recaps/2026-W03", type: "weekly-recap", status: "writing", company_slug: null, used_locked: 0 },
    ]);
  });
  it("refreshes videos when a video.json changes, and drops deleted ones", () => {
    const { root } = seeded();
    buildIndex(root);
    addVideo(root, "learning/rag-pipelines/videos/1", { type: "skill-gap-lesson", subject: { kind: "topic", topic: "RAG pipelines" } });
    expect(refreshIndex(root, ["learning/rag-pipelines/videos/1/video.json"]).mode).toBe("incremental");
    expect(rows(root)).toHaveLength(1);
    fs.rmSync(path.join(root, "learning/rag-pipelines/videos/1"), { recursive: true });
    refreshIndex(root, ["learning/rag-pipelines/videos/1"]);
    expect(rows(root)).toEqual([]);
  });
  it("reports a broken video.json and keeps going", () => {
    const { root } = seeded();
    addVideo(root, "recaps/2026-W03", { type: "weekly-recap", subject: { kind: "week", week: "2026-W03" } });
    fs.mkdirSync(path.join(root, "recaps/2026-W02"), { recursive: true });
    fs.writeFileSync(path.join(root, "recaps/2026-W02/video.json"), "{ nope");
    const report = buildIndex(root);
    expect(report.skipped.map((s) => s.file)).toEqual(["recaps/2026-W02/video.json"]);
    expect(rows(root)).toHaveLength(1);
  });
  it("plans a video refresh only for video paths", () => {
    expect(planRefresh(["recaps/2026-W03/video.json"]).videos).toBe(true);
    expect(planRefresh(["companies/acme-corp/jobs/j1/interview/1"]).videos).toBe(true);
    expect(planRefresh(["companies/acme-corp/jobs/j1/interview/1"]).jobs.has("acme-corp/j1")).toBe(true);
    expect(planRefresh(["learning/rag-pipelines/guide.md"]).videos).toBe(true);
    expect(planRefresh(["inbox/cv.pdf"]).videos).toBe(false);
    expect(planRefresh(["companies/acme-corp/company.json"]).videos).toBe(false);
  });
  it("adds the table to an index built before this change", () => {
    const { root } = seeded();
    buildIndex(root);
    const db = openIndex(root);
    db.exec("DROP TABLE videos");
    db.close();
    addVideo(root, "recaps/2026-W03", { type: "weekly-recap", subject: { kind: "week", week: "2026-W03" } });
    refreshIndex(root, ["recaps/2026-W03/video.json"]);
    expect(rows(root)).toHaveLength(1);
  });
});
