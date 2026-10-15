import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRecord } from "@careeros/core";
import type { VideoSubject } from "../src/types.js";
import { ACME_JOB, seedAcme } from "./fixtures.js";
import { harness } from "./harness.js";
import { sampleCopy } from "./helpers.js";
import { CHECK_CRASH, checkReport } from "./hf-outputs.js";
import { PITCH_SCRIPT, pitchSpec } from "./type-specs.js";

const JOB: VideoSubject = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const FOLDER = `${ACME_JOB}/interview/pitch-1`;
const PITCH_MD = { "pitch.md": "Right now I am an AI Engineer.\n" };
const files = () => ({ script: PITCH_SCRIPT, spec: pitchSpec(), extras: PITCH_MD });
function seeded() { const root = sampleCopy(); seedAcme(root); return root; }
const rec = (root: string) => readRecord("video", path.join(root, FOLDER, "video.json"));
const stage = (v: { stages: { id: string; status: string; message: string }[] }, id: string) => v.stages.find((s) => s.id === id)!;

describe("the video check (HyperFrames 0.8.140's real check output)", () => {
  it("a passing script goes all the way to the final video with the real sectioned check report", async () => {
    const root = seeded();
    const h = harness(root, { files });
    const v = h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    const run = h.pipeline.run(v.runId)!;
    expect(stage(run, "lint")).toMatchObject({ status: "done" });
    expect(stage(run, "lint").message).not.toMatch(/could not read/);
    expect(run.status).toBe("done");
    expect(rec(root).status).toBe("done");
  });

  it("a check that crashes or can't be read doesn't stop the video: it says the check was skipped", async () => {
    for (const out of [CHECK_CRASH, "garbage"]) {
      const root = seeded();
      const h = harness(root, { files, checkStdout: out });
      const v = h.pipeline.start("pitch", JOB, {});
      await h.pipeline.idle();
      const run = h.pipeline.run(v.runId)!;
      expect(run.status).toBe("done");
      expect(stage(run, "lint").message).toMatch(/layout check couldn't run, so it was skipped/);
    }
  });

  it("layout warnings and errors never stop the render", async () => {
    const root = seeded();
    const h = harness(root, { files, checkStdout: checkReport({ layout: [2, 1] }) });
    const v = h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("done");
    expect(stage(h.pipeline.run(v.runId)!, "lint").message).toMatch(/3 warnings/);
    // Honest, but not blocking: the video lists them as notes.
    const notes = h.pipeline.draft(FOLDER).check_notes;
    expect(notes).toEqual([{ area: "layout", text: "The title overflows its box" }, { area: "layout", text: "Text sits close to the edge" }]);
  });

  it("a clean check leaves no notes", async () => {
    const root = seeded();
    const h = harness(root, { files });
    h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    expect(h.pipeline.draft(FOLDER).check_notes).toEqual([]);
  });

  it("a contact sheet that can't be made doesn't stop the video", async () => {
    const root = seeded();
    const h = harness(root, { files, sheetFails: true });
    const v = h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("done");
    expect(stage(h.pipeline.run(v.runId)!, "final").message).toMatch(/contact sheet couldn't be made/);
    expect(h.pipeline.draft(FOLDER).files.contact_sheet).toBeNull();
  });
});

describe("when the video check stops a video that skipped review", () => {
  async function stoppedAtLint() {
    const root = seeded();
    const h = harness(root, { files, checkStdout: checkReport({ runtime: [1, 0] }) });
    const v = h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    return { root, h, run: h.pipeline.run(v.runId)! };
  }

  it("never lands on the review page: the video reads failed, with where and why it stopped", async () => {
    const { root, h, run } = await stoppedAtLint();
    expect(stage(run, "review").status).toBe("skipped");
    expect(stage(run, "lint").status).toBe("failed");
    expect(run.status).toBe("failed");
    expect(rec(root).status).toBe("failed");
    expect(rec(root).error).toMatch(/^The video check found 1 problem\. First: Uncaught TypeError/);
    const d = h.pipeline.draft(FOLDER);
    expect(d.status).toBe("failed");
    expect(d.stopped).toMatchObject({ stage: "lint", label: "Checking the video", quality: "final", can_skip_check: true });
    expect(d.can_approve).toBe(true);
  });

  it("Try again makes the final video (not a draft) from the failed stage, reusing the finished ones", async () => {
    const { root, h } = await stoppedAtLint();
    const narrations = h.control.narrations;
    const r = h.pipeline.retry(FOLDER);
    expect(r.phase).toBe("final");
    await h.pipeline.idle();
    const run = h.pipeline.run(r.runId)!;
    expect(h.control.narrations).toBe(narrations);
    expect(stage(run, "narrate").message).toBe("Reused");
    expect(stage(run, "lint").status).toBe("failed"); // the composition still throws
    expect(rec(root).stopped).toMatchObject({ stage: "lint", quality: "final", auto: true });
  });

  it("Make it without the check skips the browser check this once, and the next normal run checks again", async () => {
    const { root, h } = await stoppedAtLint();
    const checks = h.control.checks;
    const r = h.pipeline.retry(FOLDER, { skip_check: true });
    await h.pipeline.idle();
    const run = h.pipeline.run(r.runId)!;
    expect(h.control.checks).toBe(checks);
    expect(stage(run, "lint")).toMatchObject({ status: "done", message: expect.stringMatching(/skipped, as you asked/) });
    expect(run.status).toBe("done");
    expect(rec(root).status).toBe("done");
    expect(rec(root).stopped).toBeUndefined();
    expect(rec(root).stages.lint!.hash).toBe("");
    expect(h.pipeline.draft(FOLDER).check_notes).toEqual([{ area: "check", text: "The layout check was skipped, as you asked." }]);
    h.pipeline.render(FOLDER, "final");
    await h.pipeline.idle();
    expect(h.control.checks).toBe(checks + 1);
  });

  it("an approved draft that stops retries as a draft", async () => {
    const root = seeded();
    const h = harness(root, { files, checkStdout: checkReport({ runtime: [1, 0] }) });
    h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    expect(rec(root).status).toBe("review");
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(rec(root)).toMatchObject({ status: "failed", stopped: { stage: "lint", quality: "draft", auto: false } });
    expect(h.pipeline.retry(FOLDER).phase).toBe("build");
  });
});
