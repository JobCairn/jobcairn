import { describe, expect, it } from "vitest";
import { fakeRunner } from "../src/process.js";
import { captionSyncSamples, extractStills, qaFrameTimes, qaPlan, SYNC_TOLERANCE_S, syncMatches } from "../src/qa.js";
import type { Word } from "../src/types.js";

const words = (n: number): Word[] => Array.from({ length: n }, (_, i) => ({ text: `word${i}`, start: i * 0.4, end: i * 0.4 + 0.3 }));

describe("qaFrameTimes", () => {
  it("spreads 4 to 6 frames across the video, away from the first and last frame", () => {
    expect(qaFrameTimes(60)).toEqual([6, 18, 30, 42, 54]);
    expect(qaFrameTimes(10, 4)).toEqual([1.25, 3.75, 6.25, 8.75]);
    expect(qaFrameTimes(10, 2)).toHaveLength(4);
    expect(qaFrameTimes(10, 99)).toHaveLength(6);
    expect(qaFrameTimes(10, Number.NaN)).toHaveLength(5);
  });
  it("is empty without a usable duration", () => {
    for (const d of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(qaFrameTimes(d)).toEqual([]);
  });
});

describe("captionSyncSamples", () => {
  it("picks about 10 words spread through the transcript, with midpoints and a ±120 ms window", () => {
    const s = captionSyncSamples(words(100));
    expect(s).toHaveLength(10);
    expect(s.map((x) => x.index)).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
    expect(s[0]).toEqual({ index: 5, word: "word5", at: 2.15, from: 2.03, to: 2.27 });
    expect(SYNC_TOLERANCE_S).toBe(0.12);
  });
  it("takes every word of a short transcript and skips broken timings", () => {
    const w: Word[] = [
      { text: "Hello", start: 0, end: 0.2 }, { text: "...", start: 0.2, end: 0.3 }, { text: "bad", start: Number.NaN, end: 1 },
      { text: "back", start: 2, end: 1 }, { text: "world", start: 0.1, end: 0.12 },
    ];
    expect(captionSyncSamples(w)).toEqual([
      { index: 0, word: "Hello", at: 0.1, from: 0, to: 0.22 }, { index: 4, word: "world", at: 0.11, from: 0, to: 0.23 },
    ]);
    expect(captionSyncSamples([])).toEqual([]);
  });
});

describe("syncMatches", () => {
  const w: Word[] = [{ text: "Agents", start: 1, end: 1.31 }, { text: "are", start: 1.35, end: 1.5 }, { text: "core", start: 2, end: 2.4 }];
  const sample = captionSyncSamples(w)[1]!; // "are", midpoint 1.425
  it("passes the right word, or a neighbour within 120 ms", () => {
    expect(syncMatches(sample, "are", w)).toBe(true);
    expect(syncMatches(sample, "ARE,", w)).toBe(true);
    expect(syncMatches(sample, "Agents", w)).toBe(true); // ends at 1.31, within 120 ms of 1.425
  });
  it("fails a word further off, an unknown word, or nothing lit", () => {
    expect(syncMatches(sample, "core", w)).toBe(false);
    expect(syncMatches(sample, "banana", w)).toBe(false);
    expect(syncMatches(sample, null, w)).toBe(false);
    expect(syncMatches(sample, "  ", w)).toBe(false);
  });
});

describe("qaPlan and extractStills", () => {
  it("names a frame still and a sync still for each shot", () => {
    const p = qaPlan(20, words(30));
    expect(p.shots.filter((s) => s.kind === "frame").map((s) => s.file)).toEqual(["qa/frame-1.jpg", "qa/frame-2.jpg", "qa/frame-3.jpg", "qa/frame-4.jpg", "qa/frame-5.jpg"]);
    expect(p.shots.filter((s) => s.kind === "sync")).toHaveLength(10);
    expect(p.shots.find((s) => s.kind === "sync")).toMatchObject({ file: "qa/sync-1.jpg", word: "word1", at: 0.55 });
    // A caption word past the end of the video is never sampled.
    expect(qaPlan(1, words(30)).shots.filter((s) => s.kind === "sync").every((s) => s.at <= 1)).toBe(true);
  });

  it("runs ffmpeg once per still on the local file only", async () => {
    const runner = fakeRunner(async () => ({}));
    const shots = qaPlan(10, words(3)).shots;
    await extractStills(runner, "/fictional/bin/ffmpeg", "renders/final.mp4", shots, "/fictional/ws/video");
    expect(runner.calls).toHaveLength(shots.length);
    expect(runner.calls[0]).toMatchObject({ cmd: "/fictional/bin/ffmpeg", cwd: "/fictional/ws/video" });
    expect(runner.calls[0]!.args).toEqual(["-v", "error", "-nostdin", "-ss", "1.000", "-i", "renders/final.mp4", "-frames:v", "1", "-q:v", "3", "-y", "qa/frame-1.jpg"]);
    expect(runner.calls.flatMap((c) => c.args).some((a) => /^(https?|ftp):/.test(a))).toBe(false);
  });

  it("throws a plain error when ffmpeg fails, and cancels when aborted", async () => {
    const shots = qaPlan(10, []).shots;
    await expect(extractStills(fakeRunner(async () => ({ code: 1, stderr: "/secret/path broke" })), "ffmpeg", "v.mp4", shots, "/x")).rejects.toThrow("ffmpeg could not take the QA stills.");
    const ac = new AbortController();
    ac.abort();
    await expect(extractStills(fakeRunner(async () => ({})), "ffmpeg", "v.mp4", shots, "/x", ac.signal)).rejects.toThrow(/cancel/i);
  });
});
