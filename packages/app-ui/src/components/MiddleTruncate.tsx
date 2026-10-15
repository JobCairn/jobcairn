import { cx } from "@careeros/brand";

/** How many characters always stay visible at the end: enough for "…-final-v2.pdf". */
const TAIL = 12;

/**
 * A one-line name that, when too long, is cut in the middle ("acme-corp-cover-le…final-v2.pdf"), so the end and the
 * extension stay readable. The full name is the tooltip. The text is the whole name exactly once (the ellipsis is
 * CSS), so a screen reader and copy-paste get the real name.
 */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  const chars = [...text];
  const cut = chars.length > TAIL * 2 ? chars.length - TAIL : chars.length;
  return (
    <span className={cx("mid-trunc", className)} title={text}>
      <span className="mid-trunc__head">{chars.slice(0, cut).join("")}</span>
      <span className="mid-trunc__tail">{chars.slice(cut).join("")}</span>
    </span>
  );
}
