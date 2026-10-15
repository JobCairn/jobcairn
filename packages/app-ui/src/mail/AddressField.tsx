import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon, Icons, cx } from "@careeros/brand";

/** A plain-looking email address (the services check it properly when the draft is saved). */
const LOOKS_OK = /^(?:[^<>@,]*<\s*)?[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+\s*>?$/;

/** The addresses in a comma list. Names can't hold commas (core drafts.ts), so a plain split is exact. */
export function splitAddresses(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** "Acme Talent <talent@…>" shows as "Acme Talent"; the address itself is in the chip's tooltip and accessible name. */
function chipText(a: string): { label: string; full: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(a);
  return m && m[1] ? { label: m[1], full: `${m[1]} <${m[2]}>` } : { label: a, full: a };
}

/**
 * To and Cc as chips: each address is a chip with a remove button, and the text box takes the next one. Enter, comma
 * or Tab adds what was typed; Backspace in an empty box removes the last chip. The value stays the draft's comma list
 * (with any half-typed address on the end), so saving and checks work exactly as before.
 */
export function AddressField({ label, value, onChange, help, autoFocus }: {
  label: string; value: string; onChange: (v: string) => void; help?: string; autoFocus?: boolean;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState("");
  const all = splitAddresses(value);
  // The half-typed address is the list's last entry; it shows in the box, not as a chip.
  const chips = pending.trim() && all.at(-1) === pending.trim() ? all.slice(0, -1) : all;
  const emit = (list: string[], typed: string) => onChange([...list, typed.trim()].filter(Boolean).join(", "));
  const commit = () => {
    const parts = splitAddresses(pending);
    if (!parts.length) return;
    setPending("");
    emit([...chips, ...parts], "");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && pending.trim()) { e.preventDefault(); commit(); }
    else if (e.key === "Tab" && pending.trim()) commit();
    else if (e.key === "Backspace" && !pending && chips.length) { e.preventDefault(); emit(chips.slice(0, -1), ""); }
  };
  const remove = (i: number) => { emit(chips.filter((_, j) => j !== i), pending); inputRef.current?.focus(); };
  return (
    <div className="field addr-field">
      <label className="field__label" htmlFor={id}>{label}</label>
      <div className="addr-field__box" onClick={(e) => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}>
        {chips.map((a, i) => {
          const t = chipText(a);
          const bad = !LOOKS_OK.test(a);
          return (
            <span key={`${a}-${i}`} className={cx("addr-chip", bad && "addr-chip--bad")} title={bad ? `${t.full}: this doesn't look like an email address.` : t.full}>
              {bad ? <Icon icon={Icons.info} size="sm" /> : null}
              <span className="addr-chip__text">{t.label}</span>
              <button type="button" className="addr-chip__remove" aria-label={`Remove ${t.full}`} onClick={() => remove(i)}><Icon icon={Icons.close} size="sm" /></button>
            </span>
          );
        })}
        <input
          ref={inputRef} id={id} className="addr-field__input" value={pending} spellCheck={false} autoComplete="off" autoFocus={autoFocus}
          aria-describedby={help ? `${id}-help` : undefined}
          onChange={(e) => {
            const v = e.target.value;
            // A pasted list ("a@x, b@y") becomes chips at once, keeping anything after the last comma as typing.
            if (v.includes(",")) { const parts = v.split(","); const rest = parts.pop() ?? ""; setPending(rest); emit([...chips, ...parts.map((p) => p.trim()).filter(Boolean)], rest); return; }
            setPending(v); emit(chips, v);
          }}
          onKeyDown={onKey} onBlur={commit}
        />
      </div>
      {help ? <span id={`${id}-help`} className="field__help">{help}</span> : null}
    </div>
  );
}
