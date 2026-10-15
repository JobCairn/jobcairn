import { plainPaths } from "@careeros/contract";

/**
 * GitHub-flavoured extras for the Markdown reader, as small remark plugins over the CommonMark tree react-markdown
 * already builds: tables, task lists and ~~strikethrough~~. No new dependency (remark-gfm isn't installed): a
 * table is a paragraph whose source lines have a header row and a delimiter row, re-read here into mdast table nodes,
 * which react-markdown's HTML step already knows how to render (as it does `delete` and checked list items).
 * Known limits: tables inside block quotes stay as text, and cells are split on every unescaped pipe.
 */
export interface MdNode {
  type: string; value?: string; url?: string; children?: MdNode[]; checked?: boolean | null;
  align?: (string | null)[]; position?: { start: { offset?: number }; end: { offset?: number } };
}
type Parse = (src: string) => MdNode;

const DELIM_CELL = /^\s*:?-+:?\s*$/;
const unescapedPipe = /(?<!\\)\|/;

/** The cells of one table row: outer pipes dropped, split on unescaped pipes, `\|` kept as a pipe. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(unescapedPipe).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function delimiter(line: string): (string | null)[] | null {
  if (!line.includes("-") || (!line.includes("|") && !/^\s*:?-+:?\s*$/.test(line))) return null;
  const cells = splitRow(line);
  if (!cells.length || !cells.every((c) => DELIM_CELL.test(c))) return null;
  return cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
}

/** Inline content of one cell: the parsed paragraph's children, or the text as is when it reads as a block. */
function cellChildren(text: string, parse: Parse): MdNode[] {
  if (!text) return [];
  const first = parse(text).children?.[0];
  return first?.type === "paragraph" ? first.children ?? [] : [{ type: "text", value: text }];
}

/** Splits a paragraph's source into before / table / after, or null when it holds no table. */
function findTable(src: string): { before: string; header: string; align: (string | null)[]; rows: string[]; after: string } | null {
  const lines = src.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i]!;
    if (!head.includes("|")) continue;
    const align = delimiter(lines[i + 1]!);
    if (!align || splitRow(head).length !== align.length) continue;
    let j = i + 2;
    while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim()) j++;
    return { before: lines.slice(0, i).join("\n"), header: head, align, rows: lines.slice(i + 2, j), after: lines.slice(j).join("\n") };
  }
  return null;
}

function tableNode(t: NonNullable<ReturnType<typeof findTable>>, parse: Parse): MdNode {
  const width = t.align.length;
  const row = (line: string): MdNode => {
    const cells = splitRow(line);
    return { type: "tableRow", children: Array.from({ length: width }, (_x, k) => ({ type: "tableCell", children: cellChildren(cells[k] ?? "", parse) })) };
  };
  return { type: "table", align: t.align, children: [row(t.header), ...t.rows.map(row)] };
}

/** Replaces table-shaped paragraphs under `node` with table nodes. `src` is the text the node's offsets point into. */
function tables(node: MdNode, src: string, parse: Parse): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type !== "paragraph") { tables(child, src, parse); return [child]; }
    const a = child.position?.start.offset, b = child.position?.end.offset;
    if (a === undefined || b === undefined) return [child];
    const raw = src.slice(a, b);
    // A paragraph inside a block quote carries "> " on its later lines: left as text (see the limits above).
    if (/\n\s*>/.test(raw)) return [child];
    const t = findTable(raw);
    if (!t) return [child];
    const out: MdNode[] = [];
    const more = (text: string) => {
      if (!text.trim()) return;
      const sub = parse(text);
      tables(sub, text, parse);
      out.push(...(sub.children ?? []));
    };
    more(t.before);
    out.push(tableNode(t, parse));
    more(t.after);
    return out;
  });
}

const TASK = /^\[([ xX])\][ \t]+/;
const STRIKE = /~~(?=\S)([^~\n]*?\S)~~/g;

/** Task list items ("- [ ] todo", "- [x] done") and ~~strikethrough~~, in place. Code is never touched. */
function inline(node: MdNode): void {
  if (node.type === "listItem") {
    const p = node.children?.[0];
    const t = p?.type === "paragraph" ? p.children?.[0] : undefined;
    const m = t?.type === "text" && t.value ? TASK.exec(t.value) : null;
    if (m && t) { node.checked = m[1] !== " "; t.value = t.value!.slice(m[0].length); }
  }
  if (!node.children) return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type !== "text" || !child.value || !child.value.includes("~~")) { inline(child); return [child]; }
    const out: MdNode[] = [];
    let last = 0;
    for (const m of child.value.matchAll(STRIKE)) {
      if (m.index! > last) out.push({ type: "text", value: child.value.slice(last, m.index) });
      out.push({ type: "delete", children: [{ type: "text", value: m[1] }] });
      last = m.index! + m[0].length;
    }
    if (!out.length) return [child];
    if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
    return out;
  });
}

/** remark plugin: GFM tables, task lists and strikethrough (see above). */
export function remarkGfmLite(this: unknown) {
  const proc = this as { parse: Parse };
  const parse: Parse = (s) => proc.parse(s);
  return (tree: MdNode, file: { toString(): string }) => {
    tables(tree, String(file), parse);
    inline(tree);
  };
}

/**
 * remark plugin for Claude's write-ups: workspace paths in text and inline code become plain names ("your resume",
 * "the job ad") and internal labels go, so a raw path is never shown. Links and code blocks are left alone.
 */
export function plainPathNodes(node: MdNode): void {
  if (node.type === "link" || node.type === "code") return;
  for (const child of node.children ?? []) {
    if (child.type === "text" && child.value) child.value = plainPaths(child.value);
    else if (child.type === "inlineCode" && child.value) {
      const plain = plainPaths(child.value);
      if (plain !== child.value) { child.type = "text"; child.value = plain; }
    } else plainPathNodes(child);
  }
}
export const remarkPlainPaths = () => (tree: MdNode) => { plainPathNodes(tree); };
