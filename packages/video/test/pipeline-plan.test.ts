import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/pipeline.js";
import type { VideoSubject } from "../src/types.js";
import { seedAcme, ACME_JOB } from "./fixtures.js";
import { harness } from "./harness.js";
import { sampleCopy } from "./helpers.js";
import { PITCH_SCRIPT, pitchSpec } from "./type-specs.js";

const JOB: VideoSubject = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const FOLDER = `${ACME_JOB}/interview/pitch-1`;
const files = () => ({ script: PITCH_SCRIPT, spec: pitchSpec(), extras: { "pitch.md": "Right now I am an AI Engineer.\n" } });
function seeded() { const root = sampleCopy(); seedAcme(root); return root; }

describe("a run's plan: the steps it will take, fixed when it starts", () => {
  it("build plans include media (pictures and the sound mix, for every type) and leave out the render the run doesn't make", () => {
    expect(buildPlan("final", "none")).toEqual(["narrate", "captions", "media", "expand", "lint", "final", "save"]);
    expect(buildPlan("draft", "none")).toEqual(["narrate", "captions", "media", "expand", "lint", "draft"]);
    expect(buildPlan("final", "offline")).toEqual(["narrate", "captions", "media", "expand", "lint", "final", "save"]);
  });

  it("a new request that may skip review plans the whole way to the final video; the count never changes mid-run", async () => {
    const h = harness(seeded(), { files });
    const v = h.pipeline.start("pitch", JOB, {});
    const want = ["request", "sources", "write", "check", "narrate", "captions", "media", "expand", "lint", "final", "save"];
    expect(v.plan).toEqual(want);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.plan).toEqual(want);
    // Every planned step ran; nothing outside the plan did.
    const run = h.pipeline.run(v.runId)!;
    expect(run.stages.filter((s) => s.status === "done").map((s) => s.id)).toEqual(want);
    expect(h.pipeline.run(v.runId)!.status).toBe("done");
  });

  it("asking for review plans the script steps and the review", () => {
    const h = harness(seeded(), { files });
    expect(h.pipeline.start("pitch", JOB, { review: "always" }).plan).toEqual(["request", "sources", "write", "check", "review"]);
  });

  it("approve plans the draft; render final plans the final; revise plans the script steps", async () => {
    const h = harness(seeded(), { files });
    h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    expect(h.pipeline.approve(FOLDER).plan).toEqual(["narrate", "captions", "media", "expand", "lint", "draft"]);
    await h.pipeline.idle();
    expect(h.pipeline.render(FOLDER, "final").plan).toEqual(["narrate", "captions", "media", "expand", "lint", "final", "save"]);
    await h.pipeline.idle();
    expect(h.pipeline.revise(FOLDER, "Shorter.").plan).toEqual(["write", "check", "review"]);
    await h.pipeline.idle();
  });
});
