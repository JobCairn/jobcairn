import { core } from "../../dist/tokens";
import { GLYPHS, type GlyphName } from "./glyphs";

/**
 * The brand mark: the amber → sand → mint soft square with the rising step inside, drawn in ink.
 * One drawing feeds the sidebar mark, assets/mark.svg and the app icon (scripts/build-icons.ts).
 */
export const MARK_COLORS = { from: core["color-amber-400"], mid: core["color-sand-200"], to: core["color-jade-300"], ink: core["color-ink-900"] } as const;
/** The glyph drawn inside the mark (the closed-square candidate without its frame). */
export const MARK_GLYPH: GlyphName = "stepIn";

function glyphBody(name: GlyphName, color: string): string {
  // The mark is the frame, so the glyph's own outer square (its first rect) is dropped.
  return GLYPHS[name].filter(([tag]) => tag !== "rect")
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")} stroke="${color}"${tag === "circle" ? ` fill="${color}"` : ""}/>`).join("");
}

/** The mark on a `size` square, as SVG markup (no XML header). `id` keeps gradient ids unique on a page. */
export function markSvg(opts: { size?: number; id?: string; label?: string } = {}): string {
  const { size = 64, id = "mark", label } = opts;
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${a11y}>`
    + `<defs><linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${MARK_COLORS.from}"/><stop offset="0.5" stop-color="${MARK_COLORS.mid}"/><stop offset="1" stop-color="${MARK_COLORS.to}"/></linearGradient></defs>`
    + `<rect x="0" y="0" width="24" height="24" rx="7.5" fill="url(#${id}-g)"/>`
    + `<g fill="none" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${glyphBody(MARK_GLYPH, MARK_COLORS.ink)}</g></svg>`;
}

/**
 * The app icon on the macOS 1024 grid: an 824 px body (100 px margin, the Big Sur safe area) in
 * Graphite, with the mark centred inside it.
 */
export function appIconSvg(label: string): string {
  const inner = markSvg({ size: 560, id: "icon" }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="${label} app icon">`
    + `<rect x="100" y="100" width="824" height="824" rx="185" fill="${MARK_COLORS.ink}"/>`
    + `<g transform="translate(232 232) scale(${560 / 24})">${inner}</g></svg>`;
}
