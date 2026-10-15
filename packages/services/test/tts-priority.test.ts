// Read aloud responsiveness: the warm worker, Listen before voice samples, lazy samples, the first-chunk
// fallback to the Mac voice, and background privacy events never stopping an ordinary Listen.
// Fake processes only: nothing is synthesised and nothing is downloaded.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { TtsOptions } from "@careeros/contract";
import { dispatch } from "../src/dispatch.js";
import { type ChildLike, type NarratorPaths, type SpawnFn } from "../src/tts-runner.js";
import { installTtsHooks, setTtsDeps } from "../src/tts.js";
import { NarratorWorker, type WorkerChild, type WorkerSpawnFn } from "../src/tts-worker.js";
import { openSample } from "./helpers.js";

const OPTS: TtsOptions = { voice: "F4", lang: "en" };
const PATHS: NarratorPaths = { venvPython: "/fake/venv/python", systemPython: "/usr/bin/python3", script: "/fake/narrate.py", say: "/usr/bin/say", ffmpeg: "/fake/ffmpeg" };
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what = "condition") {
  for (let i = 0; i < 1000; i++) { if (cond()) return; await tick(); }
  throw new Error(`timed out waiting for ${what}`);
}
const arg = (args: string[], name: string) => args[args.indexOf(name) + 1]!;

// ---- a fake `narrate.py --serve` -------------------------------------------------------------

interface Job { id: string; op: string; text: string; out: string; voice: string; lang: string }
class FakeWorkerProc extends EventEmitter implements WorkerChild {
  pid = undefined;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  jobs: Job[] = [];
  signals: string[] = [];
  stdinEnded = false;
  closed = false;
  /** Set to answer jobs by hand. */
  hold = false;
  constructor(public args: string[], public env: NodeJS.ProcessEnv) {
    super();
    let buf = "";
    this.stdin.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const job = JSON.parse(buf.slice(0, nl)) as Job;
        buf = buf.slice(nl + 1);
        this.jobs.push(job);
        if (!this.hold) this.answer(job);
      }
    });
    this.stdin.on("finish", () => { this.stdinEnded = true; });
  }
  ready(engine = "supertonic") { this.stdout.write(`${JSON.stringify({ event: "ready", engine, fell_back: engine !== "supertonic" })}\n`); }
  answer(job: Job, ok = true) {
    if (ok) { fs.mkdirSync(path.dirname(job.out), { recursive: true }); fs.writeFileSync(job.out, Buffer.alloc(2048, 2)); } // like narrate's makedirs
    this.stdout.write(`${JSON.stringify({ id: job.id, ok, engine: "supertonic", fell_back: false })}\n`);
  }
  kill(sig?: NodeJS.Signals) { this.signals.push(sig ?? "SIGTERM"); return true; }
  close() { if (this.closed) return; this.closed = true; setImmediate(() => this.emit("close", 0, null)); }
}
function fakeWorkers(o: { autoReady?: boolean; hold?: boolean } = {}) {
  const procs: FakeWorkerProc[] = [];
  const spawn: WorkerSpawnFn = (_cmd, args, opts) => {
    const p = new FakeWorkerProc(args, opts.env);
    p.hold = !!o.hold;
    procs.push(p);
    if (o.autoReady !== false) setImmediate(() => p.ready());
    return p;
  };
  const killTree = (c: ChildLike, sig: NodeJS.Signals) => { const p = c as FakeWorkerProc; p.signals.push(sig); p.close(); };
  return { spawn, killTree, procs };
}

// ---- fake one-shot processes (previews, the Mac voice) -----------------------------------------

class FakeChild extends EventEmitter implements ChildLike {
  pid = undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(sig?: NodeJS.Signals) { this.signals.push(sig ?? "SIGTERM"); return true; }
  exit(code: number | null) { setImmediate(() => this.emit("close", code, null)); }
}
interface Run { cmd: string; args: string[]; child: FakeChild; at: number }
/** `--check` passes; `--preview` hangs until `finishPreview`; a one-shot paragraph writes its file and reports `say`. */
function fakeOneShots() {
  const runs: Run[] = [];
  const spawn: SpawnFn = (cmd, args) => {
    const child = new FakeChild();
    runs.push({ cmd, args, child, at: Date.now() });
    setImmediate(() => {
      if (args[0] === "-c") { child.stdout.write(`${JSON.stringify({ languages: ["en"] })}\n`); child.exit(0); return; }
      if (args.includes("--check")) { child.exit(0); return; }
      if (args.includes("--preview")) return; // finished by the test
      fs.writeFileSync(arg(args, "--out"), Buffer.alloc(1024, 1));
      child.stdout.write(`${JSON.stringify({ ok: true, engine: "macos_say", fell_back: false })}\n`);
      child.exit(0);
    });
    return child;
  };
  const killTree = (c: ChildLike, sig: NodeJS.Signals) => { (c as FakeChild).signals.push(sig); (c as FakeChild).exit(null); };
  const previews = () => runs.filter((r) => r.args.includes("--preview"));
  const finishPreview = (r: Run) => {
    for (const v of arg(r.args, "--voices").split(",")) fs.writeFileSync(path.join(arg(r.args, "--out-dir"), `${v}.wav`), "RIFF");
    r.child.exit(0);
  };
  const paragraphs = () => runs.filter((r) => r.args.includes("--text-file"));
  return { spawn, killTree, runs, previews, finishPreview, paragraphs };
}

function useDeps(o: { workers?: ReturnType<typeof fakeWorkers> | null; firstChunkMs?: number; paths?: NarratorPaths } = {}) {
  const one = fakeOneShots();
  const w = o.workers === undefined ? fakeWorkers() : o.workers;
  setTtsDeps({
    paths: () => o.paths ?? PATHS, spawn: one.spawn, killTree: one.killTree, env: () => ({ PATH: "/usr/bin" }),
    firstChunkMs: o.firstChunkMs ?? 2500,
    worker: w ? (wo) => new NarratorWorker({ ...wo, spawn: w.spawn, killTree: w.killTree, graceMs: 5 }) : undefined,
  });
  return { one, w };
}

afterEach(() => setTtsDeps());

describe("narrator worker", () => {
  it("runs narrate.py --serve offline and keeps one model for every paragraph", async () => {
    const w = fakeWorkers();
    const worker = new NarratorWorker({ python: "/fake/venv/python", script: "/fake/narrate.py", env: { PATH: "/usr/bin" }, spawn: w.spawn, killTree: w.killTree });
    const dir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "careeros-w-"));
    const a = await worker.speak({ text: "# One.", voice: "F4", lang: "en", out: path.join(dir, "a.wav") });
    const b = await worker.speak({ text: "Two.", voice: "M3", lang: "en", out: path.join(dir, "b.wav") });
    expect(a).toEqual({ engine: "supertonic", fellBack: false });
    expect(b.engine).toBe("supertonic");
    expect(w.procs).toHaveLength(1); // one process, warm for both
    const p = w.procs[0]!;
    expect(p.args).toEqual(["/fake/narrate.py", "--serve", "--no-download"]);
    expect(p.env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });
    expect(p.jobs.map((j) => [j.op, j.text, j.voice])).toEqual([["speak", "number One.", "F4"], ["speak", "Two.", "M3"]]);
    // Almost no silence after a chunk: the next one starts the moment this one ends.
    expect((p.jobs[0] as unknown as { tail: number }).tail).toBeLessThanOrEqual(0.08);
    worker.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("holds jobs until the model is loaded, then sends them one at a time", async () => {
    const w = fakeWorkers({ autoReady: false, hold: true });
    const worker = new NarratorWorker({ python: "py", script: "n.py", env: {}, spawn: w.spawn, killTree: w.killTree });
    const dir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "careeros-w-"));
    const a = worker.speak({ text: "A.", voice: "F4", lang: "en", out: path.join(dir, "a.wav") });
    const b = worker.speak({ text: "B.", voice: "F4", lang: "en", out: path.join(dir, "b.wav") });
    await tick(5);
    const p = w.procs[0]!;
    expect(worker.state).toBe("starting");
    expect(p.jobs).toHaveLength(0);
    p.ready();
    await until(() => p.jobs.length === 1, "first job");
    await tick(5);
    expect(p.jobs).toHaveLength(1); // not the second until the first is answered
    p.answer(p.jobs[0]!);
    await a;
    await until(() => p.jobs.length === 2, "second job");
    p.answer(p.jobs[1]!);
    await b;
    worker.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("forgets a cancelled job that wasn't sent, and ignores the answer to one that was", async () => {
    const w = fakeWorkers({ hold: true });
    const worker = new NarratorWorker({ python: "py", script: "n.py", env: {}, spawn: w.spawn, killTree: w.killTree });
    const dir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "careeros-w-"));
    await worker.whenReady();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const a = worker.speak({ text: "A.", voice: "F4", lang: "en", out: path.join(dir, "a.wav") }, ac1.signal);
    const b = worker.speak({ text: "B.", voice: "F4", lang: "en", out: path.join(dir, "b.wav") }, ac2.signal);
    const p = w.procs[0]!;
    await until(() => p.jobs.length === 1, "first job");
    ac2.abort();
    ac1.abort();
    await expect(a).rejects.toThrow("Reading aloud was stopped.");
    await expect(b).rejects.toThrow("Reading aloud was stopped.");
    p.answer(p.jobs[0]!);
    await tick(5);
    expect(p.jobs).toHaveLength(1); // B was never sent
    expect(worker.state).toBe("ready"); // still warm
    worker.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("quits by itself after the idle time, and on stop closes stdin and kills the group", async () => {
    const w = fakeWorkers();
    let exits = 0;
    const worker = new NarratorWorker({ python: "py", script: "n.py", env: {}, spawn: w.spawn, killTree: w.killTree, idleMs: 20, onExit: () => { exits += 1; } });
    await worker.whenReady();
    expect(worker.state).toBe("ready");
    await until(() => worker.state === "stopped", "idle stop");
    const p = w.procs[0]!;
    expect(p.stdinEnded).toBe(true);
    expect(p.signals).toContain("SIGTERM");
    expect(exits).toBe(1);
  });
  it("rejects waiting jobs when the process dies, with a plain sentence", async () => {
    const w = fakeWorkers({ autoReady: false });
    const worker = new NarratorWorker({ python: "py", script: "n.py", env: {}, spawn: w.spawn, killTree: w.killTree });
    const job = worker.speak({ text: "A.", voice: "F4", lang: "en", out: "/nowhere/a.wav" });
    await tick(2);
    w.procs[0]!.close();
    await expect(job).rejects.toThrow("The natural voice stopped unexpectedly.");
    expect(worker.state).toBe("stopped");
  });
  it("gives up when the model doesn't load in time", async () => {
    const w = fakeWorkers({ autoReady: false });
    const worker = new NarratorWorker({ python: "py", script: "n.py", env: {}, spawn: w.spawn, killTree: w.killTree, startMs: 15 });
    await expect(worker.speak({ text: "A.", voice: "F4", lang: "en", out: "/nowhere/a.wav" })).rejects.toThrow(/took too long to start/);
  });
});

describe("read aloud goes first", () => {
  it("speaks through one warm worker for the whole reading", async () => {
    const { one, w } = useDeps();
    const { ctx } = openSample();
    const a = await dispatch(ctx, "tts.speak", ["First paragraph.", OPTS, "", "r1"]) as { engine: string; fellBack: boolean };
    await dispatch(ctx, "tts.speak", ["Second paragraph.", OPTS, "", "r2"]);
    expect(a).toMatchObject({ engine: "supertonic", fellBack: false });
    expect(w!.procs).toHaveLength(1);
    expect(w!.procs[0]!.jobs).toHaveLength(2);
    expect(one.paragraphs()).toHaveLength(0); // no one-shot model loads
  });
  it("pauses a voice sample being made, speaks at once, then finishes the sample", async () => {
    const { one, w } = useDeps();
    const { ctx, root } = openSample();
    const sample = dispatch(ctx, "tts.previewVoice", ["M1", "en"]) as Promise<{ voices: { voice: string; url: string | null }[] }>;
    await until(() => one.previews().length === 1, "sample start");
    const first = one.previews()[0]!;
    expect(arg(first.args, "--voices")).toBe("M1"); // one voice, not all ten
    expect(arg(first.args, "--nice")).toBe("10");
    const t0 = Date.now();
    const said = await dispatch(ctx, "tts.speak", ["Listen now.", OPTS, "", "r1"]) as { engine: string };
    expect(said.engine).toBe("supertonic");
    expect(first.child.signals).toContain("SIGTERM"); // the sample stopped for Listen
    expect(Date.now() - t0).toBeLessThan(1000); // Listen never waited for the sample
    expect(w!.procs[0]!.jobs).toHaveLength(1);
    // Nothing waiting for read aloud now: the sample runs again and finishes.
    await until(() => one.previews().length === 2, "sample resume");
    const again = one.previews()[1]!;
    expect(arg(again.args, "--voices")).toBe("M1");
    one.finishPreview(again);
    const r = await sample;
    expect(r.voices.find((v) => v.voice === "M1")?.url).toBe("careeros-file://tts/preview-M1.wav");
    expect(fs.existsSync(path.join(root, "settings", "voice-previews", "M1.wav"))).toBe(true);
  });
  it("doesn't start a sample while a paragraph is being made", async () => {
    const workers = fakeWorkers({ hold: true });
    const { one } = useDeps({ workers });
    const { ctx } = openSample();
    const speaking = dispatch(ctx, "tts.speak", ["Long paragraph.", OPTS, "", "r1"]);
    await until(() => workers.procs[0]?.jobs.length === 1, "job sent");
    const sample = dispatch(ctx, "tts.previewVoice", ["F2", "en"]);
    await tick(10);
    expect(one.previews()).toHaveLength(0);
    expect(await dispatch(ctx, "tts.activity", [])).toEqual({ voice: "busy", previewsLeft: 1 });
    workers.procs[0]!.answer(workers.procs[0]!.jobs[0]!);
    await speaking;
    await until(() => one.previews().length === 1, "sample after Listen");
    one.finishPreview(one.previews()[0]!);
    await sample;
  });
  it("makes samples only when asked, and never again once saved", async () => {
    const { one } = useDeps();
    const { ctx, root } = openSample();
    fs.mkdirSync(path.join(root, "settings", "voice-previews"), { recursive: true });
    fs.writeFileSync(path.join(root, "settings", "voice-previews", "F4.wav"), "RIFF");
    await dispatch(ctx, "tts.previews", []);
    await dispatch(ctx, "tts.status", []);
    expect(one.previews()).toHaveLength(0); // looking at Settings makes nothing
    const r = await dispatch(ctx, "tts.previewVoice", ["F4", "en"]) as { missing: number };
    expect(r.missing).toBe(9);
    expect(one.previews()).toHaveLength(0); // already saved
    // Two clicks on the same voice share one run.
    const a = dispatch(ctx, "tts.previewVoice", ["M5", "en"]);
    const b = dispatch(ctx, "tts.previewVoice", ["M5", "en"]);
    await until(() => one.previews().length === 1, "one run");
    one.finishPreview(one.previews()[0]!);
    await Promise.all([a, b]);
    expect(one.previews()).toHaveLength(1);
  });
  it("Stop clears queued samples with a plain sentence", async () => {
    const { one } = useDeps();
    const { ctx } = openSample();
    const a = dispatch(ctx, "tts.previewVoice", ["F1", "en"]);
    const b = dispatch(ctx, "tts.previewVoice", ["F2", "en"]);
    await until(() => one.previews().length === 1, "first sample");
    expect(await dispatch(ctx, "tts.stopVoiceWork", [])).toBe(true);
    await expect(a).rejects.toThrow("Making the voice samples was stopped.");
    await expect(b).rejects.toThrow("Making the voice samples was stopped.");
    await tick(10);
    expect(one.previews()).toHaveLength(1);
  });
});

describe("fast first audio", () => {
  it("reads the first paragraph with the Mac voice while the natural voice warms up, then switches", async () => {
    const workers = fakeWorkers({ autoReady: false });
    const { one } = useDeps({ workers, firstChunkMs: 30 });
    const { ctx } = openSample();
    expect(await dispatch(ctx, "tts.activity", [])).toEqual({ voice: "off", previewsLeft: 0 });
    const first = dispatch(ctx, "tts.speak", ["First paragraph.", OPTS, "", "r1"]) as Promise<{ engine: string; warming?: boolean; fellBack: boolean }>;
    await until(() => workers.procs.length === 1, "worker start");
    expect(await dispatch(ctx, "tts.activity", [])).toMatchObject({ voice: "starting" });
    const r1 = await first;
    expect(r1).toMatchObject({ engine: "macos_say", warming: true, fellBack: true });
    expect(arg(one.paragraphs()[0]!.args, "--engine")).toBe("macos_say");
    expect(workers.procs[0]!.jobs).toHaveLength(0); // the Supertonic copy of paragraph 1 was dropped, not queued
    // The next paragraph waits for the natural voice (no second Mac-voice fallback), and gets it.
    const second = dispatch(ctx, "tts.speak", ["Second paragraph.", OPTS, "", "r2"]) as Promise<{ engine: string; warming?: boolean }>;
    await tick(60);
    workers.procs[0]!.ready();
    const r2 = await second;
    expect(r2.engine).toBe("supertonic");
    expect(r2.warming).toBeUndefined();
    expect(one.paragraphs()).toHaveLength(1);
  });
  it("doesn't fall back when the natural voice is already warm", async () => {
    const { one } = useDeps({ firstChunkMs: 500 });
    const { ctx } = openSample();
    await dispatch(ctx, "tts.speak", ["Warm up.", OPTS, "", "r1"]); // the fake loads its model at once
    const r = await dispatch(ctx, "tts.speak", ["Next.", OPTS, "", "r2"]) as { engine: string };
    expect(r.engine).toBe("supertonic");
    expect(one.paragraphs()).toHaveLength(0);
  });
  it("keeps the one-shot chunk's trailing silence short too", async () => {
    const { one } = useDeps({ workers: null });
    const { ctx } = openSample();
    await dispatch(ctx, "tts.speak", ["Hello.", OPTS, "", "r1"]);
    expect(Number(arg(one.paragraphs()[0]!.args, "--tail"))).toBeLessThanOrEqual(0.08);
  });
  it("Stop then Listen again at once never inherits the stopped run", async () => {
    const workers = fakeWorkers({ hold: true });
    useDeps({ workers });
    const { ctx } = openSample();
    const r1 = dispatch(ctx, "tts.speak", ["Same first part.", OPTS, "", "r1"]);
    await until(() => workers.procs[0]?.jobs.length === 1, "job sent");
    expect(await dispatch(ctx, "tts.cancel", ["r1"])).toBe(true);
    const r2 = dispatch(ctx, "tts.speak", ["Same first part.", OPTS, "", "r2"]) as Promise<{ engine: string }>;
    await expect(r1).rejects.toThrow("Reading aloud was stopped.");
    const p = workers.procs[0]!;
    await until(() => p.jobs.length === 1, "first answer");
    p.answer(p.jobs[0]!); // the dropped run finishes; its answer is ignored and its leftovers removed
    await until(() => p.jobs.length === 2, "r2 sent");
    expect(fs.existsSync(path.dirname(p.jobs[0]!.out))).toBe(false);
    p.answer(p.jobs[1]!);
    expect((await r2).engine).toBe("supertonic");
  });
  it("uses the Mac voice when asked, without starting the natural voice, and doesn't call it a fallback", async () => {
    const { one, w } = useDeps();
    const { ctx } = openSample();
    const r = await dispatch(ctx, "tts.speak", ["Hello there.", { ...OPTS, engine: "macos_say" }, "", "r1"]) as { engine: string; fellBack: boolean };
    expect(r).toMatchObject({ engine: "macos_say", fellBack: false });
    expect(arg(one.paragraphs()[0]!.args, "--engine")).toBe("macos_say");
    expect(w!.procs).toHaveLength(0);
    await expect(dispatch(ctx, "tts.speak", ["Hi", { ...OPTS, engine: "supertonic" }, "", "r2"])).rejects.toThrow(/engine/);
  });
  it("falls back to one paragraph at a time when the worker crashes", async () => {
    const workers = fakeWorkers({ hold: true });
    const { one } = useDeps({ workers });
    const { ctx } = openSample();
    const p = dispatch(ctx, "tts.speak", ["Paragraph.", OPTS, "", "r1"]) as Promise<{ url: string }>;
    await until(() => workers.procs[0]?.jobs.length === 1, "job sent");
    workers.procs[0]!.close();
    const r = await p;
    expect(r.url).toMatch(/^careeros-file:\/\/tts\//);
    expect(one.paragraphs()).toHaveLength(1);
  });
});

describe("only the person's own Stop stops read aloud", () => {
  it("a privacy event from a background job doesn't stop an ordinary Listen", async () => {
    const workers = fakeWorkers({ hold: true });
    useDeps({ workers });
    const { ctx } = openSample();
    installTtsHooks(ctx);
    const p = dispatch(ctx, "tts.speak", ["Job description paragraph.", OPTS, "", "r1"]) as Promise<{ engine: string }>;
    await until(() => workers.procs[0]?.jobs.length === 1, "job sent");
    ctx.emit("privacy"); // e.g. the watcher restoring Claude's privacy settings while a video renders
    workers.procs[0]!.answer(workers.procs[0]!.jobs[0]!);
    expect((await p).engine).toBe("supertonic");
  });
  it("a privacy change stops reading a lockable folder, saying why", async () => {
    const workers = fakeWorkers({ hold: true });
    useDeps({ workers });
    const { ctx, root } = openSample();
    installTtsHooks(ctx);
    fs.mkdirSync(path.join(root, "me", "employment"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "employment", "note.md"), "Fictional note.");
    const meta = JSON.parse(fs.readFileSync(path.join(root, "workspace.json"), "utf8"));
    meta.privacy.locked = [];
    fs.writeFileSync(path.join(root, "workspace.json"), JSON.stringify(meta));
    const p = dispatch(ctx, "tts.speak", ["Fictional note.", OPTS, "me/employment/note.md", "r1"]);
    await until(() => workers.procs[0]?.jobs.length === 1, "job sent");
    ctx.emit("privacy");
    await expect(p).rejects.toThrow(/privacy changed/);
  });
  it("closing the workspace (or quitting) stops the warm worker", async () => {
    const { w } = useDeps();
    const { ctx } = openSample();
    installTtsHooks(ctx);
    await dispatch(ctx, "tts.speak", ["Hello.", OPTS, "", "r1"]);
    const p = w!.procs[0]!;
    expect(p.closed).toBe(false);
    ctx.setRoot(null);
    expect(p.stdinEnded || p.signals.includes("SIGTERM")).toBe(true);
    await until(() => p.closed, "worker gone");
  });
});
