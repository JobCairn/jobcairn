import { forwardRef, useId, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { suggestPlaces } from "@careeros/contract";

export interface PlaceInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "list"> {
  value: string;
  /** Every keystroke, and a picked suggestion. */
  onChange(v: string): void;
  /** Enter, with the text as typed (or the highlighted suggestion). The text is never required to be in the list. */
  onAccept?(v: string): void;
  /** Accessible name. */
  label: string;
  /** Extra places to offer first (for example the person's own places). */
  extra?: readonly string[];
}

/**
 * A place: free text, with suggestions from the city list as you type (the app's own list, not the browser's).
 * Any text is accepted as typed (a suburb, a region, "Anywhere in QLD", another country); suggestions only help.
 * Up and Down move through the suggestions, Enter takes the highlighted one (or the typed text), Escape closes them.
 */
export const PlaceInput = forwardRef<HTMLInputElement, PlaceInputProps>(function PlaceInput({ value, onChange, onAccept, label, extra, className, onKeyDown, onBlur, onFocus, ...rest }, ref) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const items = open && value.trim() ? suggestPlaces(value, 8, extra) : [];
  const shown = items.length > 0;
  const pick = (v: string) => { onChange(v); onAccept?.(v); setOpen(false); setActive(-1); };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && items.length) { e.preventDefault(); setOpen(true); setActive((a) => (a + 1) % items.length); }
    else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); setActive((a) => (a <= 0 ? items.length - 1 : a - 1)); }
    else if (e.key === "Enter") {
      if (shown && active >= 0) { e.preventDefault(); pick(items[active]!); }
      else if (onAccept) { e.preventDefault(); onAccept(value.trim()); setOpen(false); }
    } else if (e.key === "Escape" && shown) { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1); }
    onKeyDown?.(e);
  };
  return (
    <span className="place-input">
      <input ref={ref} {...rest} className={`input place-input__box${className ? ` ${className}` : ""}`} value={value} aria-label={label}
        role="combobox" aria-autocomplete="list" aria-expanded={shown} aria-controls={`${id}-list`} aria-activedescendant={shown && active >= 0 ? `${id}-${active}` : undefined}
        autoComplete="off" spellCheck={false}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={(e) => { setOpen(true); onFocus?.(e); }}
        onBlur={(e) => { setOpen(false); setActive(-1); onBlur?.(e); }}
        onKeyDown={key} />
      {shown ? (
        <ul className="place-input__list" id={`${id}-list`} role="listbox" aria-label={`Places like ${value.trim()}`}>
          {items.map((p, i) => (
            <li key={p} id={`${id}-${i}`} role="option" aria-selected={i === active} className="place-input__option"
              // mousedown, so the box keeps focus (no blur) while a suggestion is picked.
              onMouseDown={(e) => { e.preventDefault(); pick(p); }} onMouseEnter={() => setActive(i)}>{p}</li>
          ))}
        </ul>
      ) : null}
    </span>
  );
});
