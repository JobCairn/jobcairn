import { useState, type ReactElement } from "react";
import { Button, Icons, type ButtonVariant } from "@careeros/brand";
import type { ActionId, ActionTarget } from "@careeros/contract";
import { ClaudeRunPanel, useClaudeRun } from "../claude";

/**
 * One plain button that asks Claude for an action again (Score again, Tailor resume), whatever is already saved.
 * After a click, the run panel follows it here (or says how to set Claude up).
 */
export function RunButton({ action, target, label, variant = "secondary", onPanel }: {
  action: ActionId; target: ActionTarget; label: string; variant?: ButtonVariant;
  /** Where the run panel goes: the caller puts it under the button row. */
  onPanel: (panel: ReactElement | null) => void;
}) {
  const claude = useClaudeRun(action, target);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    onPanel(<ClaudeRunPanel key={action} action={action} target={target} compact />);
    if (!claude.ready) return;
    setBusy(true);
    try { await claude.start({}); } catch { /* the panel shows the error */ } finally { setBusy(false); }
  };
  return (
    <Button variant={variant} icon={Icons.ai} loading={busy || claude.running} onClick={() => void ask()}
      title={claude.running ? "Claude is working on this. Follow it below." : undefined}>{label}</Button>
  );
}
