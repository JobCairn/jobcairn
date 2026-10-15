import type { MdNode } from "./markdown-gfm";

/**
 * Callouts in guides: a block quote whose first words are a bold label becomes a styled box.
 * `> **Tip:** ...`, `> **Interview tip:** ...`, `> **Watch out:** ...`, `> **Note:** ...` and `> **TL;DR**` (the study
 * guide prompt asks for exactly these). GitHub's `> [!TIP]` style works too. Any other quote stays a plain quote.
 */
export const CALLOUTS = {
  tldr: "TL;DR",
  tip: "Tip",
  interview: "Interview tip",
  watch: "Watch out",
  note: "Note",
} as const;
export type CalloutKind = keyof typeof CALLOUTS;

const LABELS: Record<string, CalloutKind> = {
  "tl;dr": "tldr", tldr: "tldr", "in short": "tldr", summary: "tldr",
  tip: "tip", "interview tip": "interview", "watch out": "watch", warning: "watch", caution: "watch", pitfall: "watch",
  note: "note", important: "note",
};
const GITHUB: Record<string, CalloutKind> = { TIP: "tip", WARNING: "watch", CAUTION: "watch", NOTE: "note", IMPORTANT: "note" };

const textOf = (n: MdNode): string => n.value ?? (n.children ?? []).map(textOf).join("");

/** The callout kind a label names ("Tip:", "Interview tip", "TL;DR"), or null. */
export function calloutKind(label: string): CalloutKind | null {
  return LABELS[label.trim().replace(/[:.]\s*$/, "").toLowerCase()] ?? null;
}

/** Drops leading ": " and spaces from the first text node after the label; drops the paragraph if it is now empty. */
function trimLead(quote: MdNode, para: MdNode): void {
  const first = para.children?.[0];
  if (first?.type === "text" && first.value !== undefined) {
    first.value = first.value.replace(/^\s*[:.]?\s*/, "");
    if (!first.value) para.children!.shift();
  }
  if (first?.type === "break") para.children!.shift();
  if (!para.children?.length) quote.children = quote.children!.filter((c) => c !== para);
}

function mark(quote: MdNode): void {
  const para = quote.children?.[0];
  const head = para?.type === "paragraph" ? para.children?.[0] : undefined;
  if (!para || !head) return;
  let kind: CalloutKind | null = null;
  if (head.type === "strong") {
    kind = calloutKind(textOf(head));
    if (kind) para.children!.shift();
  } else if (head.type === "text" && head.value) {
    const m = /^\[!(\w+)\][ \t]*\n?/.exec(head.value);
    kind = m ? GITHUB[m[1]!.toUpperCase()] ?? null : null;
    if (m && kind) head.value = head.value.slice(m[0].length);
  }
  if (!kind) return;
  trimLead(quote, para);
  (quote as MdNode & { data?: unknown }).data = { hProperties: { "data-callout": kind } };
}

function walk(node: MdNode): void {
  if (node.type === "blockquote") mark(node);
  for (const c of node.children ?? []) walk(c);
}

/** remark plugin: marks callout block quotes with `data-callout` (rendered by Markdown's blockquote). */
export const remarkCallouts = () => (tree: MdNode) => { walk(tree); };

/** Section headings that get a small icon, by what the words say. First match wins; no match, no icon. */
export const SECTION_ICONS: [RegExp, string][] = [
  [/\bkey terms?\b|\bglossary\b|\bvocabulary\b/i, "keyTerms"],
  [/\binterview/i, "interview"],
  [/\bself[- ]check|\bcheck yourself|\bquiz\b|\bwhat you know\b/i, "checklist"],
  [/\bpractice\b|\bplan\b|\bthis week\b|\bexercise/i, "calendar"],
  [/\bmistakes?\b|\bpitfalls?\b|\bwatch out\b|\bgotchas?\b/i, "watchOut"],
  [/\bexamples?\b|\bworked\b|\bcode\b|\btry it\b/i, "example"],
  [/\bcompar|\bversus\b|\bvs\.?\b|\btrade-?offs?\b|\bwhen to use\b/i, "compare"],
  [/\bhow it works\b|\bflow\b|\barchitecture\b|\bpipeline\b|\blifecycle\b/i, "flow"],
  [/\bwhy\b|\bemployers?\b|\bmatters\b/i, "target"],
  [/\bcore\b|\bkey ideas?\b|\bconcepts?\b|\bbuilding blocks\b|\bfundamentals\b/i, "concepts"],
  [/\bwhat (it|they) (is|are)\b|\bwhat is\b|\boverview\b|\bbasics\b|\bintroduction\b/i, "guide"],
  [/\bsources\b|\breferences\b|\bfurther reading\b|\blearn more\b/i, "link"],
];

/** The icon name (a key of brand `Icons`) for a section heading, or null. */
export function sectionIcon(heading: string): string | null {
  return SECTION_ICONS.find(([re]) => re.test(heading))?.[1] ?? null;
}
