import { useEffect, useId, useState, type ReactNode } from "react";
import { Button, Icon, Icons, Text, useToast } from "@careeros/brand";
import { ACTIONS, BOARD_NAMES, isActiveRun, type ActionId, type ActionTarget, type ClaudeRunStep, type ClaudeRunView } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { formatCost, formatElapsed, strayName, strayPath, useElapsed, useSubject, visibleStray, workingTitle } from "./run-helpers";
import { currentStep, dedupeSteps } from "./steps";
import { useFileViewer } from "../viewer";
import { diagLines } from "../chrome/state";
import { BoardStops } from "../chrome/BoardStops";
import "./claude.css";

export function StepMark({ state }: { state: ClaudeRunStep["state"] }) {
  if (state === "active") return <span className="crun__mark crun__mark--active" aria-hidden="true" />;
  return (
    <span className={`crun__mark crun__mark--${state}`} aria-hidden="true">
      <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {state === "done" ? <path d="M2.5 6.3 5 8.6 9.6 3.6" /> : <path d="M3.4 3.4 8.6 8.6M8.6 3.4 3.4 8.6" />}
      </svg>
    </span>
  );
}

const STATE_TEXT: Record<ClaudeRunStep["state"], string> = { active: "in progress", done: "done", failed: "stopped" };

/** The deduplicated step list: each label once, with "×2" when Claude did it more than once. */
export function StepList({ steps, id }: { steps: readonly ClaudeRunStep[]; id?: string }) {
  const groups = dedupeSteps(steps);
  if (!groups.length) return <Text role="body-sm" muted>No steps yet.</Text>;
  return (
    <ol className="crun__steps" id={id} aria-label="Steps">
      {groups.map((s) => (
        <li key={s.label} className={`crun__step crun__step--${s.state}`}>
          <StepMark state={s.state} />
          <span>{s.label}</span>
          {s.count > 1 ? <span className="crun__count" aria-label={`${s.count} times`}>×{s.count}</span> : null}
          <span className="sr-only"> ({STATE_TEXT[s.state]})</span>
        </li>
      ))}
    </ol>
  );
}

export interface RunCardProps {
  run: ClaudeRunView;
  action: ActionId;
  target: ActionTarget;
  compact?: boolean;
  /** Start with the steps shown. Default: collapsed. */
  stepsOpen?: boolean;
  onCancel: () => void;
  onRetry: () => void;
  retrying?: boolean;
  /** Extra text for a failure (the start call's own error). */
  error?: string | null;
  /** "Copy prompt" and the prompt it shows. */
  fallback?: ReactNode;
  /** Show Cancel in the card's line (default). Off where the surrounding row has its own. */
  cancelable?: boolean;
}

/**
 * A run as a compact card with a stable height while it works: one line (what, current step, time, Show steps,
 * Cancel). The step list is a disclosure, closed by default. Finished: one result line and the files as chips.
 */
/** "Retry 2 of 3 in 0:30 · Stop": a failed search that starts again on its own. Stop drops the wait. */
function RetryWait({ retry, label, onStop }: { retry: NonNullable<ClaudeRunView["retry"]>; label: string; onStop?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.ceil((Date.parse(retry.at) - now) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <div className="crun__retry" role="status">
      <Text role="body-sm" as="span">{left ? `Retry ${retry.attempt} of ${retry.of} in ${clock}` : `Retry ${retry.attempt} of ${retry.of} starting…`}</Text>
      {onStop ? <><span aria-hidden="true"> · </span><Button size="sm" variant="ghost" aria-label={`Stop retrying: ${label}`} onClick={onStop}>Stop</Button></> : null}
    </div>
  );
}

export function RunCard({ run, action, target, compact, stepsOpen = false, onCancel, onRetry, retrying, error, fallback, cancelable = true }: RunCardProps) {
  const bridge = useBridge();
  const toast = useToast();
  const elapsed = useElapsed(run);
  const subject = useSubject(target);
  const [open, setOpen] = useState(stepsOpen);
  const stepsId = useId();
  const label = ACTIONS[action].label;
  const active = isActiveRun(run.status);
  const now = currentStep(run.steps);
  const title = run.status === "queued" ? `Waiting for a free slot: ${workingTitle(action, subject)}` : active ? workingTitle(action, subject)
    : run.status === "succeeded" ? ACTIONS[action].done
    : run.status === "cancelled" ? `Stopped: ${label}` : `Claude didn't finish: ${label}`;
  const reveal = (rel: string) => void bridge.files.reveal(rel).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));
  const stepCount = dedupeSteps(run.steps).length;
  const stray = visibleStray(run.stray);
  // Made files open in the app's own viewer; Finder is a second, smaller choice.
  const viewer = useFileViewer(run.status === "succeeded" ? run.files.map((f) => ({ rel: f.path, title: f.label })) : []);

  return (
    <section className={`crun crun--${run.status}${compact ? " crun--compact" : ""}`} aria-label={`${label}: ${title}`} aria-busy={active || undefined}>
      <header className="crun__head">
        <span className="crun__title">
          {active ? <span className="crun__pulse" aria-hidden="true" /> : null}
          <Text role="body-sm" as="span" className="crun__title-text" title={title}>{title}</Text>
          {active ? <span className="crun__now" aria-live="polite" title={now || undefined}>{now || "Starting Claude Code…"}</span> : null}
        </span>
        {stepCount ? (
          <button type="button" className="crun__toggle" aria-expanded={open} aria-controls={stepsId} onClick={() => setOpen((o) => !o)}>
            <Icon icon={open ? Icons.collapse : Icons.expand} size="sm" />{open ? "Hide steps" : "Show steps"}
          </button>
        ) : null}
        <span className="crun__time" aria-label={`Time taken ${formatElapsed(elapsed)}`}>{formatElapsed(elapsed)}</span>
        {active && cancelable ? <Button size="sm" variant="ghost" aria-label={`Cancel: ${label}`} onClick={onCancel}>Cancel</Button> : null}
      </header>

      {open && stepCount ? <StepList steps={run.steps} id={stepsId} /> : null}

      {run.status === "succeeded" && run.summary ? <Text role="body-sm" className="crun__summary">{run.summary}</Text> : null}
      {run.status === "succeeded" && run.files.length ? (
        <ul className="crun__files" aria-label="Files Claude made">
          {run.files.map((f) => (
            <li key={f.path} className="crun__chip">
              <span className="crun__chip-label" title={f.label}>{f.label}</span>
              <Button size="sm" variant="ghost" aria-label={`View ${f.label}`} onClick={() => viewer.open(f.path, f.label)}>View</Button>
              <Button size="sm" variant="ghost" icon={Icons.showInFolder} aria-label={`Show ${f.label} in its folder`} title="Show in folder" onClick={() => reveal(f.path)} />
            </li>
          ))}
        </ul>
      ) : null}
      {!active && run.cost_usd !== null ? (
        <Text role="body-sm" muted className="crun__cost" title="Claude Code's own estimate. On a Pro or Max plan this counts against your plan's limits instead of being billed.">
          Cost estimate: {formatCost(run.cost_usd)}
        </Text>
      ) : null}
      {stray.length ? (
        <div className="crun__caution" role="note" aria-label="Also changed">
          <Icon icon={Icons.info} size="sm" />
          <div className="crun__caution-body">
            <Text role="body-sm" as="span">{stray.length === 1 ? "Another file also changed while Claude worked. Worth a look:" : `${stray.length} other files also changed while Claude worked. Worth a look:`}</Text>
            <ul className="list-plain crun__caution-list">
              {stray.slice(0, 5).map((p) => {
                const at = strayPath(p);
                return (
                  <li key={p}>
                    <Text role="body-sm" as="span" muted>{strayName(p)}</Text>
                    {at ? <Button size="sm" variant="ghost" aria-label={`View ${strayName(p)}`} onClick={() => viewer.open(at, strayName(p))}>View</Button> : null}
                  </li>
                );
              })}
            </ul>
            {stray.length > 5 ? <Text role="body-sm" muted>{`And ${stray.length - 5} more.`}</Text> : null}
          </div>
        </div>
      ) : null}

      {!active && run.browser_diag?.length ? <BoardStops diags={run.browser_diag} /> : null}
      {!active && run.browser_diag?.length ? <ChromeDetails diags={run.browser_diag} /> : null}

      {run.status === "failed" || run.status === "cancelled" ? (
        <>
          {run.error ? <Text role="body-sm" className="crun__error">{run.error}</Text> : null}
          {error ? <Text role="body-sm" className="crun__error">{error}</Text> : null}
          {run.retry ? <RetryWait retry={run.retry} label={label} onStop={onCancel} /> : null}
          <div className="crun__actions">
            <Button size="sm" variant="primary" loading={retrying} aria-label={`${run.status === "cancelled" ? "Run again" : "Retry"}: ${label}`} onClick={onRetry}>
              {run.status === "cancelled" ? "Run again" : "Retry"}
            </Button>
            {fallback}
          </div>
        </>
      ) : null}
      {viewer.element}
    </section>
  );
}

/** A run that searched in Chrome: how each board's tab was opened, behind one closed Details disclosure. */
function ChromeDetails({ diags }: { diags: NonNullable<ClaudeRunView["browser_diag"]> }) {
  return (
    <details className="crun__details">
      <summary><Text role="body-sm" as="span">Chrome details</Text></summary>
      <ul className="list-plain crun__details-list" aria-label="How each board's tab was opened in Chrome">
        {diags.map(({ board, diag }) => (
          <li key={board}>
            <Text role="body-sm" as="span">{BOARD_NAMES[board]}</Text>
            <ul className="list-plain">{diagLines(diag).map((l) => <li key={l}><Text role="body-sm" as="span" muted>{l}</Text></li>)}</ul>
          </li>
        ))}
      </ul>
    </details>
  );
}
