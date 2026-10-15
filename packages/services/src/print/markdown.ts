import { fromMarkdown } from "mdast-util-from-markdown";
import { reduceTree, type PrintDoc } from "./reduce.mjs";

export { MAX_EXPORT_BLOCKS, MAX_EXPORT_RUNS, printable, reduceTree, TooComplex, TooManyBlocks } from "./reduce.mjs";
export type { Block, PrintDoc, Run } from "./reduce.mjs";

/** Parses and reduces in this thread. The services use parseIsolated (isolate.ts), which does both in a worker with a deadline. */
export function parseMarkdown(md: string, title: string): PrintDoc {
  return reduceTree(fromMarkdown(md), title);
}
