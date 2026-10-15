// Plain JavaScript on purpose: the export worker (parse-worker.mjs) runs this file directly in a worker thread,
// in development, in tests and next to the bundled main process. Types are in reduce.d.mts.

/** Headings, paragraphs, bullets and rules after parsing. A long resume has a few hundred. */
export const MAX_EXPORT_BLOCKS = 2000;
/** Styled text runs across the whole document. A long resume has a few hundred; Word and the PDF stay quick below this. */
export const MAX_EXPORT_RUNS = 5000;
const MAX_LIST_LEVEL = 4;
/** Deeper nesting (quotes in quotes, emphasis in emphasis) is dropped rather than followed. */
const MAX_DEPTH = 32;

/** The document has more inline runs than an export allows. */
export class TooComplex extends Error {
  constructor(message = "The document is too complex to export.") { super(message); this.name = "TooComplex"; }
}
/** The document has more blocks than an export allows. */
export class TooManyBlocks extends Error {
  constructor(message = "The document has too many blocks to export.") { super(message); this.name = "TooManyBlocks"; }
}

/**
 * Characters XML 1.0 can't carry (C0 controls other than tab and newlines, U+FFFE/U+FFFF, lone surrogates).
 * Removed from every run, so the Word file stays well-formed and the PDF says the same thing.
 */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** @param {string} s */
export const printable = (s) => s.replace(NOT_XML, "");

/**
 * @typedef {{ bold?: boolean; italic?: boolean }} Style
 * @typedef {{ parts: string[]; bold?: boolean; italic?: boolean }} Piece
 */

/**
 * Appends text in O(length): pieces with the same style collect their parts, and whitespace is collapsed once, in tidy.
 * @param {Piece[]} out @param {string} text @param {Style} style @param {string[] | null} label
 */
function push(out, text, style, label) {
  const t = printable(text);
  if (!t) return;
  if (label) label.push(t);
  const last = out.at(-1);
  if (last && !!last.bold === !!style.bold && !!last.italic === !!style.italic) { last.parts.push(t); return; }
  out.push({ parts: [t], ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}) });
}

/**
 * Joins each piece once, collapses whitespace, trims the ends and drops empty runs.
 * @param {Piece[]} pieces @returns {import("./reduce.d.mts").Run[]}
 */
function tidy(pieces) {
  const out = pieces.map(({ parts, ...style }) => ({ text: parts.join("").replace(/\s+/g, " "), ...style }));
  if (out[0]) out[0].text = out[0].text.trimStart();
  const last = out.at(-1);
  if (last) last.text = last.text.trimEnd();
  return out.filter((r) => r.text !== "");
}

/**
 * Reduces a CommonMark tree (no HTML rendering, no extensions) to four block kinds. Raw HTML (block and inline),
 * images and anything else are dropped and counted. Links become plain text; an https address is written out in
 * brackets, any other address (javascript:, file:, relative) is left out. Nothing is clickable or fetched.
 * Linear in the size of the tree. Throws TooManyBlocks above MAX_EXPORT_BLOCKS and TooComplex above MAX_EXPORT_RUNS.
 * @param {import("mdast").Root} tree @param {string} title @returns {import("./reduce.d.mts").PrintDoc}
 */
export function reduceTree(tree, title) {
  let dropped = 0;
  let runCount = 0;
  const drop = () => { dropped++; };
  /** @type {import("./reduce.d.mts").Block[]} */
  const blocks = [];
  /** @param {import("./reduce.d.mts").Block} b */
  const add = (b) => {
    if (b.kind !== "rule" && !b.runs.length) return;
    if (b.kind !== "rule") {
      runCount += b.runs.length;
      if (runCount > MAX_EXPORT_RUNS) throw new TooComplex();
    }
    if (blocks.length >= MAX_EXPORT_BLOCKS) throw new TooManyBlocks();
    blocks.push(b);
  };
  /** The link label being collected, if inside a link (CommonMark links don't nest). @type {string[] | null} */
  let label = null;

  /** @param {import("mdast").PhrasingContent[]} nodes @param {Style} style @param {Piece[]} out @param {number} depth */
  const inline = (nodes, style, out, depth) => {
    if (depth > MAX_DEPTH) { drop(); return out; }
    for (const n of nodes) {
      switch (n.type) {
        case "text": case "inlineCode": push(out, n.value, style, label); break;
        case "strong": inline(n.children, { ...style, bold: true }, out, depth + 1); break;
        case "emphasis": inline(n.children, { ...style, italic: true }, out, depth + 1); break;
        case "delete": case "linkReference": inline(n.children, style, out, depth + 1); break;
        case "link": {
          const outer = label;
          label = [];
          inline(n.children, style, out, depth + 1);
          const text = label.join("").replace(/\s+/g, " ").trim();
          label = outer;
          // Links become plain text: an https address is written out, nothing is clickable or fetched.
          if (/^https:\/\//i.test(n.url) && n.url !== text) push(out, ` (${n.url})`, style, label);
          break;
        }
        case "break": push(out, " ", style, label); break;
        default: drop(); // raw HTML, images, footnote references
      }
    }
    return out;
  };
  /** @param {import("mdast").PhrasingContent[]} nodes */
  const text = (nodes) => tidy(inline(nodes, {}, [], 0));

  /** @param {import("mdast").List} l @param {number} level @param {number} depth */
  const list = (l, level, depth) => {
    l.children.forEach((item, i) => {
      let marker = l.ordered ? `${(l.start ?? 1) + i}.` : "•";
      for (const c of item.children) {
        if (c.type === "paragraph") { add({ kind: "bullet", level, marker, runs: text(c.children) }); marker = ""; }
        else if (c.type === "list") list(c, Math.min(level + 1, MAX_LIST_LEVEL), depth + 1);
        else walk([c], level + 1, depth + 1);
      }
    });
  };

  /** @param {import("mdast").RootContent[]} nodes @param {number} level @param {number} depth */
  const walk = (nodes, level, depth) => {
    if (depth > MAX_DEPTH) { drop(); return; }
    for (const n of nodes) {
      switch (n.type) {
        case "heading": add({ kind: "heading", level: /** @type {1 | 2 | 3} */ (Math.min(n.depth, 3)), runs: text(n.children) }); break;
        case "paragraph": add({ kind: "paragraph", runs: text(n.children) }); break;
        case "blockquote": walk(n.children, level, depth + 1); break;
        case "list": list(n, level, depth + 1); break;
        case "code": for (const line of n.value.split("\n")) add({ kind: "paragraph", runs: tidy([{ parts: [printable(line)] }]) }); break;
        case "thematicBreak": add({ kind: "rule" }); break;
        default: drop(); // raw HTML blocks, definitions, anything else
      }
    }
  };

  walk(tree.children, 0, 0);
  return { title: printable(title), blocks, dropped };
}
