import fs from "node:fs";
import { createRequire } from "node:module";
import type { PrintFonts } from "./html.js";

// Not called `require`: the Electron bundle's banner already defines that name.
const nodeRequire = createRequire(import.meta.url);
let cached: PrintFonts | null = null;

const extra: { serif?: string; bold?: string; text?: PrintFonts["text"] } = {};
const file = (spec: string) => fs.readFileSync(nodeRequire.resolve(spec)).toString("base64");

/**
 * Geist 400, 600 and 400 italic (latin) from the pinned @fontsource/geist package, as base64 for data: URLs. A
 * resume style with serif headings or a serif name also gets Instrument Serif 400; "bold" headings get Geist 700;
 * serif text gets Source Serif 4 400, 600 and 400 italic. All pinned, OFL, already in brand.
 */
export function loadPrintFonts(font?: string): PrintFonts {
  if (!cached) {
    const read = (weight: number, style = "normal") => file(`@fontsource/geist/files/geist-latin-${weight}-${style}.woff2`);
    cached = { regular: read(400), semibold: read(600), italic: read(400, "italic") };
  }
  const out: PrintFonts = { ...cached };
  if (font === "serif" || font === "serif-name" || font === "serif-text") out.serif = (extra.serif ??= file("@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2"));
  if (font === "serif-text") {
    const read = (weight: number, style = "normal") => file(`@fontsource/source-serif-4/files/source-serif-4-latin-${weight}-${style}.woff2`);
    out.text = (extra.text ??= { regular: read(400), semibold: read(600), italic: read(400, "italic") });
  }
  if (font === "bold") out.bold = (extra.bold ??= file("@fontsource/geist/files/geist-latin-700-normal.woff2"));
  return out;
}
