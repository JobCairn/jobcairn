import { Button } from "@careeros/brand";
import { isActiveRun, type ClaudeRunView } from "@careeros/contract";
import { chipVerb, runLabel } from "./activity-model";
import { formatElapsed, useElapsed } from "./run-helpers";
import { useActivity } from "./Activity";
import "./claude.css";

export interface RunChipProps {
  run: ClaudeRunView;
  onCancel: () => void;
  /** Failed or stopped runs offer this ("Retry" / "Run again"). */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * A run's inline status, one line at a fixed height, in place of the action button: "Researching · 0:20 · Cancel".
 * It never grows into a step list: clicking it opens the details (the job's Activity tab, or the Activity panel).
 * Successful runs show nothing here; the action's own "ready" state takes over.
 */
export function RunChip({ run, onCancel, onRetry, retrying }: RunChipProps) {
  const activity = useActivity();
  const elapsed = useElapsed(run);
  const label = runLabel(run);
  const active = isActiveRun(run.status);
  if (run.status === "succeeded") return null;
  const text = run.status === "queued" ? "Waiting for a free slot" : run.status === "running" ? chipVerb(run.action)
    : run.status === "cancelled" ? "Stopped" : "Didn't finish";
  const time = active ? formatElapsed(elapsed) : "";
  const open = () => activity?.openRun(run);
  return (
    <span className={`rchip rchip--${run.status}`} data-run={run.id}>
      <button type="button" className="rchip__main" onClick={open} disabled={!activity}
        aria-label={`${label}: ${text}${time ? `, ${time}` : ""}. Show details`} title={activity ? "Show details" : undefined}>
        {active ? <span className="rchip__spin" aria-hidden="true" /> : <span className="rchip__dot" aria-hidden="true" />}
        <span className="rchip__text">{text}</span>
        {time ? <span className="rchip__time">{time}</span> : null}
      </button>
      {active ? <Button size="sm" variant="ghost" className="rchip__btn" aria-label={`Cancel: ${label}`} onClick={onCancel}>Cancel</Button> : null}
      {!active && onRetry ? (
        <Button size="sm" variant="ghost" className="rchip__btn" loading={retrying} aria-label={`${run.status === "cancelled" ? "Run again" : "Retry"}: ${label}`} onClick={onRetry}>
          {run.status === "cancelled" ? "Run again" : "Retry"}
        </Button>
      ) : null}
    </span>
  );
}
