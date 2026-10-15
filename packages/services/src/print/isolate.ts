import { Worker } from "node:worker_threads";
import { TooManyBlocks, type PrintDoc } from "./markdown.js";

export { TooManyBlocks } from "./markdown.js";

/** The parser's worst cases are slow (minutes for some 100 KB inputs), so parsing and reducing run in a worker with a deadline. */
export const PARSE_TIMEOUT_MS = 10_000;
/** Deeper trees are refused in the worker. */
export const MAX_TREE_DEPTH = 64;

/** The document took too long, used too much memory, nested too deeply or has too many runs: the person can simplify it. */
export class ParseTooComplex extends Error {}
/** The export worker itself failed (it couldn't load, or hit a bug): nothing the person wrote is at fault. */
export class ExportUnavailable extends Error {}

/** Next to this module in development and tests; next to dist/main.js in the app (copied by the build). */
const WORKER_URL = new URL("./parse-worker.mjs", import.meta.url);

type Reply = { ok: true; doc: PrintDoc } | { ok: false; reason: "complex" | "blocks" | "internal" };

/**
 * Parses and reduces Markdown in a worker thread: at most `timeoutMs`, a bounded heap and stack, a depth-checked tree
 * and the block and run caps. Only the finished, capped PrintDoc comes back to this thread.
 */
export function parseIsolated(md: string, title: string, opts: { timeoutMs?: number; workerUrl?: URL } = {}): Promise<PrintDoc> {
  const timeoutMs = opts.timeoutMs ?? PARSE_TIMEOUT_MS;
  return new Promise<PrintDoc>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(opts.workerUrl ?? WORKER_URL, {
        workerData: { md, title, maxDepth: MAX_TREE_DEPTH },
        resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 },
      });
    } catch {
      reject(new ExportUnavailable("worker"));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new ParseTooComplex("timeout"))), timeoutMs);
    worker.once("message", (r: Reply) => finish(() => {
      if (r.ok) resolve(r.doc);
      else reject(r.reason === "blocks" ? new TooManyBlocks() : r.reason === "complex" ? new ParseTooComplex(r.reason) : new ExportUnavailable(r.reason));
    }));
    worker.once("error", (e: Error & { code?: string }) => finish(() => {
      reject(e?.code === "ERR_WORKER_OUT_OF_MEMORY" ? new ParseTooComplex("memory") : new ExportUnavailable("worker"));
    }));
    worker.once("exit", () => finish(() => reject(new ExportUnavailable("exited"))));
  });
}
