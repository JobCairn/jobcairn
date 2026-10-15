import { useState } from "react";
import { Button, PRODUCT_NAME, Text, useToast } from "@careeros/brand";
import { ACTIONS, type ActionId, type ActionTarget, type ClaudeRunView } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { useClaudeRun } from "./useClaudeRun";
import { CLAUDE_SETTINGS, navigate } from "../router";
import { RunCard } from "./RunCard";
import "./claude.css";

export { formatCost, formatElapsed, strayName, useElapsed, useSubject, workingTitle } from "./run-helpers";
export { StepMark } from "./RunCard";

export interface ClaudeRunPanelProps {
  action: ActionId;
  target: ActionTarget;
  /** Optional: the run from your own useClaudeRun, to save a lookup. The panel keeps itself up to date either way. */
  run?: ClaudeRunView | null;
  /** Default: start again with the same request. */
  onRetry?: () => void;
  /** Smaller, for tight rows. */
  compact?: boolean;
  /** Show the "set up Claude" notice when the engine isn't ready (default true). */
  showSetup?: boolean;
  /** Open the step list from the start (the Activity tab does). Default: collapsed. */
  stepsOpen?: boolean;
}

/**
 * One Claude Code run as a compact card with a stable height: one line with what it's doing, the time and Cancel,
 * and a "Show steps" disclosure. On success a short result line and the files it made; on failure a plain reason,
 * Retry and "Copy prompt". Renders nothing when there is no run and nothing to set up.
 */
export function ClaudeRunPanel({ action, target, run: given, onRetry, compact, showSetup = true, stepsOpen }: ClaudeRunPanelProps) {
  const bridge = useBridge();
  const toast = useToast();
  const c = useClaudeRun(action, target);
  const run = c.run ?? given ?? null;
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const label = ACTIONS[action].label;

  const copyPrompt = async () => {
    setBusy("copy");
    try {
      const r = await bridge.claude.prepare(action, target, false);
      if (r.copied) { toast({ tone: "success", text: "Prompt copied. Paste it into Claude." }); setPrompt(null); }
      else { setPrompt(r.prompt); toast({ tone: "neutral", text: "Copying didn't work. The prompt is shown below." }); }
    } catch (e) { toast({ tone: "danger", text: errorText(e) }); } finally { setBusy(null); }
  };
  const retry = async () => {
    if (onRetry) { onRetry(); return; }
    setBusy("retry");
    try { await c.start(); } catch { /* c.error shows it */ } finally { setBusy(null); }
  };
  const fallback = (
    <>
      <Button size="sm" variant="ghost" loading={busy === "copy"} aria-label={`Copy prompt: ${label}`} title="Copy the prompt to paste into Claude yourself" onClick={() => void copyPrompt()}>Copy prompt</Button>
      {prompt ? <pre className="markdown crun__prompt">{prompt}</pre> : null}
    </>
  );

  if (!run) {
    const e = c.engine;
    if (!showSetup || !e || e.ready) return c.error ? <div className="crun crun--failed" role="alert"><Text role="body-sm">{c.error}</Text></div> : null;
    return (
      <section className="crun crun--setup" aria-label="Claude isn't set up">
        <Text role="body-sm">{c.error ?? `Claude Code needs a one-time setup before ${PRODUCT_NAME} can run this for you.`}</Text>
        <div className="crun__actions">
          <Button size="sm" variant="primary" onClick={() => navigate(CLAUDE_SETTINGS)}>Claude setup</Button>
          {fallback}
        </div>
      </section>
    );
  }
  return (
    <RunCard run={run} action={action} target={target} compact={compact} stepsOpen={stepsOpen} error={c.error}
      onCancel={() => void c.cancel()} retrying={busy === "retry"} onRetry={() => void retry()} fallback={fallback} />
  );
}
