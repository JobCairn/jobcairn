import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { resumeTheme, themeColor, type ResumeStyle, type ThemeColor } from "@careeros/contract";
import type { Block, PrintDoc, Run } from "./markdown.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

const HEADING = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
// Word files can't carry our fonts portably, so the DOCX uses Arial, which every ATS and Word install reads.
const FONT = "Arial";
const INDENT = 360; // twentieths of a point: a quarter inch per list level

// Text goes in only as text runs; the library escapes it into <w:t>. Nothing is ever passed as raw XML.
const runs = (rs: Run[]) => rs.map((r) => new TextRun({ text: r.text, bold: r.bold, italics: r.italic }));

function paragraph(b: Block): Paragraph {
  switch (b.kind) {
    case "heading": return new Paragraph({ heading: HEADING[b.level], children: runs(b.runs) });
    case "paragraph": return new Paragraph({ children: runs(b.runs) });
    case "bullet":
      return b.marker === "•"
        ? new Paragraph({ bullet: { level: b.level }, children: runs(b.runs) })
        : new Paragraph({ indent: { left: INDENT * (b.level + 1), hanging: b.marker ? INDENT : 0 }, children: runs(b.marker ? [{ text: `${b.marker} ` }, ...b.runs] : b.runs) });
    case "rule": return new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "auto", space: 1 } }, children: [] });
  }
}

/** Word can't carry our fonts portably, so heading fonts map to ones every Word install has. */
const HEADING_FONT = { sans: FONT, serif: "Georgia" } as const;
const TWIPS_PER_PT = 20;
const PAGE_TWIPS = { A4: { width: 11906, height: 16838 }, Letter: { width: 12240, height: 15840 } } as const;

/** The same file with a resume style: page size, sizes and spacing (density), accent, heading case, rule and font. */
function styledDocument(doc: PrintDoc, style: ResumeStyle): Document {
  const t = resumeTheme(style);
  const hf = HEADING_FONT[t.headingFont];
  const half = (pt: number) => Math.round(pt * 2);
  const tw = (pt: number) => Math.round(pt * TWIPS_PER_PT);
  const accent = t.accent.slice(1);
  const color = (c: ThemeColor) => (c === "text" ? "000000" : themeColor(t, c).slice(1));
  const caps = t.headingCase === "upper";
  const margin = Math.round(t.page.marginIn * 1440);
  const para = (b: Block, i: number): Paragraph => {
    if (b.kind === "heading" && b.level === 1) return new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: t.nameAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT, children: runs(b.runs) });
    if (b.kind === "paragraph" && i === 1 && doc.blocks[0]?.kind === "heading" && doc.blocks[0].level === 1 && t.nameAlign === "center") {
      return new Paragraph({ alignment: AlignmentType.CENTER, children: runs(b.runs) });
    }
    if (b.kind === "heading" && b.level === 2) {
      return new Paragraph({
        heading: HeadingLevel.HEADING_2, children: runs(b.runs),
        ...(t.rule === "below" ? { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 1 } } } : {}),
      });
    }
    if (b.kind === "rule") return new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 1 } }, children: [] });
    if (b.kind === "bullet" && b.marker === "•") return new Paragraph({ bullet: { level: b.level }, spacing: { after: tw(t.itemGapPt) }, children: runs(b.runs) });
    return paragraph(b);
  };
  return new Document({
    creator: identity.name, lastModifiedBy: identity.name, title: doc.title,
    styles: {
      default: {
        document: { run: { font: FONT, size: half(t.basePt) }, paragraph: { spacing: { after: tw(t.paraGapPt), line: Math.round(t.lineHeight * 240) } } },
        heading1: { run: { font: HEADING_FONT[t.nameFont], size: half(t.namePt), bold: t.nameFont !== "serif", color: color(t.nameColor) }, paragraph: { spacing: { after: tw(t.headingGapPt) } } },
        heading2: { run: { font: hf, size: half(t.h2Pt), bold: t.headingFont !== "serif", allCaps: caps, color: color(t.headingColor) }, paragraph: { spacing: { before: tw(t.sectionGapPt), after: tw(t.headingGapPt) } } },
        heading3: { run: { font: hf, size: half(t.h3Pt), bold: true }, paragraph: { spacing: { before: tw(t.headingGapPt * 2), after: tw(t.itemGapPt) } } },
      },
    },
    sections: [{ properties: { page: { size: PAGE_TWIPS[t.page.css], margin: { top: margin, bottom: margin, left: margin, right: margin } } }, children: doc.blocks.map(para) }],
  });
}

/**
 * A plain Word file: real headings, paragraphs and bullets; no tables, images, text boxes or columns. With a resume
 * style the page and type follow it; without one the file is unchanged.
 */
export async function renderDocx(doc: PrintDoc, style?: ResumeStyle): Promise<Uint8Array> {
  if (style) return new Uint8Array(await Packer.toBuffer(styledDocument(doc, style)));
  const file = new Document({
    creator: identity.name, lastModifiedBy: identity.name, title: doc.title,
    styles: {
      default: {
        document: { run: { font: FONT, size: 21 } },
        heading1: { run: { font: FONT, size: 32, bold: true } },
        heading2: { run: { font: FONT, size: 24, bold: true } },
        heading3: { run: { font: FONT, size: 21, bold: true } },
      },
    },
    sections: [{ properties: { page: { margin: { top: 1008, bottom: 1008, left: 1008, right: 1008 } } }, children: doc.blocks.map(paragraph) }],
  });
  return new Uint8Array(await Packer.toBuffer(file));
}
