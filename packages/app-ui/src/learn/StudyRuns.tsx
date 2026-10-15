import { useMemo } from "react";
import { isActiveRun, type ActionTarget } from "@careeros/contract";
import { RunChip, useClaudeRun, useClaudeRuns } from "../claude";

type TopicTarget = Extract<ActionTarget, { kind: "topic" }>;

/**
 * Study guides Claude is writing: every active "study_topic" run, plus the ones started here this visit (so a
 * finished or failed run stays in view until the person leaves). Each panel follows one fixed topic.
 */
export function StudyRuns({ started }: { started: TopicTarget[] }) {
  const runs = useClaudeRuns();
  const targets = useMemo(() => {
    const out = new Map<string, TopicTarget>();
    for (const r of runs.data ?? []) {
      if (r.action === "study_topic" && r.target.kind === "topic" && isActiveRun(r.status)) out.set(r.target.topic, r.target);
    }
    for (const t of started) out.set(t.topic, t);
    return [...out.values()];
  }, [runs.data, started]);
  if (!targets.length) return null;
  return (
    <section className="learn-runs" aria-label="Study guides Claude is writing">
      {targets.map((t) => <StudyRun key={t.topic} target={t} />)}
    </section>
  );
}

/** One guide being written: its topic and a one-line chip (details open in the Activity panel). */
function StudyRun({ target }: { target: TopicTarget }) {
  const claude = useClaudeRun("study_topic", target);
  const r = claude.run;
  if (!r || r.status === "succeeded") return null;
  return (
    <div className="learn-runs__row">
      <span className="learn-runs__topic">{target.label}</span>
      <RunChip run={r} onCancel={() => void claude.cancel()} onRetry={() => void claude.start().catch(() => undefined)} />
    </div>
  );
}
