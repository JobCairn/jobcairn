import { core } from "@careeros/brand/tokens";
import { resumeTheme, themeColor, type ResumeStyle, type ResumeTheme, type ThemeColor } from "@careeros/contract";
import type { Block, PrintDoc, Run } from "./markdown.js";

/**
 * Base64 woff2 files, embedded so the PDF carries its own fonts and nothing is fetched. `serif` (Instrument Serif),
 * `bold` (Geist 700) and `text` (Source Serif 4 400, 600 and 400 italic) are only loaded for a resume style that uses them.
 */
export interface PrintFonts { regular: string; semibold: string; italic?: string; bold?: string; serif?: string; text?: { regular: string; semibold: string; italic: string } }

/** The print page loads nothing: inline styles and embedded fonts only. No scripts, images or network. */
export const PRINT_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Every piece of text from the document goes through here, so none of it can become markup. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function runHtml(r: Run): string {
  let h = esc(r.text);
  if (r.italic) h = `<em>${h}</em>`;
  if (r.bold) h = `<strong>${h}</strong>`;
  return h;
}

function blockHtml(b: Block): string {
  switch (b.kind) {
    case "heading": return `<h${b.level}>${b.runs.map(runHtml).join("")}</h${b.level}>`;
    case "paragraph": return `<p>${b.runs.map(runHtml).join("")}</p>`;
    case "bullet": return `<p class="item lvl-${Math.max(0, Math.min(4, Math.trunc(b.level)))}">${b.marker ? `${esc(b.marker)} ` : ""}${b.runs.map(runHtml).join("")}</p>`;
    case "rule": return "<hr>";
  }
}

/** Sober print style: one column, black on white, the brand's interface font, standard heading sizes. */
export function printCss(fonts: PrintFonts | null): string {
  const face = (weight: number, b64: string) => {
    if (!B64.test(b64)) throw new Error("The print font isn't valid.");
    return `@font-face { font-family: "Geist"; font-style: normal; font-weight: ${weight}; src: url(data:font/woff2;base64,${b64}) format("woff2"); }`;
  };
  return [
    ...(fonts ? [face(400, fonts.regular), face(600, fonts.semibold)] : []),
    "@page { size: A4; }",
    `html { font-family: ${core["font-family-sans"]}; font-size: 10.5pt; line-height: 1.4; color: black; background: white; }`,
    "body { margin: 0; }",
    "h1 { font-size: 18pt; font-weight: 600; margin: 0 0 4pt; }",
    "h2 { font-size: 12pt; font-weight: 600; margin: 12pt 0 4pt; padding-bottom: 2pt; border-bottom: 0.75pt solid black; }",
    "h3 { font-size: 10.5pt; font-weight: 600; margin: 8pt 0 2pt; }",
    "h1, h2, h3 { break-after: avoid; }",
    "p { margin: 0 0 4pt; orphans: 2; widows: 2; }",
    ".item { margin-bottom: 2pt; padding-left: 10pt; text-indent: -10pt; }",
    ".lvl-1 { margin-left: 12pt; } .lvl-2 { margin-left: 24pt; } .lvl-3 { margin-left: 36pt; } .lvl-4 { margin-left: 48pt; }",
    "hr { border: 0; border-top: 0.75pt solid black; margin: 8pt 0; }",
    "strong { font-weight: 600; }",
  ].join("\n");
}

export const HEADING_FAMILY = { sans: `"Geist", sans-serif`, serif: `"Instrument Serif", Georgia, serif` } as const;
export const BODY_FAMILY = { sans: `"Geist", sans-serif`, "text-serif": `"Source Serif 4", Georgia, serif` } as const;
const B64_OK = (b64: string) => { if (!B64.test(b64)) throw new Error("The print font isn't valid."); return b64; };
/** @font-face rules for the fonts a style needs. Only base64 from the pinned packages; checked before use. */
export function fontFaces(fonts: PrintFonts | null): string[] {
  if (!fonts) return [];
  const face = (family: string, weight: number, b64: string, style = "normal") =>
    `@font-face { font-family: "${family}"; font-style: ${style}; font-weight: ${weight}; src: url(data:font/woff2;base64,${B64_OK(b64)}) format("woff2"); }`;
  return [
    face("Geist", 400, fonts.regular), face("Geist", 600, fonts.semibold),
    ...(fonts.italic ? [face("Geist", 400, fonts.italic, "italic")] : []),
    ...(fonts.bold ? [face("Geist", 700, fonts.bold)] : []),
    ...(fonts.serif ? [face("Instrument Serif", 400, fonts.serif)] : []),
    ...(fonts.text ? [face("Source Serif 4", 400, fonts.text.regular), face("Source Serif 4", 600, fonts.text.semibold), face("Source Serif 4", 400, fonts.text.italic, "italic")] : []),
  ];
}

/**
 * Print CSS for a resume style (resume.style.json). Every value comes from the fixed theme numbers and palette in
 * the contract, never from free text, so the style file can't add CSS. Still one column, black body text.
 */
export function styledCss(fonts: PrintFonts | null, style: ResumeStyle): string {
  const t: ResumeTheme = resumeTheme(style);
  const faces = fontFaces(fonts);
  const hf = HEADING_FAMILY[t.headingFont];
  const hw = t.headingWeight;
  const color = (c: ThemeColor) => (c === "text" ? "black" : themeColor(t, c));
  return [
    ...faces,
    `@page { size: ${t.page.css}; }`,
    `html { font-family: ${core["font-family-sans"]}; font-size: ${t.basePt}pt; line-height: ${t.lineHeight}; color: black; background: white; }`,
    "body { margin: 0; }",
    `h1 { font-family: ${HEADING_FAMILY[t.nameFont]}; font-size: ${t.namePt}pt; font-weight: ${t.nameFont === "serif" ? 400 : hw}; margin: 0 0 ${t.headingGapPt}pt; text-align: ${t.nameAlign}; color: ${color(t.nameColor)}; }`,
    `h1 + p { text-align: ${t.nameAlign}; }`,
    `h2 { font-family: ${hf}; font-size: ${t.h2Pt}pt; font-weight: ${hw}; margin: ${t.sectionGapPt}pt 0 ${t.headingGapPt}pt; color: ${color(t.headingColor)};${t.headingCase === "upper" ? " text-transform: uppercase; letter-spacing: 0.04em;" : ""}${t.rule === "below" ? ` padding-bottom: 2pt; border-bottom: 0.75pt solid ${t.accent};` : ""} }`,
    `h3 { font-family: ${hf}; font-size: ${t.h3Pt}pt; font-weight: ${hw}; margin: ${t.headingGapPt * 2}pt 0 ${t.itemGapPt}pt; }`,
    "h1, h2, h3 { break-after: avoid; }",
    `p { margin: 0 0 ${t.paraGapPt}pt; orphans: 2; widows: 2; }`,
    `.item { margin-bottom: ${t.itemGapPt}pt; padding-left: 10pt; text-indent: -10pt; }`,
    ".lvl-1 { margin-left: 12pt; } .lvl-2 { margin-left: 24pt; } .lvl-3 { margin-left: 36pt; } .lvl-4 { margin-left: 48pt; }",
    `hr { border: 0; border-top: 0.75pt solid ${t.accent}; margin: ${t.headingGapPt * 2}pt 0; }`,
    "strong { font-weight: 600; }",
  ].join("\n");
}

/** With a resume style the page follows it (layout, fonts, accent, density, page size); without one it is unchanged. */
export function renderHtml(doc: PrintDoc, fonts: PrintFonts | null, style?: ResumeStyle): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`,
    `<title>${esc(doc.title)}</title>`,
    `<style>\n${style ? styledCss(fonts, style) : printCss(fonts)}\n</style>`,
    "</head>",
    "<body>",
    ...doc.blocks.map(blockHtml),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
