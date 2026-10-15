import type { Root } from "mdast";

export interface Run { text: string; bold?: boolean; italic?: boolean }
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { kind: "paragraph"; runs: Run[] }
  | { kind: "bullet"; level: number; marker: string; runs: Run[] }
  | { kind: "rule" };
/** A resume or letter reduced to what an ATS reads well: headings, paragraphs, bullets and rules. */
export interface PrintDoc { title: string; blocks: Block[]; dropped: number }

export declare const MAX_EXPORT_BLOCKS: number;
export declare const MAX_EXPORT_RUNS: number;
export declare class TooComplex extends Error { constructor(message?: string) }
export declare class TooManyBlocks extends Error { constructor(message?: string) }
export declare function printable(s: string): string;
export declare function reduceTree(tree: Root, title: string): PrintDoc;
