import { useId } from "react";
import { cx, Icon, Text } from "@careeros/brand";
import type { ActionOption, OptionValue } from "@careeros/contract";
import { CheckIcon } from "./icons";

interface Props { option: ActionOption; value: OptionValue; onChange: (v: OptionValue) => void; suggestions: string[] }

/** One option as a form row: the label and help on the left, the control on the right. */
export function OptionField({ option: o, value, onChange, suggestions }: Props) {
  const id = useId();
  // Slug options are ids the app fills in (like a resume section); they have no control of their own.
  if (o.kind === "slug") return null;
  const helpId = `${id}-help`;
  const labelId = `${id}-label`;
  return (
    <div className="composer-field" data-kind={o.kind}>
      <div className="composer-field__text">
        {o.kind === "toggle"
          ? <label className="composer-field__label" id={labelId} htmlFor={id}>{o.label}</label>
          : <span className="composer-field__label" id={labelId}>{o.label}</span>}
        <span className="composer-field__help" id={helpId}>{o.help}</span>
      </div>
      <div className="composer-field__control">
        {o.kind === "select" ? (
          <div className="segmented" role="radiogroup" aria-labelledby={labelId} aria-describedby={helpId}>
            {o.choices.map((c) => (
              <label key={c.value} className={cx("segmented__item", value === c.value && "is-on")}>
                <input type="radio" className="sr-only" name={id} value={c.value} checked={value === c.value} onChange={() => onChange(c.value)} />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        ) : null}
        {o.kind === "toggle" ? (
          <button id={id} type="button" role="switch" className="switch" aria-checked={value === true} aria-describedby={helpId} onClick={() => onChange(!(value === true))}>
            <span className="sr-only">{value === true ? "On" : "Off"}</span>
          </button>
        ) : null}
        {o.kind === "range" ? (
          <div className="composer-range">
            <input id={id} type="range" min={o.min} max={o.max} step={o.step} value={value as number} aria-labelledby={labelId} aria-describedby={helpId}
              aria-valuetext={`${value} ${o.unit}`} onChange={(e) => onChange(Number(e.target.value))} />
            <output htmlFor={id} className="composer-range__value">{String(value)} <span>{o.unit}</span></output>
          </div>
        ) : null}
        {o.kind === "chips" ? <Chips option={o} value={value as string[]} onChange={onChange} suggestions={suggestions} labelId={labelId} helpId={helpId} /> : null}
      </div>
    </div>
  );
}

function Chips({ option: o, value, onChange, suggestions, labelId, helpId }: {
  option: Extract<ActionOption, { kind: "chips" }>; value: string[]; onChange: (v: OptionValue) => void; suggestions: string[]; labelId: string; helpId: string;
}) {
  // Chips with no suggestions (the keyword check's ad terms) show only what was picked, so a saved pick stays visible.
  const items = o.choices ?? (o.suggest === "skills" ? suggestions : value).map((s) => ({ value: s, label: s }));
  if (!items.length) {
    return <Text role="body-sm" muted>{o.suggest === "skills" ? "No skills found in this ad or your profile yet. Add keywords to your profile in Settings." : "None picked. Use the keyword check on the job's Score tab."}</Text>;
  }
  const full = value.length >= o.max;
  return (
    <div className="chip-picker" role="group" aria-labelledby={labelId} aria-describedby={helpId}>
      {items.map((c) => {
        const on = value.includes(c.value);
        const blocked = !on && full;
        return (
          <button key={c.value} type="button" className={cx("chip-toggle", on && "is-on")} aria-pressed={on} disabled={blocked}
            title={blocked ? `You can pick up to ${o.max}. Turn one off first.` : undefined}
            onClick={() => onChange(on ? value.filter((v) => v !== c.value) : [...value, c.value])}>
            {on ? <Icon icon={CheckIcon} size="sm" /> : null}
            <span>{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}
