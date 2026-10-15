/**
 * Resume Markdown <-> section model. Pure: shared by the renderer (the editor) and the services (export, plain text).
 *
 * Every node keeps the exact source lines it came from and the text it parsed them as. Serialising writes those
 * lines unchanged unless the node was edited, so an untouched file round-trips byte for byte; an edited node is
 * written in a canonical form. Blank lines before a node are kept as its `gap`. The file stays plain Markdown the
 * career skill and the plugin can read.
 */

export type SectionKind = "summary" | "experience" | "projects" | "education" | "skills" | "other";

export interface ResumeBullet {
  id: string;
  gap: string[];
  /** The item's text, continuation lines joined with a space. */
  text: string;
  /** "-", "*", "+", "1." or "1)". */
  marker: string;
  indent: string;
  /** Nested lists and loose paragraphs under the item, verbatim (not edited here). */
  children: string[];
  raw?: string[];
  src?: string;
}
export interface ResumeEntry {
  id: string; kind: "entry"; gap: string[];
  /** "### Title": a role, project or degree. */
  title: string; level: number;
  /** Lines right under the title (dates, place), verbatim. */
  meta: string[];
  bullets: ResumeBullet[];
  raw?: string; src?: string;
}
export interface ResumeList { id: string; kind: "list"; gap: string[]; bullets: ResumeBullet[] }
/** A paragraph or other lines kept as written. `fixed`: a code block, shown but not edited. */
export interface ResumeText { id: string; kind: "text"; gap: string[]; text: string; fixed?: boolean }
export type ResumeBlock = ResumeEntry | ResumeList | ResumeText;
export interface ResumeSection {
  id: string; gap: string[]; heading: string; level: number; kind: SectionKind; blocks: ResumeBlock[];
  raw?: string; src?: string;
}
export interface ResumeHeader {
  /** Lines before the name (front matter, comments), verbatim. */
  pre: string[];
  /** The "# Name" text, or null when the file has no top heading. */
  name: string | null;
  raw?: string; src?: string;
  blocks: ResumeBlock[];
}
export interface ResumeModel { eol: string; finalEol: boolean; header: ResumeHeader; sections: ResumeSection[]; tail: string[] }

let seq = 0;
/** A fresh id for a node added in the editor. Parsed nodes get "p<n>" ids, so the two never clash. */
export const newNodeId = (): string => `n${++seq}`;

const BLANK = /^\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;

const GLYPH_START = /^\s*[•●▪◦‣■□➢►]/;
const isBlank = (l: string) => BLANK.test(l);
const indentWidth = (l: string) => { let w = 0; for (const c of l) { if (c === " ") w++; else if (c === "\t") w += 4; else break; } return w; };

function heading(l: string): { level: number; text: string } | null {
  const m = ATX.exec(l);
  if (!m) return null;
  const text = (m[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "").trim();
  return { level: m[1]!.length, text };
}
function bullet(l: string): { indent: string; marker: string; text: string } | null {
  if (RULE.test(l)) return null;
  const m = BULLET.exec(l);
  if (!m || indentWidth(m[1]!) > 3) return null;
  return { indent: m[1]!, marker: m[2]!, text: (m[3] ?? "").trim() };
}

export function sectionKind(headingText: string): SectionKind {
  const h = headingText.toLowerCase();
  if (/summary|profile|about|objective/.test(h)) return "summary";
  if (/experience|employment|work history|career history/.test(h)) return "experience";
  if (/project/.test(h)) return "projects";
  if (/education|qualification|certification|training/.test(h)) return "education";
  if (/skill|technolog|tools|stack/.test(h)) return "skills";
  return "other";
}
/** How a hidden section is remembered in resume.style.json: its heading, lower case, spaces collapsed. */
export const sectionKey = (headingText: string): string => headingText.toLowerCase().replace(/\s+/g, " ").trim();

class Parser {
  private n = 0;
  constructor(private lines: string[]) {}
  id(): string { return `p${++this.n}`; }

  /** Index just past a code fence opened at i. */
  fenceEnd(i: number): number {
    const open = FENCE.exec(this.lines[i]!)![1]!;
    for (let j = i + 1; j < this.lines.length; j++) {
      const m = FENCE.exec(this.lines[j]!);
      if (m && m[1]![0] === open[0] && m[1]!.length >= open.length && this.lines[j]!.trim() === m[1]) return j + 1;
    }
    return this.lines.length;
  }

  bulletAt(i: number, end: number): { b: ResumeBullet; next: number } {
    const L = this.lines;
    const m = bullet(L[i]!)!;
    const cont: string[] = [];
    const children: string[] = [];
    let j = i + 1;
    let child = false;
    while (j < end) {
      const l = L[j]!;
      if (isBlank(l)) {
        let k = j;
        while (k < end && isBlank(L[k]!)) k++;
        if (k < end && indentWidth(L[k]!) >= 2 && !FENCE.test(L[k]!)) { children.push(...L.slice(j, k)); j = k; child = true; continue; }
        break;
      }
      // A line starting with a bullet glyph reads as its own item to people (and to Claude), not a continuation.
      if (heading(l) || FENCE.test(l) || RULE.test(l) || GLYPH_START.test(l)) break;
      const nb = bullet(l);
      if (nb && indentWidth(nb.indent) < 2) break;
      if (!child && !nb) { cont.push(l); j++; continue; }
      child = true;
      children.push(l);
      j++;
    }
    const text = [m.text, ...cont.map((c) => c.trim())].filter((t, k) => k === 0 || t).join(" ");
    return { b: { id: this.id(), gap: [], text, marker: m.marker, indent: m.indent, children, raw: L.slice(i, j), src: text }, next: j };
  }

  /** Bullets from i on; blank lines between two items become the later item's gap. */
  bullets(i: number, end: number): { bullets: ResumeBullet[]; next: number } {
    const out: ResumeBullet[] = [];
    let j = i;
    let gap: string[] = [];
    while (j < end) {
      const m = bullet(this.lines[j]!);
      if (!m || indentWidth(m.indent) >= 2) break;
      const r = this.bulletAt(j, end);
      r.b.gap = gap;
      out.push(r.b);
      j = r.next;
      let k = j;
      while (k < end && isBlank(this.lines[k]!)) k++;
      const after = k < end ? bullet(this.lines[k]!) : null;
      if (k > j && after && indentWidth(after.indent) < 2) { gap = this.lines.slice(j, k); j = k; } else { gap = []; if (!after || k > j) break; }
    }
    return { bullets: out, next: j };
  }

  /** Blocks in [i, end). Returns the blank lines left at the end (they belong to whatever follows). */
  blocks(i: number, end: number): { blocks: ResumeBlock[]; trail: string[] } {
    const L = this.lines;
    const out: ResumeBlock[] = [];
    let gap: string[] = [];
    let j = i;
    while (j < end) {
      const l = L[j]!;
      if (isBlank(l)) { gap.push(l); j++; continue; }
      if (FENCE.test(l)) {
        const k = Math.min(this.fenceEnd(j), end);
        out.push({ id: this.id(), kind: "text", gap, text: L.slice(j, k).join("\n"), fixed: true });
        gap = []; j = k; continue;
      }
      const h = heading(l);
      if (h && h.level === 3) {
        const title = h.text;
        let k = j + 1;
        const meta: string[] = [];
        while (k < end && !isBlank(L[k]!) && !heading(L[k]!) && !FENCE.test(L[k]!) && !bullet(L[k]!)) meta.push(L[k++]!);
        let b = k;
        while (b < end && isBlank(L[b]!)) b++;
        const first = b < end ? bullet(L[b]!) : null;
        let bullets: ResumeBullet[] = [];
        if (first && indentWidth(first.indent) < 2) {
          const r = this.bullets(b, end);
          bullets = r.bullets;
          if (bullets[0]) bullets[0].gap = L.slice(k, b);
          k = r.next;
        }
        out.push({ id: this.id(), kind: "entry", gap, title, level: h.level, meta, bullets, raw: l, src: title });
        gap = []; j = k; continue;
      }
      const bl = bullet(l);
      if (bl && indentWidth(bl.indent) < 2) {
        const r = this.bullets(j, end);
        out.push({ id: this.id(), kind: "list", gap, bullets: r.bullets });
        gap = []; j = r.next; continue;
      }
      // A paragraph: lines up to a blank, a heading, a fence or a list.
      let k = j + 1;
      while (k < end) {
        const x = L[k]!;
        const xb = bullet(x);
        if (isBlank(x) || heading(x) || FENCE.test(x) || (xb && indentWidth(xb.indent) < 2)) break;
        k++;
      }
      out.push({ id: this.id(), kind: "text", gap, text: L.slice(j, k).join("\n") });
      gap = []; j = k;
    }
    return { blocks: out, trail: gap };
  }

  /** Indexes of section headings (level 1 or 2 after the first H1, or level 2 anywhere), skipping code fences. */
  sectionStarts(): number[] {
    const L = this.lines;
    const out: number[] = [];
    let sawName = false;
    for (let i = 0; i < L.length; i++) {
      if (FENCE.test(L[i]!)) { i = this.fenceEnd(i) - 1; continue; }
      const h = heading(L[i]!);
      if (!h) continue;
      if (h.level === 2 || (h.level === 1 && (sawName || out.length))) out.push(i);
      else if (h.level === 1) sawName = true;
    }
    return out;
  }
}

export function parseResume(md: string): ResumeModel {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  let lines = md.split(/\r?\n/);
  const finalEol = md.length > 0 && lines.at(-1) === "";
  if (finalEol || md.length === 0) lines = lines.slice(0, -1);
  const p = new Parser(lines);
  const starts = p.sectionStarts();
  const zoneEnd = starts[0] ?? lines.length;

  // Header zone: everything before the first section.
  let h1 = -1;
  for (let i = 0; i < zoneEnd; i++) {
    if (FENCE.test(lines[i]!)) { i = p.fenceEnd(i) - 1; continue; }
    const h = heading(lines[i]!);
    if (h?.level === 1) { h1 = i; break; }
  }
  const header: ResumeHeader = { pre: [], name: null, blocks: [] };
  let carry: string[];
  if (h1 >= 0) {
    header.pre = lines.slice(0, h1);
    header.name = heading(lines[h1]!)!.text;
    header.raw = lines[h1]!;
    header.src = header.name;
    const r = p.blocks(h1 + 1, zoneEnd);
    header.blocks = r.blocks;
    carry = r.trail;
  } else {
    const r = p.blocks(0, zoneEnd);
    header.blocks = r.blocks;
    carry = r.trail;
  }

  const sections: ResumeSection[] = starts.map((s, k) => {
    const end = starts[k + 1] ?? lines.length;
    const h = heading(lines[s]!)!;
    const r = p.blocks(s + 1, end);
    const sec: ResumeSection = { id: p.id(), gap: carry, heading: h.text, level: h.level, kind: sectionKind(h.text), blocks: r.blocks, raw: lines[s]!, src: h.text };
    carry = r.trail;
    return sec;
  });
  return { eol, finalEol, header, sections, tail: carry };
}

// ---- serialising ----------------------------------------------------------------

function bulletLines(b: ResumeBullet): string[] {
  if (b.raw && b.src === b.text) return b.raw;
  return [`${b.indent}${b.marker}${b.text ? ` ${b.text}` : ""}`, ...b.children];
}
function blockLines(b: ResumeBlock): string[] {
  if (b.kind === "text") return b.text === "" ? [] : b.text.split("\n");
  const own = b.kind === "entry" ? [b.raw !== undefined && b.src === b.title ? b.raw : `${"#".repeat(b.level)} ${b.title}`, ...b.meta] : [];
  return [...own, ...b.bullets.flatMap((x) => [...x.gap, ...bulletLines(x)])];
}
const blocksLines = (bs: ResumeBlock[]) => bs.flatMap((b) => [...b.gap, ...blockLines(b)]);
function sectionLines(s: ResumeSection): string[] {
  const head = s.raw !== undefined && s.src === s.heading ? s.raw : `${"#".repeat(s.level)} ${s.heading}`;
  return [...s.gap, head, ...blocksLines(s.blocks)];
}

function joinLines(m: ResumeModel, lines: string[]): string {
  if (!lines.length) return m.finalEol ? m.eol : "";
  return lines.join(m.eol) + (m.finalEol ? m.eol : "");
}
function headerLines(h: ResumeHeader): string[] {
  const name = h.name === null ? [] : [h.raw !== undefined && h.src === h.name ? h.raw : `# ${h.name}`];
  return [...h.pre, ...name, ...blocksLines(h.blocks)];
}

export function serializeResume(m: ResumeModel): string {
  return joinLines(m, [...headerLines(m.header), ...m.sections.flatMap(sectionLines), ...m.tail]);
}

/** The Markdown without hidden sections (export and preview leave them out; the file keeps them). */
export function visibleMarkdown(m: ResumeModel, hidden: readonly string[]): string {
  const hide = new Set(hidden);
  return serializeResume({ ...m, sections: m.sections.filter((s) => !hide.has(sectionKey(s.heading))) });
}

// ---- edits (each returns a new model; the old one is untouched) ------------------

const clone = (m: ResumeModel): ResumeModel => structuredClone(m);

function allBlocks(m: ResumeModel): ResumeBlock[] { return [...m.header.blocks, ...m.sections.flatMap((s) => s.blocks)]; }
function bulletOwner(m: ResumeModel, bulletId: string): { list: ResumeBullet[]; i: number } | null {
  for (const b of allBlocks(m)) {
    if (b.kind === "text") continue;
    const i = b.bullets.findIndex((x) => x.id === bulletId);
    if (i >= 0) return { list: b.bullets, i };
  }
  return null;
}
/** Moves an item to `to`, keeping blank lines where they were (gaps stay with positions). */
function moveKeepingGaps<T extends { gap: string[] }>(list: T[], from: number, to: number): void {
  const gaps = list.map((x) => x.gap);
  const [x] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(to, list.length)), 0, x!);
  list.forEach((y, k) => { y.gap = gaps[k]!; });
}

export function moveSection(m: ResumeModel, sectionId: string, to: number): ResumeModel {
  const c = clone(m);
  const i = c.sections.findIndex((s) => s.id === sectionId);
  if (i < 0) return m;
  moveKeepingGaps(c.sections, i, to);
  return c;
}
export function moveBullet(m: ResumeModel, bulletId: string, to: number): ResumeModel {
  const c = clone(m);
  const o = bulletOwner(c, bulletId);
  if (!o) return m;
  moveKeepingGaps(o.list, o.i, to);
  return c;
}
export function setBulletText(m: ResumeModel, bulletId: string, text: string): ResumeModel {
  const c = clone(m);
  const o = bulletOwner(c, bulletId);
  if (!o) return m;
  o.list[o.i]!.text = text.replace(/\s*\n\s*/g, " ");
  return c;
}
export function addBullet(m: ResumeModel, blockId: string, text = "", after?: string): ResumeModel {
  const c = clone(m);
  const b = allBlocks(c).find((x) => x.id === blockId);
  if (!b || b.kind === "text") return m;
  const at = after ? b.bullets.findIndex((x) => x.id === after) + 1 : b.bullets.length;
  const like = b.bullets[at - 1] ?? b.bullets[0];
  const marker = like && /^\d/.test(like.marker) ? `${at + 1}${like.marker.slice(-1)}` : like?.marker ?? "-";
  const gap = b.bullets.length === 0 && b.kind === "entry" ? [""] : [];
  b.bullets.splice(at > 0 ? at : b.bullets.length, 0, { id: newNodeId(), gap, text, marker, indent: like?.indent ?? "", children: [] });
  return c;
}
export function removeBullet(m: ResumeModel, bulletId: string): ResumeModel {
  const c = clone(m);
  const o = bulletOwner(c, bulletId);
  if (!o) return m;
  const gaps = o.list.map((x) => x.gap);
  o.list.splice(o.i, 1);
  gaps.splice(o.i + 1 < gaps.length ? o.i + 1 : o.i, 1);
  o.list.forEach((y, k) => { y.gap = gaps[k]!; });
  return c;
}
export function setSectionHeading(m: ResumeModel, sectionId: string, headingText: string): ResumeModel {
  const c = clone(m);
  const s = c.sections.find((x) => x.id === sectionId);
  if (!s) return m;
  s.heading = headingText.replace(/\s*\n\s*/g, " ");
  return c;
}
export function setName(m: ResumeModel, name: string): ResumeModel {
  const c = clone(m);
  c.header.name = name.replace(/\s*\n\s*/g, " ");
  return c;
}
export function setEntry(m: ResumeModel, entryId: string, patch: { title?: string; meta?: string[] }): ResumeModel {
  const c = clone(m);
  const e = allBlocks(c).find((x) => x.id === entryId);
  if (!e || e.kind !== "entry") return m;
  if (patch.title !== undefined) e.title = patch.title.replace(/\s*\n\s*/g, " ");
  if (patch.meta !== undefined) e.meta = patch.meta.filter((l) => !isBlank(l));
  return c;
}
export function setText(m: ResumeModel, blockId: string, text: string): ResumeModel {
  const c = clone(m);
  const t = allBlocks(c).find((x) => x.id === blockId);
  if (!t || t.kind !== "text" || t.fixed) return m;
  // Blank lines would split the paragraph into new blocks on the next parse; keep one paragraph.
  t.text = text.split("\n").filter((l) => !isBlank(l)).join("\n");
  return c;
}
export function addSection(m: ResumeModel, headingText: string): ResumeModel {
  const c = clone(m);
  c.sections.push({ id: newNodeId(), gap: [""], heading: headingText, level: 2, kind: sectionKind(headingText), blocks: [{ id: newNodeId(), kind: "list", gap: [""], bullets: [] }] });
  return c;
}
export function addEntry(m: ResumeModel, sectionId: string, title: string): ResumeModel {
  const c = clone(m);
  const s = c.sections.find((x) => x.id === sectionId);
  if (!s) return m;
  s.blocks.push({ id: newNodeId(), kind: "entry", gap: [""], title, level: 3, meta: [], bullets: [] });
  return c;
}
export function removeBlock(m: ResumeModel, blockId: string): ResumeModel {
  const c = clone(m);
  for (const owner of [c.header, ...c.sections]) {
    const i = owner.blocks.findIndex((b) => b.id === blockId);
    if (i >= 0) { owner.blocks.splice(i, 1); return c; }
  }
  return m;
}
export function removeSection(m: ResumeModel, sectionId: string): ResumeModel {
  const c = clone(m);
  c.sections = c.sections.filter((s) => s.id !== sectionId);
  return c;
}

// ---- inline text ------------------------------------------------------------------

export interface InlineRun { text: string; bold?: boolean; italic?: boolean }

const LINK = /!?\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/g;
function linksToText(s: string): string {
  return s.replace(LINK, (_m, label: string, url: string) => (/^https:\/\//i.test(url) && url !== label ? `${label} (${url})` : label));
}

/** Text with Markdown marks removed: links become "label (https address)", other addresses are dropped. */
export function stripInline(s: string): string {
  return linksToText(s)
    .replace(/<[^>\n]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1$2")
    .replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1");
}

/** Bold and italic runs for the preview. Everything comes back as text; nothing is ever HTML. */
export function inlineRuns(s: string): InlineRun[] {
  const t = linksToText(s).replace(/<[^>\n]+>/g, "").replace(/`([^`]*)`/g, "$1");
  const out: InlineRun[] = [];
  const re = /(\*\*|__)(?=\S)(.*?\S)\1|(?<![\w*])\*(?=\S)([^*]*?\S)\*(?!\*)|(?<!\w)_(?=\S)([^_]*?\S)_(?!\w)/g;
  let last = 0;
  for (const m of t.matchAll(re)) {
    if (m.index! > last) out.push({ text: t.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ text: stripInline(m[2]), bold: true });
    else out.push({ text: m[3] ?? m[4] ?? "", italic: true });
    last = m.index! + m[0].length;
  }
  if (last < t.length) out.push({ text: t.slice(last) });
  return out.filter((r) => r.text !== "");
}

// ---- plain text ---------------------------------------------------------------------

const GLYPH_BULLET = /^\s*[•●▪◦‣■□➢►–—]\s*/;
const plainLine = (l: string) => stripInline(l.replace(GLYPH_BULLET, "- ")).replace(/[•●▪◦‣]/g, "-").replace(/[ \t]+$/, "");

/** ATS-safe text: headings in capitals, "- " for every bullet (no glyphs), no Markdown marks, hidden sections out. */
export function toPlainText(m: ResumeModel, hidden: readonly string[] = []): string {
  const hide = new Set(hidden);
  const out: string[] = [];
  const blank = () => { if (out.length && out.at(-1) !== "") out.push(""); };
  const blocks = (bs: ResumeBlock[]) => {
    bs.forEach((b, i) => {
      if (i === 0 || b.gap.length) blank();
      if (b.kind === "text") {
        for (const l of b.text.split("\n")) {
          if (b.fixed && FENCE.test(l)) continue;
          const h = heading(l);
          if (RULE.test(l)) continue;
          out.push(h ? stripInline(h.text) : b.fixed ? l : plainLine(l));
        }
        return;
      }
      if (b.kind === "entry") { out.push(stripInline(b.title)); for (const l of b.meta) out.push(plainLine(l)); }
      for (const x of b.bullets) {
        out.push(`- ${plainLine(x.text)}`);
        for (const c of x.children) {
          if (isBlank(c)) continue;
          const nb = bullet(c.trimStart());
          out.push(nb ? `  - ${plainLine(nb.text)}` : `  ${plainLine(c.trim())}`);
        }
      }
    });
  };
  if (m.header.name !== null) out.push(stripInline(m.header.name).toUpperCase());
  blocks(m.header.blocks);
  for (const s of m.sections) {
    if (hide.has(sectionKey(s.heading))) continue;
    blank();
    out.push(stripInline(s.heading).toUpperCase());
    blocks(s.blocks);
  }
  while (out.at(-1) === "") out.pop();
  return out.length ? `${out.join("\n")}\n` : "";
}
