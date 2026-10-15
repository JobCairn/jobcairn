import { describe, expect, it } from "vitest";
import { alignWords } from "../src/captions.js";
import {
  captionDrift, condenseArgs, cutsFromParagraphs, cutsFromSilences, fitWords, listenPlan, paragraphOfTokens, parseSilences,
  realTime, speechSpan, timeWords, toRealTime, type Span,
} from "../src/sync.js";
import { fakeRunner } from "../src/process.js";
import { detectSilences } from "../src/sync.js";
import { LEAD_IN, resolveTimeline } from "../src/timeline.js";
import type { Word } from "../src/types.js";
import { fakeParagraphs, fakeWords, QUIZ_SCRIPT, quizSpec } from "./fixtures.js";

// A fictional three-paragraph drill: a question, an 8 s think pause, then the model answer. Timings are made up
// to match what narrate.py and silencedetect report for audio like this (digital silence between paragraphs, a
// short quiet lead-in inside each paragraph's own audio).
const SCRIPT = [
  "Here is your drill for Acme Corp.",
  "Tell me about a time you shipped an agent.",
  "[pause 8]",
  "A strong answer starts with the situation.",
].join("\n\n");
const PARAS: Span[] = [{ start: 0.5, end: 3.0 }, { start: 3.45, end: 6.3 }, { start: 14.75, end: 18.0 }];
const TOTAL = 19.0;
// Voice is silent: before the first word, in each paragraph's quiet lead-in/tail, and in the think pause.
const SILENCES: Span[] = [{ start: 0, end: 0.8 }, { start: 2.6, end: 3.85 }, { start: 5.7, end: 15.1 }, { start: 17.6, end: TOTAL }];
const w = (text: string, start: number, end: number): Word => ({ text, start, end });

/** What whisper hears across the long pause: "an agent." dragged into it, and the answer's first words spread
 * evenly across it at about 1.2 s each, the shape found in the bug report's video. */
function smeared(): Word[] {
  return [
    w("Here", 0.8, 1.0), w("is", 1.05, 1.2), w("your", 1.25, 1.5), w("drill", 1.55, 1.9), w("for", 1.95, 2.1), w("Acme", 2.15, 2.35), w("Corp.", 2.4, 2.6),
    w("Tell", 3.85, 4.05), w("me", 4.1, 4.2), w("about", 4.25, 4.5), w("a", 4.55, 4.6), w("time", 4.65, 4.9), w("you", 4.95, 5.05), w("shipped", 5.1, 5.4),
    w("an", 8.0, 9.3), w("agent.", 9.3, 10.5),
    w("A", 10.5, 11.7), w("strong", 11.7, 12.9), w("answer", 12.9, 14.1), w("starts", 14.1, 15.3),
    w("with", 15.6, 15.8), w("the", 15.85, 15.95), w("situation.", 16.0, 17.5),
  ];
}

describe("parseSilences", () => {
  it("reads silencedetect's stderr and closes a silence still open at the end", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 0",
      "[silencedetect @ 0x1] silence_end: 0.8 | silence_duration: 0.8",
      "size=N/A time=00:00:10.00 bitrate=N/A",
      "[silencedetect @ 0x1] silence_start: 5.7",
      "[silencedetect @ 0x1] silence_end: 15.1 | silence_duration: 9.4",
      "[silencedetect @ 0x1] silence_start: 17.6",
    ].join("\n");
    expect(parseSilences(stderr, TOTAL)).toEqual([{ start: 0, end: 0.8 }, { start: 5.7, end: 15.1 }, { start: 17.6, end: 19 }]);
  });
  it("ignores junk and an end with no start", () => {
    expect(parseSilences("silence_end: 3\nsilence_start: abc\nnothing here", 10)).toEqual([]);
  });
});

describe("speechSpan", () => {
  it("trims a paragraph to where its voice actually sounds", () => {
    expect(speechSpan(PARAS[1]!, SILENCES)).toEqual({ start: 3.85, end: 5.7 });
    expect(speechSpan(PARAS[2]!, SILENCES)).toEqual({ start: 15.1, end: 17.6 });
  });
  it("falls back to the paragraph itself without silences", () => {
    expect(speechSpan(PARAS[1]!, null)).toEqual(PARAS[1]);
  });
});

describe("listenPlan and realTime", () => {
  it("cuts the middle of each long silence and maps heard times back", () => {
    const plan = listenPlan(cutsFromSilences(SILENCES), TOTAL)!;
    // 0 -> 0.8 is exactly 0.8 s: longer than 0.6, so its middle is cut too.
    expect(plan[0]).toEqual({ from: 0, to: 0.1, at: 0 });
    const think = plan.find((s) => s.from === 14.85)!;
    expect(think).toBeTruthy();
    // A word whisper hears 0.3 s into the segment after the think pause is 0.3 s into it on the real timeline.
    expect(realTime(think.at + 0.3, plan)).toBeCloseTo(15.15, 3);
    // The condensed copy is much shorter than the narration.
    const last = plan.at(-1)!;
    expect(last.at + (last.to - last.from)).toBeLessThan(TOTAL - 9);
  });
  it("is null when there's nothing long to cut", () => {
    expect(listenPlan(cutsFromSilences([{ start: 1, end: 1.4 }]), 10)).toBeNull();
    expect(listenPlan([], 10)).toBeNull();
  });
  it("can cut by paragraph gaps alone", () => {
    expect(cutsFromParagraphs(PARAS)).toEqual([{ start: 6.4, end: 14.5 }]);
  });
  it("builds a plain ffmpeg trim-and-join command", () => {
    const args = condenseArgs("work/narration.wav", "work/listen.wav", [{ from: 0, to: 6.4, at: 0 }, { from: 14.5, to: 19, at: 6.4 }]);
    expect(args).toContain("-filter_complex");
    expect(args.join(" ")).toContain("atrim=start=0.000:end=6.400");
    expect(args.join(" ")).toContain("concat=n=2:v=0:a=1[out]");
    expect(args.at(-1)).toBe("work/listen.wav");
  });
  it("maps every heard word back, never ending before it starts", () => {
    const plan = [{ from: 0, to: 6.4, at: 0 }, { from: 14.5, to: 19, at: 6.4 }];
    expect(toRealTime([w("A", 6.5, 6.7)], plan)).toEqual([w("A", 14.6, 14.8)]);
    expect(toRealTime([w("A", 6.3, 6.5)], plan)).toEqual([w("A", 6.3, 14.6)]);
    expect(toRealTime([w("A", 1, 2)], null)).toEqual([w("A", 1, 2)]);
  });
});

describe("paragraphOfTokens", () => {
  it("skips pause blocks when counting paragraphs", () => {
    const para = paragraphOfTokens(SCRIPT, 3)!;
    expect(para.slice(0, 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(para.slice(7, 16)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(para.slice(16)).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });
  it("is null when the script and the narration disagree", () => {
    expect(paragraphOfTokens(SCRIPT, 4)).toBeNull();
  });
});

describe("fitWords: the bug report's shape, fictional words", () => {
  const aligned = alignWords(SCRIPT, smeared());
  const fitted = timeWords({ script: SCRIPT, words: aligned, estimated: false, paragraphs: PARAS, silences: SILENCES });

  it("reproduces the bug before the fit: the answer's captions start seconds early", () => {
    const para = paragraphOfTokens(SCRIPT, 3)!;
    const r = captionDrift({ words: aligned, para, paragraphs: PARAS, silences: SILENCES });
    expect(r.ok).toBe(false);
    expect(r.max_ms).toBeGreaterThan(4000);
    expect(r.message).toMatch(/ahead of|behind/);
  });

  it("keeps every word inside its own paragraph's voice", () => {
    const para = paragraphOfTokens(SCRIPT, 3)!;
    fitted.forEach((x, i) => {
      const sp = speechSpan(PARAS[para[i]!]!, SILENCES);
      expect(x.start).toBeGreaterThanOrEqual(sp.start);
      expect(x.end).toBeLessThanOrEqual(sp.end + 1e-9);
    });
  });

  it("puts no word inside the think pause", () => {
    for (const x of fitted) expect(x.start < 5.7 || x.start >= 15.1).toBe(true);
  });

  it("never goes backwards", () => {
    for (let i = 0; i < fitted.length; i++) {
      expect(fitted[i]!.end).toBeGreaterThanOrEqual(fitted[i]!.start);
      if (i) expect(fitted[i]!.start).toBeGreaterThanOrEqual(fitted[i - 1]!.start);
    }
  });

  it("passes the drift check after the fit", () => {
    const r = captionDrift({ words: fitted, para: paragraphOfTokens(SCRIPT, 3), paragraphs: PARAS, silences: SILENCES });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/match the voice/);
  });

  it("re-spreads a paragraph whisper put somewhere else entirely, instead of stacking its words", () => {
    const para = paragraphOfTokens(SCRIPT, 3)!;
    const answer = fitted.filter((_, i) => para[i] === 2);
    const starts = new Set(answer.map((x) => x.start));
    expect(starts.size).toBe(answer.length);
  });
});

describe("fitWords: narrate.py's estimated words", () => {
  it("scales each paragraph from its span onto its voice", () => {
    const est = [w("Tell", 3.45, 4.0), w("me", 4.1, 4.5), w("now.", 5.5, 6.3)];
    const out = fitWords(est, [1, 1, 1], PARAS, SILENCES, { remap: true });
    expect(out[0]!.start).toBeCloseTo(3.85, 3);
    expect(out.at(-1)!.end).toBeLessThanOrEqual(5.7);
  });
  it("leaves words alone when nothing is known about the audio", () => {
    expect(timeWords({ script: SCRIPT, words: [w("Here", 1, 2)], estimated: true, paragraphs: undefined, silences: null })).toEqual([w("Here", 1, 2)]);
  });
});

describe("captionDrift", () => {
  it("measures a caption that is late after a pause inside a paragraph", () => {
    const paras = [{ start: 0, end: 10 }];
    const sil = [{ start: 0, end: 0.5 }, { start: 4, end: 4.6 }, { start: 9.5, end: 10 }];
    const words = [w("One", 0.5, 1), w("two", 1.2, 4), w("three", 5.4, 6), w("four", 6.2, 9.5)];
    const r = captionDrift({ words, para: [0, 0, 0, 0], paragraphs: paras, silences: sil });
    const pause = r.points.find((p) => p.kind === "pause")!;
    expect(pause.drift).toBeCloseTo(0.8, 3);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Captions are 0.8 s behind the voice at 0:04. Make the captions again to fix it.");
  });
  it("allows whisper's own few hundred ms at a pause, but not at a paragraph start", () => {
    const paras = [{ start: 0, end: 10 }];
    const sil = [{ start: 0, end: 0.5 }, { start: 4, end: 4.6 }, { start: 9.5, end: 10 }];
    const pauseOnly = captionDrift({ words: [w("One", 0.5, 1), w("two", 1.2, 4), w("three", 4.9, 6), w("four", 6.2, 9.5)], para: [0, 0, 0, 0], paragraphs: paras, silences: sil });
    expect(pauseOnly.ok).toBe(true);
    const lateStart = captionDrift({ words: [w("One", 0.7, 1), w("two", 1.2, 4), w("three", 4.6, 6), w("four", 6.2, 9.5)], para: [0, 0, 0, 0], paragraphs: paras, silences: sil });
    expect(lateStart.ok).toBe(false);
    expect(lateStart.max_ms).toBe(200);
  });
  it("says so when there's nothing to check against", () => {
    expect(captionDrift({ words: [], para: null, paragraphs: [], silences: null }).message).toBe("Caption timing could not be checked against the voice.");
  });
});

describe("detectSilences", () => {
  it("runs silencedetect and parses its stderr", async () => {
    const runner = fakeRunner(() => ({ stderr: "silence_start: 1\nsilence_end: 2 | silence_duration: 1\n" }));
    expect(await detectSilences(runner, "/fictional/ffmpeg", "/tmp", "narration.wav", 5)).toEqual([{ start: 1, end: 2 }]);
    expect(runner.calls[0]!.args).toContain("silencedetect=noise=-40dB:d=0.2");
  });
  it("is null when ffmpeg fails, so captions still get made", async () => {
    expect(await detectSilences(fakeRunner(() => ({ code: 1 })), "/fictional/ffmpeg", "/tmp", "narration.wav", 5)).toBeNull();
  });
});

describe("scene starts come from the narration's paragraphs, not from whisper", () => {
  // The fictional drill: fake narration (fixtures), whisper's words jittered: every paragraph's first word heard
  // 0.12 s late, and the words after each think pause smeared back across it.
  const { words: truth, total } = fakeWords(QUIZ_SCRIPT);
  const paragraphs = fakeParagraphs(QUIZ_SCRIPT);
  const silences: Span[] = [];
  for (let i = 1; i < truth.length; i++) if (truth[i]!.start - truth[i - 1]!.end > 0.2) silences.push({ start: truth[i - 1]!.end, end: truth[i]!.start });
  const firsts = new Set(paragraphs.map((p) => truth.findIndex((x) => x.start === p.start)));
  const heard = truth.map((x, i) => (firsts.has(i) ? { ...x, start: x.start + 0.12, end: x.end + 0.12 } : { ...x }));
  for (const p of paragraphs) {
    const prev = paragraphs.find((q) => p.start - q.end > 5 && p.start - q.end < 10);
    if (!prev) continue;
    // Whisper's shape from the bug report: the next paragraph's first 4 words spread evenly across the pause.
    const k = truth.findIndex((x) => x.start === p.start);
    const step = (truth[k + 3]!.end - prev.end) / 4;
    for (let j = 0; j < 4; j++) heard[k + j] = { ...heard[k + j]!, start: prev.end + j * step, end: prev.end + (j + 1) * step };
  }
  const before = alignWords(QUIZ_SCRIPT, heard);
  const after = timeWords({ script: QUIZ_SCRIPT, words: before, estimated: false, paragraphs, silences });
  const tlBefore = resolveTimeline(quizSpec(), before, total);
  const tlAfter = resolveTimeline(quizSpec(), after, total);

  it("starts every scene LEAD_IN before its paragraph's voice, exactly", () => {
    quizSpec().scenes.forEach((s, i) => {
      if (i === 0) return;
      const p = paragraphs.find((x) => x.text.toLowerCase().startsWith(s.cue.toLowerCase()))!;
      expect(tlAfter.scenes[i]!.start).toBeCloseTo(p.start - LEAD_IN, 2);
    });
  });

  it("keeps each quiz think pause at its full length", () => {
    for (const s of tlAfter.scenes.filter((x) => x.type === "quiz")) expect(s.think!.end - s.think!.start).toBeGreaterThan(8);
    // Before the fix, whisper's smear ate most of it.
    expect(tlBefore.scenes.filter((x) => x.type === "quiz").some((s) => s.think!.end - s.think!.start < 2)).toBe(true);
  });
});
