import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

/** `tone: "danger"`: a destructive item (Delete), set apart at the end of the menu in the danger colour. */
export interface MoreItem { id: string; label: string; onSelect: () => void; tone?: "danger" }

/**
 * A small "⋯" button with a menu of low-priority actions. Arrow keys move through the items,
 * Escape closes it and puts focus back on the button, and a click anywhere else closes it.
 */
export function MoreMenu({ label = "More actions", items, size = "sm" }: { label?: string; items: MoreItem[]; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const first = wrap.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  if (!items.length) return null;
  const close = () => { setOpen(false); button.current?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); all[(at + 1) % all.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); all[all.length - 1]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="more-menu" ref={wrap} onKeyDown={open ? onKey : undefined}>
      <button ref={button} type="button" className={`btn btn--ghost${size === "sm" ? " btn--sm" : ""} more-menu__button`} aria-label={label} title={label}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true" className="more-menu__dots">⋯</span>
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label={label} className="more-menu__list">
          {items.map((it) => (
            <button key={it.id} type="button" role="menuitem" tabIndex={-1} className={`more-menu__item${it.tone === "danger" ? " more-menu__item--danger" : ""}`}
              onClick={() => { setOpen(false); it.onSelect(); }}>{it.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
