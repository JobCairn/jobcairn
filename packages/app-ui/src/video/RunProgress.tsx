import { Button, Card, Icons, Text } from "@careeros/brand";
import { isActiveRun, type ClaudeRunView, type VideoRunView } from "@careeros/contract";
import { StepMark } from "../claude/ClaudeRunPanel";

type Stage = VideoRunView["stages"][number];

/** The steps this run takes, in order: its plan when it has one (fixed at the start), else every step not skipped. */
export function plannedStages(run: VideoRunView): Stage[] {
  if (run.plan?.length) {
    const byId = new Map(run.stages.map((s) => [s.id, s]));
    const out = run.plan.map((id) => byId.get(id)).filter((s): s is Stage => !!s);
    // A step that runs outside the plan (it never should) still shows, so the panel never hides where it is.
    const extra = run.stages.find((s) => s.status === "running" && !run.plan!.includes(s.id));
    return extra ? [...out, extra] : out;
  }
  return run.stages.filter((s) => s.status !== "skipped");
}

/** Where a video job is up to, for its one-line header: "Step 4 of 9: Narrating", and how far along it is overall. */
export function videoProgress(run: VideoRunView): { step: number; total: number; current: Stage | null; pct: number } {
  const stages = plannedStages(run);
  const total = stages.length;
  const done = stages.filter((s) => s.status === "done" || s.status === "skipped").length;
  const i = stages.findIndex((s) => s.status === "running");
  const current = i >= 0 ? stages[i]! : null;
  const step = current ? i + 1 : Math.min(done + 1, total);
  const pct = total ? Math.round(((done + (current ? current.pct / 100 : 0)) / total) * 100) : 0;
  return { step, total, current, pct };
}

/** "about 40 s", "about 3 min", "about 1 hr 5 min". Rounded up; never "0". */
export function aboutTime(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `about ${Math.max(5, Math.ceil(s / 5) * 5)} s`;
  const m = Math.ceil(s / 60);
  return m >= 60 ? `about ${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ""}` : `about ${m} min`;
}

/** "1:05" for a time taken. */
export function took(ms: number): string {
  if (ms > 0 && ms < 1000) return "under 1 s";
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The time left for the run, from its per-step estimates: the current step's remainder plus every step still to come. */
export function timeLeft(run: VideoRunView): number | null {
  const est = run.estimates?.ms;
  if (!est) return null;
  let left = 0;
  for (const s of plannedStages(run)) {
    const e = est[s.id];
    if (e === undefined || s.status === "done" || s.status === "skipped") continue;
    left += s.status === "running" ? Math.max(e * 0.1, e - s.elapsed_ms) : e;
  }
  return left;
}

const WRITER_STAGES = new Set<Stage["id"]>(["write", "check"]);

/** The writer's Claude steps that belong under the current step: the last few, newest last. */
function claudeSteps(writer: ClaudeRunView | null | undefined, current: Stage | null): ClaudeRunView["steps"] {
  if (!writer || !isActiveRun(writer.status) || !current || !WRITER_STAGES.has(current.id)) return [];
  return writer.steps.slice(-3);
}

function ClaudeSub({ writer, steps }: { writer: ClaudeRunView; steps: ClaudeRunView["steps"] }) {
  const label = writer.status === "queued" ? "Claude is waiting for a free slot" : "Claude is writing the script";
  return (
    <div className="vrun-sub" role="group" aria-label={label}>
      {steps.length ? (
        <ol className="vrun-sub__steps" aria-live="polite">
          {steps.map((s, i) => (
            <li key={`${i}-${s.label}`} className={`vrun-sub__step vrun-sub__step--${s.state}`}><StepMark state={s.state} /><span>{s.label}</span></li>
          ))}
        </ol>
      ) : <Text role="body-sm" muted>{writer.status === "queued" ? label : "Starting Claude Code…"}</Text>}
    </div>
  );
}

/**
 * A video job's progress as one panel: what it's making, the step it's on with the time left, one bar and Cancel.
 * While Claude writes or fixes the script, Claude's own steps show under that step, not in a second panel. "Show all
 * steps" is a compact list of this run's planned steps (fixed when it starts, so the count never jumps), each with
 * its time taken or expected.
 */
export function RunPanel({ run, onCancel, cancelling, writer }: { run: VideoRunView; onCancel(): void; cancelling: boolean; writer?: ClaudeRunView | null }) {
  const waiting = run.status === "queued" || run.queued_behind > 0;
  const p = videoProgress(run);
  const title = waiting ? "Waiting to start" : run.phase === "write" ? "Writing your script" : run.phase === "final" ? "Making the final video" : "Making your draft";
  const left = waiting ? null : timeLeft(run);
  const where = waiting ? "Waiting for another video to finish." : p.total ? `Step ${p.step} of ${p.total}${p.current ? `: ${p.current.label}` : ""}` : "";
  const sub = claudeSteps(writer, p.current);
  const msg = p.current?.message && !sub.length ? ` · ${p.current.message}` : "";
  const stageBar = p.current && p.current.pct > 0;
  const est = run.estimates;
  return (
    <Card className="video-run video-run--compact" aria-label="Progress" aria-busy="true">
      <div className="video-run__head">
        <span className="crun__pulse" aria-hidden="true" />
        <div className="video-run__text">
          <Text role="body" as="span" className="video-run__title">{title}</Text>
          <Text role="body-sm" as="span" muted className="video-run__where" aria-live="polite" title={`${where}${msg}`}>{where}{msg}</Text>
        </div>
        {left !== null ? (
          <Text role="body-sm" as="span" muted className="video-run__left" title={est?.measured ? "From how long earlier videos took on this computer" : "A cautious first guess. It gets sharper as you make more videos."}>
            {`${aboutTime(left).replace(/^about/, "About")} left`}
          </Text>
        ) : null}
        {stageBar
          ? <progress className="video-run__bar" max={100} value={p.current!.pct} aria-label={`${p.current!.label} progress`} />
          : <progress className="video-run__bar" max={100} value={p.pct} aria-label="Overall progress" />}
        <Button size="sm" variant="ghost" icon={Icons.close} loading={cancelling} onClick={onCancel}>Cancel</Button>
      </div>
      {sub.length || (writer && isActiveRun(writer.status) && p.current && WRITER_STAGES.has(p.current.id)) ? <ClaudeSub writer={writer!} steps={sub} /> : null}
      <details className="video-run__steps">
        <summary><Text role="body-sm" as="span">All steps</Text></summary>
        <ol className="vstep" aria-label="Steps">
          {plannedStages(run).map((s) => {
            const state = s.status === "done" || s.status === "skipped" ? "done" : s.status === "running" ? "current" : s.status === "failed" || s.status === "cancelled" ? "stopped" : "next";
            const time = state === "done" ? (s.elapsed_ms > 0 ? took(s.elapsed_ms) : s.message === "Reused" ? "reused" : "")
              : state === "current" ? (est?.ms[s.id] !== undefined ? `${took(s.elapsed_ms)} of ${aboutTime(est.ms[s.id]!)}` : took(s.elapsed_ms))
              : state === "next" && est?.ms[s.id] !== undefined ? aboutTime(est.ms[s.id]!) : "";
            return (
              <li key={s.id} className={`vstep__row vstep__row--${state}`} aria-current={state === "current" ? "step" : undefined}>
                <span className="vstep__mark" aria-hidden="true">{state === "done" ? <StepMark state="done" /> : state === "current" ? <StepMark state="active" /> : state === "stopped" ? <StepMark state="failed" /> : <span className="vstep__dot" />}</span>
                <span className="vstep__label">{s.label}<span className="sr-only">{`, ${state === "next" ? "to do" : state}`}</span></span>
                <span className="vstep__time">{time}</span>
              </li>
            );
          })}
        </ol>
      </details>
    </Card>
  );
}
