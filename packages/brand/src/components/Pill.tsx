import type { ReactNode } from "react";
import { cx } from "../cx";

export type PillTone = "success" | "accent" | "neutral" | "warning" | "danger";
export function Pill({ tone = "neutral", children, title }: { tone?: PillTone; children: ReactNode; title?: string }) {
  return <span className={cx("pill", `pill--${tone}`)} title={title ?? (typeof children === "string" ? children : undefined)}>{children}</span>;
}
