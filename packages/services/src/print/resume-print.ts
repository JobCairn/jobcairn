/**
 * A resume's PDF (as HTML for the printer) and Word file, drawn from the same layout tree as the studio's live
 * preview (contract resumeLayout + arrangeLayout), so entry lines, dates, roles, chip groups and columns match.
 * Text from the file only ever goes in escaped (HTML) or as text runs (Word). Every style value comes from the
 * contract's fixed theme numbers and palette, never from free text.
 */
import {
  AlignmentType, BorderStyle, Document, LevelFormat, Packer, Paragraph, ShadingType, Table, TableCell, TableLayoutType, TableRow, TabStopType, TextRun, WidthType,
  type IBorderOptions, type IParagraphOptions,
} from "docx";
import {
  arrangeLayout, columnWidths, headingBandTint, inlineRuns, RESUME_ON_ACCENT, resumeTheme, sideTint, themeColor,
  type LayoutItem, type LayoutSection, type ResumeLayoutDoc, type ResumeStyle, type ResumeTheme,
} from "@careeros/contract";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { BODY_FAMILY, fontFaces, HEADING_FAMILY, PRINT_CSP, type PrintFonts } from "./html.js";

/** At most this many nodes are printed; a real resume has a few hundred. */
export const MAX_RESUME_NODES = 5000;
export class ResumeTooLarge extends Error {}

export function countNodes(d: ResumeLayoutDoc): number {
  const item = (i: LayoutItem): number => {
    switch (i.t) {
      case "entry": return 1 + i.extra.length + i.bullets.length + i.roles.reduce((n, r) => n + 1 + r.bullets.length, 0);
      case "bullets": return 1 + i.bullets.length;
      case "items": return 1 + i.items.length;
      case "groups": return 1 + i.groups.length;
      case "fixed": return 1 + i.lines.length;
      default: return 1;
    }
  };
  return 3 + d.contact.length + d.intro.reduce((n, i) => n + item(i), 0) + d.sections.reduce((n, s) => n + 1 + s.items.reduce((k, i) => k + item(i), 0), 0);
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);
/** Inline Markdown as escaped HTML: bold and italic runs only. */
function runs(text: string): string {
  return inlineRuns(text).map((r) => {
    let h = esc(r.text);
    if (r.italic) h = `<em>${h}</em>`;
    if (r.bold) h = `<strong>${h}</strong>`;
    return h;
  }).join("");
}

/** Print CSS for a resume style. Mirrors the preview's stylesheet (app-ui resume.css, .rp-*). */
export function resumeCss(fonts: PrintFonts | null, style: ResumeStyle): string {
  const t = resumeTheme(style);
  const cols = columnWidths(style);
  const head = HEADING_FAMILY[t.headingFont];
  const nameW = t.nameFont === "serif" ? 400 : t.nameWeight;
  const hc = themeColor(t, t.headingColor);
  const indent = t.indentPt + (t.dates === "gutter" ? t.gutterPt : 0);
  const onBand = t.header === "band";
  return [
    ...fontFaces(fonts),
    `@page { size: ${t.page.css}; margin: ${t.page.marginIn}in; }`,
    // Fills (header band, heading bands, the side column) print even though the printer leaves backgrounds off.
    `html { font-family: ${BODY_FAMILY[t.bodyFont]}; font-size: ${t.basePt}pt; line-height: ${t.lineHeight}; color: black; background: white; print-color-adjust: exact; -webkit-print-color-adjust: exact; }`,
    "body { margin: 0; }",
    "p, ul, h1, h2 { margin: 0; }",
    `.name { font-family: ${HEADING_FAMILY[t.nameFont]}; font-size: ${t.namePt}pt; font-weight: ${nameW}; line-height: 1.1; text-align: ${t.nameAlign}; color: ${onBand ? RESUME_ON_ACCENT : themeColor(t, t.nameColor)}; }`,
    `.headline { font-size: ${t.headlinePt}pt; margin-top: ${t.headingGapPt}pt; text-align: ${t.nameAlign}; color: ${onBand ? RESUME_ON_ACCENT : themeColor(t, t.headlineColor)}; }`,
    `.contact { margin-top: ${t.headingGapPt}pt; font-size: ${t.metaPt}pt; text-align: ${t.nameAlign}; }`,
    ...(t.header === "band" ? [`.head { background: ${t.accent}; color: ${RESUME_ON_ACCENT}; padding: ${t.bandPadPt}pt; margin: 0 -${t.bandPadPt}pt; }`] : []),
    ...(t.header === "bar" ? [`.head { border-top: ${t.barPt}pt solid ${t.accent}; padding-top: 6pt; }`] : []),
    ...(t.header === "rule" ? [`.head { border-bottom: 0.75pt solid ${t.accent}; padding-bottom: 4pt; }`] : []),
    `.intro { margin-top: ${t.paraGapPt}pt; }`,
    `h2 { font-family: ${head}; font-size: ${t.h2Pt}pt; font-weight: ${t.headingWeight}; color: ${hc}; text-align: ${t.headingAlign}; margin: ${t.sectionGapPt}pt 0 ${t.headingGapPt}pt; break-after: avoid;${t.headingCase === "upper" ? " text-transform: uppercase; letter-spacing: 0.06em;" : ""}${t.rule === "below" ? ` padding-bottom: 2pt; border-bottom: 0.75pt solid ${t.accent};` : ""}${t.rule === "above" ? ` padding-top: 3pt; border-top: 1.5pt solid ${t.accent};` : ""}${t.band ? ` padding: 2pt 4pt; background: ${headingBandTint(t)}; border-left: 2pt solid ${t.accent};` : ""} }`,
    ...(indent ? [`.main > section > :not(h2), body > section > :not(h2) { margin-left: ${indent}pt; }`] : []),
    `.entry + .entry, .entry + .items, .items + .entry { margin-top: ${t.entryGapPt}pt; }`,
    ".keep { break-inside: avoid; }",
    `.line { display: flex; gap: 8pt; align-items: baseline; }`,
    `.line .title { flex: 1 1 auto; font-weight: 600; }`,
    `.line .dates { flex: 0 0 auto; white-space: nowrap; font-size: ${t.metaPt}pt; color: ${themeColor(t, t.datesColor)}; }`,
    `.line.gut { display: grid; grid-template-columns: ${t.gutterPt}pt minmax(0, 1fr); gap: 0; margin-left: -${t.gutterPt}pt; }`,
    // A date longer than the column wraps inside it instead of running into the title.
    ".line.gut .dates { white-space: normal; padding-right: 6pt; }",
    `.inline .line, .side .line { display: block; } :is(.inline, .side) .line .dates { margin-left: 4pt; } :is(.inline, .side) .line .dates::before { content: "· "; }`,
    `.sub, .extra { font-size: ${t.metaPt}pt;${t.subItalic ? " font-style: italic;" : ""} }`,
    `.line.subline { font-size: ${t.metaPt}pt; font-style: italic; } .line.subline .title { font-weight: 400; } .line.subline .place { flex: 0 0 auto; white-space: nowrap; }`,
    `.role { margin-top: ${t.paraGapPt}pt; } .role .title { font-weight: 600; }`,
    `ul { list-style: none; padding: 0; margin-top: ${t.itemGapPt}pt; }`,
    "ul.more { margin-top: 0; }",
    // No positioning on bullets: a positioned box is painted after the rest of the page, which would move every
    // bullet to the end of the PDF's text and split it from its job for applicant tracking systems.
    `li { padding-left: 11pt; margin-bottom: ${t.itemGapPt}pt; break-inside: avoid; }`,
    `li::before { content: "${t.bullet}"; display: inline-block; width: 10pt; margin-left: -10pt; }`,
    `.para { margin-bottom: ${t.paraGapPt}pt; break-inside: avoid; }`,
    `.item { margin-bottom: ${t.itemGapPt}pt; } .item .title { font-weight: 600; } .item .rest { font-weight: 400; }`,
    `.group { margin-bottom: ${t.itemGapPt}pt; break-inside: avoid; } .group strong { font-weight: 600; }`,
    `.group.grid { display: grid; grid-template-columns: ${t.groupLabelPt}pt minmax(0, 1fr); } .group.grid > :last-child { grid-column: 2; }`,
    ".side .group strong { display: block; }",
    `hr { border: 0; border-top: 0.75pt solid ${t.accent}; margin: ${t.headingGapPt}pt 0; }`,
    "strong { font-weight: 600; }",
    ...(t.columns === "right" ? [
      // The side column comes after the main column in the page's text (reading order) and is placed on the right.
      `.cols { display: grid; grid-template-columns: minmax(0, 1fr) ${cols.side}pt; column-gap: ${cols.gap}pt; align-items: stretch; }`,
      ".cols > .main { grid-column: 1; grid-row: 1; min-width: 0; } .cols > .side { grid-column: 2; grid-row: 1; min-width: 0; box-sizing: border-box; }",
      ...(t.side === "tint" ? [`.side { background: ${sideTint(t)}; padding: 0 ${t.sidePadPt}pt ${t.sidePadPt}pt; }`] : []),
      ...(t.side === "rule" ? [`.side { border-left: 0.75pt solid ${t.accent}; padding-left: ${t.sidePadPt}pt; }`] : []),
    ] : []),
  ].join("\n");
}

/** Where a run of content sits: the main column (with the template's indent, dates column and skill grid), the side column, or the intro. */
interface Ctx { gutter: boolean; place: boolean; side: boolean; grid: boolean; indent: boolean }
const contexts = (t: ResumeTheme): { main: Ctx; side: Ctx; intro: Ctx } => ({
  main: { gutter: t.dates === "gutter", place: t.placeRight, side: false, grid: t.groups === "grid", indent: true },
  side: { gutter: false, place: false, side: true, grid: false, indent: false },
  intro: { gutter: false, place: false, side: false, grid: false, indent: false },
});

function bulletsHtml(bs: { text: string }[], cls = ""): string {
  return bs.length ? `<ul${cls ? ` class="${cls}"` : ""}>${bs.map((b) => `<li>${runs(b.text)}</li>`).join("")}</ul>` : "";
}
/** An entry or item line. In a left dates column the dates come first, in the text too. */
const lineHtml = (titleHtml: string, dates: string, c: Ctx) => (c.gutter
  ? `<div class="line gut"><span class="dates">${esc(dates)}</span><span class="title">${titleHtml}</span></div>`
  : `<div class="line"><span class="title">${titleHtml}</span>${dates ? `<span class="dates">${esc(dates)}</span>` : ""}</div>`);

function itemHtml(i: LayoutItem, c: Ctx): string {
  switch (i.t) {
    case "para": return `<p class="para">${runs(i.text)}</p>`;
    case "rule": return "<hr>";
    case "fixed": return i.lines.map((l) => `<p class="para">${esc(l)}</p>`).join("");
    case "bullets": return bulletsHtml(i.bullets);
    case "groups": return i.groups.map((g) => (c.grid
      ? `<div class="group grid">${g.label ? `<strong>${runs(g.label)}</strong>` : ""}<span>${g.chips.map(runs).join(", ")}</span></div>`
      : c.side
        ? `<p class="group">${g.label ? `<strong>${runs(g.label)}</strong>` : ""}${g.chips.map(runs).join(", ")}</p>`
        : `<p class="group">${g.label ? `<strong>${runs(g.label)}:</strong> ` : ""}${g.chips.map(runs).join(", ")}</p>`)).join("");
    case "items": return `<div class="items">${i.items.map((x) => `<div class="item keep">${lineHtml(`${runs(x.main)}${x.sub ? `<span class="rest">, ${runs(x.sub)}</span>` : ""}`, x.dates, c)}</div>`).join("")}</div>`;
    case "entry": {
      const sub = c.place && i.place
        ? `<div class="line subline"><span class="title">${runs(i.subLead)}</span><span class="place">${runs(i.place)}</span></div>`
        : i.sub ? `<p class="sub">${runs(i.sub)}</p>` : "";
      const head = `${lineHtml(runs(i.title), i.dates, c)}${sub}${i.extra.map((x) => `<p class="extra">${runs(x)}</p>`).join("")}`;
      if (i.roles.length) {
        const roles = i.roles.map((r, k) => {
          const rh = `<div class="role">${lineHtml(runs(r.title), r.dates, c)}`;
          // The entry's head stays with its first role's first bullet.
          return k === 0
            ? `<div class="keep">${head}${rh}${bulletsHtml(r.bullets.slice(0, 1))}</div>${bulletsHtml(r.bullets.slice(1), "more")}</div>`
            : `<div class="keep">${rh}${bulletsHtml(r.bullets.slice(0, 1))}</div>${bulletsHtml(r.bullets.slice(1), "more")}</div>`;
        }).join("");
        return `<div class="entry">${roles}</div>`;
      }
      // An entry's head is never split from its first bullet.
      return `<div class="entry"><div class="keep">${head}${bulletsHtml(i.bullets.slice(0, 1))}</div>${bulletsHtml(i.bullets.slice(1), "more")}</div>`;
    }
  }
}

/** The page the printer turns into a PDF: real text, embedded fonts, nothing loaded. Header, main column, then side. */
export function resumeHtml(d: ResumeLayoutDoc, title: string, style: ResumeStyle, fonts: PrintFonts | null): string {
  if (countNodes(d) > MAX_RESUME_NODES) throw new ResumeTooLarge("too many nodes");
  const t = resumeTheme(style);
  const ctx = contexts(t);
  const { main, side } = arrangeLayout(d, style);
  const sections = (ss: LayoutSection[], c: Ctx) => ss.map((s) => `<section><h2>${runs(s.heading)}</h2>${s.items.map((x) => itemHtml(x, c)).join("")}</section>`).join("");
  const head = [
    d.name ? `<h1 class="name">${runs(d.name.text)}</h1>` : "",
    d.headline ? `<p class="headline">${runs(d.headline.text)}</p>` : "",
    d.contact.length ? `<p class="contact">${d.contact.map((c) => runs(c.text)).join(esc(t.contactSep))}</p>` : "",
  ].join("");
  const body = [
    head ? `<header class="head">${head}</header>` : "",
    d.intro.length ? `<div class="intro">${d.intro.map((x) => itemHtml(x, ctx.intro)).join("")}</div>` : "",
    side.length ? `<div class="cols"><div class="main">${sections(main, ctx.main)}</div><aside class="side">${sections(side, ctx.side)}</aside></div>` : sections(main, ctx.main),
  ].filter(Boolean);
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`,
    `<title>${esc(title)}</title>`,
    `<style>\n${resumeCss(fonts, style)}\n</style>`,
    "</head>", `<body class="${t.dates}">`, ...body, "</body>", "</html>", "",
  ].join("\n");
}

// ---- Word -------------------------------------------------------------------------------

// Word files can't carry our fonts portably, so the DOCX uses Arial (and Georgia for serif headings). Serif text
// names Source Serif 4 (free to install); where it is not installed, Word shows a substitute font.
const FONT = "Arial";
const SERIF = "Georgia";
const TEXT_SERIF = "Source Serif 4";
const TWIPS_PER_PT = 20;
const PAGE_TWIPS = { A4: { width: 11906, height: 16838 }, Letter: { width: 12240, height: 15840 } } as const;
const NONE: IBorderOptions = { style: BorderStyle.NONE, size: 0, color: "auto" };

type RunOpts = { bold?: boolean; italics?: boolean; size?: number; color?: string; font?: string; allCaps?: boolean };
const wordRuns = (text: string, extra: RunOpts = {}) =>
  inlineRuns(text).map((r) => new TextRun({ text: r.text, bold: r.bold || extra.bold, italics: r.italic || extra.italics, size: extra.size, color: extra.color, font: extra.font, allCaps: extra.allCaps }));

/**
 * A Word file with real headings, paragraphs and bullets, dates on tab stops. One-column templates have no tables,
 * images or text boxes. Two-column templates put the main column and the side column in the two cells of one
 * borderless table row (main first, so it is read first); the row may break across pages.
 */
export async function resumeDocx(d: ResumeLayoutDoc, title: string, style: ResumeStyle): Promise<Uint8Array> {
  if (countNodes(d) > MAX_RESUME_NODES) throw new ResumeTooLarge("too many nodes");
  const t = resumeTheme(style);
  const half = (pt: number) => Math.round(pt * 2);
  const tw = (pt: number) => Math.round(pt * TWIPS_PER_PT);
  const hex = (c: string) => c.slice(1).toUpperCase();
  const accent = hex(t.accent);
  const margin = Math.round(t.page.marginIn * 1440);
  const cols = columnWidths(style);
  const full = cols.main + cols.gap + cols.side;
  const { main, side } = arrangeLayout(d, style);
  const align = t.nameAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT;
  const meta = half(t.metaPt);
  const datesColor = hex(themeColor(t, t.datesColor));
  const ctx = contexts(t);

  /** Paragraphs for content in a column `widthPt` wide. */
  const column = (sections: LayoutSection[], intro: LayoutItem[], c: Ctx, widthPt: number): Paragraph[] => {
    const out: Paragraph[] = [];
    const right = tw(widthPt);
    const base = c.indent ? tw(t.indentPt + (c.gutter ? t.gutterPt : 0)) : 0;
    const p = (o: IParagraphOptions) => out.push(new Paragraph({ ...(base && !o.indent ? { indent: { left: base } } : {}), ...o }));
    const line = (titleRuns: TextRun[], dates: string, after = 0) => {
      if (c.gutter) {
        // Dates hang into the left column, then a tab to the text column.
        p({ keepNext: true, spacing: { after: tw(after) }, indent: { left: base, hanging: tw(t.gutterPt) }, tabStops: [{ type: TabStopType.LEFT, position: base }],
          children: [new TextRun({ text: dates, size: meta, color: datesColor }), new TextRun({ text: "\t" }), ...titleRuns] });
        return;
      }
      const inline = c.side || t.dates === "inline";
      p({
        keepNext: true, spacing: { after: tw(after) }, tabStops: inline ? [] : [{ type: TabStopType.RIGHT, position: right }],
        children: [...titleRuns, ...(dates ? [new TextRun({ text: inline ? ` · ${dates}` : `\t${dates}`, size: meta, color: datesColor })] : [])],
      });
    };
    const bullets = (bs: { text: string }[]) => bs.forEach((b) => p({
      numbering: { reference: "resume-bullets", level: 0 }, indent: { left: base + 280, hanging: 220 }, spacing: { after: tw(t.itemGapPt) }, children: wordRuns(b.text),
    }));
    const item = (i: LayoutItem) => {
      switch (i.t) {
        case "para": p({ children: wordRuns(i.text) }); return;
        case "rule": p({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 1 } }, children: [] }); return;
        case "fixed": i.lines.forEach((l) => p({ children: [new TextRun(l)] })); return;
        case "bullets": bullets(i.bullets); return;
        case "groups":
          i.groups.forEach((g) => {
            const chips = wordRuns(g.chips.join(", "));
            if (c.grid) {
              const at = base + tw(t.groupLabelPt);
              p({ spacing: { after: tw(t.itemGapPt) }, indent: { left: at, hanging: tw(t.groupLabelPt) }, tabStops: [{ type: TabStopType.LEFT, position: at }],
                children: [...(g.label ? wordRuns(g.label, { bold: true }) : []), new TextRun({ text: "\t" }), ...chips] });
            } else if (c.side) {
              if (g.label) p({ keepNext: true, spacing: { after: 0 }, children: wordRuns(g.label, { bold: true }) });
              p({ spacing: { after: tw(t.itemGapPt) }, children: chips });
            } else {
              p({ spacing: { after: tw(t.itemGapPt) }, children: [...(g.label ? [new TextRun({ text: `${g.label}: `, bold: true })] : []), ...chips] });
            }
          });
          return;
        case "items": i.items.forEach((x) => line([...wordRuns(x.main, { bold: true }), ...(x.sub ? [new TextRun({ text: ", " }), ...wordRuns(x.sub)] : [])], x.dates, t.itemGapPt)); return;
        case "entry":
          p({ spacing: { before: tw(t.entryGapPt / 2), after: 0 }, children: [] });
          line(wordRuns(i.title, { bold: true }), i.dates);
          if (c.place && i.place) {
            p({ keepNext: true, tabStops: [{ type: TabStopType.RIGHT, position: right }], children: [...wordRuns(i.subLead, { italics: true, size: meta }), new TextRun({ text: "\t" }), ...wordRuns(i.place, { italics: true, size: meta })] });
          } else if (i.sub) p({ keepNext: true, children: wordRuns(i.sub, { italics: t.subItalic, size: meta }) });
          i.extra.forEach((x) => p({ keepNext: true, children: wordRuns(x, { italics: t.subItalic, size: meta }) }));
          for (const r of i.roles) { line(wordRuns(r.title, { bold: true }), r.dates); bullets(r.bullets); }
          bullets(i.bullets);
      }
    };
    intro.forEach(item);
    for (const s of sections) {
      const hb: IParagraphOptions["border"] = t.rule === "below"
        ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 1 } }
        : t.rule === "above" ? { top: { style: BorderStyle.SINGLE, size: 12, color: accent, space: 3 } }
          : t.band ? { left: { style: BorderStyle.SINGLE, size: 16, color: accent, space: 4 } } : undefined;
      out.push(new Paragraph({
        keepNext: true, spacing: { before: tw(t.sectionGapPt), after: tw(t.headingGapPt) },
        alignment: t.headingAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT,
        ...(hb ? { border: hb } : {}),
        ...(t.band ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(headingBandTint(t)) } } : {}),
        // Capitals are a run property, so the heading's text stays as written for ATS.
        children: wordRuns(s.heading, { bold: t.headingFont !== "serif", size: half(t.h2Pt), color: hex(themeColor(t, t.headingColor)), font: t.headingFont === "serif" ? SERIF : FONT, allCaps: t.headingCase === "upper" }),
      }));
      s.items.forEach(item);
    }
    return out;
  };

  // Header: name, headline, contact. A band is shading plus same-colour borders, so Word draws one padded block.
  const onBand = t.header === "band";
  const pad = Math.min(31, Math.round(t.bandPadPt));
  const bandBorder = { style: BorderStyle.SINGLE, size: 4, color: accent, space: pad };
  const parts = [d.name ? "name" : "", d.headline ? "headline" : "", d.contact.length ? "contact" : ""].filter(Boolean);
  const frame = (part: string): IParagraphOptions => (onBand
    ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: accent }, border: { top: bandBorder, bottom: bandBorder, left: bandBorder, right: bandBorder } }
    : t.header === "bar" && part === parts[0] ? { border: { top: { style: BorderStyle.SINGLE, size: Math.round(t.barPt * 8), color: accent, space: 6 } } }
      : t.header === "rule" && part === parts.at(-1) ? { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 4 } } } : {});
  const headColor = (c: ResumeTheme["nameColor"]) => (onBand ? hex(RESUME_ON_ACCENT) : hex(themeColor(t, c)));
  const body: (Paragraph | Table)[] = [];
  if (d.name) body.push(new Paragraph({ alignment: align, spacing: { after: tw(t.headingGapPt) }, ...frame("name"), children: wordRuns(d.name.text, { bold: t.nameFont !== "serif" && t.nameWeight >= 600, size: half(t.namePt), color: headColor(t.nameColor), font: t.nameFont === "serif" ? SERIF : FONT }) }));
  if (d.headline) body.push(new Paragraph({ alignment: align, ...frame("headline"), children: wordRuns(d.headline.text, { size: half(t.headlinePt), color: headColor(t.headlineColor) }) }));
  if (d.contact.length) body.push(new Paragraph({ alignment: align, ...frame("contact"), children: [new TextRun({ text: d.contact.map((c) => c.text).join(t.contactSep), size: meta, ...(onBand ? { color: hex(RESUME_ON_ACCENT) } : {}) })] }));
  body.push(...column([], d.intro, ctx.intro, full));

  if (side.length) {
    const tinted = t.side === "tint";
    const ruled = t.side === "rule";
    const sideInner = cols.side - (tinted ? 2 * t.sidePadPt : ruled ? t.sidePadPt : 0);
    const cell = { top: NONE, bottom: NONE, left: NONE, right: NONE };
    body.push(new Table({
      layout: TableLayoutType.FIXED,
      width: { size: tw(full), type: WidthType.DXA },
      columnWidths: [tw(cols.main + cols.gap), tw(cols.side)],
      borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
      rows: [new TableRow({
        cantSplit: false,
        children: [
          new TableCell({ width: { size: tw(cols.main + cols.gap), type: WidthType.DXA }, borders: cell, margins: { left: 0, right: tw(cols.gap), top: 0, bottom: 0 }, children: column(main, [], ctx.main, cols.main) }),
          new TableCell({
            width: { size: tw(cols.side), type: WidthType.DXA },
            borders: ruled ? { ...cell, left: { style: BorderStyle.SINGLE, size: 6, color: accent } } : cell,
            ...(tinted ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(sideTint(t)) } } : {}),
            margins: { left: tw(tinted || ruled ? t.sidePadPt : 0), right: tw(tinted ? t.sidePadPt : 0), top: 0, bottom: tw(tinted ? t.sidePadPt : 0) },
            children: column(side, [], ctx.side, sideInner),
          }),
        ],
      })],
    }));
  } else body.push(...column(main, [], ctx.main, cols.main));

  const doc = new Document({
    creator: identity.name, lastModifiedBy: identity.name, title,
    numbering: { config: [{ reference: "resume-bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: t.bullet, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 280, hanging: 220 } } } }] }] },
    styles: { default: { document: { run: { font: t.bodyFont === "text-serif" ? TEXT_SERIF : FONT, size: half(t.basePt) }, paragraph: { spacing: { after: tw(t.paraGapPt), line: Math.round(t.lineHeight * 240) } } } } },
    sections: [{ properties: { page: { size: PAGE_TWIPS[t.page.css], margin: { top: margin, bottom: margin, left: margin, right: margin } } }, children: body }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
