import fs from "node:fs";
import path from "node:path";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { fakeRunner, parseScript, stripTags, type Narrator, type ScriptWriter, type ToolsReport, type Word } from "@careeros/video";
import type { VideoHost } from "./video.js";

const FAKE_PATHS = {
  node: "/fake/bin/node", cli: "/fake/hyperframes/cli.js", ffmpeg: "/fake/bin/ffmpeg", ffprobe: "/fake/bin/ffprobe", chrome: "/fake/chrome",
  python: "/fake/venv/bin/python", narrate: "/fake/narrate.py", captionsModel: "base.en" as const,
};

/** Same timing rule as narrate.py's defaults: 0.5 s lead, 0.4 s a word, 0.45 s between paragraphs, 1 s tail. */
function estimate(script: string): { words: Word[]; total: number } {
  const words: Word[] = [];
  let t = 0.5;
  parseScript(script).forEach((b, i) => {
    if (i > 0) t += 0.45;
    if (b.kind === "pause") { t += b.seconds; return; }
    for (const w of stripTags(b.text).split(/\s+/).filter(Boolean)) { words.push({ text: w, start: +t.toFixed(2), end: +(t + 0.32).toFixed(2) }); t += 0.4; }
  });
  return { words, total: +(t + 1).toFixed(2) };
}

/**
 * A video host for tests and for the end-to-end "fake video" mode: no ffmpeg, Chrome, HyperFrames, Python or Claude.
 * The fake writer makes a title, a comparison and a recap card, which suits every built-in type except interview prep
 * (it needs three quiz scenes, so its check fails with a plain message). The weekly recap uses its template writer.
 */
export function fakeVideoHost(o: { pluginDir: string; gsapFile: string; toolsOk?: boolean; free?: number }): VideoHost & { control: { renders: number } } {
  const control = { renders: 0 };
  const runner = fakeRunner((cmd, args, opts) => {
    if (cmd === FAKE_PATHS.ffprobe) {
      const total = JSON.parse(fs.readFileSync(path.join(opts.cwd, "narration.timing.json"), "utf8")).total as number;
      return { stdout: JSON.stringify({ format: { duration: String(total) }, streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }] }) };
    }
    const sub = args[1];
    if (sub === "transcribe") {
      fs.writeFileSync(path.join(opts.cwd, path.dirname(args[2]!), "transcript.json"), JSON.stringify(estimate(fs.readFileSync(path.join(opts.cwd, "script.txt"), "utf8")).words));
      return {};
    }
    if (sub === "lint" || sub === "check") return { stdout: '{"ok":true,"errorCount":0,"warningCount":0,"findings":[]}' };
    if (sub === "snapshot") { fs.mkdirSync(path.join(opts.cwd, "snapshots"), { recursive: true }); fs.writeFileSync(path.join(opts.cwd, "snapshots", "contact-sheet.jpg"), "jpg"); return {}; }
    if (sub === "render") { control.renders++; opts.onLine?.('@hf-progress {"pct":100}', "stdout"); fs.writeFileSync(args[args.indexOf("--output") + 1]!, "mp4"); return {}; }
    return { stdout: "0.8.140\n" };
  });
  const narrator: Narrator = {
    async narrate(i) {
      const { words, total } = estimate(fs.readFileSync(path.join(i.folder, "script.txt"), "utf8"));
      fs.writeFileSync(path.join(i.folder, "narration.wav"), "RIFF");
      fs.writeFileSync(path.join(i.folder, "narration.timing.json"), JSON.stringify({ total, paragraphs: [], words_estimated: words, engine: "fake", voice: "F4", fell_back: false }));
      return { total, engine: "fake", voice: "F4", fell_back: false };
    },
  };
  const writer: ScriptWriter = {
    mode: "api",
    async write(req) {
      const dir = path.join(req.root, req.folder);
      const cite = req.pack.files[0] ? [{ file: req.pack.files[0].rel }] : undefined;
      const script = "Here is a short video for you.\n\nOn one side, the ad. On the other side, your history.\n\nSo remember. One, two, three.\n";
      const src = cite ? { sources: cite } : {};
      const spec = {
        version: 2, title: "A short video", voice_type: req.type.voice_type,
        scenes: [
          { type: "title", cue: "Here is", kicker: identity.name, title: "A short video", ...src },
          { type: "comparison", cue: "On one side", headline: "Two sides", left: { label: "The ad", items: ["What it asks"] }, right: { label: "You", items: ["What you did"] },
            cue_left: "the ad", cue_right: "other side", ...src },
          { type: "recap-card", cue: "So remember", headline: "Three things", closing: "That is all.", ...src,
            items: [{ text: "One", cue: "One" }, { text: "Two", cue: "two" }, { text: "Three", cue: "three" }] },
        ],
      };
      fs.writeFileSync(path.join(dir, "script.txt"), script);
      fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec, null, 2));
      fs.writeFileSync(path.join(dir, "sources.md"), "# Sources\n");
      for (const x of req.type.extras) fs.writeFileSync(path.join(dir, x), "# Notes\n");
      return { lockedFacts: [] };
    },
  };
  const tools = async (): Promise<ToolsReport> => (o.toolsOk === false
    ? { ok: false, paths: null, checked_at: new Date(0).toISOString(), tools: [{ id: "ffmpeg", label: "ffmpeg", ok: false, required: true, version: "", path: "", install: "ffmpeg", message: `Videos need ffmpeg to join audio and pictures. ${identity.name} can install it for you.` }] }
    : { ok: true, paths: FAKE_PATHS, checked_at: new Date(0).toISOString(), tools: [] });
  return {
    runner, pluginDir: o.pluginDir, gsapFile: o.gsapFile, platform: "linux", home: "/fake/home", env: {}, freeBytes: () => o.free ?? 10 * 1024 ** 3,
    tools, narrator: () => narrator, writer: () => writer, control,
  };
}
