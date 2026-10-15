import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expand } from "../src/expander.js";
import { HfCli } from "../src/hf.js";
import { nodeProcessRunner } from "../src/process.js";
import { resolveTimeline } from "../src/timeline.js";
import { hyperframesRenderer } from "../src/render/hyperframes.js";
import { contactSheet } from "../src/sheet.js";
import { requireValidated, validateSpec } from "../src/spec.js";
import { checkTools } from "../src/tools-check.js";
import { CATALOG_SCRIPT, catalogSpec, catalogType } from "./catalog.js";
import { fakeWords } from "./fixtures.js";
import { TEMPLATES } from "./helpers.js";

/** Stage timings on the real tools (CAREEROS_VIDEO_IT=1). Prints a table; only checks that each step worked. */
const IT = process.env.CAREEROS_VIDEO_IT === "1";
const PLUGIN = path.resolve(import.meta.dirname, "../../../plugin");
const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");

describe.skipIf(!IT)("video stage timings (CAREEROS_VIDEO_IT=1)", () => {
  it("times lint, check, the old snapshot, a draft render and the new contact sheet of the catalog", async () => {
    const runner = nodeProcessRunner();
    const tools = await checkTools({
      runner, platform: process.platform, env: process.env, home: os.homedir(), pluginDir: PLUGIN,
      exists: (p) => fs.existsSync(p), isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
      readFile: (p) => fs.readFileSync(p, "utf8"), now: () => new Date(),
    });
    const p = tools.paths!;
    const hf = new HfCli(runner, p, process.platform);
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-timing-")));
    const folder = path.join(root, "learning", "timing", "videos", "1");
    fs.mkdirSync(folder, { recursive: true });
    const cw = fakeWords(CATALOG_SCRIPT);
    expect((await runner.run(p.ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(cw.total), "narration.wav"], { cwd: folder, timeoutMs: 60_000 })).code).toBe(0);
    const spec = requireValidated(validateSpec(catalogSpec(), { type: catalogType(), script: CATALOG_SCRIPT, mode: "practice" }));
    const comp = expand({ root, folder, spec, words: cw.words, total: cw.total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
    const times = resolveTimeline(spec, cw.words, cw.total).scenes.map((s) => (s.start + s.end) / 2);
    const fontCache = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-fonts-"));
    const rows: [string, number][] = [];
    const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t = Date.now();
      const out = await fn();
      rows.push([label, Date.now() - t]);
      return out;
    };
    await time("lint", () => hf.lint(comp.compDir));
    const cold = await time("check, empty font cache", () => hf.run("check", ["--json"], { cwd: comp.compDir, env: { HYPERFRAMES_FONT_CACHE_DIR: fontCache } }));
    await time("check, warm font cache", () => hf.run("check", ["--json"], { cwd: comp.compDir, env: { HYPERFRAMES_FONT_CACHE_DIR: fontCache } }));
    const fetched = fs.readdirSync(fontCache);
    await time(`snapshot (${times.length} frames)`, () => hf.snapshot(comp.compDir, times));
    const full = await time("lint + check (what the lint stage runs)", () => hyperframesRenderer(hf).lint(comp.compDir, new AbortController().signal));
    expect(full.findings.filter((f) => f.code === "unreadable" || f.code === "tool_error")).toEqual([]);
    const out = path.join(folder, "draft.mp4");
    await time(`draft render (${Math.round(cw.total)} s video)`, () => hf.render(comp.compDir, out, "draft", {}));
    fs.mkdirSync(path.join(folder, "work"), { recursive: true });
    await time(`contact sheet from the MP4 (${times.length} frames)`, () => contactSheet(runner, p.ffmpeg, { cwd: folder, video: "draft.mp4", times, duration: cw.total, workRel: "work", outRel: "contact-sheet.jpg" }));
    expect(fs.statSync(path.join(folder, "contact-sheet.jpg")).size).toBeGreaterThan(10_000);
    fs.copyFileSync(path.join(folder, "contact-sheet.jpg"), path.join(os.tmpdir(), "careeros-timing-contact-sheet.jpg"));
    console.log(`\nfonts fetched into an empty cache: ${fetched.length ? fetched.join(", ") : "none"}`);
    console.log(`check said: ${cold.stderr.split("\n").filter((l) => /font/i.test(l)).slice(0, 3).join(" | ") || "(nothing about fonts)"}`);
    console.log(`load averages: ${os.loadavg().map((n) => n.toFixed(1)).join(" ")}`);
    console.log(rows.map(([l, ms]) => `${l.padEnd(36)} ${(ms / 1000).toFixed(1)} s`).join("\n"));
  }, 1_800_000);
});
