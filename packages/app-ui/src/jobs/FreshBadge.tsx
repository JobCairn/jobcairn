import { Pill } from "@careeros/brand";
import { FRESH_HOURS, FRESH_TEXT, isFreshPosting, type JobRow } from "@careeros/contract";

const WHY = `Posted in the last ${FRESH_HOURS} hours. Early applications are read before the pile builds up.`;

/** "New · apply today" when the ad's own posted date is under 48 hours old. No posted date, no badge. */
export function FreshBadge({ row, now }: { row: Pick<JobRow, "posted">; now?: Date }) {
  if (!isFreshPosting(row, now ?? new Date())) return null;
  return <span className="fresh-badge"><Pill tone="accent" title={WHY}>{FRESH_TEXT}</Pill></span>;
}
