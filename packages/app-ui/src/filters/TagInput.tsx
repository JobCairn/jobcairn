import { useState } from "react";
import { Button, Icon, Icons, Input } from "@careeros/brand";
import { PlaceInput } from "./PlaceInput";

/**
 * A short list of words edited in place: type, then Enter, a comma, Add or leaving the box adds it (any text, trimmed);
 * x removes one. `ordered` lists show their rank and move up and down (the first is the most preferred). `places`
 * offers the city list as you type, in the app's own suggestion list; it never limits what can be typed.
 */
export function TagInput({ label, values, onChange, places = false, ordered = false, placeholder, help, max = 20, item }: {
  label: string; values: readonly string[]; onChange(v: string[]): void; places?: boolean; ordered?: boolean;
  placeholder?: string; help?: string; max?: number;
  /** One item in words ("company"), when dropping a trailing "s" from the label doesn't give it. */
  item?: string;
}) {
  const [typed, setTyped] = useState("");
  const [said, setSaid] = useState("");
  const word = item ?? label.replace(/s$/, "").toLowerCase();
  const add = (text = typed) => {
    const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
    const next = [...values];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase()) && next.length < max) next.push(p);
    if (next.length !== values.length) { onChange(next); setSaid(`Added ${parts.join(", ")}.`); }
    setTyped("");
  };
  const move = (i: number, to: number) => {
    const next = [...values];
    const [x] = next.splice(i, 1);
    next.splice(to, 0, x!);
    onChange(next);
    setSaid(`${x} moved to position ${to + 1} of ${values.length}.`);
  };
  return (
    <div className="qf-tags">
      {values.length ? (
        <ol className={`qf-tags__list${ordered ? " qf-tags__list--ordered" : ""}`} aria-label={label}>
          {values.map((v, i) => (
            <li key={v} className="qf-tag">
              {ordered ? <span className="qf-tag__rank" aria-hidden="true">{i + 1}</span> : null}
              <span className="qf-tag__text">{v}</span>
              {ordered ? (
                <>
                  <button type="button" className="qf-tag__btn" aria-label={`Move ${v} up`} title="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}><Icon icon={Icons.moveUp} size="sm" /></button>
                  <button type="button" className="qf-tag__btn" aria-label={`Move ${v} down`} title="Move down" disabled={i === values.length - 1} onClick={() => move(i, i + 1)}><Icon icon={Icons.moveDown} size="sm" /></button>
                </>
              ) : null}
              <button type="button" className="qf-tag__btn" aria-label={`Remove ${v}`} title="Remove" onClick={() => { onChange(values.filter((x) => x !== v)); setSaid(`${v} removed.`); }}>
                <Icon icon={Icons.close} size="sm" />
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="qf-tags__add">
        {places ? (
          <PlaceInput label={`Add ${word}`} value={typed} placeholder={placeholder ?? `Add a ${word}`}
            onChange={(t) => (t.includes(",") ? add(t) : setTyped(t))} onAccept={(t) => add(t)} onBlur={() => add()} />
        ) : (
          <Input label={label} hideLabel value={typed} placeholder={placeholder ?? `Add a ${word}`} autoComplete="off" help={help} aria-label={`Add ${word}`}
            onChange={(e) => (e.target.value.includes(",") ? add(e.target.value) : setTyped(e.target.value))}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} onBlur={() => add()} />
        )}
        <Button size="sm" disabled={!typed.trim()} title={typed.trim() ? undefined : `Type a ${word} first.`} onMouseDown={(e) => e.preventDefault()} onClick={() => add()}>Add</Button>
      </div>
      <span className="sr-only" aria-live="polite">{said}</span>
    </div>
  );
}
