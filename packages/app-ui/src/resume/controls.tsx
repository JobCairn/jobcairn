import { forwardRef, useId, useState, type ButtonHTMLAttributes, type KeyboardEvent } from "react";
import { Icon, Icons, type IconGlyph } from "@careeros/brand";
import { formatDates, parseDates, type DateFormat, type DateRange, type YearMonth } from "@careeros/contract";

/**
 * An icon-only button with a visible tooltip on hover and keyboard focus (the label is also its accessible name).
 * Disabled buttons say why in the tooltip.
 */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconGlyph; label: string; tip?: string; tone?: "danger" | "accent" }>(
  function IconButton({ icon, label, tip, tone, className, disabled, ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={`rs-icon${tone ? ` rs-icon--${tone}` : ""}${className ? ` ${className}` : ""}`} aria-label={label} data-tip={tip ?? label}
        aria-disabled={disabled || undefined} disabled={disabled} {...rest}>
        <Icon icon={icon} size="sm" />
      </button>
    );
  },
);

/** Chips with a remove button each, and a box that adds one on Enter or a comma. Backspace in the empty box removes the last chip. */
export function ChipInput({ label, chips, onChange, placeholder, render, field }: {
  label: string; chips: string[]; onChange(next: string[]): void; placeholder?: string; render?(chip: string): string; field?: string;
}) {
  const [draft, setDraft] = useState("");
  const id = useId();
  const add = (raw: string) => {
    const parts = raw.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length) onChange([...chips, ...parts]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && draft.trim()) { e.preventDefault(); add(draft); }
    else if (e.key === "Backspace" && !draft && chips.length) { e.preventDefault(); onChange(chips.slice(0, -1)); }
  };
  return (
    <div className="field rs-chips-field" data-field={field}>
      <label htmlFor={id} className="field__label">{label}</label>
      <div className="rs-chips" onClick={(e) => { if (e.target === e.currentTarget) (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus(); }}>
        {chips.map((c, i) => (
          <span key={`${i}:${c}`} className="rs-chip">
            <span className="rs-chip__text" title={c}>{render ? render(c) : c}</span>
            <button type="button" className="rs-chip__x" aria-label={`Remove ${render ? render(c) : c}`} onClick={() => onChange(chips.filter((_x, k) => k !== i))}>
              <Icon icon={Icons.close} size="sm" />
            </button>
          </span>
        ))}
        <input id={id} className="rs-chips__input" value={draft} placeholder={chips.length ? "" : placeholder} onChange={(e) => {
          const v = e.target.value;
          if (v.includes(",")) add(v); else setDraft(v);
        }} onKeyDown={onKey} onBlur={() => { if (draft.trim()) add(draft); }} />
      </div>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR_MIN = 1960;

function MonthYear({ label, value, onChange, disabled, idBase }: { label: string; value: YearMonth | null; onChange(v: YearMonth | null): void; disabled?: boolean; idBase: string }) {
  const [year, setYear] = useState(value ? String(value.year) : "");
  const shown = value ? String(value.year) : year;
  return (
    <fieldset className="rs-my" disabled={disabled}>
      <legend className="field__label">{label}</legend>
      <span className="select-wrap">
        <select id={`${idBase}-m`} className="input select" aria-label={`${label} month`} value={value?.month ?? ""}
          onChange={(e) => onChange({ year: value?.year ?? Number(year || new Date().getFullYear()), month: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Month</option>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <span className="select-wrap__chevron" aria-hidden="true"><Icon icon={Icons.expand} size="sm" /></span>
      </span>
      <input id={`${idBase}-y`} className="input rs-my__year" aria-label={`${label} year`} inputMode="numeric" placeholder="Year" maxLength={4} value={shown}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 4);
          setYear(v);
          const n = Number(v);
          if (v.length === 4 && n >= YEAR_MIN && n <= 2100) onChange({ year: n, month: value?.month ?? null });
          else if (!v) onChange(null);
        }} />
    </fieldset>
  );
}

/**
 * Start and end month and year, with "Present". Dates are written back in the format the resume already uses.
 * Text that isn't a date ("Summer 2020") stays editable as text.
 */
export function DateRangeField({ label = "Dates", value, onChange, field }: { label?: string; value: string; onChange(next: string): void; field?: string }) {
  const id = useId();
  const parsed = value.trim() ? parseDates(value) : null;
  const [asText, setAsText] = useState(!!value.trim() && !parsed);
  const fmt: DateFormat | undefined = parsed?.format;
  const range: DateRange = parsed?.range ?? { start: null, end: null };
  if (asText) {
    return (
      <div className="field rs-dates" data-field={field}>
        <label htmlFor={id} className="field__label">{label}</label>
        <input id={id} className="input" value={value} onChange={(e) => { onChange(e.target.value); if (!e.target.value.trim() || parseDates(e.target.value)) setAsText(false); }} />
        <span className="field__help">Written as text. Clear it or type a date like Mar 2022 to use the pickers.</span>
      </div>
    );
  }
  const set = (r: DateRange) => onChange(r.start ? formatDates(r, fmt) : "");
  const present = range.end === "present";
  return (
    <fieldset className="rs-dates" data-field={field}>
      <legend className="field__label">{label}</legend>
      <div className="rs-dates__row">
        <MonthYear idBase={`${id}-s`} label="Start" value={range.start} onChange={(v) => set({ start: v, end: v ? range.end : null })} />
        <MonthYear idBase={`${id}-e`} label="End" value={present ? null : (range.end as YearMonth | null)} disabled={present || !range.start} onChange={(v) => set({ ...range, end: v })} />
        <label className="rs-present">
          <input type="checkbox" checked={present} disabled={!range.start} onChange={(e) => set({ ...range, end: e.target.checked ? "present" : null })} />
          <span>Present</span>
        </label>
      </div>
      {!range.start ? <span className="field__help">Add a start year first.</span> : null}
      <button type="button" className="rs-linkbtn" onClick={() => setAsText(true)}>Type dates</button>
    </fieldset>
  );
}

/** A row of mutually exclusive choices (density, margins), as radio buttons that look like a segmented control. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  const name = useId();
  return (
    <fieldset className="rs-seg">
      <legend className="field__label">{label}</legend>
      <div className="rs-seg__row">
        {options.map((o) => (
          <label key={o.value} className="rs-seg__opt">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
