import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRecord } from "@careeros/core";
import { CAPTION_TIMING, stageHashes } from "../src/pipeline.js";
import type { Word } from "../src/types.js";
import { ACME_JOB, fakeParagraphs, QUIZ_SCRIPT, quizSpec, seedAcme } from "./fixtures.js";
import { harness } from "./harness.js";
import { sampleCopy } from "./helpers.js";

const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
const FOLDER = `${ACME_JOB}/interview/1`;
const drill = () => ({ script: QUIZ_SCRIPT, spec: quizSpec(), extras: { "notes.md": "# Notes\n" } });

async function finalVideo(o: Parameters<typeof harness>[1] = {}) {
  const root = sampleCopy();
  seedAcme(root);
  const h = harness(root, { files: drill, ...o });
  h.pipeline.start("interview-prep", JOB, { mode: "practice" });
  await h.pipeline.idle();
  const run = h.pipeline.render(FOLDER, "final");
  await h.pipeline.idle();
  expect(h.pipeline.run(run.runId)!.status, h.pipeline.run(run.runId)!.error ?? "").toBe("done");
  return { root, h, abs: path.join(root, FOLDER) };
}

describe("caption sync in the pipeline (a drill with 8 s think pauses)", () => {
  it("lets whisper hear the narration with the think pauses cut, then puts every word back on the real timeline", async () => {
    const { h, abs } = await finalVideo();
    expect(h.control.silencedetects).toBeGreaterThanOrEqual(2); // captions, then the QA check
    // Three think pauses (and the quiet tail) cut: what whisper hears is about 25 s shorter.
    const kept = h.control.condensed.reduce((t, c) => t + c.to - c.from, 0);
    const total = JSON.parse(fs.readFileSync(path.join(abs, "narration.timing.json"), "utf8")).total as number;
    expect(total - kept).toBeGreaterThan(24);
    expect(h.control.transcribed).toEqual(["work/listen.wav"]);
    const words = JSON.parse(fs.readFileSync(path.join(abs, "transcript.json"), "utf8")) as Word[];
    const paras = fakeParagraphs(QUIZ_SCRIPT);
    // The first word of each paragraph starts where that paragraph's voice starts, not inside a pause.
    let n = 0;
    for (const p of paras) {
      expect(words[n]!.start).toBeCloseTo(p.start, 2);
      n += p.text.split(/\s+/).length;
    }
  });

  it("writes the caption sync check and adds no note when the captions match the voice", async () => {
    const { root, abs } = await finalVideo();
    const sync = JSON.parse(fs.readFileSync(path.join(abs, "qa", "sync.json"), "utf8"));
    expect(sync).toMatchObject({ ok: true, audio_start_s: 0, limit_ms: 150 });
    expect(sync.points.length).toBeGreaterThan(10);
    expect(sync.message).toMatch(/^Captions match the voice/);
    const rec = readRecord("video", path.join(root, FOLDER, "video.json"));
    expect((rec.check_notes ?? []).filter((n) => n.area === "captions")).toEqual([]);
  });

  it("flags, in plain words, a final video whose sound starts late", async () => {
    const { root } = await finalVideo({ audioStart: 0.4 });
    const rec = readRecord("video", path.join(root, FOLDER, "video.json"));
    expect(rec.status).toBe("done");
    expect(rec.check_notes).toContainEqual({ area: "captions", text: "The sound starts 0.40 s late in the video, so the captions are off by that much." });
  });

  it("still makes captions when ffmpeg can't measure the silences", async () => {
    const root = sampleCopy();
    seedAcme(root);
    const h = harness(root, { files: drill, ffmpegFails: true });
    h.pipeline.start("interview-prep", JOB, { mode: "practice" });
    await h.pipeline.idle();
    expect(h.control.transcribed).toEqual(["work/narration.wav"]);
    expect(fs.existsSync(path.join(root, FOLDER, "captions.vtt"))).toBe(true);
  });
});

describe("caption cache", () => {
  it("changes the captions hash with the timing version, so old videos re-time their captions", () => {
    const base = { script: "Hi.", specText: "{}", voiceType: "interview", voice: {}, style: "rail", templatesDir: "/none", gsapFile: "/none" };
    expect(CAPTION_TIMING).toBe("timing-v2");
    expect(stageHashes(base).captions).not.toBe(stageHashes({ ...base, listen: "base.en" }).captions);
  });
});
