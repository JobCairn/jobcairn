import type { IconGlyph } from "../icons";
import { cx } from "../cx";

export interface IconProps { icon: IconGlyph; size?: "sm" | "md"; label?: string; className?: string }

/** Size comes from tokens via CSS (.icon--sm/.icon--md); every icon, brand or lucide, uses the brand stroke (1.75). */
export function Icon({ icon: Glyph, size = "md", label, className }: IconProps) {
  return (
    <Glyph
      className={cx("icon", `icon--${size}`, className)}
      strokeWidth={1.75}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}

/** Re-exported here too, so "the AI glyph from Icon.tsx" resolves for callers that look for it. */
export { AiMark } from "../icons";
