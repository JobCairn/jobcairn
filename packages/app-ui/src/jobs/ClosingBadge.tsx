import { Pill } from "@careeros/brand";
import { closingState, type JobStatus } from "@careeros/contract";
import "./extras.css";

/**
 * "Closes in 5 days" (warm when seven days or fewer), "Closes today", or "Closed" once the ad's own closing date has
 * passed. Only for jobs not yet applied for, and only when the ad stated a date: no date, no badge.
 */
export function ClosingBadge({ row, now }: { row: { closes_on?: string; status: JobStatus }; now?: Date }) {
  const c = closingState(row, now ?? new Date());
  if (!c) return null;
  return (
    <span className="closing-badge">
      <Pill tone={c.closed ? "neutral" : c.soon ? "warning" : "neutral"} title={c.why}>{c.text}</Pill>
    </span>
  );
}
