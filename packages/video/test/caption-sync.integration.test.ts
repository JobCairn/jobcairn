import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRecord } from "@careeros/core";
import { alignWords } from "../src/captions.js";
import { HfCli } from "../src/hf.js";
import { narratePy } from "../src/narrate.js";
import { VideoPipeline, type PipelineDeps } from "../src/pipeline.js";
import { nodeProcessRunner } from "../src/process.js";
import { loadRegistry } from "../src/registry.js";
import { hyperframesRenderer } from "../src/render/hyperframes.js";
import { parseScript } from "../src/script.js";
import { captionDrift, detectSilences, paragraphOfTokens, speechSpan, type Span } from "../src/sync.js";
import { resolveTimeline } from "../src/timeline.js";
import { checkTools, type ToolPaths } from "../src/tools-check.js";
import type { Word } from "../src/types.js";
import { ACME_JOB, QUIZ_SCRIPT, quizSpec, seedAcme } from "./fixtures.js";
import { BUILTIN_TYPES, sampleCopy, TEMPLATES } from "./helpers.js";

/**
 * Caption sync, end to end on the real local tools (fix/caption-sync): the fictional Acme Corp drill (three 8 s think
 * pauses) narrated with the installed voice, captioned with the installed whisper model, rendered with HyperFrames.
 * Then, per scene, where the voice starts against where the captions and the scene start: the old way (whisper on
 * the whole narration, as before this fix) and the new one (what the pipeline wrote). No Claude: the script and spec
 * are fixtures. Skipped unless CAREEROS_VIDEO_SYNC_IT=1; CAREEROS_VIDEO_SYNC_OUT names a folder for the numbers.
 */
const IT = process.env.CAREEROS_VIDEO_SYNC_IT === "1";
const OUT = process.env.CAREEROS_VIDEO_SYNC_OUT ?? "";
const PLUGIN = path.resolve(import.meta.dirname, "../../../plugin");
const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");
const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
const FOLDER = `${ACME_JOB}/interview/1`;

describe.skipIf(!IT)("caption sync on the real tools (CAREEROS_VIDEO_SYNC_IT=1)", () => {
  it("makes a drill video whose captions and scenes start with the voice", async () => {
    const runner = nodeProcessRunner();
    const tools = await checkTools({
      runner, platform: process.platform, env: process.env, home: os.homedir(), pluginDir: PLUGIN,
      exists: (p) => fs.existsSync(p), isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
      readFile: (p) => fs.readFileSync(p, "utf8"), now: () => new Date(),
    });
    // CAREEROS_VIDEO_SYNC_ANY_HF=1: run with whatever HyperFrames is installed, when the pinned version isn't.
    const at = (id: string) => tools.tools.find((t) => t.id === id)?.path ?? "";
    const onlyHf = tools.tools.every((t) => t.ok || t.id === "hyperframes") && at("hyperframes") !== "";
    const paths: ToolPaths | null = tools.paths ?? (process.env.CAREEROS_VIDEO_SYNC_ANY_HF === "1" && onlyHf ? {
      node: at("node"), cli: at("hyperframes"), ffmpeg: at("ffmpeg"), ffprobe: at("ffprobe"), chrome: at("chrome") || null,
      python: at("python"), narrate: at("narrate"), captionsModel: (tools.tools.find((t) => t.id === "whisper")?.version as ToolPaths["captionsModel"]) ?? null,
    } : null);
    if (!paths) throw new Error(tools.tools.filter((t) => !t.ok).map((t) => `${t.id}: ${t.message}`).join("; "));
    const report = { ...tools, ok: true, paths };
    expect(paths.captionsModel, "a whisper model must be installed, or this measures the estimate, not the bug").not.toBeNull();
    const hf = new HfCli(runner, paths, process.platform);
    const root = sampleCopy();
    seedAcme(root);
    const deps: PipelineDeps = {
      root, runner, tools: async () => report, hf: () => hf, renderer: () => hyperframesRenderer(hf), narrator: (p) => narratePy(runner, p),
      registry: () => loadRegistry({ builtinDir: BUILTIN_TYPES, workspaceRoot: root }),
      writer: () => ({
        mode: "api",
        async write(req) {
          const dir = path.join(req.root, req.folder);
          fs.writeFileSync(path.join(dir, "script.txt"), QUIZ_SCRIPT);
          fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(quizSpec(), null, 2));
          fs.writeFileSync(path.join(dir, "sources.md"), "# Sources\n");
          fs.writeFileSync(path.join(dir, "notes.md"), "# Notes\n");
          return { lockedFacts: [] };
        },
      }),
      templatesDir: TEMPLATES, gsapFile: GSAP, settings: () => ({ captions: "rail", lengths: {} }), freeBytes: () => 50 * 1024 ** 3,
      now: () => new Date(), onEvent: () => {},
    };
    const pipeline = new VideoPipeline(deps);
    pipeline.start("interview-prep", JOB, { mode: "practice", sound: "on" });
    await pipeline.idle();
    const f = pipeline.render(FOLDER, "final");
    await pipeline.idle();
    expect(pipeline.run(f.runId)!.status, pipeline.run(f.runId)!.error ?? "").toBe("done");

    const abs = path.join(root, FOLDER);
    const rec = readRecord("video", path.join(abs, "video.json"));
    expect(rec.captions.estimated, "captions must come from listening").toBe(false);
    const timing = JSON.parse(fs.readFileSync(path.join(abs, "narration.timing.json"), "utf8")) as { total: number; paragraphs: Span[] };
    const silences = await detectSilences(runner, paths.ffmpeg, abs, "narration.wav", timing.total);
    const after = JSON.parse(fs.readFileSync(path.join(abs, "transcript.json"), "utf8")) as Word[];

    // The old way, exactly: whisper on the whole narration, aligned to the script, nothing else.
    const old = path.join(abs, "old");
    fs.mkdirSync(old);
    fs.copyFileSync(path.join(abs, "narration.wav"), path.join(old, "narration.wav"));
    await hf.transcribe(abs, "old/narration.wav", { model: paths.captionsModel! });
    const before = alignWords(QUIZ_SCRIPT, JSON.parse(fs.readFileSync(path.join(old, "transcript.json"), "utf8")) as Word[]);

    const para = paragraphOfTokens(QUIZ_SCRIPT, timing.paragraphs.length)!;
    const spec = quizSpec();
    const scenesBefore = resolveTimeline(spec, before, timing.total).scenes;
    const scenesAfter = resolveTimeline(spec, after, timing.total).scenes;
    // Which paragraph each scene's cue word is in, so the scene start can be compared with that paragraph's voice.
    const rows = timing.paragraphs.map((p, k) => {
      const voice = speechSpan(p, silences).start;
      const first = para.indexOf(k);
      return {
        paragraph: k + 1, voice_starts: voice,
        caption_before: +(before[first]!.start - voice).toFixed(2), caption_after: +(after[first]!.start - voice).toFixed(2),
      };
    });
    const sceneRows = spec.scenes.map((s, i) => {
      const cueBlock = parseScript(QUIZ_SCRIPT).findIndex((b) => b.kind === "speech" && b.text.toLowerCase().includes(s.cue.toLowerCase()));
      const k = parseScript(QUIZ_SCRIPT).slice(0, cueBlock).filter((b) => b.kind === "speech").length;
      const voice = speechSpan(timing.paragraphs[k]!, silences).start;
      const think = (t: (typeof scenesBefore)[number]) => (t.think ? +(t.think.end - t.think.start).toFixed(2) : null);
      return {
        scene: i + 1, type: s.type, voice_starts: voice, scene_before: +(scenesBefore[i]!.start - voice).toFixed(2), scene_after: +(scenesAfter[i]!.start - voice).toFixed(2),
        think_before: think(scenesBefore[i]!), think_after: think(scenesAfter[i]!),
      };
    });
    const driftBefore = captionDrift({ words: before, para, paragraphs: timing.paragraphs, silences });
    const driftAfter = captionDrift({ words: after, para, paragraphs: timing.paragraphs, silences });
    const qa = JSON.parse(fs.readFileSync(path.join(abs, "qa", "sync.json"), "utf8"));
    console.table(rows);
    console.table(sceneRows);
    console.log("before:", driftBefore.message, "| after:", driftAfter.message, "| pipeline QA:", qa.message, "| audio starts at", qa.audio_start_s);
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, "caption-sync.json"), JSON.stringify({ rows, sceneRows, driftBefore, driftAfter, qa, engine: rec.voice, model: paths.captionsModel }, null, 2));
      fs.copyFileSync(path.join(abs, "renders", "final.mp4"), path.join(OUT, "drill.mp4"));
      fs.copyFileSync(path.join(abs, "captions.vtt"), path.join(OUT, "captions.vtt"));
    }
    expect(driftAfter.ok, driftAfter.message).toBe(true);
    expect(qa.ok, qa.message).toBe(true);
    // Scenes open exactly LEAD_IN (0.3 s) before their paragraph's voice, and each think pause keeps its 8 s.
    for (const r of sceneRows) if (r.scene > 1) expect(Math.abs(r.scene_after + 0.3), `scene ${r.scene}`).toBeLessThan(0.02);
    for (const r of sceneRows) if (r.type === "quiz") expect(r.think_after!, `scene ${r.scene} think`).toBeGreaterThan(8);
  }, 1_800_000);
});
