import { useMemo, useState } from "react";
import { Button, Icon, Icons } from "@careeros/brand";
import type { ActionId, ActionTarget } from "@careeros/contract";
import { useAction } from "../bridge-context";
import { AllowHint } from "../chrome";
import { ClaudeRunPanel, RunChip, useClaudeRun } from "../claude";
import "../jobs/cells/cells.css";
import "./learn.css";

export interface RunButtonProps {
  action: ActionId;
  /** A fixed target. Pass a different one and the button follows that target's run instead. */
  target: ActionTarget;
  label: string;
  ariaLabel?: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  /** "cell": the small bordered Score action the Jobs table uses (icon and one word), for dense rows. */
  look?: "button" | "cell";
}

/**
 * One Claude Code run from Learn or the checklist ("Score this job", "Find jobs", "Prepare interview questions").
 * While the run is queued or running a one-line chip takes the button's place (details are a click away), so
 * the page doesn't move. When Claude isn't set up, a short notice says how (with "Copy prompt").
 */
export function RunButton({ action, target, label, ariaLabel, variant = "secondary", size = "sm", look = "button" }: RunButtonProps) {
  const json = JSON.stringify(target);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const t = useMemo(() => target, [json]);
  const claude = useClaudeRun(action, t);
  const { busy, run } = useAction();
  const [asked, setAsked] = useState(false);
  const key = `learn:${action}:${json}`;
  const ask = () => run(key, async () => {
    setAsked(true);
    if (claude.ready) await claude.start();
  });
  const r = claude.run;
  const chip = r && (claude.running || (asked && (r.status === "failed" || r.status === "cancelled")));
  return (
    <div className="learn-run">
      {chip ? <RunChip run={r} onCancel={() => void claude.cancel()} onRetry={() => void ask()} retrying={busy === key} />
        : look === "cell"
          ? <button type="button" className="cell-action" disabled={busy === key} aria-busy={busy === key || undefined} aria-label={ariaLabel} onClick={() => void ask()}><Icon icon={Icons.ai} size="sm" />{label}</button>
          : <Button size={size} variant={variant} icon={Icons.ai} loading={busy === key} aria-label={ariaLabel} onClick={() => void ask()}>{label}</Button>}
      {action === "find_jobs" ? <AllowHint show={busy === key} /> : null}
      {asked && claude.engine && !claude.ready ? <ClaudeRunPanel action={action} target={t} compact /> : null}
    </div>
  );
}
