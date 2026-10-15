import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expand } from "../src/expander.js";
import { HfCli, probe } from "../src/hf.js";
import { nodeProcessRunner } from "../src/process.js";
import { hyperframesRenderer } from "../src/render/hyperframes.js";
import { requireValidated, validateSpec } from "../src/spec.js";
import { checkTools } from "../src/tools-check.js";
import type { SceneSpec, Word } from "../src/types.js";
import { CATALOG_SCRIPT, catalogSpec, catalogType } from "./catalog.js";
import { fakeWords, typeOf } from "./fixtures.js";
import { TEMPLATES } from "./helpers.js";

/**
 * The one test that runs the real tools: ffmpeg, Chrome and HyperFrames 0.8.140. It is skipped unless
 * CAREEROS_VIDEO_IT=1, because it needs those tools installed (Setup CareerOS.command) and a few minutes.
 * It proves the composition, the vendored GSAP and the macOS render flags work together.
 */
const IT = process.env.CAREEROS_VIDEO_IT === "1";
const PLUGIN = path.resolve(import.meta.dirname, "../../../plugin");
const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");
const SHORT_SCRIPT = "Here is the idea.\n\nSo remember one, two, three.\n";

function shortSpec(): SceneSpec {
  return {
    version: 2, title: "One idea", voice_type: "guide",
    scenes: [
      { type: "title", cue: "Here is", kicker: "Test clip", title: "One idea" },
      { type: "recap-card", cue: "So remember", headline: "Remember", closing: "Done.", items: [{ text: "One", cue: "one" }, { text: "Two", cue: "two" }, { text: "Three", cue: "three" }] },
    ],
  } as SceneSpec;
}

/** Squeezes estimated word times into `seconds`, keeping their order and gaps in proportion. */
function squeeze(words: Word[], total: number, seconds: number): Word[] {
  const k = (seconds - 0.2) / total;
  return words.map((w) => ({ ...w, start: +(w.start * k).toFixed(3), end: +(w.end * k).toFixed(3) }));
}

/** A fresh workspace-like root with one video folder in it, as `expand` requires. */
function videoFolder(prefix: string): { root: string; folder: string } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const folder = path.join(root, "learning", "test-clip", "videos", "1");
  fs.mkdirSync(folder, { recursive: true });
  return { root, folder };
}

describe.skipIf(!IT)("real HyperFrames render (CAREEROS_VIDEO_IT=1)", () => {
  it("lints the catalog composition and renders a 2-second draft", async () => {
    const runner = nodeProcessRunner();
    const tools = await checkTools({
      runner, platform: process.platform, env: process.env, home: os.homedir(), pluginDir: PLUGIN,
      exists: (p) => fs.existsSync(p), isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
      readFile: (p) => fs.readFileSync(p, "utf8"), now: () => new Date(),
    });
    const missing = tools.tools.filter((t) => t.required && !t.ok && ["ffmpeg", "ffprobe", "node", "chrome", "hyperframes"].includes(t.id));
    expect(missing.map((t) => t.message)).toEqual([]);
    const p = tools.paths ?? (() => { throw new Error("tool paths missing"); })();
    const hf = new HfCli(runner, p, process.platform);
    const silence = async (dir: string, seconds: number) => {
      const r = await runner.run(p.ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(seconds), "narration.wav"], { cwd: dir, timeoutMs: 60_000 });
      expect(r.code).toBe(0);
    };

    // 1. The full catalog passes lint with 0 errors (spec §7).
    const cat = videoFolder("careeros-it-catalog-");
    const cw = fakeWords(CATALOG_SCRIPT);
    await silence(cat.folder, cw.total);
    const catSpec = requireValidated(validateSpec(catalogSpec(), { type: catalogType(), script: CATALOG_SCRIPT, mode: "practice" }));
    const catComp = expand({ ...cat, spec: catSpec, words: cw.words, total: cw.total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
    const lint = await hf.lint(catComp.compDir);
    expect(lint.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(lint.errorCount).toBe(0);
    // The renderer runs lint and then the browser check, whose sectioned report must be read (the bug that stopped
    // every video with "HyperFrames gave an answer ... could not read").
    const full = await hyperframesRenderer(hf).lint(catComp.compDir, new AbortController().signal);
    expect(full.findings.filter((f) => f.code === "unreadable" || f.code === "tool_error")).toEqual([]);
    expect(full.note ?? "").not.toMatch(/couldn't run/);
    expect(full.errorCount).toBe(0);

    // 2. A 2-second, 2-scene draft renders with picture and sound.
    const clip = videoFolder("careeros-it-clip-");
    await silence(clip.folder, 2);
    const est = fakeWords(SHORT_SCRIPT);
    const spec = requireValidated(validateSpec(shortSpec(), { type: typeOf("skill-gap-lesson"), script: SHORT_SCRIPT }));
    const comp = expand({ ...clip, spec, words: squeeze(est.words, est.total, 2), total: 2, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
    expect((await hf.lint(comp.compDir)).errorCount).toBe(0);
    const out = path.join(clip.folder, "draft.mp4");
    let last = 0;
    await hf.render(comp.compDir, out, "draft", { onPct: (pct) => { last = pct; } });
    const info = await probe(runner, p.ffprobe, out, clip.folder);
    expect(info.video).toBe(true);
    expect(info.audio).toBe(true);
    expect(info.duration).toBeGreaterThan(1.5);
    expect(info.duration).toBeLessThan(2.6);
    expect(last).toBeGreaterThan(0);
  }, 600_000);
});

// Runs by default with no tools: the clip the real test renders is a valid spec and expands offline, so a skipped
// real run never hides a broken input.
describe("the real render test's inputs", () => {
  it("validate and expand without any tools", () => {
    const clip = videoFolder("careeros-it-dry-");
    fs.writeFileSync(path.join(clip.folder, "narration.wav"), "RIFF fake");
    const est = fakeWords(SHORT_SCRIPT);
    const words = squeeze(est.words, est.total, 2);
    expect(words.at(-1)!.end).toBeLessThanOrEqual(2);
    const spec = requireValidated(validateSpec(shortSpec(), { type: typeOf("skill-gap-lesson"), script: SHORT_SCRIPT }));
    const comp = expand({ ...clip, spec, words, total: 2, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
    expect(fs.existsSync(path.join(comp.compDir, "index.html"))).toBe(true);
    expect(comp.timeline.issues).toEqual([]);
  });
});
