import { cx } from "../cx";

export interface AvatarProps { name: string; size?: "sm" | "md"; label?: string }

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

/** Decorative by default (aria-hidden); pass `label` for an accessible name. Sized from tokens only. */
export function Avatar({ name, size = "md", label }: AvatarProps) {
  return (
    <span
      className={cx("avatar", `avatar--${size}`)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    >
      {initials(name)}
    </span>
  );
}
