import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRecord, updateRecord, layout, type VideoRecord } from "@careeros/core";
import {
  checkTools, HfCli, hyperframesRenderer, loadRegistry, narratePy, nodeProcessRunner, VideoPipeline, type SceneSpec, type ScriptWriter,
} from "@careeros/video";
import { ServiceContext } from "../src/context.js";
import { fakeHost, fakeShell, memorySecrets } from "../src/fakes.js";
import { openSample } from "../src/workspace.js";
import { EXAMPLE_VIDEOS, exampleVideoAt, SEED_VIDEO_FILES } from "../src/sample-videos.js";
import { SAMPLE, tmpDir } from "./helpers.js";

/**
 * Renders the example's sample videos with the app's own pipeline (real narration, captions, HyperFrames render) from
 * hand-written scripts about the fictional example, then keeps the finished files in samples/alex-example/.example-seed/
 * videos. A maker's tool, not a gate: skipped unless CAREEROS_EXAMPLE_VIDEOS=1. If the global HyperFrames isn't the
 * pinned version, install the pinned one under another npm prefix and name it (npm i -g --prefix DIR hyperframes@<pin>):
 *   CAREEROS_EXAMPLE_VIDEOS=1 CAREEROS_EXAMPLE_NPM_PREFIX=DIR npx vitest run packages/services/test/example-videos.render.test.ts
 * Optional: CAREEROS_EXAMPLE_VIDEOS_ONLY=<name> renders one.
 */
// The weekly recap normally names its dates ("the week of 5 to 11 October"). The example's copy is moved to "this
// week" every time it opens, so its words must not date it: the same template, with the dates taken out.
vi.mock("../../video/src/recap.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../video/src/recap.ts")>();
  return {
    ...orig,
    writeRecap: (root: string, folder: string, stats: Parameters<typeof orig.writeRecap>[2], o?: Parameters<typeof orig.writeRecap>[3]) => {
      const out = orig.writeRecap(root, folder, stats, o);
      const { long, short } = orig.weekLabel(stats.week);
      const dir = path.join(root, folder);
      const undate = (t: string) => t.split(`the week of ${long}`).join("this week").split(`Your week, ${short}`).join("Your week").split(`for ${long}`).join("for this week");
      for (const f of ["script.txt", "spec.json", "sources.md"]) fs.writeFileSync(path.join(dir, f), undate(fs.readFileSync(path.join(dir, f), "utf8")));
      return out;
    },
  };
});

const ON = process.env.CAREEROS_EXAMPLE_VIDEOS === "1";
const ONLY = process.env.CAREEROS_EXAMPLE_VIDEOS_ONLY ?? "";
const REPO = path.resolve(import.meta.dirname, "../../..");
const PLUGIN = path.join(REPO, "plugin");
const OUT = path.join(SAMPLE, ".example-seed", "videos");
const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");
const PREFIX = process.env.CAREEROS_EXAMPLE_NPM_PREFIX ?? "";
const ENV: NodeJS.ProcessEnv = PREFIX ? { ...process.env, npm_config_prefix: PREFIX } : process.env;

const ACME = "companies/acme-corp/jobs/2026-01-12-ai-engineer";
const JD = `${ACME}/jd.md`;
const HISTORY = "me/history/roles.md";

const JD_SCRIPT = [
  "Acme Corp wants an AI Engineer to build its clinic assistant. Here is what the role asks for.",
  "The must-haves. LLM agents. Retrieval with citations. Evaluation with test sets. And clear writing for people who aren't engineers.",
  "Here is how the assistant fits together. A staff question goes to the agent. The agent searches the clinic's policies. The answer comes back with its sources.",
  "Now your match. Retrieval is a match. Evaluation is a match. Agents are a match. Healthcare is a gap, but it's only a nice to have.",
  "And the best part. The ad says it plainly. Visa sponsorship available for the right candidate.",
  "So the plan. Lead with your evaluation suite, mention your agent, and apply this week.",
].join("\n\n") + "\n";

function jdSpec(): SceneSpec {
  const src = [{ file: JD }];
  return {
    version: 3, title: "Acme Corp: what the role asks", voice_type: "slides", captions: "rail",
    scenes: [
      { type: "title", cue: "Acme Corp wants", kicker: "JD walkthrough", title: "An AI Engineer for the clinic assistant", underline: "assistant", sources: src },
      {
        type: "icon-grid", cue: "The must-haves", headline: "What the role asks for", sources: src,
        items: [
          { label: "LLM agents", icon: "bot", cue: "LLM agents" }, { label: "Retrieval with citations", icon: "search", cue: "Retrieval" },
          { label: "Evaluation with tests", icon: "list-checks", cue: "Evaluation" }, { label: "Clear writing", icon: "pen-line", cue: "clear writing" },
        ],
      },
      {
        type: "flowchart", cue: "Here is how", headline: "How it fits together", direction: "lr", sources: src,
        nodes: [
          { id: "q", label: "Staff question", cue: "staff question" }, { id: "agent", label: "Agent", cue: "goes to the agent" },
          { id: "docs", label: "Clinic policies", cue: "searches" }, { id: "answer", label: "Answer with sources", cue: "comes back" },
        ],
        edges: [["q", "agent"], ["agent", "docs"], ["docs", "answer"]],
      },
      {
        type: "match", cue: "Now your match", headline: "Your evidence", sources: [{ file: HISTORY }, { file: JD }],
        rows: [
          { ask: "Retrieval", status: "match", icon: "search", cue: "Retrieval is" }, { ask: "Evaluation", status: "match", icon: "list-checks", cue: "Evaluation is" },
          { ask: "LLM agents", status: "match", icon: "bot", cue: "Agents are" }, { ask: "Healthcare", status: "gap", icon: "shield", cue: "Healthcare is" },
        ],
      },
      {
        type: "quote", cue: "And the best part", text: "Visa sponsorship available for the right candidate.", by: "From the job ad",
        sources: [{ file: JD, quote: "Visa sponsorship available for the right candidate." }],
      },
      {
        type: "checklist", cue: "So the plan", headline: "Before you apply", sources: [{ file: HISTORY }],
        items: [{ text: "Lead with evaluation", state: "yes", cue: "Lead" }, { text: "Mention your agent", state: "yes", cue: "mention" }, { text: "Apply this week", state: "yes", cue: "apply" }],
      },
    ],
  } as SceneSpec;
}

const PITCH_SCRIPT = [
  "Here is how I would answer, tell me about yourself, for Acme Corp.",
  "Right now I'm a Senior AI Engineer at Sampletown Software. I lead the retrieval platform behind our support assistant.",
  "I built the evaluation suite that checks each answer against its sources. It runs 400 fixed questions every night.",
  "Acme Corp's assistant has to cite clinic policies. That is the work I do today.",
  "So that's why I applied. I want to build an assistant people can trust. Thanks for listening.",
].join("\n\n") + "\n";

function pitchSpec(): SceneSpec {
  return {
    version: 2, title: "My answer for Acme Corp", voice_type: "interview",
    scenes: [
      { type: "title", cue: "Here is how", kicker: "Tell me about yourself", title: "My answer for Acme Corp", sources: [{ file: JD }] },
      {
        type: "bullet-build", cue: "Right now", headline: "What I do now", sources: [{ file: HISTORY }],
        items: [{ text: "Senior AI Engineer, Sampletown Software", cue: "Senior AI Engineer" }, { text: "Lead the retrieval platform", cue: "lead the retrieval" }],
      },
      {
        type: "kinetic", cue: "I built", lines: [{ text: "400 questions.", cue: "400" }, { text: "Checked every night.", cue: "every night" }], emphasis: "400", sources: [{ file: HISTORY, quote: "400 fixed questions" }],
      },
      {
        type: "comparison", cue: "Acme Corp's assistant", headline: "Why I fit", left: { label: "Acme Corp needs", items: ["Answers that cite policies"] },
        right: { label: "I do today", items: ["Answers checked against sources"] }, cue_left: "cite clinic policies", cue_right: "work I do today",
        sources: [{ file: JD }, { file: HISTORY }],
      },
      {
        type: "recap-card", cue: "So that's why", headline: "Why this job", sources: [{ file: JD }, { file: HISTORY }], closing: "Thanks for listening.",
        items: [{ text: "Retrieval that cites", cue: "applied" }, { text: "Evaluation every night", cue: "build" }, { text: "An assistant to trust", cue: "trust" }],
      },
    ],
  } as SceneSpec;
}

const LESSON_SCRIPT = [
  "Here is how to evaluate an LLM app, in under a minute.",
  "Start with a fixed test set. Real questions, with the answers you expect.",
  "Then run the loop. Run the app. Score each answer. Fix the prompt or the retrieval. Then run it again.",
  "Score three things. Is the answer correct? Is it grounded in the sources? Does it follow the format?",
  "Then gate the release. If the score drops by two points, the release stops.",
  "So remember. A fixed test set, three scores, and a release gate. Write twenty questions today.",
].join("\n\n") + "\n";

function lessonSpec(): SceneSpec {
  return {
    version: 2, title: "Evaluating LLM apps", voice_type: "guide",
    scenes: [
      { type: "title", cue: "Here is how", kicker: "Skill-gap lesson", title: "Evaluating LLM apps", underline: "Evaluating" },
      { type: "kinetic", cue: "Start with", lines: [{ text: "A fixed test set.", cue: "fixed test set" }, { text: "Real questions, expected answers.", cue: "Real questions" }], emphasis: "fixed" },
      {
        type: "flowchart", cue: "Then run the loop", headline: "The evaluation loop", direction: "lr",
        nodes: [{ id: "run", label: "Run the app", cue: "Run the app" }, { id: "score", label: "Score answers", cue: "Score each" }, { id: "fix", label: "Fix the prompt", cue: "Fix the prompt" }],
        edges: [["run", "score"], ["score", "fix"]],
      },
      {
        type: "icon-grid", cue: "Score three things", headline: "Score three things",
        items: [{ label: "Correct", icon: "circle-check", cue: "correct" }, { label: "Grounded", icon: "book-open", cue: "grounded" }, { label: "Right format", icon: "list-checks", cue: "format" }],
      },
      { type: "code-typing", cue: "Then gate", lang: "python", code: "if score < last_score - 2:\n    raise SystemExit(\"Release blocked\")", label: "A release gate", cue_done: "stops" },
      {
        type: "recap-card", cue: "So remember", headline: "Remember these three", closing: "Write twenty questions today.",
        items: [{ text: "A fixed test set", cue: "fixed test set" }, { text: "Three scores", cue: "three scores" }, { text: "A release gate", cue: "release gate" }],
      },
    ],
  } as SceneSpec;
}

const FILES: Record<string, { script: string; spec: () => SceneSpec; extras?: Record<string, string> }> = {
  "jd-walkthrough": { script: JD_SCRIPT, spec: jdSpec, extras: { "notes.md": "# Notes\n\n- Sponsorship is in the ad. Lead with it in the cover letter.\n" } },
  pitch: { script: PITCH_SCRIPT, spec: pitchSpec, extras: { "pitch.md": PITCH_SCRIPT } },
  "skill-gap-lesson": { script: LESSON_SCRIPT, spec: lessonSpec },
};

const writer: ScriptWriter = {
  mode: "api",
  async write(req) {
    const f = FILES[req.type.id];
    if (!f) throw new Error(`no script for ${req.type.id}`);
    const dir = path.join(req.root, req.folder);
    fs.writeFileSync(path.join(dir, "script.txt"), f.script);
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(f.spec(), null, 2));
    fs.writeFileSync(path.join(dir, "sources.md"), "# Sources\n\n- The job ad\n- Your work history\n");
    for (const [n, t] of Object.entries(f.extras ?? {})) fs.writeFileSync(path.join(dir, n), t);
    return { lockedFacts: [] };
  },
};

describe.skipIf(!ON)("example videos (CAREEROS_EXAMPLE_VIDEOS=1)", () => {
  it("renders each sample video with the real pipeline and keeps it in the seed folder", async () => {
    const home = tmpDir();
    const ctx = new ServiceContext(fakeHost({ now: () => new Date(), shell: fakeShell(), secrets: memorySecrets(), homeDir: home, sampleDir: SAMPLE }));
    const { root } = await openSample(ctx);
    // Videos already in the example would be reused; render from scratch.
    const now = new Date();
    for (const v of EXAMPLE_VIDEOS) fs.rmSync(path.join(root, exampleVideoAt(v, now).folder), { recursive: true, force: true });
    updateRecord("integrations", layout(root).integrations, (i) => { i.voice = { ...i.voice, engine: (process.env.CAREEROS_EXAMPLE_VOICE_ENGINE ?? i.voice.engine) as typeof i.voice.engine }; });
    const runner = nodeProcessRunner();
    const report = await checkTools({
      runner, platform: process.platform, env: ENV, home: os.homedir(), pluginDir: PLUGIN, captions: "rail",
      exists: (p) => fs.existsSync(p), isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
      readFile: (p) => fs.readFileSync(p, "utf8"), now: () => new Date(),
    });
    if (!report.paths) throw new Error(report.tools.filter((t) => !t.ok).map((t) => `${t.id}: ${t.message}`).join("; "));
    const p = report.paths;
    const pipeline = new VideoPipeline({
      root, registry: () => loadRegistry({ builtinDir: path.join(PLUGIN, "video-types"), workspaceRoot: root }), tools: async () => report,
      renderer: (tp) => hyperframesRenderer(new HfCli(runner, tp, process.platform)), hf: (tp) => new HfCli(runner, tp, process.platform),
      narrator: (tp) => narratePy(runner, tp, ENV), runner, writer: () => writer, templatesDir: path.join(PLUGIN, "templates", "video"), gsapFile: GSAP,
      settings: () => ({ captions: "rail", lengths: {}, motion: "full", sound: "subtle", music: false }), freeBytes: () => 50 * 1024 ** 3, now: () => new Date(),
      onEvent: (e) => { if (e.kind === "run") console.log("video:", JSON.stringify(e).slice(0, 300)); }, sponsorship: () => true,
    });
    for (const v of EXAMPLE_VIDEOS) {
      if (ONLY && v.name !== ONLY) continue;
      const at = exampleVideoAt(v, now);
      pipeline.start(v.type, at.subject, { length_s: v.length_s, review: "if_problems" });
      await pipeline.idle();
      const folder = path.join(root, at.folder);
      const rec = readRecord("video", path.join(folder, "video.json")) as VideoRecord;
      if (rec.status !== "done") {
        const fc = fs.existsSync(path.join(folder, "factcheck.json")) ? fs.readFileSync(path.join(folder, "factcheck.json"), "utf8") : "";
        throw new Error(`${v.name}: ${rec.status} ${rec.error}\n${fc.slice(0, 4000)}`);
      }
      // 720p and well compressed, so the repo stays small. The pipeline's own render is 1080p.
      const final = path.join(folder, "renders", "final.mp4");
      const small = path.join(folder, "renders", "final-720.mp4");
      const r = await runner.run(p.ffmpeg, ["-y", "-i", final, "-map_metadata", "0", "-vf", "scale=1280:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", small], { cwd: folder, timeoutMs: 600_000 });
      expect(r.code).toBe(0);
      fs.renameSync(small, final);
      // The AI voice disclosure survives the re-encode.
      const tags = await runner.run(p.ffprobe, ["-v", "error", "-show_entries", "format_tags=comment", "-of", "default=nw=1:nk=1", final], { cwd: folder, timeoutMs: 60_000 });
      expect(tags.stdout).toMatch(/AI voice/);
      const sheet = path.join(folder, "contact-sheet.jpg");
      if (fs.existsSync(sheet)) {
        const s2 = path.join(folder, "sheet-small.jpg");
        const x = await runner.run(p.ffmpeg, ["-y", "-i", sheet, "-vf", "scale=1280:-2", "-q:v", "5", s2], { cwd: folder, timeoutMs: 60_000 });
        if (x.code === 0) fs.renameSync(s2, sheet);
      }
      const dest = path.join(OUT, v.name);
      fs.rmSync(dest, { recursive: true, force: true });
      for (const rel of SEED_VIDEO_FILES) {
        const from = path.join(folder, rel);
        if (!fs.existsSync(from)) continue;
        fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
        fs.copyFileSync(from, path.join(dest, rel));
      }
      console.log(`${v.name}: ${rec.length_s}s, ${(fs.statSync(path.join(dest, "renders", "final.mp4")).size / 1e6).toFixed(1)} MB`);
    }
  }, 3_600_000);
});
