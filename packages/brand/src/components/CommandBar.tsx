import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { cx } from "../cx";
import { Dialog, isDialogOpenGlobally } from "./Dialog";

export interface CommandItem { id: string; label: string; group: string; hint?: string; run: () => void }
export interface CommandBarProps { open: boolean; onClose: () => void; items: CommandItem[]; query: string; onQueryChange: (q: string) => void; placeholder?: string }

/**
 * Opens on Cmd/Ctrl+K, except while a Dialog is already open anywhere (the
 * CommandBar's own Dialog included): the brief has no toggle-closed behaviour
 * for Cmd/Ctrl+K, so if the CommandBar is already open the key press would
 * otherwise just redundantly call `onOpen` again, and if some other dialog
 * (e.g. a confirm) is on top, Cmd/Ctrl+K must not steal focus into a new
 * CommandBar instance from under it. Either way: ignore.
 */
export function useCommandShortcut(onOpen: () => void): void {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) return;
      if (isDialogOpenGlobally()) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}

export function CommandBar({ open, onClose, items, query, onQueryChange, placeholder = "Search jobs or run an action" }: CommandBarProps) {
  const [active, setActive] = useState(0);
  const listId = useId();
  useEffect(() => setActive(0), [query, items.length]);
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(active); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Command" hideTitle>
      <input
        role="combobox" aria-label="Command" aria-expanded={open} aria-controls={listId}
        aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
        className="input cmd-input" value={query} placeholder={placeholder}
        onChange={(e) => onQueryChange(e.target.value)} onKeyDown={onKey}
      />
      <ul role="listbox" id={listId} className="cmd-list" aria-label="Results">
        {items.map((it, i) => (
          <li
            key={it.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
            className={cx("cmd-item", i === active && "is-active")}
            onMouseEnter={() => setActive(i)} onClick={() => choose(i)}
          >
            <span className="t-label cmd-item__group">{it.group}</span>
            <span className="truncate" title={it.label}>{it.label}</span>
            {it.hint ? <span className="t-body-sm t-muted">{it.hint}</span> : null}
          </li>
        ))}
      </ul>
      {!items.length ? <p className="t-body-sm t-muted">No matches.</p> : null}
    </Dialog>
  );
}
