import fs from "node:fs";
import path from "node:path";
import { initWorkspace } from "@careeros/core";
import { describe, expect, it } from "vitest";
import { VideoError } from "../src/errors.js";
import { buildHtml } from "../src/expander.js";
import { factCheck } from "../src/factcheck.js";
import { recapContent, weekLabel, writeRecap } from "../src/recap.js";
import { buildSourcePack } from "../src/sources.js";
import { requireValidated, validateSpec } from "../src/spec.js";
import { weekStats } from "../src/stats.js";
import type { WeekStats } from "../src/types.js";
import { fakeWords, typeOf } from "./fixtures.js";
import { FIXED, sampleCopy, tmpDir } from "./helpers.js";

/** A minimal, otherwise-valid WeekStats, overridden per test - lets each Fix round 1 test focus
 * on the one field it's exercising instead of repeating every field. */
function baseStats(over: Partial<WeekStats> = {}): WeekStats {
  return {
    week: "2026-W05", from: "2026-01-26", to: "2026-02-01", found: 0, applied: 0, replies: 0, interviews: 0,
    sponsorship: { sponsorship_offered: 0, visa_ok: 0, silent: 0, citizen_pr_only: 0, clearance: 0 },
    next_steps: [],
    ...over,
  };
}

describe("weekly recap", () => {
  it("labels weeks in plain words", () => {
    expect(weekLabel("2026-W03")).toEqual({ long: "12 to 18 January 2026", short: "12 to 18 Jan" });
    expect(weekLabel("2026-W01")).toEqual({ long: "29 December 2025 to 4 January 2026", short: "29 Dec to 4 Jan" });
  });

  it("writes a checked script and spec from the week's numbers", () => {
    const root = sampleCopy();
    const folder = "recaps/2026-W03";
    const files = writeRecap(root, folder, weekStats(root, "2026-W03"));
    for (const f of ["stats.json", "script.txt", "spec.json", "sources.md"]) expect(fs.existsSync(path.join(root, folder, f)), f).toBe(true);
    expect(files.script).toContain("This week you found 3 new jobs.");
    expect(files.script).toContain("Of the new jobs, 1 offer sponsorship, 1 don't say and 1 need citizens, residents or cleared staff.");
    expect(files.script).toContain("Next steps. First, decide on the Backend Engineer (LLM) role at Example Labs. Second, watch for a reply from Acme Corp. Third, run one new search.");
    const type = typeOf("weekly-recap");
    const v = validateSpec(files.spec, { type, script: files.script });
    expect(v.issues.filter((i) => i.level === "error")).toEqual([]);
    const pack = buildSourcePack({ root, type, subject: { kind: "week", week: "2026-W03" }, folder, clock: { now: FIXED } });
    expect(factCheck({ root, folder, type, spec: v.spec!, pack, clock: { now: FIXED } }).issues).toEqual([]);
  });

  it("keeps a quiet week short", () => {
    const root = sampleCopy();
    const { spec, script } = recapContent(weekStats(root, "2026-W10"), "recaps/2026-W10");
    expect(spec.scenes.map((s) => s.type)).toEqual(["title", "stat", "stat", "bullet-build", "recap-card"]);
    expect(script).toContain("This week you found no new jobs.");
    expect(validateSpec(spec, { type: typeOf("weekly-recap"), script }).issues.filter((i) => i.level === "error")).toEqual([]);
  });

  // Fix round 1, item 1: recapContent used to crash (`top[2]` undefined, TypeError) whenever
  // fewer than 2 real next steps existed, because the filler list only ever had 2 entries - never
  // enough to pad 0 real steps up to the 3 a recap-card scene requires (spec.ts's cuedItems
  // enforces exactly 3 items for this scene type).
  describe("next steps with fewer than 2 real entries (Fix round 1, item 1)", () => {
    it("doesn't crash with zero next steps, and produces a valid recap", () => {
      const stats = baseStats({ next_steps: [] });
      const { spec, script } = recapContent(stats, "recaps/2026-W05");
      expect(spec.scenes.find((s) => s.type === "recap-card")).toMatchObject({ type: "recap-card" });
      const result = validateSpec(spec, { type: typeOf("weekly-recap"), script });
      expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    });

    it("doesn't crash with one next step, and produces a valid recap", () => {
      const stats = baseStats({ next_steps: [{ title: "AI Engineer", company: "Acme Corp", action: "Watch for a reply" }] });
      const { spec, script } = recapContent(stats, "recaps/2026-W05");
      expect(script).toContain("First, watch for a reply from Acme Corp.");
      const result = validateSpec(spec, { type: typeOf("weekly-recap"), script });
      expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    });

    it("produces a valid, validated recap for a brand-new workspace with no open jobs", () => {
      const root = tmpDir();
      initWorkspace(root, { name: "Alex Example", now: FIXED });
      const stats = weekStats(root, "2026-W05");
      expect(stats.next_steps).toEqual([]);
      const folder = "recaps/2026-W05";
      const files = writeRecap(root, folder, stats);
      const type = typeOf("weekly-recap");
      const result = validateSpec(files.spec, { type, script: files.script });
      expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    });
  });

  // Job titles and company names come from the job records, not from Claude - untrusted text that
  // ends up only as spoken words and a short on-screen label (recap.ts's `words9`). This runs a
  // hostile company name (markup that would close a <script> tag, an RLO bidi override, and a raw
  // newline) through the real pipeline - recapContent -> validateSpec -> requireValidated ->
  // buildHtml - the same chain expander.test.ts's "keeps hostile text out of the script" case uses
  // for a spec built by hand, and asserts it comes out escaped rather than tripping spec.ts's
  // control-character check or reaching the rendered HTML unescaped.
  it("escapes a hostile company name wherever it ends up on screen", () => {
    const HOSTILE = "</script><img src=x onerror=alert(1)>‮done\nmore";
    const stats: WeekStats = {
      week: "2026-W05", from: "2026-01-26", to: "2026-02-01", found: 1, applied: 0, replies: 0, interviews: 0,
      sponsorship: { sponsorship_offered: 0, visa_ok: 0, silent: 1, citizen_pr_only: 0, clearance: 0 },
      next_steps: [{ title: "AI Engineer", company: HOSTILE, action: "Decide whether to apply" }],
    };
    const folder = "recaps/2026-W05";
    const { spec, script } = recapContent(stats, folder);
    expect(script).not.toContain("alert(1)>‮done\nmore"); // the embedded newline doesn't survive into the script
    const type = typeOf("weekly-recap");
    const result = validateSpec(spec, { type, script });
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    const validated = requireValidated(result);
    const { words, total } = fakeWords(script);
    const { html } = buildHtml(validated, words, total, "none");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=alert(1)>");
    // The on-screen recap-card label is escaped and has the RLO override stripped (html.ts's
    // `esc`, same as every other scene text node). The raw word-level transcript embedded for
    // captions (via `jsJson`) is a separate, pre-existing concern this test doesn't cover: jsJson
    // only neutralises what could break out of the <script> tag, not bidi display characters.
    const card = (/<p class="body">Decide whether to apply:([^<]*)<\/p>/.exec(html)?.[1] ?? "").trim();
    expect(card).toBe("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;done more");
    expect(card).not.toMatch(/‮/i);
  });

  // Fix round 1, item 4: titles and company names (from job records, not Claude) used to reach
  // the spoken script with no cap at all - only the on-screen label (words9) bounded word COUNT,
  // not character length, and the spoken sentence used the raw value directly. A 10k-character
  // title or company name would have made the script itself enormous, and only the on-screen
  // control-character strip (not the full bidi/invisible strip) ran on either use.
  describe("untrusted titles and company names are capped and cleaned at the source (Fix round 1, item 4)", () => {
    it("caps a 10,000-character title so the script stays short and the spec stays valid", () => {
      const stats = baseStats({ next_steps: [{ title: "A".repeat(10_000), company: "Acme Corp", action: "Decide whether to apply" }] });
      const { spec, script } = recapContent(stats, "recaps/2026-W05");
      expect(script.length).toBeLessThan(1_000);
      const result = validateSpec(spec, { type: typeOf("weekly-recap"), script });
      expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    });

    it("caps a 10,000-character company name so the on-screen label stays valid", () => {
      const stats = baseStats({ next_steps: [{ title: "AI Engineer", company: "B".repeat(10_000), action: "Watch for a reply" }] });
      const { spec, script } = recapContent(stats, "recaps/2026-W05");
      const result = validateSpec(spec, { type: typeOf("weekly-recap"), script });
      expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    });

    it("strips RLO, ZWSP and LRI from titles and company names before they ever reach script.txt or spec.json", () => {
      const hostile = `a‮b​c⁦d`;
      const stats = baseStats({ next_steps: [{ title: hostile, company: hostile, action: "Decide whether to apply" }] });
      const { spec, script } = recapContent(stats, "recaps/2026-W05");
      expect(script).not.toMatch(/[‮​⁦]/);
      expect(JSON.stringify(spec)).not.toMatch(/[‮​⁦]/);
    });
  });

  // Fix round 1, item 9.
  describe("hardening odds and ends (Fix round 1, item 9)", () => {
    it("throws a plain VideoError when a count in stats isn't a finite non-negative integer", () => {
      const badStats: WeekStats[] = [
        baseStats({ found: Number.NaN }),
        baseStats({ found: -1 }),
        baseStats({ applied: 1.5 }),
        baseStats({ replies: Number.POSITIVE_INFINITY }),
        baseStats({ sponsorship: { sponsorship_offered: -1, visa_ok: 0, silent: 0, citizen_pr_only: 0, clearance: 0 } }),
      ];
      for (const stats of badStats) {
        let caught: unknown;
        try { recapContent(stats, "recaps/2026-W05"); } catch (e) { caught = e; }
        expect(caught, JSON.stringify(stats)).toBeInstanceOf(VideoError);
      }
    });

    it("drops the sponsorship sentence and scene (never 'undefined') when every bucket is zero despite found > 0", () => {
      const stats = baseStats({ found: 2 }); // inconsistent data: found > 0 but every sponsorship bucket is 0
      const { spec, script } = recapContent(stats, "recaps/2026-W05");
      expect(script).not.toContain("undefined");
      expect(spec.scenes.map((s) => s.type)).toEqual(["title", "stat", "stat", "bullet-build", "recap-card"]);
    });

    it("writeRecap throws VideoError('unsafe_path'), not a plain Error, for a folder outside root", () => {
      const root = tmpDir();
      initWorkspace(root, { name: "Alex Example", now: FIXED });
      let caught: unknown;
      try {
        writeRecap(root, "../escape", baseStats());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(VideoError);
      expect((caught as VideoError).code).toBe("unsafe_path");
    });

    it("speaks a generic phrase for a next-step action it doesn't recognise, not the raw action text", () => {
      const stats = baseStats({ next_steps: [{ title: "AI Engineer", company: "Acme Corp", action: "Some Unknown Action" }] });
      const { script } = recapContent(stats, "recaps/2026-W05");
      expect(script).not.toMatch(/some unknown action/i);
      expect(script).toContain("Acme Corp");
    });

    // Task 15, carried from Task 14: recap.ts's on-screen recap-card label used the raw
    // `s.action` directly (`words9(\`${s.action}: ${company}\`)`), with only `words9`'s narrow
    // C0-control strip between an unrecognised, hand-edited or corrupted action and the spec -
    // no length cap at all, and no bidi/invisible-character strip (words9 isn't `sanitizeField`).
    // A generic label for any action outside the 4 STEP_SPOKEN recognises closes both gaps at
    // once: the raw action text, whatever it is, never reaches the label.
    it("uses a generic on-screen label, not the raw action text, for a 10,000-character unrecognised action", () => {
      const stats = baseStats({ next_steps: [{ title: "AI Engineer", company: "Acme Corp", action: "A".repeat(10_000) }] });
      const { spec, script } = recapContent(stats, "recaps/2026-W05");
      expect(JSON.stringify(spec)).not.toContain("A".repeat(50));
      expect(script.length).toBeLessThan(2_000);
      const type = typeOf("weekly-recap");
      const result = validateSpec(spec, { type, script });
      expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    });

    it("strips an RLO override from an unrecognised action before it can reach the on-screen label", () => {
      const hostile = "a‮evil";
      const stats = baseStats({ next_steps: [{ title: "AI Engineer", company: "Acme Corp", action: hostile }] });
      const { spec, script } = recapContent(stats, "recaps/2026-W05");
      expect(JSON.stringify(spec)).not.toMatch(/‮/);
      expect(script).not.toMatch(/‮/);
    });

    it("still uses the real action text as the label for one of the 4 known actions", () => {
      const stats = baseStats({ next_steps: [{ title: "AI Engineer", company: "Acme Corp", action: "Watch for a reply" }] });
      const { spec } = recapContent(stats, "recaps/2026-W05");
      const card = spec.scenes.find((s) => s.type === "recap-card");
      expect(JSON.stringify(card)).toContain("Watch for a reply: Acme Corp");
    });
  });
});
