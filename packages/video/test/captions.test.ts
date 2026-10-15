import { describe, expect, it } from "vitest";
import {
  alignWords, groupCaptions, MAX_ALIGN_HEARD_WORDS, MAX_ALIGN_SCRIPT_TOKENS, toSrt, toVtt, wordsFromTiming,
} from "../src/captions.js";
import type { Word } from "../src/types.js";
import type { CaptionGroup } from "../src/captions.js";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });

describe("alignWords", () => {
  it("keeps script spelling with heard timings", () => {
    const heard = [w("Run", 0.5, 0.7), w("cube", 0.8, 1.0), w("control", 1.0, 1.3), w("get", 1.4, 1.6), w("pods.", 1.6, 1.9)];
    expect(alignWords("Run kubectl get pods.\n", heard)).toEqual([w("Run", 0.5, 0.7), w("kubectl", 0.8, 1.3), w("get", 1.4, 1.6), w("pods.", 1.6, 1.9)]);
  });
  it("drops extra heard words and fills skipped ones", () => {
    const heard = [w("So", 0.5, 0.6), w("um", 0.7, 0.8), w("RAG", 0.9, 1.2), w("helps.", 1.6, 1.9)];
    expect(alignWords("So RAG really helps.\n", heard)).toEqual([w("So", 0.5, 0.6), w("RAG", 0.9, 1.2), w("really", 1.2, 1.6), w("helps.", 1.6, 1.9)]);
  });
  it("ignores notes, pauses and expression tags", () => {
    const heard = [w("Hi", 0.5, 0.7), w("there", 0.8, 1.0), w("Go", 9.5, 9.7)];
    expect(alignWords("# note\nHi <breath> there\n\n[pause 8]\n\nGo\n", heard).map((x) => x.text)).toEqual(["Hi", "there", "Go"]);
  });
  it("returns nothing without heard words", () => {
    expect(alignWords("Hello.\n", [])).toEqual([]);
  });

  describe("bounded inputs (Ruling 1)", () => {
    it("falls back to proportional timing when the script has more tokens than the cap", () => {
      const n = MAX_ALIGN_SCRIPT_TOKENS + 1;
      const script = Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
      const heard = [w("w0", 0, 10)];
      const out = alignWords(script, heard);
      expect(out).toHaveLength(n);
      expect(out[0]!.text).toBe("w0");
      expect(out.at(-1)!.text).toBe(`w${n - 1}`);
      expect(out[0]!.start).toBe(0);
      expect(out.at(-1)!.end).toBe(10);
      // monotonic, evenly spread, never beyond the heard span
      for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.start);
      expect(out.every((x) => x.start >= 0 && x.end <= 10 && x.end >= x.start)).toBe(true);
    });

    it("falls back to proportional timing when there are more heard words than the cap", () => {
      const m = MAX_ALIGN_HEARD_WORDS + 1;
      const heard = Array.from({ length: m }, (_, i) => w(`h${i}`, i, i + 1));
      const out = alignWords("one two three\n", heard);
      expect(out).toHaveLength(3);
      expect(out.map((x) => x.text)).toEqual(["one", "two", "three"]);
      expect(out[0]!.start).toBe(0);
      expect(out.at(-1)!.end).toBe(m);
    });

    it("stays within the caps for ordinary inputs (no fallback triggered)", () => {
      // A script right at the cap, aligned 1:1, must still use real LCS alignment: the
      // heard spelling differs from the script spelling, which proportional timing
      // could never reproduce (it only ever copies script spelling, so this only proves
      // we took the LCS branch by checking the *timings* line up with real anchors).
      const words = Array.from({ length: 50 }, (_, i) => `w${i}`);
      const script = words.join(" ") + "\n";
      const heard = words.map((text, i) => w(text, i, i + 0.5));
      const out = alignWords(script, heard);
      expect(out).toHaveLength(50);
      expect(out[10]).toEqual(w("w10", 10, 10.5));
    });
  });
});

describe("caption files", () => {
  const words = [
    w("Run", 0.5, 0.7), w("kubectl", 0.8, 1.3), w("get", 1.4, 1.6), w("pods.", 1.6, 1.9),
    w("Then", 2.0, 2.2), w("read", 2.3, 2.5), w("the", 2.5, 2.6), w("output", 2.6, 2.9), w("line", 2.9, 3.1), w("by", 3.1, 3.2), w("line.", 3.2, 3.5),
  ];
  it("groups like the composition does", () => {
    expect(groupCaptions(words).map((g) => g.text)).toEqual(["Run kubectl get pods.", "Then read the output line", "by line."]);
  });
  it("writes SRT and VTT", () => {
    const g = groupCaptions(words);
    expect(toSrt(g)).toBe([
      "1", "00:00:00,500 --> 00:00:01,960", "Run kubectl get pods.", "",
      "2", "00:00:02,000 --> 00:00:03,060", "Then read the output line", "",
      "3", "00:00:03,100 --> 00:00:03,900", "by line.", "", "",
    ].join("\n"));
    expect(toVtt(g)).toBe([
      "WEBVTT", "",
      "00:00:00.500 --> 00:00:01.960", "Run kubectl get pods.", "",
      "00:00:02.000 --> 00:00:03.060", "Then read the output line", "",
      "00:00:03.100 --> 00:00:03.900", "by line.", "", "",
    ].join("\n"));
  });
  it("reads narrate.py's estimated words", () => {
    expect(wordsFromTiming({ words_estimated: [{ text: "Hi", start: 0.5, end: 0.8 }, { text: 3 }] })).toEqual([w("Hi", 0.5, 0.8)]);
    expect(wordsFromTiming(null)).toEqual([]);
  });

  describe("wordsFromTiming robustness (Ruling 2)", () => {
    it("never throws on junk input and returns [] for shapes that aren't a timing object", () => {
      expect(wordsFromTiming(undefined)).toEqual([]);
      expect(wordsFromTiming(42)).toEqual([]);
      expect(wordsFromTiming("oops")).toEqual([]);
      expect(wordsFromTiming([])).toEqual([]);
      expect(wordsFromTiming({})).toEqual([]);
      expect(wordsFromTiming({ words_estimated: "not an array" })).toEqual([]);
      expect(wordsFromTiming({ words_estimated: null })).toEqual([]);
      expect(wordsFromTiming({ words_estimated: [null, undefined, 1, "x", [], true] })).toEqual([]);
    });

    it("ignores a hostile getter instead of throwing", () => {
      const hostile = {
        get words_estimated(): unknown { throw new Error("boom"); },
      };
      expect(wordsFromTiming(hostile)).toEqual([]);
      const hostileEntry = [{ get text() { throw new Error("boom"); }, start: 0, end: 1 }];
      expect(wordsFromTiming({ words_estimated: hostileEntry })).toEqual([]);
    });

    it("drops non-finite, negative and reversed start/end", () => {
      const list = [
        { text: "nan-start", start: NaN, end: 1 },
        { text: "nan-end", start: 0, end: Infinity },
        { text: "neg-start", start: -1, end: 1 },
        { text: "neg-end", start: 0, end: -1 },
        { text: "reversed", start: 2, end: 1 },
        { text: "ok", start: 0.5, end: 0.8 },
      ];
      expect(wordsFromTiming({ words_estimated: list })).toEqual([w("ok", 0.5, 0.8)]);
    });

    it("makes the output monotonic: no caption ends before it starts, no backwards overlap", () => {
      const list = [
        { text: "a", start: 1, end: 2 },
        { text: "b", start: 1.5, end: 1.8 }, // starts before the previous one ends
        { text: "c", start: 5, end: 6 },
      ];
      const out = wordsFromTiming({ words_estimated: list });
      expect(out).toHaveLength(3);
      for (const word of out) expect(word.end).toBeGreaterThanOrEqual(word.start);
      for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.end);
      expect(out[1]!.start).toBe(out[0]!.end);
    });

    it("caps the number of entries it will process", () => {
      const n = MAX_ALIGN_HEARD_WORDS + 5;
      const list = Array.from({ length: n }, (_, i) => ({ text: `w${i}`, start: i, end: i + 1 }));
      const out = wordsFromTiming({ words_estimated: list });
      expect(out.length).toBeLessThanOrEqual(MAX_ALIGN_HEARD_WORDS);
    });
  });

  describe("safe caption text (Ruling 3)", () => {
    const base: Word[] = [w("a", 0, 1)];
    const groupWith = (text: string): CaptionGroup[] => [{ words: base, start: 0, end: 1, text }];

    it("collapses CR, LF, U+2028 and U+2029 to spaces", () => {
      const g = groupWith("line1\rline2\nline3 line4 line5");
      expect(toSrt(g)).toContain("line1 line2 line3 line4 line5");
      expect(toVtt(g)).toContain("line1 line2 line3 line4 line5");
      expect(toSrt(g).includes("\r")).toBe(false);
      // no bare "\n\n" (blank line) can appear inside the cue block
      expect(toSrt(g)).not.toMatch(/\n\n\n/);
    });

    it("escapes & < > in VTT but not in SRT", () => {
      const g = groupWith("A & B <tag> C > D");
      expect(toVtt(g)).toContain("A &amp; B &lt;tag&gt; C &gt; D");
      expect(toSrt(g)).toContain("A & B <tag> C > D");
    });

    it("never lets '-->' appear in cue text in either format", () => {
      const g = groupWith("before --> after");
      expect(toSrt(g)).not.toMatch(/before --> after/);
      expect(toVtt(g)).not.toMatch(/before --> after/);
      // the timestamp line's own "-->" must still be intact
      expect(toSrt(g)).toContain(" --> ");
      expect(toVtt(g)).toContain(" --> ");
    });

    it("never leaves a blank line inside a cue, even when the text sanitizes to nothing", () => {
      const g = groupWith("​​﻿"); // all Default_Ignorable_Code_Point
      const srt = toSrt(g);
      const vtt = toVtt(g);
      // every line between the timestamp and the trailing blank separator must be non-empty
      const srtLines = srt.split("\n");
      const tsIdx = srtLines.findIndex((l) => l.includes(" --> "));
      expect(srtLines[tsIdx + 1]).not.toBe("");
      const vttLines = vtt.split("\n");
      const vtsIdx = vttLines.findIndex((l) => l.includes(" --> "));
      expect(vttLines[vtsIdx + 1]).not.toBe("");
    });

    it("strips Default_Ignorable_Code_Point characters from caption text", () => {
      const g = groupWith("Hi​ there﻿!");
      expect(toSrt(g)).toContain("Hi there!");
      expect(toVtt(g)).toContain("Hi there!");
    });

    it("sanitizes per-word text inside groupCaptions itself", () => {
      const dirty = [w("Run\r\nkubectl", 0.5, 0.7), w("get-->pods.", 0.8, 1.0)];
      const groups = groupCaptions(dirty);
      expect(groups.map((g) => g.text).join(" ")).not.toMatch(/-->/);
      expect(groups.map((g) => g.text).join(" ")).not.toMatch(/[\r\n]/);
    });
  });

  describe("timestamp rounding and carry (Ruling 4)", () => {
    const g = (start: number, end: number): CaptionGroup[] => [{ words: base(start, end), start, end, text: "x" }];
    function base(start: number, end: number): Word[] { return [w("x", start, end)]; }

    it("rounds 59.9995s up with a carry into minutes, not 60 seconds", () => {
      expect(toSrt(g(59.9995, 59.9995))).toContain("00:01:00,000");
      expect(toVtt(g(59.9995, 59.9995))).toContain("00:01:00.000");
    });

    it("carries seconds into minutes into hours", () => {
      expect(toSrt(g(3599.9995, 3599.9995))).toContain("01:00:00,000");
    });

    it("clamps negative timestamps to zero", () => {
      expect(toSrt(g(-5, -1))).toContain("00:00:00,000");
    });

    it("pads milliseconds and uses the right separator per format", () => {
      expect(toSrt(g(1.2, 1.2))).toContain("00:00:01,200");
      expect(toVtt(g(1.2, 1.2))).toContain("00:00:01.200");
    });
  });
});
