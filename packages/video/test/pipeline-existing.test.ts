import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRecord, writeRecord } from "@careeros/core";
import { VideoError } from "../src/errors.js";
import { validateVideoType } from "../src/registry.js";
import type { VideoSubject } from "../src/types.js";
import { ACME_JOB, seedAcme } from "./fixtures.js";
import { harness } from "./harness.js";
import { BUILTIN_TYPES, sampleCopy } from "./helpers.js";
import { filesFor, seedApplication } from "./type-specs.js";

// Final review I1 and I2: a video is only ever made into a folder the pipeline owns, and making a
// fixed-folder video again never silently wipes the one already there.
/** These tests stop at review, as a request that asks for it does (a new request otherwise goes straight on). */
const ALWAYS = { review: "always" } as const;
const JOB: VideoSubject = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const SUMMARY = `${ACME_JOB}/application/summary-video`;
const LOCKED = { folder: "me/identity", granted_at: "2026-01-14T09:00:00.000Z" };

async function madeSummary() {
  const root = sampleCopy();
  seedAcme(root);
  seedApplication(root);
  const h = harness(root, { files: (req) => filesFor(req.type.id) });
  h.pipeline.start("application-summary", JOB, ALWAYS);
  await h.pipeline.idle();
  const f = h.pipeline.render(SUMMARY, "final");
  await h.pipeline.idle();
  expect(h.pipeline.run(f.runId)!.status).toBe("done");
  // The person edits the script by hand, and the record notes a locked folder that fed the video.
  fs.writeFileSync(path.join(root, SUMMARY, "script.txt"), `${fs.readFileSync(path.join(root, SUMMARY, "script.txt"), "utf8")}\nMy own words.`);
  const file = path.join(root, SUMMARY, "video.json");
  writeRecord("video", file, { ...readRecord("video", file), locked_facts: [LOCKED] });
  return { root, h };
}

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof VideoError ? e.code : `other: ${(e as Error).message}`; }
  return "no error";
};

describe("making a fixed-folder video again (I1)", () => {
  it("refuses without a choice and leaves the old video and the hand edits alone", async () => {
    const { root, h } = await madeSummary();
    const before = fs.readFileSync(path.join(root, SUMMARY, "script.txt"), "utf8");
    expect(codeOf(() => h.pipeline.start("application-summary", JOB, ALWAYS))).toBe("video_exists");
    expect(fs.readFileSync(path.join(root, SUMMARY, "script.txt"), "utf8")).toBe(before);
    expect(readRecord("video", path.join(root, SUMMARY, "video.json")).renders.final?.path).toBe("renders/final.mp4");
    expect(h.pipeline.existing("application-summary", JOB)).toMatchObject({ folder: SUMMARY, has_final: true, has_script: true });
  });

  it("replace: starts fresh in the same folder, drops the old renders and keeps the locked-folder audit", async () => {
    const { root, h } = await madeSummary();
    const writes = h.control.writes.length;
    const v = h.pipeline.start("application-summary", JOB, { existing: "replace", review: "always" });
    expect(v.folder).toBe(SUMMARY);
    await h.pipeline.idle();
    expect(h.control.writes.length).toBe(writes + 1);
    expect(fs.existsSync(path.join(root, SUMMARY, "renders", "final.mp4"))).toBe(false);
    expect(fs.readFileSync(path.join(root, SUMMARY, "script.txt"), "utf8")).not.toContain("My own words.");
    const rec = readRecord("video", path.join(root, SUMMARY, "video.json"));
    expect(rec.locked_facts).toEqual([LOCKED]);
    expect(rec.renders.final).toBeFalsy();
    // request.json never stores the choice.
    expect(JSON.parse(fs.readFileSync(path.join(root, SUMMARY, "request.json"), "utf8")).options).not.toHaveProperty("existing");
  });

  it("keep_copy: moves the old video, hand edits and all, to a dated folder, then starts fresh", async () => {
    const { root, h } = await madeSummary();
    h.pipeline.start("application-summary", JOB, { existing: "keep_copy", review: "always" });
    await h.pipeline.idle();
    const copy = `${SUMMARY}-2026-01-15`;
    expect(fs.readFileSync(path.join(root, copy, "script.txt"), "utf8")).toContain("My own words.");
    expect(fs.existsSync(path.join(root, copy, "renders", "final.mp4"))).toBe(true);
    expect(readRecord("video", path.join(root, copy, "video.json")).locked_facts).toEqual([LOCKED]);
    expect(fs.readFileSync(path.join(root, SUMMARY, "script.txt"), "utf8")).not.toContain("My own words.");
    // A second copy on the same day gets its own name.
    h.pipeline.start("application-summary", JOB, { existing: "keep_copy", review: "always" });
    await h.pipeline.idle();
    expect(fs.existsSync(path.join(root, `${copy}-2`, "video.json"))).toBe(true);
  });

  it("keep_copy works for a weekly recap too, and the copy is still a video folder", async () => {
    const root = sampleCopy();
    seedAcme(root);
    const h = harness(root);
    const week: VideoSubject = { kind: "week", week: "2026-W03" };
    h.pipeline.start("weekly-recap", week, ALWAYS);
    await h.pipeline.idle();
    expect(codeOf(() => h.pipeline.start("weekly-recap", week, ALWAYS))).toBe("video_exists");
    h.pipeline.start("weekly-recap", week, { existing: "keep_copy", review: "always" });
    await h.pipeline.idle();
    expect(fs.existsSync(path.join(root, "recaps/2026-W03-2026-01-15/video.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "recaps/2026-W03/video.json"))).toBe(true);
  });

  it("a numbered type never asks: each start gets the next free folder", async () => {
    const root = sampleCopy();
    seedAcme(root);
    const h = harness(root);
    expect(h.pipeline.existing("jd-walkthrough", JOB)).toBeNull();
  });
});

describe("video folders are the pipeline's own (I2)", () => {
  it("refuses an existing folder that holds other files and touches nothing in it", () => {
    const root = sampleCopy();
    seedAcme(root);
    seedApplication(root);
    const dir = path.join(root, SUMMARY);
    fs.mkdirSync(path.join(dir, "work"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cover-letter.md"), "# Mine\n");
    fs.writeFileSync(path.join(dir, "work", "draft.md"), "mine\n");
    const h = harness(root, { files: (req) => filesFor(req.type.id) });
    expect(codeOf(() => h.pipeline.start("application-summary", JOB, { existing: "replace", review: "always" }))).toBe("not_video_folder");
    expect(fs.readdirSync(dir).sort()).toEqual(["cover-letter.md", "work"]);
    expect(fs.readFileSync(path.join(dir, "work", "draft.md"), "utf8")).toBe("mine\n");
  });

  it("a folder holding only OS junk (.DS_Store, Thumbs.db, ._ files) counts as empty", async () => {
    const root = sampleCopy();
    seedAcme(root);
    seedApplication(root);
    const dir = path.join(root, SUMMARY);
    fs.mkdirSync(dir, { recursive: true });
    for (const junk of [".DS_Store", "Thumbs.db", "._notes.md", "desktop.ini", "~$letter.docx"]) fs.writeFileSync(path.join(dir, junk), "x");
    const h = harness(root, { files: (req) => filesFor(req.type.id) });
    expect(h.pipeline.start("application-summary", JOB, ALWAYS).folder).toBe(SUMMARY);
    await h.pipeline.idle();
  });

  it("an empty existing folder is fine", async () => {
    const root = sampleCopy();
    seedAcme(root);
    seedApplication(root);
    fs.mkdirSync(path.join(root, SUMMARY), { recursive: true });
    const h = harness(root, { files: (req) => filesFor(req.type.id) });
    expect(h.pipeline.start("application-summary", JOB, ALWAYS).folder).toBe(SUMMARY);
    await h.pipeline.idle();
  });

  it("a workspace video type must write to a new numbered folder of its own", () => {
    const base = JSON.parse(fs.readFileSync(path.join(BUILTIN_TYPES, "jd-walkthrough.json"), "utf8"));
    const at = (output: string) => validateVideoType({ ...base, output, custom: {} }).problems.filter((p) => p.startsWith("/output"));
    expect(at("companies/{slug}/jobs/{id}/videos/mine-{n}/")).toEqual([]);
    expect(at("companies/{slug}/jobs/{id}/application/")).not.toEqual([]);
    expect(at("companies/{slug}/jobs/{id}/videos/mine/")).not.toEqual([]);
  });
});
