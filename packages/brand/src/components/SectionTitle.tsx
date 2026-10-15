import type { ReactNode } from "react";
import type { IconGlyph } from "../icons";
import { cx } from "../cx";

export interface SectionTitleProps {
  /** A brand icon (Icons.*) or a service mark (ServiceMarks.*), shown at 20px before the title. */
  icon: IconGlyph;
  title: ReactNode;
  /** Optional status on the right, usually a Pill ("Connected", "Not set"). */
  status?: ReactNode;
  /** One quiet line under the title. */
  sub?: ReactNode;
  /** Heading level; cards in a screen are h2 by default. */
  as?: "h2" | "h3";
  id?: string;
  className?: string;
}

/** The one header pattern for cards and sections: icon, title, optional status on the right. */
export function SectionTitle({ icon: Glyph, title, status, sub, as: Tag = "h2", id, className }: SectionTitleProps) {
  return (
    <div className={cx("section-title", className)}>
      <span className="section-title__icon" aria-hidden="true"><Glyph className="icon section-title__glyph" strokeWidth={1.75} focusable="false" /></span>
      <div className="section-title__text">
        <Tag id={id} className="t-heading-2 section-title__heading">{title}</Tag>
        {sub ? <p className="t-body-sm t-muted section-title__sub">{sub}</p> : null}
      </div>
      {status ? <span className="section-title__status">{status}</span> : null}
    </div>
  );
}
