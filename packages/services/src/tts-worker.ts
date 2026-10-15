// A warm narrator for read aloud: one long-lived `narrate.py --serve` process that keeps the Supertonic model
// loaded, so only the first Listen after a while pays for the model load. Jobs go in as JSON lines on stdin, one
// at a time; answers come back as JSON lines on stdout. The worker quits by itself after a few idle minutes, when
// its stdin closes (the app quit or crashed), or when it is stopped (workspace closed, app quitting).
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TtsEngine } from "@careeros/contract";
import { CHUNK_TAIL_S, killProcessTree, OFFLINE_ENV, TtsCancelled, type ChildLike } from "./tts-runner.js";

export interface WorkerChild extends ChildLike { stdin: NodeJS.WritableStream | null }
export type WorkerSpawnFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; detached: boolean; shell: false; stdio: ["pipe", "pipe", "pipe"] }) => WorkerChild;

export interface WorkerJob { text: string; voice: string; lang: string; out: string }
export interface WorkerResult { engine: TtsEngine; fellBack: boolean }
export type WorkerState = "starting" | "ready" | "stopped";

export interface WorkerOptions {
  python: string;
  script: string;
  env: NodeJS.ProcessEnv;
  spawn?: WorkerSpawnFn;
  killTree?: (child: ChildLike, signal: NodeJS.Signals) => void;
  /** Quit after this long with nothing to do. Default 5 minutes. */
  idleMs?: number;
  /** Give up if the model hasn't loaded by then. Default 90 s. */
  startMs?: number;
  /** One paragraph may take this long. Default 120 s. */
  jobMs?: number;
  graceMs?: number;
  /** Called once when the process has gone, whatever the reason. */
  onExit?: () => void;
}

interface Pending {
  id: string;
  job: WorkerJob;
  resolve: (r: WorkerResult) => void;
  reject: (e: Error) => void;
  /** The caller gave up on it (cancel): its answer is ignored when it comes. */
  dropped: boolean;
  cleanup: () => void;
}

export const WORKER_IDLE_MS = 5 * 60_000;

/** The same text rule as a one-shot run: one line, and never a leading "#" (narrate skips those lines). */
export const spokenLine = (text: string) => text.replace(/\s+/g, " ").replace(/^\s*#\s*/, "number ");

export class NarratorWorker {
  state: WorkerState = "starting";
  /** True once the "macOS voice while Supertonic warms up" fallback was used for this start. */
  warmFallbackUsed = false;
  /** What the worker said it speaks with once ready. */
  engine: TtsEngine | null = null;
  private child: WorkerChild | null = null;
  private queue: Pending[] = [];
  private running: Pending | null = null;
  private buf = "";
  private seq = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private jobTimer: ReturnType<typeof setTimeout> | undefined;
  private exited = false;
  private readonly onProcessExit = () => this.kill("SIGKILL");
  private readonly o: WorkerOptions;
  private readonly ready$: Promise<void>;
  private readyResolve!: () => void;

  constructor(o: WorkerOptions) {
    this.o = o;
    this.ready$ = new Promise((r) => { this.readyResolve = r; });
    const spawn = o.spawn ?? (nodeSpawn as unknown as WorkerSpawnFn);
    try {
      this.child = spawn(o.python, [o.script, "--serve", "--no-download"], { env: { ...o.env, ...OFFLINE_ENV }, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      this.finish(new Error("The natural voice couldn't start."));
      return;
    }
    process.once("exit", this.onProcessExit);
    this.child.stdout?.on("data", (d: Buffer | string) => this.onData(d.toString()));
    this.child.stderr?.on("data", () => { /* narrate's own notes; never shown */ });
    this.child.stdin?.on?.("error", () => { /* the process went away; close handles it */ });
    this.child.on("error", () => this.finish(new Error("The natural voice couldn't start.")));
    this.child.on("close", () => this.finish(new Error("The natural voice stopped unexpectedly.")));
    this.startTimer = setTimeout(() => this.stop(new Error("The natural voice took too long to start.")), o.startMs ?? 90_000);
    this.startTimer.unref?.();
  }

  /** Paragraphs waiting or being spoken. */
  get pending(): number { return this.queue.length + (this.running && !this.running.dropped ? 1 : 0); }
  get busy(): boolean { return !!this.running; }
  /** Resolves when the model is loaded (never rejects; check `state`). */
  whenReady(): Promise<void> { return this.ready$; }

  speak(job: WorkerJob, signal?: AbortSignal): Promise<WorkerResult> {
    if (this.state === "stopped") return Promise.reject(new Error("The natural voice isn't running."));
    if (signal?.aborted) return Promise.reject(signal.reason instanceof TtsCancelled ? signal.reason : new TtsCancelled());
    clearTimeout(this.idle);
    return new Promise<WorkerResult>((resolve, reject) => {
      const p: Pending = { id: `j${++this.seq}`, job, resolve, reject, dropped: false, cleanup: () => undefined };
      const onAbort = () => {
        const why = signal?.reason instanceof TtsCancelled ? signal.reason : new TtsCancelled();
        const i = this.queue.indexOf(p);
        if (i >= 0) this.queue.splice(i, 1); // never sent: just forget it
        else p.dropped = true; // being spoken: its answer is ignored, the worker stays warm
        p.cleanup();
        reject(why);
        this.scheduleIdle();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      p.cleanup = () => signal?.removeEventListener("abort", onAbort);
      this.queue.push(p);
      this.pump();
    });
  }

  /** Closes stdin (narrate exits by itself), then makes sure the process group is gone. */
  stop(why: Error = new TtsCancelled("The voice was stopped.")): void {
    if (this.state === "stopped" && this.exited) return;
    const child = this.child;
    this.finish(why);
    if (!child) return;
    try { child.stdin?.end(); } catch { /* already closed */ }
    this.kill("SIGTERM");
    const hard = setTimeout(() => this.kill("SIGKILL"), this.o.graceMs ?? 2000);
    hard.unref?.();
  }

  private kill(sig: NodeJS.Signals) {
    if (!this.child) return;
    try { (this.o.killTree ?? killProcessTree)(this.child, sig); } catch { /* gone */ }
  }

  private finish(why: Error) {
    const first = !this.exited;
    this.exited = true;
    this.state = "stopped";
    clearTimeout(this.idle);
    clearTimeout(this.startTimer);
    clearTimeout(this.jobTimer);
    process.removeListener("exit", this.onProcessExit);
    const all = [...(this.running ? [this.running] : []), ...this.queue];
    this.running = null;
    this.queue = [];
    for (const p of all) { p.cleanup(); if (!p.dropped) p.reject(why); }
    this.readyResolve();
    if (first) this.o.onExit?.();
  }

  private onData(chunk: string) {
    this.buf += chunk;
    if (this.buf.length > 1_000_000) this.buf = this.buf.slice(-100_000);
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string) {
    let m: { event?: string; engine?: string; id?: string; ok?: boolean; fell_back?: boolean };
    try { m = JSON.parse(line) as typeof m; } catch { return; }
    if (!m || typeof m !== "object") return;
    if (m.event === "ready") {
      if (this.state !== "starting") return;
      clearTimeout(this.startTimer);
      this.state = "ready";
      this.engine = m.engine === "supertonic" ? "supertonic" : "macos_say";
      this.readyResolve();
      this.pump();
      this.scheduleIdle();
      return;
    }
    const p = this.running;
    if (!p || m.id !== p.id) return;
    clearTimeout(this.jobTimer);
    this.running = null;
    p.cleanup();
    if (p.dropped) {
      // Nobody wants this audio any more, and its temp folder is already gone (narrate made it again): tidy up.
      try { fs.rmSync(p.job.out, { force: true }); fs.rmdirSync(path.dirname(p.job.out)); } catch { /* not ours to remove, or not empty */ }
    } else {
      if (m.ok) p.resolve({ engine: m.engine === "supertonic" ? "supertonic" : "macos_say", fellBack: !!m.fell_back || m.engine !== "supertonic" });
      else p.reject(new Error("The voice couldn't read this paragraph."));
    }
    this.pump();
    this.scheduleIdle();
  }

  private pump() {
    if (this.state !== "ready" || this.running || !this.queue.length || !this.child?.stdin) return;
    const p = this.queue.shift()!;
    this.running = p;
    const line = JSON.stringify({ id: p.id, op: "speak", text: spokenLine(p.job.text), out: p.job.out, voice: p.job.voice, lang: p.job.lang, lead: 0, gap: 0, tail: CHUNK_TAIL_S });
    try { this.child.stdin.write(`${line}\n`); } catch { this.stop(new Error("The natural voice stopped unexpectedly.")); return; }
    this.jobTimer = setTimeout(() => this.stop(new Error("The voice took too long on this paragraph, so it was stopped.")), this.o.jobMs ?? 120_000);
    this.jobTimer.unref?.();
  }

  private scheduleIdle() {
    clearTimeout(this.idle);
    if (this.state !== "ready" || this.running || this.queue.length) return;
    this.idle = setTimeout(() => this.stop(), this.o.idleMs ?? WORKER_IDLE_MS);
    this.idle.unref?.();
  }
}
