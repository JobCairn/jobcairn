/**
 * One resume line as the reader sees it, not as markdown: a heading, a bullet, a paragraph or a blank line, with
 * bold and italic runs. Used by the suggestion and version diffs, so they never show `**`, `#` or `*` markers.
 * Text only; nothing here is ever treated as HTML.
 */
export interface Run { text: string; bold?: boolean; italic?: boolean }
export interface LineView { kind: "h1" | "h2" | "h3" | "bullet" | "para" | "blank"; runs: Run[] }

const INLINE = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`)/g;

export function inlineRuns(text: string): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index) });
    if (m[2] ?? m[3]) out.push({ text: (m[2] ?? m[3])!, bold: true });
    else if (m[4] ?? m[5]) out.push({ text: (m[4] ?? m[5])!, italic: true });
    else out.push({ text: m[6]! });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

export function lineView(line: string): LineView {
  const t = line.trim();
  if (!t) return { kind: "blank", runs: [] };
  const h = /^(#{1,6})\s+(.*)$/.exec(t);
  if (h) return { kind: h[1]!.length === 1 ? "h1" : h[1]!.length === 2 ? "h2" : "h3", runs: inlineRuns(h[2]!) };
  const b = /^[-*+]\s+(.*)$/.exec(t);
  if (b) return { kind: "bullet", runs: inlineRuns(b[1]!) };
  return { kind: "para", runs: inlineRuns(t) };
}
