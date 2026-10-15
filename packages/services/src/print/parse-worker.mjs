// The export worker: parses Markdown and reduces it to a PrintDoc off the main thread, so a slow or huge document
// can only cost this thread (which isolate.ts stops at its deadline), never the app. Plain JavaScript, run directly.
import { parentPort, workerData } from "node:worker_threads";
import { fromMarkdown } from "mdast-util-from-markdown";
import { reduceTree, TooComplex, TooManyBlocks } from "./reduce.mjs";

/** True when the tree is deeper than `max`, checked without recursion. */
function tooDeep(tree, max) {
  const stack = [[tree, 0]];
  while (stack.length) {
    const [node, d] = stack.pop();
    if (d > max) return true;
    if (Array.isArray(node.children)) for (const c of node.children) stack.push([c, d + 1]);
  }
  return false;
}

let reply;
try {
  const tree = fromMarkdown(workerData.md);
  reply = tooDeep(tree, workerData.maxDepth) ? { ok: false, reason: "complex" } : { ok: true, doc: reduceTree(tree, workerData.title) };
} catch (e) {
  // Running out of stack or string length is the document's fault; anything else is ours, and says so.
  const reason = e instanceof TooManyBlocks ? "blocks" : e instanceof TooComplex || e instanceof RangeError ? "complex" : "internal";
  reply = { ok: false, reason };
}
parentPort.postMessage(reply);
