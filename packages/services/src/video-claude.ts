import fs from "node:fs";
import path from "node:path";
import { CancelledError, desktopWriter, expectedFiles, buildWriterPrompt, isFixPass, VideoError, type ScriptWriter } from "@careeros/video";
import type { ClaudeRunView } from "@careeros/contract";
import { engineFor, VIDEO_TIMEOUT_MS } from "./claude/engine.js";
import { mcpToolId } from "./claude/mcp/tools.js";
import type { ServiceContext } from "./context.js";

/**
 * The tools a video script run gets in Claude Code (video Task 20 on Lane H's engine, `videoScriptPlan`): read the
 * workspace (locked folders denied), write only this video's files, load the plugin's skills (and read their
 * reference files), and ask for a locked folder. No web, no shell, no email, no other CareerOS tool.
 */
export const WRITER_TOOLS: string[] = ["Read", "Glob", "Grep", "Edit", "Write", "Skill", mcpToolId("request_access")];
/**
 * The writer's budget. Lane H's runner stops a video run after VIDEO_TIMEOUT_MS (45 minutes); the Claude Code flags
 * the engine is tested with have no turn or token cap, so these numbers are the target the prompt is sized for, not
 * a hard stop (Task 20 ruling).
 */
export const WRITER_BUDGET = { max_turns: 24, max_tokens: 400_000 };
const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** What the writer needs from a Claude run, so tests can use a pretend one. */
export interface RunPort {
  /** `folder` and `files` (Task 20 ruling, added to the brief's shape): the only files the run may write. */
  start(o: { title: string; prompt: string; folder: string; files: string[] }): string;
  view(id: string): { status: string; note: string } | undefined;
  cancel(id: string): void;
  pendingWrites(runId: string): { id: string; paths: string[] }[];
  approve(approvalId: string): Promise<void>;
  onAccess(cb: (runId: string, folder: string, state: string) => void): () => void;
}

const STATUS: Record<ClaudeRunView["status"], string> = { queued: "queued", running: "running", succeeded: "done", failed: "failed", cancelled: "cancelled" };

/**
 * Lane H's Claude Code engine as a RunPort. Claude Code writes the files itself, confined by the run's permission
 * rules to this video's files, so there is no approval card: `pendingWrites` lists every file the run's workspace
 * diff shows it changed, its own and (fix round 1) anything outside the video, so the writer's `writer_outside`
 * check sees what the engine saw; `approve` has nothing left to do. Access: the locked folders a live grant opened for the run
 * are reported as allowed, because the run could read them (a request made during the run only opens the folder
 * for the next run, since a run's permissions are fixed when it starts).
 */
export function claudeRunPort(ctx: ServiceContext): RunPort {
  const engine = engineFor(ctx);
  const listeners = new Set<(runId: string, folder: string, state: string) => void>();
  return {
    start: (o) => {
      const r = engine.startVideoScript(o);
      const open = r.open;
      if (open.length) queueMicrotask(() => { for (const l of [...listeners]) for (const f of open) l(r.view.id, f, "allowed"); });
      return r.view.id;
    },
    view: (id) => {
      const v = engine.get(id);
      return v ? { status: STATUS[v.status], note: v.error } : undefined;
    },
    cancel: (id) => { try { engine.cancel(id); } catch { /* already gone */ } },
    pendingWrites: (runId) => {
      const v = engine.get(runId);
      if (!v || (v.status !== "succeeded" && v.status !== "failed")) return [];
      const paths = [...v.files.map((f) => f.path), ...v.stray];
      return paths.length ? [{ id: runId, paths }] : [];
    },
    approve: async () => { /* Claude Code already saved them, inside the run's permission rules. */ },
    onAccess: (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** How long the writer waits for a run at most: the engine's own video timeout plus a margin (fix round 1, item 3). */
export const WRITER_WAIT_MS = VIDEO_TIMEOUT_MS + 5 * 60_000;

/** Modes 2 and 3: a Claude run writes this video's files, and only those count. */
export function claudeRunWriter(port: RunPort, o: { pollMs?: number; now?: () => Date; mode?: "api" | "cli"; waitMs?: number } = {}): ScriptWriter {
  const pollMs = o.pollMs ?? 500;
  const waitMs = o.waitMs ?? WRITER_WAIT_MS;
  const now = o.now ?? (() => new Date());
  return {
    mode: o.mode ?? "cli",
    async write(req) {
      if (req.signal.aborted) throw new CancelledError();
      const expected = expectedFiles(req.type).map((n) => `${req.folder}/${n}`);
      const prompt = [
        buildWriterPrompt(req, { interactive: false }),
        isFixPass(req.revision)
          ? `Edit only the files you change, using the full paths ${expected.join(", ")}. Nothing else can be written in this run.`
          : `Write each of them with the Write tool, using the full paths ${expected.join(", ")}. Nothing else can be written in this run.`,
        "",
      ].join("\n");
      const runId = port.start({ title: `Video script: ${req.type.label}`, prompt, folder: req.folder, files: expected });
      const locked = new Map<string, string>();
      const off = port.onAccess((run, folder, state) => { if (run === runId && state === "allowed" && !locked.has(folder)) locked.set(folder, now().toISOString()); });
      const onAbort = () => port.cancel(runId);
      req.signal.addEventListener("abort", onAbort, { once: true });
      const since = Date.now();
      const outside = () => {
        const wanted = new Set(expected);
        const foreign = port.pendingWrites(runId).flatMap((c) => c.paths).filter((p) => !wanted.has(p));
        if (foreign.length) {
          throw new VideoError("writer_outside", `Claude wrote files outside this video (${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? " and more" : ""}). The video stops here so you can check them.`);
        }
      };
      try {
        req.onStatus?.("Claude is writing the script.");
        for (;;) {
          if (req.signal.aborted) throw new CancelledError();
          const v = port.view(runId);
          if (!v) throw new VideoError("writer_failed", "The Claude run went missing. Start the video again.");
          if (TERMINAL.has(v.status)) {
            if (v.status === "cancelled") throw new CancelledError();
            if (v.status === "failed") {
              outside();
              throw new VideoError("writer_failed", v.note || "Claude could not write the script. Try again.");
            }
            break;
          }
          if (Date.now() - since > waitMs) {
            port.cancel(runId);
            throw new VideoError("writer_timeout", "Claude did not finish the script in time. Start the video again when you are ready.");
          }
          await sleep(pollMs, req.signal);
        }
        if (req.signal.aborted) throw new CancelledError();
        outside();
        const cards = port.pendingWrites(runId);
        const proposed = cards.flatMap((c) => c.paths);
        // A fix pass writes only what it changes: any of the files will do. Otherwise every file must be written.
        const missing = isFixPass(req.revision) ? (expected.some((p) => proposed.includes(p)) ? [] : expected) : expected.filter((p) => !proposed.includes(p));
        if (missing.length && isFixPass(req.revision)) throw new VideoError("writer_incomplete", "Claude didn't change any of the script's files.");
        if (missing.length) throw new VideoError("writer_incomplete", `Claude did not write ${missing.map((p) => path.basename(p)).join(", ")}. Ask Claude to revise, or start again.`);
        for (const c of cards) await port.approve(c.id);
        const unsaved = expected.filter((p) => { try { return !fs.lstatSync(path.join(req.root, p)).isFile(); } catch { return true; } });
        if (unsaved.length) throw new VideoError("writer_incomplete", `Claude's files didn't arrive: ${unsaved.map((p) => path.basename(p)).join(", ")}. Try again.`);
        return { lockedFacts: [...locked].map(([folder, granted_at]) => ({ folder, granted_at })) };
      } finally {
        off();
        req.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * The writer for how Claude is set up. Claude Code ready (Lane H's engine): a run in the app. Otherwise the Claude
 * Desktop hand-off (copy the request, open Claude). `mode` is the last known answer; `write` checks again.
 */
export function defaultWriter(ctx: ServiceContext): ScriptWriter {
  const desktop = desktopWriter({ copyText: (t) => ctx.host.shell.copyText(t), openClaudeDesktop: () => ctx.host.shell.openClaudeDesktop() });
  if (!ctx.host.claude) return desktop;
  const engine = engineFor(ctx);
  const run = claudeRunWriter(claudeRunPort(ctx), { mode: "cli" });
  return {
    get mode() { return engine.readyHint() === false ? "desktop" : "cli"; },
    async write(req) {
      // A readiness check that itself fails means "not ready": hand over to Claude Desktop (fix round 1, item 5).
      const s = await engine.state(false).catch(() => null);
      return (s?.ready ? run : desktop).write(req);
    },
  };
}
