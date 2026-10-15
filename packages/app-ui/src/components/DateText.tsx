import "../styles/tables.css";
import { dateView } from "../format";

/**
 * A stored date as people read it: "17 Sep 2026", optionally with "3 weeks ago" underneath.
 * The full timestamp shows as a tooltip only when the value has a real time.
 */
export function DateText({ value, hint = false, empty = "Not recorded", now }: { value: string | null | undefined; hint?: boolean; empty?: string; now?: Date }) {
  const v = dateView(value, now);
  if (!v) return <span className="t-body-sm t-muted">{empty}</span>;
  return (
    <time className="date-text" dateTime={v.iso} title={v.title}>
      <span className="t-body-sm">{v.text}</span>
      {hint && v.hint ? <span className="t-body-sm t-muted date-text__hint">{v.hint}</span> : null}
    </time>
  );
}
