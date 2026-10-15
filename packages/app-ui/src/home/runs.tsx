// Claude Code runs started from Home rows. Each row owns its run through Lane H's `useClaudeRun(action, target)`,
// so the button spins while that row's run is queued or running, and the run panel follows it in place.
import { useMemo, useState } from "react";
import { Button, Icons, Text } from "@careeros/brand";
import { actionKey, isActiveRun, ownTarget, type ActionId, type ActionTarget, type JobRef } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";
import { ClaudeRunPanel, RunChip, useClaudeEngine, useClaudeRun, useClaudeRuns } from "../claude";
import { navigate } from "../router";

export const jobTarget = (j: JobRef): ActionTarget => ({ kind: "job", company_slug: j.company_slug, id: j.id });

interface RunButtonProps {
  action: ActionId;
  job: JobRef;
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}

/** One row's Claude action (Score, for example). While it runs, a one-line chip takes the button's place. */
export function RunButton({ action, job, label, variant = "secondary", className }: RunButtonProps) {
  const target = useMemo(() => jobTarget(job), [job]);
  const claude = useClaudeRun(action, target);
  const { busy, run } = useAction();
  const [asked, setAsked] = useState(false);
  const key = `home:${action}:${job.company_slug}/${job.id}`;
  const ask = () => run(key, async () => {
    setAsked(true);
    if (claude.ready) await claude.start();
  });
  const r = claude.run;
  if (r && (claude.running || (asked && (r.status === "failed" || r.status === "cancelled")))) {
    return <RunChip run={r} onCancel={() => void claude.cancel()} onRetry={() => void ask()} retrying={busy === key} />;
  }
  return (
    <>
      <Button size="sm" variant={variant} icon={Icons.ai} loading={busy === key} className={className}
        aria-label={`${label} ${job.title} at ${job.company_name}`} onClick={() => void ask()}>{label}</Button>
      {asked && claude.engine && !claude.ready ? <div className="row-run"><ClaudeRunPanel action={action} target={target} compact /></div> : null}
    </>
  );
}

/**
 * Prepare: mark the job Applying with its prepare note, ask Claude to tailor the application, then open the Apply
 * steps (which follow the run). If the job can't be prepared, say why and stay on Home. When Claude isn't set up,
 * the Apply screen says how, so Prepare still opens it.
 */
export function PrepareButton({ job, variant = "secondary", className }: { job: JobRef; variant?: "primary" | "secondary" | "ghost"; className?: string }) {
  const bridge = useBridge();
  const target = useMemo(() => jobTarget(job), [job]);
  const claude = useClaudeRun("tailor_application", target);
  const { busy, run } = useAction();
  const key = `home:prepare:${job.company_slug}/${job.id}`;
  const prepare = () => run(key, async () => {
    try {
      await bridge.apply.prepare(job.company_slug, job.id);
    } catch (e) {
      throw new Error(`Couldn't prepare ${job.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (claude.ready && !claude.running) await claude.start();
    navigate({ screen: "apply", slug: job.company_slug, id: job.id });
  });
  return (
    <Button size="sm" variant={variant} icon={Icons.ai} loading={busy === key || claude.running} className={className}
      aria-label={`Prepare ${job.title} at ${job.company_name}`} onClick={() => void prepare()}>Prepare</Button>
  );
}

const keyOf = (j: JobRef) => actionKey("score_job", ownTarget("score_job", jobTarget(j)));

/**
 * "Score these": asks Claude to score each listed role. The engine queues them (two at a time), and this
 * shows how many are done.
 */
export function ScoreMany({ jobs, ariaLabel, label = "Score these" }: { jobs: JobRef[]; ariaLabel: string; label?: string }) {
  const bridge = useBridge();
  const engine = useClaudeEngine();
  const runs = useClaudeRuns();
  const { busy, run } = useAction();
  const [asked, setAsked] = useState<JobRef[] | null>(null);
  const ready = !!engine.data?.ready;

  const progress = useMemo(() => {
    if (!asked) return null;
    const keys = new Set(asked.map(keyOf));
    const latest = new Map<string, boolean>();
    // Runs come newest first, so the first one per key is the current one.
    for (const r of runs.data ?? []) if (r.action === "score_job" && keys.has(r.key) && !latest.has(r.key)) latest.set(r.key, isActiveRun(r.status));
    const active = [...latest.values()].filter(Boolean).length;
    return { total: asked.length, done: latest.size - active, active };
  }, [asked, runs.data]);

  const scoreAll = () => run("home:score-many", async () => {
    setAsked(jobs);
    if (!ready) return;
    for (const j of jobs) await bridge.claude.run("score_job", jobTarget(j), {});
    runs.reload();
  });
  const working = busy === "home:score-many" || (!!progress && progress.active > 0);
  return (
    <div className="score-many">
      <Button size="sm" icon={Icons.ai} loading={working} onClick={() => void scoreAll()} aria-label={ariaLabel}>{label}</Button>
      {asked && !ready && engine.data ? <div className="row-run"><ClaudeRunPanel action="score_job" target={jobTarget(asked[0]!)} compact /></div> : null}
      {asked && ready && progress ? (
        <Text role="body-sm" muted className="row-run" aria-live="polite">
          {progress.active ? `Scoring: ${progress.done} of ${progress.total} done.` : `${progress.done} of ${progress.total} finished.`}
        </Text>
      ) : null}
    </div>
  );
}
