import { cx } from "../cx";
import { Card } from "./Card";
import { Text } from "./Text";

const round = (n: number) => Math.round(n * 10) / 10;

export function sparkPoints(values: number[], width = 64, height = 24, pad = 2): string {
  if (!values.length) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((v, i) => `${round(i * step)},${round(height - pad - ((v - min) / span) * (height - 2 * pad))}`).join(" ");
}

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  return (
    <svg className="kpi__spark" viewBox="0 0 64 24" preserveAspectRatio="none" role="img" aria-label={label}>
      <polyline fill="none" stroke="currentColor" strokeWidth={1.5} points={sparkPoints(values)} />
    </svg>
  );
}

export interface KpiCardProps { label: string; value: number | string; delta?: string; trend?: number[]; tone?: "default" | "accent" }

/** Number and sparkline share the row's last baseline (see .kpi__row). Numbers use lining tabular figures. */
export function KpiCard({ label, value, delta, trend, tone = "default" }: KpiCardProps) {
  return (
    <Card className="kpi" aria-label={label}>
      <Text role="label" as="div">{label}</Text>
      <div className="kpi__row">
        <span className={cx("kpi__value", tone === "accent" && "kpi__value--accent")}>{value}</span>
        {trend ? <Sparkline values={trend} label={`${label} trend: ${trend.join(", ")}`} /> : null}
      </div>
      {delta ? <div className="kpi__delta">{delta}</div> : null}
    </Card>
  );
}
