import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRecord } from "@careeros/core";
import type { SceneSpec, VideoSubject } from "../src/types.js";
import { ACME_JOB, seedAcme } from "./fixtures.js";
import { harness } from "./harness.js";
import { sampleCopy } from "./helpers.js";
import { PITCH_SCRIPT, pitchSpec } from "./type-specs.js";

const JOB: VideoSubject = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const FOLDER = `${ACME_JOB}/interview/pitch-1`;
const PITCH_MD = { "pitch.md": "Right now I am an AI Engineer.\n" };
function seeded() { const root = sampleCopy(); seedAcme(root); return root; }

/** A pitch spec with the slips seen in a real run (fictional data): `path` sources and plain-text points. */
function slipped(): SceneSpec {
  const s = pitchSpec() as unknown as { scenes: Record<string, unknown>[] };
  for (const sc of s.scenes) sc.sources = (sc.sources as { file: string }[]).map((x) => ({ path: x.file }));
  s.scenes[1]!.items = ["AI Engineer at Example Labs", "Since 2024 building agents"];
  return s as unknown as SceneSpec;
}
/** Problems repair can't fix: five points where four fit, and no closing line. */
function broken(): SceneSpec {
  const s = slipped() as unknown as { scenes: Record<string, unknown>[] };
  s.scenes[1]!.items = ["AI Engineer", "Example Labs", "Since 2024", "built agents", "support tickets"];
  delete s.scenes[3]!.closing;
  return s as unknown as SceneSpec;
}

/** A version 3 pitch whose list scene shows more words than the cap. */
function wordy(): SceneSpec {
  const s = pitchSpec() as unknown as { version: number; scenes: Record<string, unknown>[] };
  s.version = 3;
  s.scenes[1]!.headline = "Right now I build support agents that really ship";
  return s as unknown as SceneSpec;
}
function trimmed(): SceneSpec {
  const s = wordy() as unknown as { scenes: Record<string, unknown>[] };
  s.scenes[1]!.headline = "I build agents";
  for (const sc of s.scenes) if (Array.isArray(sc.items)) sc.items = (sc.items as { text: string; cue: string }[]).map((it) => ({ ...it, text: it.text.split(" ").slice(0, 2).join(" ") }));
  (s.scenes[2]!.right as { items: string[] }).items = ["An agent"];
  if (typeof s.scenes[3]?.closing === "string") s.scenes[3].closing = "Thanks.";
  if (typeof s.scenes[3]?.headline === "string") s.scenes[3].headline = "Why me";
  return s as unknown as SceneSpec;
}

describe("check stage: the word cap", () => {
  it("flags a scene over the cap and asks Claude to cut it in a fix pass, before the person sees it", async () => {
    const root = seeded();
    const h = harness(root, { files: (_r, call) => ({ script: PITCH_SCRIPT, spec: call === 1 ? wordy() : trimmed(), extras: PITCH_MD }) });
    h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    expect(h.control.writes.length).toBeGreaterThanOrEqual(2);
    const asked = h.control.writes[1]!.revision!.issues;
    expect(asked.some((i) => i.code === "word_cap" && /^Scene 2: shows \d+ words on screen; keep it to 12\./.test(i.message))).toBe(true);
    const d = h.pipeline.draft(FOLDER);
    expect(d.issues.filter((i) => i.code === "word_cap")).toEqual([]);
  });
});

describe("check stage: repair, then at most two fix passes", () => {
  it("repairs shape slips without asking Claude, writes the spec back and records what it did", async () => {
    const root = seeded();
    const h = harness(root, { files: () => ({ script: PITCH_SCRIPT, spec: slipped(), extras: PITCH_MD }) });
    const v = h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    expect(h.control.writes).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(path.join(root, FOLDER, "spec.json"), "utf8")) as SceneSpec;
    expect(saved.scenes[0]!.sources).toEqual([{ file: `${ACME_JOB}/jd.md` }]);
    const d = h.pipeline.draft(FOLDER);
    expect(d.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(d.can_approve).toBe(true);
    expect(d.autofix).toEqual({
      repairs: ['Changed 6 sources from "path" to "file".', "Scene 2: turned 2 plain-text points into points with cues."],
      claude_passes: 0, claude_fixed: 0, left: 0,
    });
    const check = h.pipeline.run(v.runId)!.stages.find((s) => s.id === "check")!;
    expect(check.message).toBe("Fixed the plan's format in 2 places. No problems left");
  });

  it("asks Claude to fix what is left, and says how many it fixed", async () => {
    const root = seeded();
    const h = harness(root, { files: (_r, call) => ({ script: PITCH_SCRIPT, spec: call === 1 ? broken() : slipped(), extras: PITCH_MD }) });
    h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    expect(h.control.writes).toHaveLength(2);
    const asked = h.control.writes[1]!.revision!.issues.map((i) => i.message);
    expect(asked).toContain("Scene 2: items must have 2 to 4 entries; it has 5.");
    expect(asked).toContain("Scene 4: closing is missing.");
    const d = h.pipeline.draft(FOLDER);
    expect(d.autofix).toMatchObject({ claude_passes: 1, left: 0 });
    expect(d.autofix!.claude_fixed).toBeGreaterThanOrEqual(2);
    expect(d.can_approve).toBe(true);
  });

  it("stops after two passes with an honest count of what is left", async () => {
    const root = seeded();
    const h = harness(root, { files: () => ({ script: PITCH_SCRIPT, spec: broken(), extras: PITCH_MD }) });
    const v = h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    expect(h.control.writes).toHaveLength(3);
    const d = h.pipeline.draft(FOLDER);
    expect(d.autofix).toMatchObject({ claude_passes: 2, claude_fixed: 0, left: 2 });
    expect(d.can_approve).toBe(false);
    expect(h.pipeline.run(v.runId)!.status).toBe("review");
    expect(h.pipeline.run(v.runId)!.stages.find((s) => s.id === "check")!.message).toBe("Fixed the plan's format in 2 places. 2 problems left for you to fix");
    expect(readRecord("video", path.join(root, FOLDER, "video.json")).status).toBe("review");
  });

  it("a fix pass that changes nothing ends the passes (no second ask for the same files)", async () => {
    const root = seeded();
    // A spec with a problem repair can't fix and no shape slips, so the files are identical after every write.
    const stuck = () => { const s = pitchSpec() as unknown as { scenes: Record<string, unknown>[] }; delete s.scenes[3]!.closing; return s as unknown as SceneSpec; };
    const h = harness(root, { files: () => ({ script: PITCH_SCRIPT, spec: stuck(), extras: PITCH_MD }) });
    const v = h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    expect(h.control.writes).toHaveLength(2);
    expect(h.pipeline.draft(FOLDER).autofix).toMatchObject({ claude_passes: 1, claude_fixed: 0, left: 1 });
    expect(h.pipeline.run(v.runId)!.stages.find((s) => s.id === "check")!.message).toMatch(/Claude's fix changed nothing/);
    // The pass's time is kept with the check step.
    expect(readRecord("video", path.join(root, FOLDER, "video.json")).stages.check!.parts!.map((p) => p.name)).toEqual(["Claude fix pass 1"]);
  });

  it("keeps the earlier script when a fix pass fails, and still stops for review", async () => {
    const root = seeded();
    const h = harness(root, {
      files: () => ({ script: PITCH_SCRIPT, spec: broken(), extras: PITCH_MD }),
      writeFails: (call) => (call === 2 ? { partial: "half a scr" } : null),
    });
    const v = h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    expect(h.control.writes).toHaveLength(2);
    expect(fs.readFileSync(path.join(root, FOLDER, "script.txt"), "utf8")).toBe(PITCH_SCRIPT);
    expect(h.pipeline.run(v.runId)!.status).toBe("review");
    expect(h.pipeline.run(v.runId)!.stages.find((s) => s.id === "check")!.message).toMatch(/Claude's fix didn't finish, so the script is as it was\. 2 problems left/);
    expect(h.pipeline.draft(FOLDER).autofix).toMatchObject({ claude_passes: 1, claude_fixed: 0, left: 2 });
  });
});

describe('options.review: "Make video" makes a video', () => {
  const stage = (v: { stages: { id: string; status: string; message: string }[] }, id: string) => v.stages.find((s) => s.id === id)!;

  it("a new request stores if_problems and, when the script passes, goes straight on to the final video in the same run", async () => {
    const root = seeded();
    const h = harness(root, { files: () => ({ script: PITCH_SCRIPT, spec: pitchSpec(), extras: PITCH_MD }) });
    const v = h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    expect(readRecord("video_request", path.join(root, FOLDER, "request.json")).options).toMatchObject({ review: "if_problems" });
    const done = h.pipeline.run(v.runId)!;
    expect(done).toMatchObject({ status: "done", phase: "final" });
    expect(stage(done, "review")).toMatchObject({ status: "skipped", message: "The script passed its checks, so it went straight on to the video" });
    expect(stage(done, "final").status).toBe("done");
    expect(fs.existsSync(path.join(root, FOLDER, "renders/final.mp4"))).toBe(true);
    expect(readRecord("video", path.join(root, FOLDER, "video.json")).status).toBe("done");
    expect(h.pipeline.runs()).toHaveLength(1);
  });

  it("still stops for review when problems are left", async () => {
    const root = seeded();
    const h = harness(root, { files: () => ({ script: PITCH_SCRIPT, spec: broken(), extras: PITCH_MD }) });
    const v = h.pipeline.start("pitch", JOB, { review: "if_problems" });
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("review");
    // Narration started while the script was checked (its paragraphs stay cached), but nothing was built.
    expect(h.control.narrations).toBe(1);
    expect(h.control.maxRendering).toBe(0);
    expect(readRecord("video", path.join(root, FOLDER, "video.json")).status).toBe("review");
  });

  it('"always" stops for review even when the script passes', async () => {
    const root = seeded();
    const h = harness(root, { files: () => ({ script: PITCH_SCRIPT, spec: pitchSpec(), extras: PITCH_MD }) });
    const v = h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("review");
    expect(readRecord("video_request", path.join(root, FOLDER, "request.json")).options).toMatchObject({ review: "always" });
  });

  it("a revision the person asked for stops for review", async () => {
    const root = seeded();
    // The first write and both fix passes leave problems; the person's revision then fixes them.
    const h = harness(root, { files: (_r, call) => ({ script: PITCH_SCRIPT, spec: call <= 3 ? broken() : pitchSpec(), extras: PITCH_MD }) });
    h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    expect(readRecord("video", path.join(root, FOLDER, "video.json")).status).toBe("review");
    const r = h.pipeline.revise(FOLDER, "Shorter please.");
    await h.pipeline.idle();
    expect(h.pipeline.run(r.runId)!.status).toBe("review");
    // Only the first run narrated early; a revision the person asked for never does.
    expect(h.control.narrations).toBe(1);
  });

  it("doesn't go on while a tool is installing: stops for review and says why", async () => {
    const root = seeded();
    const h = harness(root, { files: () => ({ script: PITCH_SCRIPT, spec: pitchSpec(), extras: PITCH_MD }), canBuild: () => "A tool is installing, so approve it when that finishes." });
    const v = h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    const run = h.pipeline.run(v.runId)!;
    expect(run.status).toBe("review");
    expect(stage(run, "review").message).toBe("The script passed its checks. A tool is installing, so approve it when that finishes.");
    expect(h.control.narrations).toBe(0);
  });

  it("when making the video stops (a tool is missing), it says Didn't finish with the reason, and the script stays approvable", async () => {
    const root = seeded();
    const h = harness(root, { files: () => ({ script: PITCH_SCRIPT, spec: pitchSpec(), extras: PITCH_MD }), toolsOk: false });
    const v = h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    const run = h.pipeline.run(v.runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/^Videos need ffmpeg/);
    const rec = readRecord("video", path.join(root, FOLDER, "video.json"));
    expect(rec.status).toBe("failed");
    expect(rec.stopped).toMatchObject({ stage: "narrate", quality: "final", auto: true });
    expect(h.pipeline.draft(FOLDER)).toMatchObject({ can_approve: true, stopped: { stage: "narrate", quality: "final", can_skip_check: false, reason: expect.stringMatching(/ffmpeg/) } });
  });

});
