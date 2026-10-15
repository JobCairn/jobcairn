import { describe, expect, it } from "vitest";
import { chapterCount, isInDepth, MAX_SCENES, maxScenes, sceneCountsFor, sceneRange } from "../src/lengths.js";
import { validateSpec } from "../src/spec.js";
import type { Scene, SceneSpec } from "../src/types.js";
import { buildWriterPrompt } from "../src/writer.js";
import { JD_SCRIPT, jdSpec, typeOf } from "./fixtures.js";

const WORDS = ["amber", "birch", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kestrel", "lagoon", "maple", "nectar", "onyx", "pebble", "quartz", "raven", "sierra", "tundra"];
const word = (i: number) => `${WORDS[i % WORDS.length]}${WORDS[Math.floor(i / WORDS.length) % WORDS.length]}`;

/** A JD walkthrough with `middle` extra bullet scenes of about 11 seconds each; every `chapterEvery`th starts a chapter. */
function longVideo(middle: number, chapterEvery = 0): { spec: SceneSpec; script: string } {
  const base = jdSpec();
  const paras = JD_SCRIPT.trim().split("\n\n");
  const extra: Scene[] = [];
  const extraParas: string[] = [];
  for (let i = 0; i < middle; i++) {
    const w = word(i);
    extraParas.push(`Now ${w} matters. This part covers ${w} work, shipping it to users and checking the results. It is a real part of this job today.`);
    extra.push({
      type: "bullet-build", cue: `Now ${w}`, headline: `Why ${w} matters`, items: [{ text: `Ship ${w} work`, cue: "shipping it" }, { text: "Check the results", cue: "checking the" }],
      sources: [{ file: "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md" }], ...(chapterEvery && i % chapterEvery === 0 ? { chapter: true } : {}),
    });
  }
  const scenes = [base.scenes[0]!, base.scenes[1]!, ...extra, base.scenes[2]!, base.scenes[3]!];
  const script = [paras[0], paras[1], ...extraParas, paras[2], paras[3]].join("\n\n") + "\n";
  return { spec: { ...base, scenes }, script };
}
const run = (v: { spec: SceneSpec; script: string }, length_s?: number) =>
  validateSpec(v.spec, { type: typeOf("jd-walkthrough"), script: v.script, ...(length_s ? { length_s } : {}) });
const errs = (r: ReturnType<typeof run>) => r.issues.filter((i) => i.level === "error");
const warns = (r: ReturnType<typeof run>, code: string) => r.issues.filter((i) => i.level === "warning" && i.code === code);

describe("length scaling", () => {
  it("keeps 12 scenes up to two minutes, then one per 10 seconds, at most 60", () => {
    expect(maxScenes(60)).toBe(12);
    expect(maxScenes(120)).toBe(12);
    expect(maxScenes(150)).toBe(15);
    expect(maxScenes(480)).toBe(48);
    expect(maxScenes(600)).toBe(MAX_SCENES);
    expect(maxScenes(5000)).toBe(60);
  });
  it("asks for more scenes at longer lengths, never fewer than three", () => {
    expect(sceneRange(60)).toEqual({ min: 4, max: 10 });
    expect(sceneRange(150)).toEqual({ min: 10, max: 15 });
    expect(sceneRange(390)).toEqual({ min: 26, max: 39 });
    expect(sceneRange(30).min).toBeGreaterThanOrEqual(3);
  });
  it("splits in-depth videos into chapters of about a minute and a half", () => {
    expect(isInDepth(299)).toBe(false);
    expect(chapterCount(150)).toBe(0);
    expect(chapterCount(300)).toBe(3);
    expect(chapterCount(390)).toBe(4);
    expect(chapterCount(600)).toBe(7);
  });
  it("scales repeatable scenes with length and keeps one-off scenes one-off", () => {
    const prep = typeOf("interview-prep");
    expect(sceneCountsFor(prep, 150)).toEqual({ title: { min: 1, max: 1 }, quiz: { min: 3, max: 6 }, "recap-card": { min: 1, max: 1 } });
    expect(sceneCountsFor(prep, 390).quiz).toEqual({ min: 3, max: 16 });
    expect(sceneCountsFor(prep, 60).quiz).toEqual({ min: 1, max: 6 });
    expect(sceneCountsFor(prep, 600)["recap-card"]).toEqual({ min: 1, max: 1 });
  });
});

describe("spec validation for longer videos", () => {
  it("accepts an 8-minute walkthrough of about 40 scenes with chapters", () => {
    const r = run(longVideo(38, 8), 480);
    expect(r.estimate_s).toBeGreaterThan(300);
    expect(errs(r)).toEqual([]);
    expect(warns(r, "chapters")).toEqual([]);
    expect(warns(r, "length")).toEqual([]);
  });
  it("warns when an in-depth video has no chapters", () => {
    const r = run(longVideo(38), 480);
    expect(errs(r).map((i) => i.message)).toEqual([]);
    expect(warns(r, "chapters")[0]?.message).toMatch(/split into chapters/);
  });
  it("refuses more scenes than the length allows", () => {
    const r = run(longVideo(38, 8), 120);
    expect(errs(r).map((i) => i.message).join("\n")).toMatch(/A video this long needs 2 to 12 scenes; this spec has 42\./);
  });
  it("judges the length against what was asked, not the type's 10-minute ceiling", () => {
    const r = run(longVideo(38, 8), 60);
    expect(errs(r).some((i) => i.code === "length" && /should run about 60/.test(i.message))).toBe(true);
    const short = run({ spec: jdSpec(), script: JD_SCRIPT }, 390);
    expect(warns(short, "length")[0]?.message).toMatch(/aim for about 390/);
  });
  it("warns when scenes get long instead of more numerous", () => {
    const filler = "This sentence keeps going so the scene runs long. ".repeat(14);
    const script = JD_SCRIPT.replace("Three things matter most.", `Three things matter most. ${filler}`).replace("So remember.", `So remember. ${filler}`);
    const r = run({ spec: jdSpec(), script }, 150);
    expect(warns(r, "scene_length")[0]?.message).toMatch(/Split them so each runs 4 to 15 seconds/);
  });
});

describe("writer prompt at in-depth length", () => {
  it("asks for more scenes and chapters, not more words per scene", () => {
    const type = typeOf("jd-walkthrough");
    const p = buildWriterPrompt({
      type, options: { length_s: 390 }, folder: "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1",
      pack: { files: [], missing: [], facts: { name: "Alex", role: "AI Engineer", company: "Acme Corp", gap: "", week: "", stats: null }, candidateTerms: [] },
    } as never, { nonce: "n" });
    expect(p).toContain("Length: about 390 seconds (312 to 468), about 975 words.");
    expect(p).toContain("Scenes: 26 to 39.");
    expect(p).toContain("Chapters: split the video into about 4 chapters of 1 to 2 minutes.");
    expect(p).toContain("comparison 0 to 8");
  });
});
