import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon, Icons } from "@careeros/brand";
import "./filters.css";

/** Tones a choice's dot can carry (the Sponsor cell's traffic light). */
export type ChoiceTone = "success" | "warning" | "danger" | "neutral";
export interface Choice<T extends string | number> { value: T; label: string; count?: number; tone?: ChoiceTone; hint?: string; sub?: string }

/** "Likely", "Likely, Possible", "Likely +2": the chip's value line. */
export function chipValue(labels: readonly string[], max = 2): string {
  if (labels.length <= max) return labels.join(", ");
  return `${labels.slice(0, max - 1).join(", ")} +${labels.length - max + 1}`;
}

export interface FilterChipProps {
  /** The filter's name: "Sponsorship". */
  label: string;
  /** What's picked, in words ("" when the filter is off). */
  value: string;
  onClear(): void;
  /** The popover's content. `close` closes it and puts focus back on the chip. */
  children: (close: () => void) => ReactNode;
  "data-tour"?: string;
  /** A wider panel, for lists you edit (roles, places). */
  wide?: boolean;
  /** False for a filter that must always have a value (a search's roles and places): no x. */
  clearable?: boolean;
  /**
   * "setting": the chip shows a search's own value (Find jobs), not a filter, so a value alone isn't highlighted;
   * `changed` marks one that differs from the saved default.
   */
  kind?: "filter" | "setting";
  changed?: boolean;
}

/**
 * One quick filter: a chip that opens a small panel of choices. Off, it reads "Sponsorship" with a chevron; on, it
 * reads "Sponsorship: Likely" and has its own x to clear it. The panel hangs under the chip and flips left near an
 * edge; Escape or a click outside closes it.
 */
export function FilterChip({ label, value, onClear, children, wide, clearable = true, kind = "filter", changed = false, ...rest }: FilterChipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const on = value !== "";
  const x = on && clearable;
  const close = () => { setOpen(false); btn.current?.focus(); };

  // The panel hangs under its chip (absolute, so it scrolls with the page and stays inside a dialog). It opens to the
  // right, or to the left when the right would run past the window or the box the chip sits in.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = wrap.current?.getBoundingClientRect();
      if (!r) return;
      const w = panel.current?.offsetWidth ?? 280;
      let edge = window.innerWidth - 8;
      for (let el = wrap.current?.parentElement; el; el = el.parentElement) {
        const o = getComputedStyle(el).overflowX;
        if (o === "hidden" || o === "auto" || o === "scroll" || o === "clip") { edge = Math.min(edge, el.getBoundingClientRect().right - 8); break; }
      }
      setPos(r.left + w > edge ? { top: 0, left: Math.min(0, edge - r.left - w) } : { top: 0, left: 0 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // Focus the first choice (or the panel) so the keyboard lands inside.
    requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>("input, button, [tabindex]") ?? panel.current)?.focus());
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    // Capture on the document runs before a dialog's own Escape, so the first Escape closes only this panel.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); close(); } };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="qf-chip" ref={wrap} data-on={on || undefined} data-kind={kind} data-changed={changed || undefined} data-tour={rest["data-tour"]}>
      <button type="button" ref={btn} className="qf-chip__btn" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
        aria-label={on ? `${label}: ${value}${changed ? " (changed for this search)" : ""}. Change` : kind === "setting" ? `${label}: any. Change` : `Filter by ${label.toLowerCase()}`} onClick={() => setOpen((o) => !o)}>
        <span className="qf-chip__name">{label}{on || kind === "setting" ? ":" : ""}</span>
        {on ? <span className="qf-chip__value">{value}</span> : kind === "setting" ? <span className="qf-chip__value qf-chip__value--any">Any</span> : null}
        {changed ? <span className="qf-chip__changed" aria-hidden="true" /> : null}
        {x ? null : <Icon icon={Icons.expand} size="sm" />}
      </button>
      {x ? (
        <button type="button" className="qf-chip__clear" aria-label={`Clear ${label.toLowerCase()} filter`} title={`Clear ${label.toLowerCase()}`} onClick={() => { onClear(); setOpen(false); btn.current?.focus(); }}>
          <Icon icon={Icons.close} size="sm" />
        </button>
      ) : null}
      {open ? (
        <div className={`qf-panel${wide ? " qf-panel--wide" : ""}`} id={panelId} ref={panel} role="dialog" aria-label={label} tabIndex={-1}
          style={pos ? { left: pos.left } : { visibility: "hidden" }}>
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

const countText = (n: number | undefined) => (n === undefined ? null : <span className="qf-count" aria-label={`${n} ${n === 1 ? "job" : "jobs"}`}>{n.toLocaleString("en-AU")}</span>);

/** Several choices at once (checkboxes), each with its live count. */
export function ManyChoices<T extends string>({ name, choices, value, onChange }: { name: string; choices: readonly Choice<T>[]; value: readonly T[]; onChange(v: T[]): void }) {
  return (
    <fieldset className="qf-choices">
      <legend className="sr-only">{name}</legend>
      {choices.map((c) => {
        const on = value.includes(c.value);
        return (
          <label key={c.value} className="qf-choice" data-empty={c.count === 0 && !on ? true : undefined} title={c.hint}>
            <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? choices.filter((x) => x.value === c.value || value.includes(x.value)).map((x) => x.value) : value.filter((v) => v !== c.value))} />
            {c.tone ? <span className={`qf-dot qf-dot--${c.tone}`} aria-hidden="true" /> : null}
            <span className="qf-choice__label">{c.label}{c.sub ? <span className="qf-choice__sub">{c.sub}</span> : null}</span>
            {countText(c.count)}
          </label>
        );
      })}
    </fieldset>
  );
}

/** One choice (radio buttons), "Any" first, each with its live count. Picking one closes the panel. */
export function OneChoice<T extends string | number>({ name, choices, value, onChange, anyLabel = "Any", anyCount }: {
  name: string; choices: readonly Choice<T>[]; value: T | null; onChange(v: T | null): void; anyLabel?: string; anyCount?: number;
}) {
  const group = useId();
  const all: { value: T | null; label: string; count?: number; hint?: string }[] = [{ value: null, label: anyLabel, count: anyCount }, ...choices];
  return (
    <fieldset className="qf-choices">
      <legend className="sr-only">{name}</legend>
      {all.map((c) => (
        <label key={String(c.value)} className="qf-choice" data-empty={c.count === 0 && value !== c.value ? true : undefined} title={c.hint}>
          <input type="radio" name={group} checked={value === c.value} onChange={() => onChange(c.value)} />
          <span className="qf-choice__label">{c.label}</span>
          {countText(c.count)}
        </label>
      ))}
    </fieldset>
  );
}

/** The bar: chips in a row, wrapping, with Clear all at the end once any filter is on. */
export function QuickFilterBar({ label, children, active, onClearAll, "data-tour": tour }: { label: string; children: ReactNode; active: number; onClearAll(): void; "data-tour"?: string }) {
  return (
    <div className="qf-bar" role="group" aria-label={label} data-tour={tour}>
      <span className="qf-bar__lead" aria-hidden="true"><Icon icon={Icons.filter} size="sm" /></span>
      {children}
      {active ? <button type="button" className="qf-bar__clear" onClick={onClearAll}>Clear all</button> : null}
    </div>
  );
}
