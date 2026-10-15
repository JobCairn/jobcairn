import { useId } from "react";
import { GLYPHS } from "../icons/glyphs";
import { MARK_COLORS, MARK_GLYPH } from "../icons/mark";

/** The brand mark (gradient soft square + rising step), the same drawing as assets/mark.svg. */
export function Mark({ size = 24, label }: { size?: number; label?: string }) {
  const id = `${useId().replace(/:/g, "")}-mark`;
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={MARK_COLORS.from} /><stop offset="0.5" stopColor={MARK_COLORS.mid} /><stop offset="1" stopColor={MARK_COLORS.to} />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="7.5" fill={`url(#${id})`} />
      <g fill="none" stroke={MARK_COLORS.ink} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        {GLYPHS[MARK_GLYPH].filter(([tag]) => tag !== "rect").map(([tag, attrs], i) =>
          tag === "path" ? <path key={i} {...attrs} /> : tag === "circle" ? <circle key={i} {...attrs} fill={MARK_COLORS.ink} /> : null)}
      </g>
    </svg>
  );
}
