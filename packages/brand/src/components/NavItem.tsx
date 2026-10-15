import type { ReactNode } from "react";
import type { IconGlyph } from "../icons";
import { Badge } from "./Badge";
import { Icon } from "./Icon";

export interface NavItemProps {
  icon: IconGlyph; label: string; count?: number; current?: boolean; trailing?: ReactNode; onClick?: () => void;
  /** The collapsed rail's tooltip text; defaults to the label. */
  tip?: string;
}

export function NavItem({ icon, label, count, current, trailing, onClick, tip }: NavItemProps) {
  return (
    // No native title: it lingered and showed the wrong item's name. When the rail collapses to icons, CSS shows
    // `data-tip` beside the item instead (composites.css); the label stays in the accessibility tree.
    <button type="button" className="nav-item" aria-current={current ? "page" : undefined} onClick={onClick} data-tip={tip ?? label}>
      <span className="nav-item__icon"><Icon icon={icon} /></span>
      <span className="nav-item__label truncate">{label}</span>
      {count !== undefined && count > 0 ? <Badge>{count}</Badge> : null}
      {trailing ? <span className="nav-item__trailing">{trailing}</span> : null}
    </button>
  );
}
