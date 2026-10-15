import "../styles/tables.css";
import "../jobs/cells/cells.css";

/** Fill colours: the default bands, plus the Fit bands (fit-top/high/mid/low, see jobs/cells/meta.ts). */
export type MeterBand = "high" | "mid" | "low" | "none" | "fit-top" | "fit-high" | "fit-mid" | "fit-low";
const bandOf = (n: number): MeterBand => (n >= 65 ? "high" : n >= 45 ? "mid" : n > 0 ? "low" : "none");

/**
 * A 0-100 score as a small ring with the number inside (narrow enough for a table cell). The reasons show as a tooltip.
 * `band` overrides the default colour bands (Fit uses the scoring rubric's); `label` replaces the tooltip's first line.
 */
export function ScoreMeter({ value, reasons = [], tier, band, label }: { value: number; reasons?: string[]; tier?: string; band?: MeterBand; label?: string }) {
  const n = Math.max(0, Math.min(100, Math.round(value)));
  const head = label ?? `${n} out of 100${tier ? `, ${tier.toLowerCase()}` : ""}`;
  const title = [head, ...reasons.map((r) => `• ${r.charAt(0).toUpperCase()}${r.slice(1)}`)].join("\n");
  const C = 2 * Math.PI * 12;
  return (
    <span className="score-meter" title={title}>
      <span className="score-ring">
        <svg className="score-ring__svg" viewBox="0 0 28 28" aria-hidden="true">
          <circle className="score-ring__track" cx="14" cy="14" r="12" />
          <circle className={`score-ring__fill score-meter__fill--${band ?? bandOf(n)}`} cx="14" cy="14" r="12" strokeDasharray={`${(n / 100) * C} ${C}`} />
        </svg>
        <span className="score-meter__value cell-num">{n}</span>
      </span>
    </span>
  );
}
