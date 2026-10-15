import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openIndex, readRecord, updateRecord, writeRecord, layout } from "@careeros/core";
import { dispatch } from "../src/dispatch.js";
import { fakeVideoHost } from "../src/fakes-video.js";
import { DEFAULT_MAKING_RATE } from "@careeros/contract";
import { defaultLength, setVideoIntent, videoIdle } from "../src/video.js";
import { openSample, tmpDir } from "./helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const PLUGIN = path.resolve(import.meta.dirname, "../../../plugin");
const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");
const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const FOLDER = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1";

function setup(o: { toolsOk?: boolean; video?: boolean } = {}) {
  const x = openSample();
  if (o.video !== false) x.host.video = fakeVideoHost({ pluginDir: PLUGIN, gsapFile: GSAP, toolsOk: o.toolsOk });
  updateRecord("job", layout(x.root).jobFile("acme-corp", "2026-01-12-ai-engineer"), (j) => { j.scores.fit.must_haves = [{ skill: "LLM agents", met: true }]; });
  const areas: string[] = [];
  x.ctx.onChange((e) => areas.push(...e.areas));
  const call = (m: string, ...args: unknown[]) => dispatch(x.ctx, m, args);
  return { ...x, areas, call };
}

describe("video handlers", () => {
  it("lists the types for a screen and reports bad custom types", async () => {
    const { root, call } = setup();
    fs.mkdirSync(path.join(root, "settings/video-types"), { recursive: true });
    fs.writeFileSync(path.join(root, "settings/video-types/broken.json"), "{");
    const r = (await call("video.types", "job")) as { types: { id: string }[]; errors: { file: string }[] };
    expect(r.types.map((t) => t.id).sort()).toEqual(["company-briefing", "interview-prep", "jd-walkthrough", "pitch"]);
    expect(r.errors.map((e) => e.file)).toEqual(["settings/video-types/broken.json"]);
  });

  it("gives each type the length Make video starts on, and how long making takes here", async () => {
    const { root, call } = setup();
    type View = { types: { id: string; default_s: number; length: { target_s: number } }[]; making: { fixed_s: number; per_video_s: number; measured: boolean } };
    const before = (await call("video.types", "job")) as View;
    expect(before.types.find((t) => t.id === "jd-walkthrough")!.default_s).toBe(150);
    expect(before.making).toEqual(DEFAULT_MAKING_RATE);
    updateRecord("integrations", layout(root).integrations, (r) => { r.video.lengths = { jd_walkthrough: 390, pitch: 600 }; });
    const after = (await call("video.types", "job")) as View;
    expect(after.types.find((t) => t.id === "jd-walkthrough")!.default_s).toBe(390);
    // A saved default the type can't run is brought into its range, never offered as is.
    expect(after.types.find((t) => t.id === "pitch")!.default_s).toBe(180);
    expect(defaultLength({ min_s: 30, target_s: 60, max_s: 180 }, 0)).toBe(60);
  });

  it("makes a video from start to final and records it", async () => {
    const { ctx, root, call, areas } = setup();
    const run = (await call("video.start", "jd-walkthrough", JOB, { review: "always" })) as { folder: string };
    expect(run.folder).toBe(FOLDER);
    await videoIdle(ctx);
    const d = (await call("video.draft", FOLDER)) as { status: string; can_approve: boolean; issues: { level: string }[] };
    expect(d).toMatchObject({ status: "review", can_approve: true });
    expect(d.issues.filter((i) => i.level === "error")).toEqual([]);
    await call("video.approveScript", FOLDER);
    await videoIdle(ctx);
    await call("video.render", FOLDER, "final");
    await videoIdle(ctx);
    const items = (await call("video.list", { section: "jobs" })) as { folder: string; final: string | null; context: string }[];
    expect(items).toEqual([expect.objectContaining({ folder: FOLDER, final: `${FOLDER}/renders/final.mp4`, context: "AI Engineer at Acme Corp" })]);
    const job = readRecord("job", layout(root).jobFile("acme-corp", "2026-01-12-ai-engineer"));
    expect(job.timeline.at(-1)).toMatchObject({ event: "Video made", note: `JD walkthrough: ${FOLDER}` });
    const db = openIndex(root);
    expect(db.prepare("SELECT status FROM videos WHERE folder = ?").get(FOLDER)).toEqual({ status: "done" });
    db.close();
    expect(areas).toContain("video");
    expect(await call("video.exportCaptions", FOLDER, "vtt")).toBe(`${FOLDER}/captions.vtt`);
  });

  it("a new request whose script passes its checks goes straight on to the final video", async () => {
    const { ctx, root, call } = setup();
    await call("video.start", "jd-walkthrough", JOB, {});
    await videoIdle(ctx);
    expect(readRecord("video_request", path.join(root, FOLDER, "request.json")).options.review).toBe("if_problems");
    const d = (await call("video.draft", FOLDER)) as { status: string; files: { final: string | null } };
    expect(d).toMatchObject({ status: "done", files: { final: `${FOLDER}/renders/final.mp4` } });
    await expect(call("video.start", "jd-walkthrough", JOB, { review: "sometimes" })).rejects.toThrow(/review/);
    // Each run carries its plan and per-step time estimates for the progress panel.
    const [r] = (await call("video.runs")) as { plan: string[]; estimates: { ms: Record<string, number>; measured: boolean } }[];
    expect(r!.plan).toEqual(["request", "sources", "write", "check", "narrate", "captions", "media", "expand", "lint", "final", "save"]);
    expect(r!.estimates.ms.final).toBeGreaterThan(0);
    // A video that stops lists why, and Try again goes through video.retry.
    const rec = readRecord("video", path.join(root, FOLDER, "video.json"));
    writeRecord("video", path.join(root, FOLDER, "video.json"), { ...rec, status: "failed", error: `The video check found 1 problem in ${root}/x.`, stopped: { stage: "lint", quality: "final", auto: true, at: rec.updated_at } });
    const [item] = (await call("video.list", { section: "jobs" })) as { error?: string }[];
    expect(item!.error).toMatch(/^The video check found 1 problem/);
    expect(item!.error).not.toContain(root);
    expect(((await call("video.draft", FOLDER)) as { stopped: unknown }).stopped).toMatchObject({ stage: "lint", can_skip_check: true });
    expect(await call("video.retry", FOLDER, { skip_check: true })).toMatchObject({ phase: "final" });
    await videoIdle(ctx);
    expect(readRecord("video", path.join(root, FOLDER, "video.json")).status).toBe("done");
  });

  it("tells Make video about a video already in a fixed folder, and needs a choice to make it again (final review I1)", async () => {
    const { ctx, call } = setup();
    const week = { kind: "week", week: "2026-W03" };
    expect(((await call("video.sources", "weekly-recap", week)) as { existing: unknown }).existing).toBeNull();
    await call("video.start", "weekly-recap", week, {});
    await videoIdle(ctx);
    expect(((await call("video.sources", "weekly-recap", week)) as { existing: unknown }).existing).toMatchObject({ has_script: true });
    await expect(call("video.start", "weekly-recap", week, {})).rejects.toThrow(/already exists/);
    await expect(call("video.start", "weekly-recap", week, { existing: "overwrite" })).rejects.toThrow(/existing/);
    await call("video.start", "weekly-recap", week, { existing: "keep_copy" });
    await videoIdle(ctx);
    const folders = ((await call("video.list", { section: "recaps" })) as { folder: string }[]).map((v) => v.folder).sort();
    expect(folders).toEqual(["recaps/2026-W03", expect.stringMatching(/^recaps\/2026-W03-\d{4}-\d{2}-\d{2}$/)]);
  });

  it("lists only a render path inside the video's renders folder (final review M1)", async () => {
    const { ctx, root, call } = setup();
    await call("video.start", "jd-walkthrough", JOB, {});
    await videoIdle(ctx);
    updateRecord("video", path.join(root, FOLDER, "video.json"), (v) => {
      v.renders.final = { path: "../../jd.md", at: "2026-01-15T09:00:00.000Z" } as never;
      v.renders.draft = { path: "renders/draft.mp4", at: "2026-01-15T09:00:00.000Z" } as never;
    });
    const [item] = (await call("video.list", { section: "jobs" })) as { final: string | null; draft: string | null }[];
    expect(item).toMatchObject({ final: null, draft: `${FOLDER}/renders/draft.mp4` });
  });

  it("refuses folder tricks before touching the disk (Review Focus 4)", async () => {
    const { root, call } = setup();
    await expect(call("video.draft", "../x")).rejects.toThrow(/workspace-relative|video folder|\.\. segments/);
    await expect(call("video.draft", "me/identity/videos/1")).rejects.toThrow(/video folder/);
    await expect(call("video.draft", "ME/Identity/videos/1")).rejects.toThrow(/video folder/);
    fs.mkdirSync(path.join(root, "learning/rag/videos/1"), { recursive: true });
    await expect(call("video.draft", "learning/rag/videos/1")).rejects.toThrow("There is no video in that folder.");
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "video.json"), "{}");
    fs.mkdirSync(path.join(root, "learning/linked/videos"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "learning/linked/videos/1"), "dir");
    await expect(call("video.delete", "learning/linked/videos/1")).rejects.toThrow(/is a link|outside your workspace/);
    expect(fs.existsSync(path.join(outside, "video.json"))).toBe(true);
    // A link that stays inside the workspace is caught by the lstat walk.
    fs.mkdirSync(path.join(root, "learning/real/videos/1"), { recursive: true });
    fs.writeFileSync(path.join(root, "learning/real/videos/1/video.json"), "{}");
    fs.symlinkSync(path.join(root, "learning/real/videos"), path.join(root, "learning/linked/videos/2"), "dir");
    await expect(call("video.delete", "learning/linked/videos/2/1")).rejects.toThrow(/is a link/);
    expect(fs.existsSync(path.join(root, "learning/real/videos/1/video.json"))).toBe(true);
  });

  it("moves a deleted video to Recently deleted, with its own files, and Undo brings it back", async () => {
    const { ctx, root, call } = setup();
    await call("video.start", "jd-walkthrough", JOB, {});
    await videoIdle(ctx);
    fs.writeFileSync(path.join(root, FOLDER, "my-notes.txt"), "mine");
    const entry = (await call("video.delete", FOLDER)) as { id: string; kind: string };
    expect(entry.kind).toBe("video");
    expect(fs.existsSync(path.join(root, FOLDER))).toBe(false);
    expect(await call("video.list", {})).toEqual([]);
    await call("trash.restore", entry.id);
    expect(fs.readFileSync(path.join(root, FOLDER, "my-notes.txt"), "utf8")).toBe("mine");
    expect(((await call("video.list", {})) as unknown[]).length).toBe(1);
  });

  it("adds videos to Learn without listing them twice", async () => {
    const { ctx, call } = setup();
    await call("video.start", "skill-gap-lesson", { kind: "topic", topic: "Kubernetes", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }, {});
    await call("video.start", "weekly-recap", { kind: "week", week: "2026-W03" }, {});
    await videoIdle(ctx);
    const l = (await call("learn.list")) as { topics: { slug: string; items: { path: string }[] }[]; videos: { folder: string }[]; video_recaps: { folder: string }[]; recaps: { path: string }[] };
    expect(l.videos.map((v) => v.folder)).toEqual(["learning/kubernetes/videos/1"]);
    expect(l.video_recaps.map((v) => v.folder)).toEqual(["recaps/2026-W03"]);
    expect(l.topics.flatMap((t) => t.items.map((i) => i.path)).some((p) => p.startsWith("learning/kubernetes/videos/1/"))).toBe(false);
  });

  it("hands a chat request to the renderer once", async () => {
    const { ctx, call } = setup();
    setVideoIntent(ctx, { type: "pitch", subject: "Why I fit Acme Corp" });
    expect(await call("video.takeIntent")).toEqual({ type: "pitch", subject: "Why I fit Acme Corp" });
    expect(await call("video.takeIntent")).toBeNull();
  });

  it("never makes a video as a Claude-only run: claude.run on a video action opens Make video instead (final review I6)", async () => {
    const { call } = setup();
    await expect(call("claude.run", "jd_walkthrough_video", JOB, {})).rejects.toThrow("Videos are made in Make video, so you end with a video you can play. Make video is open now.");
    expect(await call("video.takeIntent")).toEqual({ type: "jd-walkthrough", subject: "", target: JOB });
  });

  it("explains missing tools and a missing installer", async () => {
    const { call } = setup({ toolsOk: false });
    const t = (await call("video.tools", true)) as { ok: boolean; can_install: boolean };
    expect(t).toMatchObject({ ok: false, can_install: false });
    await expect(call("video.installTool", "ffmpeg")).rejects.toThrow(`This copy of ${brand.name} can't install video tools. The install guide lists the commands: https://jobcairn.github.io/install.html`);
  });

  it("never installs a tool while a video is being made", async () => {
    const { ctx, host, call } = setup();
    let installs = 0;
    host.video!.install = async () => { installs++; return { ok: true, message: "done" }; };
    await call("video.start", "jd-walkthrough", JOB, {});
    await expect(call("video.installTool", "ffmpeg")).rejects.toThrow("A video is being made. Install the tool when it has finished, or stop it first.");
    expect(installs).toBe(0);
    await videoIdle(ctx);
    await call("video.installTool", "ffmpeg");
    expect(installs).toBe(1);
  });

  it("says so when an install finished but the tool still isn't usable (final review I4)", async () => {
    const { host, call } = setup();
    host.video!.install = async () => ({ ok: true, message: "HyperFrames renderer was already installed." });
    host.video!.tools = async () => ({
      ok: false, paths: null, checked_at: "2026-01-15T09:00:00.000Z",
      tools: [{ id: "hyperframes", label: "HyperFrames", ok: false, required: true, version: "0.8.100", path: "", install: "hyperframes", message: "Videos need HyperFrames 0.8.140." }],
    });
    await expect(call("video.installTool", "hyperframes")).rejects.toThrow(`HyperFrames is installed, but ${brand.name} still can't use it. Videos need HyperFrames 0.8.140.`);
  });

  it("never starts a video while a tool is installing", async () => {
    const { ctx, host, call } = setup();
    let finish: () => void = () => {};
    host.video!.install = () => new Promise((r) => { finish = () => r({ ok: true, message: "done" }); });
    const install = call("video.installTool", "ffmpeg");
    await new Promise((r) => setTimeout(r, 0));
    await expect(call("video.start", "jd-walkthrough", JOB, {})).rejects.toThrow("ffmpeg is installing. Try again when it finishes.");
    await expect(call("video.render", FOLDER, "draft")).rejects.toThrow("ffmpeg is installing. Try again when it finishes.");
    finish();
    await install;
    await call("video.start", "jd-walkthrough", JOB, {});
    await videoIdle(ctx);
  });

  it("lets Stop (setup.cancel) end a video tool install, and shows its progress line meanwhile", async () => {
    const { call, host } = setup();
    host.video!.install = (_id, onLine, signal) => new Promise((r) => {
      onLine?.("==> Downloading ffmpeg bottle");
      signal?.addEventListener("abort", () => r({ ok: false, message: "Install stopped." }));
    });
    const install = call("video.installTool", "ffmpeg");
    await new Promise((r) => setTimeout(r, 0));
    expect(((await call("setup.status", false)) as { installing: { line: string } }).installing.line).toBe("Downloading ffmpeg bottle");
    expect(await call("setup.cancel")).toBe(true);
    await expect(install).rejects.toThrow("Install stopped.");
    expect(((await call("setup.status", false)) as { installing: unknown }).installing).toBeNull();
  });

  it("says videos aren't available without a video host", async () => {
    const { call } = setup({ video: false });
    await expect(call("video.types", "job")).rejects.toThrow(`Videos aren't set up in this copy of ${brand.name}.`);
  });
});
