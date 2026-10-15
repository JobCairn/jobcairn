import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "../cx";

const FOCUSABLE = "input, select, textarea, button, [href], [tabindex]:not([tabindex='-1'])";

/**
 * Module-level stack of open Dialog instances, in open order. Only the topmost
 * instance handles Escape and the Tab focus trap; dialogs underneath it ignore
 * keydown entirely, so a stacked dialog (e.g. a confirm dialog opened from
 * within another dialog) doesn't fight its parent for the keyboard.
 * `isDialogOpenGlobally` lets other brand components (e.g. useCommandShortcut)
 * know a Dialog is currently open, anywhere.
 */
const dialogStack: number[] = [];
let dialogSeq = 0;

export function isDialogOpenGlobally(): boolean {
  return dialogStack.length > 0;
}

export interface DialogProps { open: boolean; onClose: () => void; title: string; hideTitle?: boolean; children: ReactNode; actions?: ReactNode }

export function Dialog({ open, onClose, title, hideTitle, children, actions }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const idRef = useRef<number | undefined>(undefined);
  if (idRef.current === undefined) idRef.current = ++dialogSeq;
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const id = idRef.current!;
    dialogStack.push(id);
    const isTop = () => dialogStack[dialogStack.length - 1] === id;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((x) => !x.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = dialogStack.indexOf(id);
      if (i !== -1) dialogStack.splice(i, 1);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="dialog">
        {/* Header and actions stay put; only the body scrolls, so Start or Save never falls below the fold (Carbon Modal). */}
        <div className="dialog__head"><h2 id={titleId} className={cx("t-heading-2", hideTitle && "sr-only")}>{title}</h2></div>
        <div className="dialog__body">{children}</div>
        {actions ? <div className="dialog__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
