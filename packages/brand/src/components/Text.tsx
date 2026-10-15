import type { ElementType, HTMLAttributes, MouseEvent, ReactNode } from "react";
import { isTruncated } from "./table-prefs";
import { cx } from "../cx";

export type TextRole = "display" | "hero" | "heading-1" | "heading-2" | "body" | "body-sm" | "label" | "numeric";
const TAG: Record<TextRole, ElementType> = {
  display: "h1", hero: "span", "heading-1": "h1", "heading-2": "h2", body: "p", "body-sm": "p", label: "span", numeric: "span",
};

export interface TextProps extends HTMLAttributes<HTMLElement> {
  role?: TextRole; as?: ElementType; truncate?: boolean; muted?: boolean; children?: ReactNode;
}

/**
 * Typography by role, never by raw font. Truncated plain text shows its full value as a tooltip, but only when it is
 * actually cut off (checked on hover), so a short value never gets a tooltip covering the next row.
 */
export function Text({ role = "body", as, truncate, muted, className, title, children, onMouseEnter, ...rest }: TextProps) {
  const Tag = as ?? TAG[role];
  const plain = truncate && title === undefined && (typeof children === "string" || typeof children === "number") ? String(children) : undefined;
  const enter = plain === undefined ? onMouseEnter : (e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (isTruncated(el)) el.title = plain; else el.removeAttribute("title");
    onMouseEnter?.(e);
  };
  return (
    <Tag className={cx(`t-${role}`, truncate && "truncate", muted && "t-muted", className)} title={title} data-truncate={truncate || undefined} onMouseEnter={enter} {...rest}>
      {children}
    </Tag>
  );
}
