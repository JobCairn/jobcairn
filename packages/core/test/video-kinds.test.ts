import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { layout } from "../src/paths.js";
import { check, defaults } from "../src/schema.js";
import { writeRecord } from "../src/store.js";
import { isVideoFolderRel, listVideoFolders, VIDEO_ARTIFACTS } from "../src/videos.js";
import { initWorkspace } from "../src/workspace.js";
import { FIXED, tmpDir } from "./helpers.js";

const TYPE = {
  schema: 1, id: "jd-walkthrough", label: "JD walkthrough", description: "What the role really asks for.", version: 1,
  entry_points: ["job"], subject: "job", writer: "claude", skill: "video-slides", voice_type: "slides",
  length: { min_s: 60, target_s: 75, max_s: 90 }, scene_types: ["title", "comparison", "recap-card"],
  sources: [{ resolver: "job.jd", required: true }], brief_template: "This recap tells {name} what {company} asks for.",
  rules: ["Name gaps as gaps."], facts: "strict", output: "companies/{slug}/jobs/{id}/videos/jd-walkthrough-{n}/", media: "none",
};

describe("video_type records", () => {
  it("accepts a well-formed type and fills defaults", () => {
    const r = check("video_type", TYPE);
    expect(r.problems).toEqual([]);
    expect(r.value).toMatchObject({ extras: [], modes: [], scene_counts: {}, custom: {} });
  });
  it("refuses outputs outside the allowed roots and unsafe globs", () => {
    for (const output of ["me/identity/{n}/", "../x/{n}/", "settings/video/{n}/", "companies/{slug}/../../me/{n}/", "companies/{slug}/.hidden/{n}/", "/abs/{n}/"]) {
      expect(check("video_type", { ...TYPE, output }).ok, output).toBe(false);
    }
    for (const glob of ["../identity/*", "a/b.md", ".env"]) {
      expect(check("video_type", { ...TYPE, sources: [{ resolver: "application.files", required: true, glob }] }).ok, glob).toBe(false);
    }
    expect(check("video_type", { ...TYPE, sources: [{ resolver: "me.identity", required: true }] }).ok).toBe(false);
    expect(check("video_type", { ...TYPE, script: "<script>" }).ok).toBe(false);
  });
});

describe("video_request and video records", () => {
  it("requires the subject fields its kind needs", () => {
    const base = { schema: 1, type: "jd-walkthrough", created_at: FIXED.toISOString() };
    expect(check("video_request", { ...base, subject: { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } }).ok).toBe(true);
    expect(check("video_request", { ...base, subject: { kind: "job", company_slug: "acme-corp" } }).ok).toBe(false);
    expect(check("video_request", { ...base, subject: { kind: "week", week: "2026-W03" } }).ok).toBe(true);
    expect(check("video_request", { ...base, subject: { kind: "week", week: "2026-W54" } }).ok).toBe(false);
    expect(check("video_request", { ...base, subject: { kind: "topic", topic: "RAG\u0000" } }).ok).toBe(false);
    expect(check("video_request", { ...base, subject: { kind: "job", company_slug: "../x", id: "y" } }).ok).toBe(false);
  });
  it("fills a fresh video record", () => {
    const v = defaults("video", { type: "pitch", subject: { kind: "job", company_slug: "acme-corp", id: "x" }, created_at: FIXED.toISOString() });
    expect(v).toMatchObject({
      status: "writing", title: "", stages: {}, renders: { draft: null, final: null }, locked_facts: [],
      captions: { style: "rail", estimated: false, srt: "", vtt: "" }, issues: { errors: 0, warnings: 0 }, length_s: null,
    });
  });
});

describe("video qa (Task 18b)", () => {
  const base = { schema: 1, type: "pitch", subject: { kind: "job", company_slug: "acme-corp", id: "x" }, created_at: FIXED.toISOString() };
  const issue = { scene: 2, from_s: 14.2, to_s: 16, description: "Headline overlaps the caption band", tried: "Shortened the headline twice" };
  it("is optional, and a fresh record has none", () => {
    expect(check("video", base).ok).toBe(true);
    expect("qa" in defaults("video", base)).toBe(false);
  });
  it("accepts passed with no issues, and open_issues with at least one", () => {
    expect(check("video", { ...base, qa: { status: "passed", open_issues: [] } }).problems).toEqual([]);
    expect(check("video", { ...base, qa: { status: "open_issues", open_issues: [issue] } }).problems).toEqual([]);
  });
  it("refuses a label that hides or invents issues, and malformed entries", () => {
    expect(check("video", { ...base, qa: { status: "passed", open_issues: [issue] } }).ok).toBe(false);
    expect(check("video", { ...base, qa: { status: "open_issues", open_issues: [] } }).ok).toBe(false);
    expect(check("video", { ...base, qa: { status: "fine", open_issues: [] } }).ok).toBe(false);
    expect(check("video", { ...base, qa: { status: "passed" } }).ok).toBe(false);
    for (const bad of [{ ...issue, scene: -1 }, { ...issue, description: "" }, { ...issue, extra: 1 }, { scene: 1, from_s: 0, to_s: 1, description: "x" }]) {
      expect(check("video", { ...base, qa: { status: "open_issues", open_issues: [bad] } }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("video settings and layout", () => {
  it("adds video settings to integrations", () => {
    const i = defaults("integrations", {});
    expect(i.video.captions).toBe("rail");
    expect(i.video.lengths).toMatchObject({ skill_gap_lesson: 0, weekly_recap: 0 });
    expect(check("integrations", { schema: 1, video: { captions: "neon" } }).ok).toBe(false);
  });
  it("knows the video folders", () => {
    const L = layout("/fictional/ws");
    expect(L.recaps).toBe(path.join("/fictional/ws", "recaps"));
    expect(L.researchDir("acme-corp")).toBe(path.join("/fictional/ws", "companies", "acme-corp", "research"));
    expect(L.jobVideosDir("acme-corp", "j1")).toBe(path.join("/fictional/ws", "companies", "acme-corp", "jobs", "j1", "videos"));
    expect(L.videoTypesDir).toBe(path.join("/fictional/ws", "settings", "video-types"));
  });
});

describe("video folders", () => {
  it("recognises only video folder paths", () => {
    for (const ok of [
      "learning/rag-pipelines/videos/1", "companies/acme-corp/videos/briefing-2", "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1",
      "companies/acme-corp/jobs/2026-01-12-ai-engineer/interview/3", "companies/acme-corp/jobs/2026-01-12-ai-engineer/application/summary-video", "recaps/2026-W03",
    ]) expect(isVideoFolderRel(ok), ok).toBe(true);
    for (const bad of [
      "", "me/identity/videos/1", "learning/../me/identity", "learning/rag/videos/../../x", "recaps/2026-w03", "recaps/x", "companies/Acme/videos/1",
      "companies/acme-corp", "settings/video-types/x", "learning/rag/.hidden/1", "/learning/rag/videos/1", "learning\\rag\\videos\\1",
    ]) expect(isVideoFolderRel(bad), bad).toBe(false);
  });
  it("lists folders that hold a video.json, skipping links and hidden folders", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    const rec = (rel: string) => writeRecord("video", path.join(root, rel, "video.json"),
      defaults("video", { type: "weekly-recap", subject: { kind: "week", week: "2026-W03" }, created_at: FIXED.toISOString() }));
    rec("recaps/2026-W03");
    rec("learning/rag-pipelines/videos/1");
    rec("companies/acme-corp/jobs/2026-01-12-ai-engineer/interview/1");
    fs.mkdirSync(path.join(root, "learning/rag-pipelines/videos/2"), { recursive: true });
    rec("learning/rag-pipelines/.cache/1");
    const outside = path.join(tmpDir(), "elsewhere");
    fs.mkdirSync(path.join(outside, "9"), { recursive: true });
    fs.writeFileSync(path.join(outside, "9", "video.json"), "{}");
    fs.symlinkSync(outside, path.join(root, "learning/rag-pipelines/videos/linked"), "dir");
    expect(listVideoFolders(root)).toEqual([
      "companies/acme-corp/jobs/2026-01-12-ai-engineer/interview/1", "learning/rag-pipelines/videos/1", "recaps/2026-W03",
    ]);
    expect(VIDEO_ARTIFACTS.has("video.json")).toBe(true);
    expect(VIDEO_ARTIFACTS.has("job.json")).toBe(false);
  });
  it("still lists a company or topic whose slug collides with an artifact folder name", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    const rec = (rel: string) => writeRecord("video", path.join(root, rel, "video.json"),
      defaults("video", { type: "company-briefing", subject: { kind: "company", company_slug: "media" }, created_at: FIXED.toISOString() }));
    rec("companies/media/videos/1");
    writeRecord("video", path.join(root, "learning/vendor/videos/1", "video.json"),
      defaults("video", { type: "skill-gap-lesson", subject: { kind: "topic", topic: "vendor" }, created_at: FIXED.toISOString() }));
    expect(listVideoFolders(root)).toEqual(["companies/media/videos/1", "learning/vendor/videos/1"]);
  });
  it("lists only the outer folder when a matched video folder holds a stray subfolder with its own video.json", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    const outer = "companies/acme-corp/videos/briefing-1";
    const mk = (rel: string) => writeRecord("video", path.join(root, rel, "video.json"),
      defaults("video", { type: "company-briefing", subject: { kind: "company", company_slug: "acme-corp" }, created_at: FIXED.toISOString() }));
    mk(outer);
    mk(`${outer}/stray`);
    expect(listVideoFolders(root)).toEqual([outer]);
  });
  it("never reads inside a matched video folder", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    const outer = "recaps/2026-W03";
    writeRecord("video", path.join(root, outer, "video.json"),
      defaults("video", { type: "weekly-recap", subject: { kind: "week", week: "2026-W03" }, created_at: FIXED.toISOString() }));
    fs.mkdirSync(path.join(root, outer, "stray"), { recursive: true });
    const spy = vi.spyOn(fs, "readdirSync");
    expect(listVideoFolders(root)).toEqual([outer]);
    const insideMatch = path.join(root, outer, "stray");
    expect(spy.mock.calls.some(([p]) => p === insideMatch)).toBe(false);
    spy.mockRestore();
  });
});

describe("video request review option and autofix record (video pipeline lane)", () => {
  const req = { schema: 1, type: "pitch", subject: { kind: "job", company_slug: "acme-corp", id: "x" }, created_at: FIXED.toISOString() };
  it("accepts review always or if_problems, and nothing else", () => {
    expect(check("video_request", { ...req, options: { review: "always" } }).ok).toBe(true);
    expect(check("video_request", { ...req, options: { review: "if_problems" } }).ok).toBe(true);
    expect(check("video_request", { ...req, options: {} }).ok).toBe(true);
    expect(check("video_request", { ...req, options: { review: "never" } }).ok).toBe(false);
  });
  it("autofix is optional and bounded", () => {
    const fix = { repairs: ['Changed 2 sources from "path" to "file".'], claude_passes: 2, claude_fixed: 3, at: FIXED.toISOString() };
    expect("autofix" in defaults("video", req)).toBe(false);
    expect(check("video", { ...req, autofix: fix }).problems).toEqual([]);
    expect(check("video", { ...req, autofix: { ...fix, claude_passes: 9 } }).ok).toBe(false);
    expect(check("video", { ...req, autofix: { ...fix, extra: 1 } }).ok).toBe(false);
    expect(check("video", { ...req, autofix: { repairs: [] } }).ok).toBe(false);
  });
});
