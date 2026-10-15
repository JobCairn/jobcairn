import { useMemo } from "react";
import { Text } from "@careeros/brand";
import { isActiveRun, type ClaudeRunView } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { useToast } from "@careeros/brand";
import { isActionRun, runsForJob } from "./activity-model";
import { RunCard } from "./RunCard";
import { useClaudeRuns } from "./useClaudeRun";
import { PRODUCT_NAME } from "@careeros/brand";

/** How many of this job's runs are going now (the Activity tab's badge). */
export function useJobRunCount(slug: string, id: string): number {
  const runs = useClaudeRuns();
  return useMemo(() => runsForJob(runs.data ?? [], slug, id).filter((r) => isActiveRun(r.status)).length, [runs.data, slug, id]);
}

function Row({ run }: { run: ClaudeRunView }) {
  const bridge = useBridge();
  const toast = useToast();
  if (!isActionRun(run)) return null;
  const action = run.action;
  const cancel = () => void bridge.claude.cancel(run.id).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));
  const retry = () => void bridge.claude.run(action, run.target, {}).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));
  return <li><RunCard run={run} action={action} target={run.target} stepsOpen={isActiveRun(run.status)} onCancel={cancel} onRetry={retry} /></li>;
}

/**
 * A job's Activity tab: Claude's runs for this job and its company, newest first. Running ones show their steps
 * live (each label once); finished ones show the result and the files they made.
 */
export function JobActivity({ slug, id }: { slug: string; id: string }) {
  const runs = useClaudeRuns();
  const mine = useMemo(() => runsForJob(runs.data ?? [], slug, id), [runs.data, slug, id]);
  const active = mine.filter((r) => isActiveRun(r.status));
  const done = mine.filter((r) => !isActiveRun(r.status));
  if (!runs.data) return runs.error ? <Text role="body" muted>Claude's activity can't be shown: {runs.error}</Text> : null;
  return (
    <div className="job-activity">
      {!mine.length ? <Text role="body" muted>Nothing yet. When you ask Claude to research this company, score the job or make a video, its progress and files show here.</Text> : null}
      {/* Only worth saying while something runs: it answers "can I leave this page?". */}
      {active.length ? <Text role="body-sm" muted>Runs keep going when you switch screens. They stop if you quit {PRODUCT_NAME}.</Text> : null}
      {active.length ? <ul className="list-plain job-activity" aria-label="Running now">{active.map((r) => <Row key={r.id} run={r} />)}</ul> : null}
      {done.length ? (
        <section className="stack" aria-label="Earlier runs">
          {active.length ? <Text role="label" as="h3">Earlier</Text> : null}
          <ul className="list-plain job-activity">{done.map((r) => <Row key={r.id} run={r} />)}</ul>
        </section>
      ) : null}
    </div>
  );
}
