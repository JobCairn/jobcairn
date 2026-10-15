import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "../cx";
import { Icon } from "./Icon";
import { Icons } from "../icons";
import { isDialogOpenGlobally } from "./Dialog";
import "../styles/table.css";

const FOCUSABLE = "input, select, textarea, button, [href], [tabindex]:not([tabindex='-1'])";
const TYPING = "input, select, textarea, [contenteditable='true']";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Step to the previous / next item. Omit both to hide the stepper. */
  onPrev?: () => void;
  onNext?: () => void;
  /** "3 of 12" style text next to the stepper. */
  position?: string;
  /** What one item is called, for the stepper labels: "Next employer". */
  itemLabel?: string;
  /** Where focus goes on close. Defaults to whatever had focus when the drawer opened. */
  returnFocus?: () => HTMLElement | null | undefined;
  /**
   * Which arrow keys step: Up/Down (default, lists of records) or Left/Right (documents, where Up and Down
   * scroll the text). The stepper buttons point the same way.
   */
  stepKeys?: "vertical" | "horizontal";
  /** "full" fills the window (minus a small margin); "wide" is a reading width. Default: the detail-sheet width. */
  size?: "default" | "wide" | "full";
  /** Controls in the top bar, before Close (a viewer's Copy, Open, Expand). */
  toolbar?: ReactNode;
  className?: string;
}

/**
 * A right-side detail sheet. Modal: focus is trapped while open and restored on close, Escape
 * closes it, and the arrow keys step through items when a stepper is shown. A Dialog opened on
 * top of it keeps the keyboard.
 */
export function Drawer({ open, onClose, title, subtitle, children, actions, onPrev, onNext, position, itemLabel = "item", returnFocus, stepKeys = "vertical", size = "default", toolbar, className }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const latest = useRef({ onClose, onPrev, onNext, returnFocus });
  latest.current = { onClose, onPrev, onNext, returnFocus };
  const stepper = !!(onPrev || onNext) || position !== undefined;
  const across = stepKeys === "horizontal";
  const keys = useRef(across);
  keys.current = across;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus();
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((x) => !x.hasAttribute("disabled"));
    const onKey = (e: KeyboardEvent) => {
      if (isDialogOpenGlobally()) return;
      if (e.key === "Escape") { e.stopPropagation(); latest.current.onClose(); return; }
      const typing = (e.target as HTMLElement | null)?.closest?.(TYPING);
      const [prevKey, nextKey] = keys.current ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      if (!typing && e.key === prevKey && latest.current.onPrev) { e.preventDefault(); latest.current.onPrev(); return; }
      if (!typing && e.key === nextKey && latest.current.onNext) { e.preventDefault(); latest.current.onNext(); return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0]!;
      const last = f[f.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      else if (!el?.contains(active)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const target = latest.current.returnFocus?.() ?? previous;
      target?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="drawer-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) latest.current.onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx("drawer", size !== "default" && `drawer--${size}`, className)} tabIndex={-1}>
        <header className="drawer__head">
          {stepper ? (
            <div className="drawer__stepper">
              <button type="button" className="drawer__icon-btn" aria-label={`Previous ${itemLabel}`} aria-keyshortcuts={across ? "ArrowLeft" : "ArrowUp"}
                disabled={!onPrev} title={onPrev ? `Previous ${itemLabel}` : `This is the first ${itemLabel}`} onClick={() => onPrev?.()}>
                <Icon icon={across ? Icons.stepPrev : Icons.collapse} size="sm" />
              </button>
              <button type="button" className="drawer__icon-btn" aria-label={`Next ${itemLabel}`} aria-keyshortcuts={across ? "ArrowRight" : "ArrowDown"}
                disabled={!onNext} title={onNext ? `Next ${itemLabel}` : `This is the last ${itemLabel}`} onClick={() => onNext?.()}>
                <Icon icon={across ? Icons.stepNext : Icons.expand} size="sm" />
              </button>
              {position ? <span className="drawer__position t-body-sm t-muted" aria-live="polite">{position}</span> : null}
            </div>
          ) : <span />}
          <div className="drawer__tools">
            {toolbar}
            <button type="button" className="drawer__icon-btn" aria-label="Close" title="Close (Esc)" aria-keyshortcuts="Escape" onClick={() => latest.current.onClose()}>
              <Icon icon={Icons.close} size="sm" />
            </button>
          </div>
        </header>
        <div className="drawer__title">
          <h2 id={titleId} className="t-heading-2">{title}</h2>
          {subtitle ? <div className="drawer__subtitle t-body-sm t-muted">{subtitle}</div> : null}
        </div>
        <div className="drawer__body">{children}</div>
        {actions ? <footer className="drawer__actions">{actions}</footer> : null}
      </div>
    </div>
  );
}

export interface DetailField { label: string; value: ReactNode; /** Lay the value out under the label, full width (long text, lists). */ wide?: boolean }

const isEmpty = (v: ReactNode) => v === null || v === undefined || v === false || (typeof v === "string" && !v.trim());

/** Label/value pairs. A missing value reads "Not recorded" so nothing is silently blank. */
export function DetailList({ fields, className }: { fields: DetailField[]; className?: string }) {
  return (
    <dl className={cx("details", className)}>
      {fields.map((f, i) => (
        <div key={`${f.label}-${i}`} className={cx("details__row", f.wide && "details__row--wide")}>
          <dt className="details__label t-body-sm t-muted">{f.label}</dt>
          <dd className="details__value t-body">{isEmpty(f.value) ? <span className="t-muted">Not recorded</span> : f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
