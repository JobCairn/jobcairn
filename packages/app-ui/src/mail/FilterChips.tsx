import { useId } from "react";
import { Icon, Icons } from "@careeros/brand";

/**
 * A filter shown as a compact chip: a native select (so keyboard, screen readers and the OS menu all just work)
 * that reads as its current choice. It's highlighted while it narrows the list.
 */
export function ChipSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  const id = useId();
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <span className={`chip-select${value ? " is-active" : ""}`} title={`${label}: ${current?.label ?? ""}`}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} className="chip-select__select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="chip-select__chevron" aria-hidden="true"><Icon icon={Icons.expand} size="sm" /></span>
    </span>
  );
}

/** An on/off filter chip. On shows a leading check mark, so the state isn't carried by colour alone. */
export function ToggleChip({ label, pressed, onChange }: { label: string; pressed: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`chip-toggle${pressed ? " is-active" : ""}`} aria-pressed={pressed} onClick={() => onChange(!pressed)}>
      {pressed ? <Icon icon={Icons.check} size="sm" /> : null}
      {label}
    </button>
  );
}
