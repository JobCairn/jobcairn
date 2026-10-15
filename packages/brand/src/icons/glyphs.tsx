import { createElement, forwardRef, type ReactSVGElement, type SVGProps } from "react";

/**
 * The brand's own glyphs: a 24px grid, round caps and joins, `currentColor`, and the same stroke
 * as the lucide icons beside them (the Icon component sets it). Each glyph is plain SVG nodes, so
 * the guide, the app icon and the tests can read the same drawing.
 *
 * The family's idea is the mark (a soft square) and a rising step: the career moving up and out.
 */
export type GlyphNode = ["path", { d: string }] | ["rect", { x: number; y: number; width: number; height: number; rx: number }] | ["circle", { cx: number; cy: number; r: number }];
export type GlyphProps = SVGProps<SVGSVGElement> & { strokeWidth?: number | string };

export const GLYPHS = {
  /** AI action, default: the mark, opened at its top-right corner, with a step climbing out of it. */
  stepOut: [
    ["path", { d: "M12.5 3.5h-4a5 5 0 0 0-5 5v7a5 5 0 0 0 5 5h7a5 5 0 0 0 5-5v-4" }],
    ["path", { d: "M7.5 16.5h3v-3h3V11h2l5-7.5" }],
    ["path", { d: "M16.5 3.5h4v4" }],
  ],
  /** AI action, candidate B: a rising step inside the closed mark, ending in a point of light. */
  stepIn: [
    ["rect", { x: 3.5, y: 3.5, width: 17, height: 17, rx: 5 }],
    ["path", { d: "M7 17h3v-3h3v-3h2" }],
    ["circle", { cx: 17, cy: 7, r: 1.25 }],
  ],
  /** AI action, candidate C: a cursor drawing a path upward. */
  drawUp: [
    ["path", { d: "M3.5 20.5c3 0 4.5-1.2 5.5-3.5s2-4 4.5-4.5" }],
    ["path", { d: "m13.5 4.5 7 3-3 1.4-1.4 3-2.6-7.4Z" }],
  ],
  /** Drop box: a tray, with a file dropping into the mark-shaped well. */
  dropBox: [
    ["path", { d: "M3.5 13v2.5a5 5 0 0 0 5 5h7a5 5 0 0 0 5-5V13" }],
    ["path", { d: "M3.5 13h4.5l1.5 2.5h5l1.5-2.5h4.5" }],
    ["path", { d: "M12 3.5v7M9 7.5l3 3 3-3" }],
  ],
  /** Sponsors: a passport with the seal of an approved visa. */
  sponsor: [
    ["rect", { x: 5, y: 3, width: 14, height: 18, rx: 3 }],
    ["circle", { cx: 12, cy: 10, r: 3.5 }],
    ["path", { d: "M8.5 10h7" }],
    ["path", { d: "M8.5 17h7" }],
  ],
  /** Apply: a page leaving with its step. */
  apply: [
    ["path", { d: "M13 20.5H8a3.5 3.5 0 0 1-3.5-3.5V7A3.5 3.5 0 0 1 8 3.5h4.5l4 4V11" }],
    ["path", { d: "M8 10.5h4M8 14h3" }],
    ["path", { d: "M14.5 18.5h6M17.5 15.5l3 3-3 3" }],
  ],
  /** Learn: an open book whose right page carries a small rising step. */
  learn: [
    ["path", { d: "M12 6.5C10.2 5 7.5 4.5 3.5 4.5v13c4 0 6.7.5 8.5 2 1.8-1.5 4.5-2 8.5-2v-13c-4 0-6.7.5-8.5 2Z" }],
    ["path", { d: "M12 6.5v13" }],
    ["path", { d: "M14.5 14.5h2v-2h2" }],
  ],
} satisfies Record<string, GlyphNode[]>;
export type GlyphName = keyof typeof GLYPHS;

/** The glyph as an SVG string (for the guide, docs and generated assets). */
export function glyphSvg(name: GlyphName, opts: { size?: number; stroke?: number; color?: string } = {}): string {
  const { size = 24, stroke = 1.75, color = "currentColor" } = opts;
  const body = GLYPHS[name].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** A React component with the same props lucide icons take, so Icon renders both alike. */
export function makeGlyph(name: GlyphName) {
  const Glyph = forwardRef<SVGSVGElement, GlyphProps>(function Glyph({ strokeWidth = 1.75, ...rest }, ref) {
    return createElement(
      "svg",
      { ref, xmlns: "http://www.w3.org/2000/svg", width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", "data-glyph": name, ...rest },
      ...GLYPHS[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }) as ReactSVGElement),
    );
  });
  Glyph.displayName = `Glyph(${name})`;
  return Glyph;
}
