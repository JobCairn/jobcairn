import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { CancelledError, VideoError } from "../src/errors.js";
import { HfCli } from "../src/hf.js";
import type { Narrator } from "../src/narrate.js";
import { VideoPipeline, type PipelineDeps } from "../src/pipeline.js";
import { fakeRunner, untilAborted } from "../src/process.js";
import { loadRegistry } from "../src/registry.js";
import { hyperframesRenderer } from "../src/render/hyperframes.js";
import type { ToolsReport } from "../src/tools-check.js";
import type { SceneSpec, VideoEvent } from "../src/types.js";
import type { ScriptWriter, WriterRequest } from "../src/writer.js";
import { fakeParagraphs, fakeWords, JD_SCRIPT, jdSpec } from "./fixtures.js";
import { checkReport } from "./hf-outputs.js";
import { BUILTIN_TYPES, FIXED, TEMPLATES } from "./helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

export const PATHS = {
  node: "/fictional/bin/node", cli: "/fictional/lib/node_modules/hyperframes/dist/cli.js", ffmpeg: "/fictional/bin/ffmpeg", ffprobe: "/fictional/bin/ffprobe",
  chrome: "/fictional/Chrome", python: "/fictional/venv/bin/python", narrate: "/fictional/narrate.py", captionsModel: "base.en" as const,
};
const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");
const read = (f: string) => fs.readFileSync(f, "utf8");

export interface Files { script: string; spec: SceneSpec; extras?: Record<string, string> }
export interface HarnessOpts {
  files?: (req: WriterRequest, call: number) => Files;
  /** The writer throws on these calls (1-based), after writing `partial` into script.txt when given. */
  writeFails?: (call: number) => { partial?: string } | null;
  writer?: false; toolsOk?: boolean; free?: number; transcribeFails?: boolean;
  /** Extra cases beyond the brief: a wrong-size final file, and a render that fails with a path in its stderr. */
  probeWidth?: number; renderStderr?: string;
  /** Task 18b: the QA stills step's ffmpeg fails. */
  ffmpegFails?: boolean;
  /** Fix round 1: lines the narrator prints, a status line the writer reports, and a tools check that throws. */
  narratorLines?: (folderAbs: string) => string[]; writerStatus?: (root: string) => string; toolsThrow?: string;
  /** The captions model the tools check found (default base.en; null: none installed). */
  captionsModel?: "small.en" | "base.en" | null;
  /** The pipeline's canBuild: a reason a passing script can't go straight on to the video. */
  canBuild?: () => string | null;
  /** What `hyperframes check --json` prints (default: HyperFrames 0.8.140's real sectioned shape, passing). */
  checkStdout?: string;
  /** The contact sheet's ffmpeg calls fail (the QA stills still work). */
  sheetFails?: boolean;
  /** Caption sync: where the final video's sound starts (ffprobe), default 0. */
  audioStart?: number;
}

/** A pipeline over the sample workspace where every outside tool is a fake. */
export function harness(root: string, o: HarnessOpts = {}) {
  const events: VideoEvent[] = [];
  const control = { narrateHang: false, renderHang: false, renderGate: null as Promise<void> | null, rendering: 0, maxRendering: 0, narrations: 0, narrateCalls: [] as { textFile?: string; cacheDir?: string; made: number; reused: number }[], paragraphCache: new Set<string>(), checks: 0, silencedetects: 0, condensed: [] as { from: number; to: number }[], transcribed: [] as string[], writes: [] as WriterRequest[], saved: [] as string[], beforeNarrate: null as (() => void) | null, toolsFail: false, captions: "rail" as "rail" | "pill" | "highlight" | "none" };
  const runner = fakeRunner(async (cmd, args, opts) => {
    if (cmd === PATHS.ffprobe && args.includes("stream=start_time")) return { stdout: JSON.stringify({ streams: [{ start_time: String(o.audioStart ?? 0) }] }) };
    if (cmd === PATHS.ffprobe) {
      const total = JSON.parse(read(path.join(opts.cwd, "narration.timing.json"))).total as number;
      return { stdout: JSON.stringify({ format: { duration: String(total) }, streams: [{ codec_type: "video", width: o.probeWidth ?? 1920, height: 1080 }, { codec_type: "audio" }] }) };
    }
    if (cmd === PATHS.ffmpeg && args.some((a) => a.startsWith("silencedetect="))) {
      // The fake narration's silences: wherever two fake words are more than 0.2 s apart, plus the lead and tail.
      if (o.ffmpegFails) return { code: 1, stderr: "ffmpeg broke" };
      const { words, total } = fakeWords(read(path.join(opts.cwd, "script.txt")));
      const lines = [`silence_start: 0`, `silence_end: ${words[0]!.start} | silence_duration: ${words[0]!.start}`];
      for (let i = 1; i < words.length; i++) if (words[i]!.start - words[i - 1]!.end > 0.2) lines.push(`silence_start: ${words[i - 1]!.end}`, `silence_end: ${words[i]!.start} | silence_duration: 1`);
      lines.push(`silence_start: ${words.at(-1)!.end}`);
      control.silencedetects++;
      return { stderr: `${lines.join("\n")}\nsize=N/A time=00:00:${total} bitrate=N/A\n` };
    }
    if (cmd === PATHS.ffmpeg && args.includes("-filter_complex")) {
      if (o.ffmpegFails) return { code: 1, stderr: "ffmpeg broke" };
      // The condensed copy whisper hears: remember its segments, so the fake transcript is timed the way it would be.
      control.condensed = [...args[args.indexOf("-filter_complex") + 1]!.matchAll(/atrim=start=([\d.]+):end=([\d.]+)/g)].map((m) => ({ from: Number(m[1]), to: Number(m[2]) }));
      fs.writeFileSync(path.join(opts.cwd, args.at(-1)!), "RIFF");
      return {};
    }
    if (cmd === PATHS.ffmpeg) {
      if (o.ffmpegFails) return { code: 1, stderr: "ffmpeg broke" };
      if (o.sheetFails && args.some((a) => a.includes("sheet"))) return { code: 1, stderr: "ffmpeg broke" };
      fs.writeFileSync(path.join(opts.cwd, args.at(-1)!), "jpg");
      return {};
    }
    const sub = args[1];
    if (sub === "transcribe") {
      if (o.transcribeFails) return { code: 1, stderr: "model download failed" };
      let words = fakeWords(read(path.join(opts.cwd, "script.txt"))).words;
      control.transcribed.push(args[2]!);
      if (args[2]!.endsWith("listen.wav")) {
        // Heard on the condensed copy: each word moves by what was cut before it.
        let at = 0;
        const segs = control.condensed.map((c) => { const x = { ...c, at }; at += c.to - c.from; return x; });
        const toListen = (t: number) => { const g = segs.find((x) => t >= x.from && t <= x.to) ?? segs.at(-1)!; return +(g.at + (t - g.from)).toFixed(3); };
        words = words.map((w) => ({ ...w, start: toListen(w.start), end: toListen(w.end) }));
      }
      fs.writeFileSync(path.join(opts.cwd, path.dirname(args[2]!), "transcript.json"), JSON.stringify(words));
      return {};
    }
    if (sub === "lint") return { stdout: '{"ok":true,"errorCount":0,"warningCount":0,"findings":[]}' };
    if (sub === "check") { control.checks++; return { stdout: o.checkStdout ?? checkReport() }; }
    if (sub === "snapshot") {
      fs.mkdirSync(path.join(opts.cwd, "snapshots"), { recursive: true }); fs.writeFileSync(path.join(opts.cwd, "snapshots", "contact-sheet.jpg"), "jpg"); return {}; }
    if (sub === "render") {
      control.rendering++;
      control.maxRendering = Math.max(control.maxRendering, control.rendering);
      try {
        opts.onLine?.('@hf-progress {"pct":50}', "stdout");
        if (control.renderHang) return await untilAborted(opts);
        if (o.renderStderr) return { code: 1, stderr: o.renderStderr };
        if (control.renderGate) await control.renderGate;
        fs.writeFileSync(args[args.indexOf("--output") + 1]!, "mp4");
        return {};
      } finally { control.rendering--; }
    }
    return {};
  });
  const hf = new HfCli(runner, PATHS, "linux");
  const narrator: Narrator = {
    async narrate(i) {
      control.narrations++;
      control.beforeNarrate?.();
      for (const l of o.narratorLines?.(i.folder) ?? []) i.onLine?.(l);
      if (control.narrateHang) { await untilAborted({ cwd: i.folder, signal: i.signal }); throw new CancelledError(); }
      const text = read(path.join(i.folder, i.textFile ?? "script.txt"));
      const { words, total } = fakeWords(text);
      // A pretend paragraph cache: a paragraph narrated before (with a cache folder) is reused.
      const paras = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
      const made = paras.filter((x) => !(i.cacheDir && control.paragraphCache.has(x))).length;
      if (i.cacheDir) for (const x of paras) control.paragraphCache.add(x);
      control.narrateCalls.push({ textFile: i.textFile, cacheDir: i.cacheDir, made, reused: paras.length - made });
      fs.writeFileSync(path.join(i.folder, "narration.wav"), "RIFF");
      fs.writeFileSync(path.join(i.folder, "narration.timing.json"), JSON.stringify({ total, paragraphs: fakeParagraphs(text), words_estimated: words, engine: "supertonic", voice: "F4", fell_back: false }));
      return { total, engine: "supertonic", voice: "F4", fell_back: false, made, reused: paras.length - made };
    },
  };
  const writer: ScriptWriter = {
    mode: "api",
    async write(req) {
      control.writes.push(req);
      if (o.writerStatus) req.onStatus?.(o.writerStatus(req.root));
      const failing = o.writeFails?.(control.writes.length);
      if (failing) {
        if (failing.partial !== undefined) fs.writeFileSync(path.join(req.root, req.folder, "script.txt"), failing.partial);
        throw new VideoError("writer_failed", "Claude could not write the script. Try again.");
      }
      const f = (o.files ?? (() => ({ script: JD_SCRIPT, spec: jdSpec(), extras: { "notes.md": "# Notes\n" } })))(req, control.writes.length);
      const dir = path.join(req.root, req.folder);
      fs.writeFileSync(path.join(dir, "script.txt"), f.script);
      fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(f.spec, null, 2));
      fs.writeFileSync(path.join(dir, "sources.md"), "# Sources\n");
      for (const [n, t] of Object.entries(f.extras ?? {})) fs.writeFileSync(path.join(dir, n), t);
      return { lockedFacts: [] };
    },
  };
  const tools = async (): Promise<ToolsReport> => { if (o.toolsThrow) throw new Error(o.toolsThrow); return o.toolsOk === false || control.toolsFail
    ? { ok: false, paths: null, checked_at: FIXED.toISOString(), tools: [{ id: "ffmpeg", label: "ffmpeg", ok: false, required: true, version: "", path: "", install: "ffmpeg", message: `Videos need ffmpeg to join audio and pictures. ${brand.name} can install it for you.` }] }
    : { ok: true, paths: { ...PATHS, ...(o.captionsModel !== undefined ? { captionsModel: o.captionsModel } : {}) }, checked_at: FIXED.toISOString(), tools: [] }; };
  let n = 0;
  const deps: PipelineDeps = {
    root, runner, tools, hf: () => hf, renderer: () => hyperframesRenderer(hf), narrator: () => narrator,
    registry: () => loadRegistry({ builtinDir: BUILTIN_TYPES, workspaceRoot: root }),
    writer: () => (o.writer === false ? null : writer), templatesDir: TEMPLATES, gsapFile: GSAP,
    settings: () => ({ captions: control.captions, lengths: {} }), freeBytes: () => o.free ?? 10 * 1024 ** 3,
    canBuild: o.canBuild, now: () => FIXED, newId: () => `vr-${++n}`, onEvent: (e) => events.push(e), onSaved: (f) => control.saved.push(f),
  };
  return { pipeline: new VideoPipeline(deps), events, control, runner };
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
