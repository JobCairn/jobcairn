import { describe, expect, it } from "vitest";
import { printTimeline, resolveTimeline } from "../src/timeline.js";
import { fakeWords, JD_SCRIPT, jdSpec, QUIZ_SCRIPT, quizSpec } from "./fixtures.js";
import type { SceneSpec, Word } from "../src/types.js";

describe("resolveTimeline", () => {
  it("places scenes and reveals on their cue words", () => {
    const { words, total } = fakeWords(JD_SCRIPT);
    expect(total).toBe(27.25);
    const t = resolveTimeline(jdSpec(), words, total);
    expect(t.issues).toEqual([]);
    expect(t.scenes.map((s) => [s.id, s.start, s.end])).toEqual([["s1", 0, 6.85], ["s2", 6.25, 13.7], ["s3", 13.1, 21.35], ["s4", 20.75, 27.25]]);
    expect(t.scenes[1]!.items).toEqual({ cue_left: 8.05, cue_right: 9.25 });
    expect(t.scenes[2]!.items).toEqual({ "items.0": 14.9, "items.1": 16.5, "items.2": 18.1 });
    expect(t.scenes[3]!.items).toEqual({ "items.0": 21.75, "items.1": 24.15, "items.2": 24.95 });
  });

  it("reports a cue the voice never said and still returns a full timeline", () => {
    const heard = fakeWords(JD_SCRIPT.replace("Second, shipping", "Next, shipping"));
    const t = resolveTimeline(jdSpec(), heard.words, heard.total);
    expect(t.issues.map((i) => i.message)).toEqual(['Scene 3: the cue "Second" for items.1 was not heard in the narration. Check the script, then narrate again.']);
    expect(t.scenes[2]!.items["items.1"]).toBe(15.9);
  });

  it("finds the think time inside a quiz scene", () => {
    const { words, total } = fakeWords(QUIZ_SCRIPT);
    const t = resolveTimeline(quizSpec(), words, total);
    expect(t.issues).toEqual([]);
    const q = t.scenes[1]!;
    expect(q.think).not.toBeNull();
    expect(q.think!.end - q.think!.start).toBeGreaterThan(8);
    expect(q.items.cue_review).toBeGreaterThan(q.think!.end);
    expect(q.items["beats.0"]).toBeGreaterThan(q.think!.end);
  });

  it("prints a readable timeline", () => {
    const { words, total } = fakeWords(JD_SCRIPT);
    const out = printTimeline(resolveTimeline(jdSpec(), words, total), jdSpec());
    expect(out.split("\n")[0]).toBe("s1  0.00 -> 6.85  title  What Acme Corp wants from an AI Engineer");
    expect(out).toContain("    cue_right  9.25");
  });

  describe("robust inputs (Ruling 1)", () => {
    it("rejects a non-finite or negative total as a plain error", () => {
      const { words } = fakeWords(JD_SCRIPT);
      expect(() => resolveTimeline(jdSpec(), words, NaN)).toThrow();
      expect(() => resolveTimeline(jdSpec(), words, Infinity)).toThrow();
      expect(() => resolveTimeline(jdSpec(), words, -1)).toThrow();
    });

    it("treats a hostile words array (NaN, Infinity, reversed, out of order) as unheard without breaking real cues", () => {
      const { words, total } = fakeWords(JD_SCRIPT);
      const hostile: Word[] = [
        { text: "ghost-inf", start: Infinity, end: 1 },
        words[0]!,
        { text: "ghost-nan", start: NaN, end: NaN },
        words[1]!,
        { text: "ghost-reversed", start: 5, end: 1 },
        ...words.slice(2, 10),
        { text: "ghost-neg-inf", start: -Infinity, end: 2 },
        ...words.slice(10),
        // valid (finite, not reversed) but earlier than everything around it: "unordered" is
        // allowed for a heard word, it just must not corrupt any other result.
        { text: "zzz-unordered-but-heard", start: 0.01, end: 0.02 },
      ];
      const t = resolveTimeline(jdSpec(), hostile, total);
      // the real cues are all still present, in order, so the timeline is unaffected by the
      // interspersed hostile/extra entries
      expect(t.issues).toEqual([]);
      expect(t.scenes.map((s) => [s.id, s.start, s.end])).toEqual([["s1", 0, 6.85], ["s2", 6.25, 13.7], ["s3", 13.1, 21.35], ["s4", 20.75, 27.25]]);
      for (const s of t.scenes) {
        expect(Number.isFinite(s.start)).toBe(true);
        expect(Number.isFinite(s.end)).toBe(true);
        expect(s.start).toBeGreaterThanOrEqual(0);
        expect(s.end).toBeLessThanOrEqual(total);
        expect(s.start).toBeLessThanOrEqual(s.end);
        for (const v of Object.values(s.items)) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(total);
        }
      }
    });

    it("clamps every time into [0, total] when total is shorter than the last cue", () => {
      const { words } = fakeWords(JD_SCRIPT);
      const shortTotal = 5;
      const t = resolveTimeline(jdSpec(), words, shortTotal);
      expect(t.total).toBe(5);
      expect(t.scenes).toHaveLength(4);
      for (const s of t.scenes) {
        expect(Number.isFinite(s.start)).toBe(true);
        expect(Number.isFinite(s.end)).toBe(true);
        expect(s.start).toBeGreaterThanOrEqual(0);
        expect(s.end).toBeLessThanOrEqual(shortTotal);
        expect(s.start).toBeLessThanOrEqual(s.end);
        for (const v of Object.values(s.items)) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(shortTotal);
        }
      }
      expect(t.scenes.at(-1)!.end).toBe(5);
    });

    it("sanitizes hostile spec text (newlines, cue arrows) before it reaches printed lines, like captions.ts does", () => {
      const { words, total } = fakeWords(JD_SCRIPT);
      const spec = jdSpec();
      // a hostile title trying to forge an extra log line / inject SRT-like cue syntax
      (spec.scenes[0] as { title: string }).title = "evil\ntitle --> 00:00:01,000";
      const out = printTimeline(resolveTimeline(spec, words, total), spec);
      const firstLine = out.split("\n")[0]!;
      expect(firstLine).not.toContain("\n");
      expect(firstLine).not.toContain("-->");
      expect(firstLine).toContain("evil title -> 00:00:01,000");
    });
  });

  describe("fix round 1", () => {
    it("chains the marks fallback off the previous mark, not the scene start, and marks never go backwards", () => {
      const { words, total } = fakeWords(JD_SCRIPT);
      const spec = jdSpec();
      (spec.scenes[1] as unknown as { marks: { type: string; target: string; cue: string }[] }).marks = [
        { type: "underline", target: "retrieval", cue: "retrieval" },
        { type: "circle", target: "nothing", cue: "nothing like this exists" },
      ];
      const t = resolveTimeline(spec, words, total);
      const s2 = t.scenes[1]!;
      expect(s2.marks).toHaveLength(2);
      // the first mark is found on its own cue word, after the scene start
      expect(s2.marks[0]).toBeGreaterThan(s2.start);
      // the second mark's cue was never heard: it must fall back to one second after the FIRST
      // mark, not one second after the scene start (the bug this fixes)
      const expectedFallback = Math.round((s2.marks[0]! + 1) * 100) / 100;
      expect(s2.marks[1]).toBe(expectedFallback);
      expect(s2.marks[1]).toBeGreaterThan(s2.marks[0]!);
      expect(t.issues.map((i) => i.message)).toContain(
        'Scene 2: the cue "nothing like this exists" for marks.1 was not heard in the narration. Check the script, then narrate again.',
      );
    });

    it("finds a short quiz think window too, not just gaps of 2s or more", () => {
      const spec: SceneSpec = {
        version: 2, title: "T", voice_type: "interview",
        scenes: [
          { type: "title", cue: "Intro", kicker: "k", title: "Intro" },
          {
            type: "quiz", cue: "Question", kind: "behavioural", question: "Q?", think_seconds: 8,
            beats: [{ label: "A", text: "A", cue: "Answer" }], strong: [], weak: [], prompt: "p", cue_review: "Review",
          },
        ],
      };
      const words: Word[] = [
        { text: "Intro", start: 0, end: 0.3 },
        { text: "Question", start: 1, end: 1.3 },
        { text: "before", start: 1.4, end: 1.7 },
        { text: "left", start: 1.8, end: 2.1 },
        { text: "right", start: 3.6, end: 3.9 }, // gap from "left" = 1.5s, below the old 2s floor
        { text: "Answer", start: 4.0, end: 4.3 },
        { text: "Review", start: 4.4, end: 4.7 },
      ];
      const t = resolveTimeline(spec, words, 6);
      expect(t.issues).toEqual([]);
      const q = t.scenes[1]!;
      expect(q.think).not.toBeNull();
      expect(q.think!.start).toBeCloseTo(2.1, 2);
      expect(q.think!.end).toBeCloseTo(3.6, 2);
      expect(q.think!.end - q.think!.start).toBeCloseTo(1.5, 2);
    });

    it("still finds a think window (just a small one) in a quiz scene with no [pause]", () => {
      const noPause = QUIZ_SCRIPT.replaceAll("[pause 8]\n\n", "");
      const { words, total } = fakeWords(noPause);
      const t = resolveTimeline(quizSpec(), words, total);
      expect(t.issues).toEqual([]);
      const q = t.scenes[1]!;
      expect(q.think).not.toBeNull();
      // under the old `gap >= 2` floor this would have been null
      expect(q.think!.end - q.think!.start).toBeLessThan(2);
      expect(q.think!.end - q.think!.start).toBeGreaterThan(0);
    });

    it("reports a scene-0 cue the voice never said too, even though scene 1 still starts at 0", () => {
      const { words, total } = fakeWords(JD_SCRIPT);
      const spec = jdSpec();
      spec.scenes[0]!.cue = "Nonexistent opening phrase";
      const t = resolveTimeline(spec, words, total);
      expect(t.issues.map((i) => i.message)).toContain(
        'Scene 1: the cue "Nonexistent opening phrase" was not heard in the narration. Check the script, then narrate again.',
      );
      expect(t.scenes[0]!.start).toBe(0);
    });
  });
});
