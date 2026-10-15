import { describe, expect, it } from "vitest";
import {
  choiceFor, CUSTOM_MAX_S, CUSTOM_MIN_S, DEFAULT_MAKING_RATE, estimateMakingSeconds, formatLength, makingRateFrom, makingTimeText,
  parseCustomLength, PRESET_SECONDS, presetsFor, stageEstimates,
} from "../src/video-lengths.js";

const WIDE = { min_s: 30, target_s: 150, max_s: 600 };
const PITCH = { min_s: 30, target_s: 60, max_s: 180 };

describe("length presets", () => {
  it("map to seconds: Quick about 1 min, Standard 2 to 3, In-depth 5 to 8", () => {
    expect(PRESET_SECONDS).toEqual({ quick: 60, standard: 150, in_depth: 390 });
    expect(PRESET_SECONDS.standard).toBeGreaterThanOrEqual(120);
    expect(PRESET_SECONDS.standard).toBeLessThanOrEqual(180);
    expect(PRESET_SECONDS.in_depth).toBeGreaterThanOrEqual(300);
    expect(PRESET_SECONDS.in_depth).toBeLessThanOrEqual(480);
  });
  it("offers only the presets that fit the type's range", () => {
    expect(presetsFor(WIDE)).toEqual(["quick", "standard", "in_depth"]);
    expect(presetsFor(PITCH)).toEqual(["quick", "standard"]);
    expect(presetsFor({ min_s: 30, target_s: 50, max_s: 60 })).toEqual(["quick"]);
  });
  it("picks the preset that matches a length, else custom", () => {
    expect(choiceFor(WIDE, 150)).toBe("standard");
    expect(choiceFor(WIDE, 390)).toBe("in_depth");
    expect(choiceFor(WIDE, 200)).toBe("custom");
    expect(choiceFor(PITCH, 390)).toBe("custom");
  });
});

describe("custom length", () => {
  it("reads m:ss and whole minutes", () => {
    expect(parseCustomLength("4:30", WIDE)).toEqual({ ok: true, seconds: 270 });
    expect(parseCustomLength(" 0:30 ")).toEqual({ ok: true, seconds: 30 });
    expect(parseCustomLength("10:00")).toEqual({ ok: true, seconds: 600 });
    expect(parseCustomLength("5", WIDE)).toEqual({ ok: true, seconds: 300 });
  });
  it("refuses anything outside 0:30 to 10:00 and says the range", () => {
    expect(CUSTOM_MIN_S).toBe(30);
    expect(CUSTOM_MAX_S).toBe(600);
    expect(parseCustomLength("0:29")).toEqual({ ok: false, error: "This video can run 0:30 to 10:00." });
    expect(parseCustomLength("10:01")).toEqual({ ok: false, error: "This video can run 0:30 to 10:00." });
    expect(parseCustomLength("11")).toEqual({ ok: false, error: "This video can run 0:30 to 10:00." });
  });
  it("narrows to the type's own range and names the type", () => {
    expect(parseCustomLength("4:00", PITCH, "Tell me about yourself")).toEqual({ ok: false, error: "Tell me about yourself can run 0:30 to 3:00." });
    expect(parseCustomLength("2:45", PITCH)).toEqual({ ok: true, seconds: 165 });
  });
  it("explains a value it can't read", () => {
    for (const bad of ["", "abc", "4:5", "4:60", "1:2:3", "-1", "2.5"]) {
      const r = parseCustomLength(bad, WIDE);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/0:30 to 10:00\.$/);
    }
  });
  it("formats m:ss", () => {
    expect(formatLength(30)).toBe("0:30");
    expect(formatLength(150)).toBe("2:30");
    expect(formatLength(600)).toBe("10:00");
  });
});

describe("making-time estimate", () => {
  it("adds a fixed part to a rate per second of video", () => {
    expect(estimateMakingSeconds(60)).toBe(DEFAULT_MAKING_RATE.fixed_s + 60 * DEFAULT_MAKING_RATE.per_video_s);
    expect(estimateMakingSeconds(150, { fixed_s: 60, per_video_s: 2, measured: true })).toBe(360);
    expect(estimateMakingSeconds(Number.NaN)).toBe(DEFAULT_MAKING_RATE.fixed_s);
  });
  it("says about, rounds up and never says 0 min", () => {
    expect(makingTimeText(150, { fixed_s: 60, per_video_s: 2, measured: true }, "this Mac")).toBe("About 6 min to make on this Mac");
    expect(makingTimeText(150, { fixed_s: 61, per_video_s: 2, measured: true })).toBe("About 7 min to make on this computer");
    expect(makingTimeText(0, { fixed_s: 0, per_video_s: 0, measured: true })).toBe("About 1 min to make on this computer");
    expect(makingTimeText(600, { fixed_s: 120, per_video_s: 6, measured: true })).toBe("About 1 hr 2 min to make on this computer");
  });
  it("uses the median of finished videos once there are two, never far below the default", () => {
    expect(makingRateFrom([])).toEqual(DEFAULT_MAKING_RATE);
    expect(makingRateFrom([{ length_s: 60, stage_ms: 300_000 }])).toEqual(DEFAULT_MAKING_RATE);
    expect(makingRateFrom([{ length_s: 60, stage_ms: 180_000 }, { length_s: 100, stage_ms: 400_000 }, { length_s: 0, stage_ms: 5 }]))
      .toEqual({ fixed_s: DEFAULT_MAKING_RATE.fixed_s, per_video_s: 3.5, measured: true });
    expect(makingRateFrom([{ length_s: 60, stage_ms: 1000 }, { length_s: 60, stage_ms: 1000 }]).per_video_s).toBe(DEFAULT_MAKING_RATE.per_video_s / 2);
  });
});

describe("stageEstimates", () => {
  it("uses the defaults until two videos really ran a step, scaling render steps with the length", () => {
    const e = stageEstimates([], 120);
    expect(e.measured).toBe(false);
    expect(e.ms.write).toBe(150_000);
    expect(e.ms.final).toBe(Math.round(1.1 * 120 * 1000));
  });
  it("takes the median of this computer's own times, per second of video for render steps", () => {
    const e = stageEstimates([
      { length_s: 60, stages: { final: 60_000, lint: 30_000, write: 0 } },
      { length_s: 120, stages: { final: 240_000, lint: 50_000 } },
      { length_s: 60, stages: { final: 90_000, lint: 40_000 } },
    ], 100);
    expect(e.measured).toBe(true);
    expect(e.ms.final).toBe(150_000); // median 1.5 s per second of video
    expect(e.ms.lint).toBe(40_000);
    expect(e.ms.write).toBe(150_000); // a reused (0 ms) step never counts
  });
});
