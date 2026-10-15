import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";

export interface CardProps extends HTMLAttributes<HTMLElement> { highlight?: boolean; as?: "section" | "div" | "article"; children?: ReactNode }
export function Card({ highlight, as: Tag = "section", className, children, ...rest }: CardProps) {
  return <Tag className={cx("card", highlight && "card--highlight", className)} {...rest}>{children}</Tag>;
}
