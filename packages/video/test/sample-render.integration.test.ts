import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expand } from "../src/expander.js";
import { HfCli } from "../src/hf.js";
import { nodeProcessRunner } from "../src/process.js";
import { requireValidated, validateSpec } from "../src/spec.js";
import { checkTools } from "../src/tools-check.js";
import { mixSound } from "../src/sound.js";
import { resolveTimeline } from "../src/timeline.js";
import { fakeWords, typeOf } from "./fixtures.js";
import { TEMPLATES } from "./helpers.js";
import { AFTER_SCRIPT, afterSpec, BEFORE_SCRIPT, beforeSpec } from "./sample-jd.js";

/**
 * Renders the fictional JD walkthrough sample with the real, pinned HyperFrames and saves one still per scene.
 * Skipped unless CAREEROS_VIDEO_SAMPLE_OUT names a folder for the stills (it is a design aid, not a gate).
 */
const OUT = process.env.CAREEROS_VIDEO_SAMPLE_OUT ?? "";
const AFTER = process.env.CAREEROS_VIDEO_SAMPLE !== "before";
const MOTION = process.env.CAREEROS_VIDEO_SAMPLE_MOTION === "reduced" ? "reduced" as const : "full" as const;
const REPO = path.resolve(import.meta.dirname, "../../..");
/** A fictional logo for the fictional Example Labs, drawn here (not anyone's real mark). */
const EXAMPLE_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#1d3b5c"/><circle cx="72" cy="100" r="34" fill="none" stroke="#7fd1c7" stroke-width="14"/><circle cx="128" cy="100" r="34" fill="none" stroke="#f2b441" stroke-width="14"/></svg>';
const PLUGIN = path.resolve(import.meta.dirname, "../../../plugin");
const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");

describe.skipIf(!OUT)("sample render (CAREEROS_VIDEO_SAMPLE_OUT)", () => {
  it("renders the sample and saves stills", async () => {
    const runner = nodeProcessRunner();
    const tools = await checkTools({
      runner, platform: process.platform, env: process.env, home: os.homedir(), pluginDir: PLUGIN,
      exists: (p) => fs.existsSync(p), isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
      readFile: (p) => fs.readFileSync(p, "utf8"), now: () => new Date(),
    });
    if (!tools.paths) throw new Error(tools.tools.filter((t) => !t.ok).map((t) => `${t.id}: ${t.message}`).join("; "));
    const p = tools.paths;
    const hf = new HfCli(runner, p, process.platform);
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-sample-")));
    const folder = path.join(root, "companies", "example-labs", "jobs", "ai-engineer", "videos", "jd-walkthrough-1");
    fs.mkdirSync(folder, { recursive: true });
    const SCRIPT = AFTER ? AFTER_SCRIPT : BEFORE_SCRIPT;
    const { words, total } = fakeWords(SCRIPT);
    const r = await runner.run(p.ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(total), "narration.wav"], { cwd: folder, timeoutMs: 60_000 });
    expect(r.code).toBe(0);
    const checked = validateSpec(AFTER ? afterSpec() : beforeSpec(), { type: typeOf("jd-walkthrough"), script: SCRIPT, length_s: AFTER ? 60 : 30 });
    expect(checked.issues.filter((i) => i.level === "error")).toEqual([]);
    const spec = requireValidated(checked);
    const logo = path.join(root, "companies", "example-labs", "logo.svg");
    fs.writeFileSync(logo, EXAMPLE_LOGO);
    const board = path.join(REPO, "docs", "assets", "boards", "seek.png");
    const boardCopy = path.join(folder, "seek.png");
    fs.copyFileSync(board, boardCopy);
    const media = AFTER ? { refs: { logo: { src: "assets/company-logo.svg", company: "Example Labs" }, board: { src: "assets/board-seek.png", name: "SEEK" } }, files: [{ abs: logo, rel: "assets/company-logo.svg" }, { abs: boardCopy, rel: "assets/board-seek.png" }] } : undefined;
    // The real sound mix (ffmpeg, offline): effects on scene changes and reveals over the narration.
    const mix = AFTER ? await mixSound({ runner, ffmpeg: p.ffmpeg, folderAbs: folder, tl: resolveTimeline(spec, words, total), effects: true, music: process.env.CAREEROS_VIDEO_SAMPLE_MUSIC === "1", signal: new AbortController().signal }) : null;
    const comp = expand({ folder, root, spec, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP, media, motion: MOTION, audio: mix?.file });
    if (process.env.CAREEROS_VIDEO_SAMPLE_SNAPSHOT === "1") {
      await hf.snapshot(comp.compDir, comp.timeline.scenes.map((s) => +Math.max(s.start + 0.5, s.end - 0.8).toFixed(2)));
      fs.mkdirSync(OUT, { recursive: true });
      for (const f of fs.readdirSync(path.join(comp.compDir, "snapshots"))) fs.copyFileSync(path.join(comp.compDir, "snapshots", f), path.join(OUT, f));
      return;
    }
    const lint = await hf.lint(comp.compDir);
    expect(lint.findings.filter((f) => f.severity === "error")).toEqual([]);
    const mp4 = path.join(folder, "sample.mp4");
    await hf.render(comp.compDir, mp4, "final", {});
    fs.mkdirSync(OUT, { recursive: true });
    fs.copyFileSync(mp4, path.join(OUT, "sample.mp4"));
    for (const s of comp.timeline.scenes) {
      const at = Math.max(s.start + 0.5, s.end - 0.45);
      const still = path.join(OUT, `${s.id}-${s.type}.png`);
      const x = await runner.run(p.ffmpeg, ["-y", "-ss", at.toFixed(2), "-i", mp4, "-frames:v", "1", still], { cwd: folder, timeoutMs: 60_000 });
      expect(x.code).toBe(0);
    }
  }, 900_000);
});
