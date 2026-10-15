import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { IconGlyph } from "../icons";
import { cx } from "../cx";
import { Icon } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant; size?: "sm" | "md"; loading?: boolean; icon?: IconGlyph; children?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", loading = false, icon, disabled, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("btn", `btn--${variant}`, size === "sm" && "btn--sm", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : icon ? <Icon icon={icon} size="sm" /> : null}
      {children}
    </button>
  );
}
