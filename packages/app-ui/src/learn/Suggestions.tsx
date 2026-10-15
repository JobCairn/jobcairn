import { useMemo, useState, type ReactNode } from "react";
import { Button, Card, Icon, Icons, SectionTitle, Tabs, Text } from "@careeros/brand";
import { isActiveRun, type JobRow, type JobToLearn, type LearnHub, type SkillSuggestion } from "@careeros/contract";
import { useLoad } from "../bridge-context";
import { useClaudeRuns } from "../claude";
import { SourceBadge } from "../source/SourceBadge";
import { displayName } from "../components/displayName";
import { MakeVideoButton } from "../components/MakeVideo";
import { ScoreMeter } from "../components/ScoreMeter";
import { ScoreMany } from "../home/runs";
import { fitView } from "../jobs/cells/meta";
import { navigate, type Route } from "../router";
import { RunButton } from "./RunButton";

/** "In 2 of 3 jobs" */
export const jobsText = (s: SkillSuggestion) => `In ${s.jobs} of ${s.total} ${s.total === 1 ? "job" : "jobs"}`;
/** The share of saved jobs that ask for a skill, as a whole percent. */
export const sharePct = (s: SkillSuggestion) => Math.round((s.jobs / Math.max(1, s.total)) * 100);
/** What a skill card's action does: write a new guide (via the Start a topic dialog), or open the one there is. */
export const suggestionAction = (s: SkillSuggestion) => (s.started ? "Open guide" : "Make guide");

/**
 * The top skills saved jobs ask for that your profile and resumes don't mention. Each card says how many jobs ask
 * (in words and as a share bar of all saved jobs), and what clicking does.
 */
export function SuggestedTopics({ suggestions, onPick }: { suggestions: SkillSuggestion[]; onPick: (s: SkillSuggestion) => void }) {
  return (
    <section className="learn-section" aria-labelledby="suggested-title" data-tour="learn-suggested">
      <div className="learn-section__head">
        <SectionTitle icon={Icons.learn} title="Suggested topics" id="suggested-title" />
        <Text role="body-sm" muted>Skills your saved jobs ask for that your profile and resumes don't mention yet. The bar is the share of jobs that ask.</Text>
      </div>
      <ul className="skill-chips">
        {suggestions.map((s) => {
          const pct = sharePct(s);
          return (
            <li key={s.slug}>
              <button type="button" className="skill-chip" onClick={() => onPick(s)}
                aria-label={`${s.skill}, ${jobsText(s).toLowerCase()} (${pct}%). ${suggestionAction(s)}`}>
                <span className="skill-chip__name">{s.skill}</span>
                <span className="skill-chip__count t-body-sm">{jobsText(s)}</span>
                <span className="skill-chip__pct t-body-sm">{pct}%</span>
                <span className="skill-chip__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                <span className="skill-chip__cta"><Icon icon={s.started ? Icons.guide : Icons.add} size="sm" />{suggestionAction(s)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Under a short topic list: the next skills to study, each with "Make guide" and "Make video", so a page with
 * one or two topics ends in a next step instead of empty space.
 */
export function NextTopics({ suggestions, onGuide, limit = 3 }: { suggestions: SkillSuggestion[]; onGuide: (skill: string) => void; limit?: number }) {
  const picks = suggestions.filter((s) => !s.started).slice(0, limit);
  if (!picks.length) return null;
  return (
    <section className="next-topics" aria-labelledby="next-topics-title">
      <Text role="label" as="h3" id="next-topics-title" className="next-topics__title">Study next</Text>
      <ul className="list-plain next-topics__list">
        {picks.map((s) => (
          <li key={s.slug} className="next-topics__row">
            <span className="next-topics__what">
              <span className="next-topics__skill">{s.skill}</span>
              <span className="t-body-sm t-muted">{jobsText(s)}</span>
            </span>
            <span className="next-topics__actions">
              <Button size="sm" variant="secondary" icon={Icons.add} aria-label={`Make guide: ${s.skill}`} onClick={() => onGuide(s.skill)}>Make guide</Button>
              <MakeVideoButton target={{ kind: "topic", topic: s.slug, label: s.skill }} label="Make video" ariaLabel={`Make video: ${s.skill}`} variant="ghost" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Jobs seen being scored while this window is open: once finished they stay listed as their result. */
const watched = new Set<string>();
const SHOWN = 5;
const keyOf = (j: { company_slug: string; id: string }) => `${j.company_slug}/${j.id}`;

/** Fit, source and salary for the listed jobs (best effort; rows work without it). */
function useJobFacts() {
  const r = useLoad((b) => b.jobs.list({ limit: 500, showIneligible: true }), [], ["jobs"]);
  return useMemo(() => new Map((r.data?.rows ?? []).map((x) => [keyOf(x), x])), [r.data]);
}

const jobRoute = (j: JobToLearn, tab?: string): Route => ({ screen: "job", slug: j.company_slug, id: j.id, ...(tab ? { tab } : {}) });

/**
 * One job as a compact row: source logo, title and company, then trailing content. The title button stretches over
 * the whole row (so a click anywhere opens the job), and the trailing controls sit above it.
 */
function JobRowShell({ j, facts, tab, fresh, children, trailing }: {
  j: JobToLearn; facts: JobRow | undefined; tab?: string; fresh?: boolean; children?: ReactNode; trailing: ReactNode;
}) {
  return (
    <li className={`job-learn__row${fresh ? " is-fresh" : ""}`} data-fresh={fresh || undefined}>
      <span className="job-learn__lead">{facts ? <SourceBadge job={{ source: facts.source, source_site: facts.source_site }} size="sm" /> : null}</span>
      <span className="job-learn__main">
        <button type="button" className="job-learn__open" onClick={() => navigate(jobRoute(j, tab))}>
          <span className="job-learn__title">{displayName(j.title)}</span>
          <span className="job-learn__company">{displayName(j.company_name)}</span>
        </button>
        {children}
      </span>
      <span className="job-learn__end">{trailing}</span>
    </li>
  );
}

/** A scored job: its fit as the Jobs table's ring, and its top gaps (each starts a topic). Opens on its Score tab. */
function ScoredRow({ j, facts, fresh, onGap }: { j: JobToLearn; facts: JobRow | undefined; fresh: boolean; onGap: (g: string) => void }) {
  const v = fitView(facts?.fit ?? null);
  return (
    <JobRowShell j={j} facts={facts} tab="score" fresh={fresh}
      trailing={v ? <span className="job-learn__ring"><ScoreMeter value={v.value} band={`fit-${v.band}`} label={`Fit ${v.label}`} /><span className="sr-only">Fit {v.value}, {v.label}</span></span>
        : <span className="t-body-sm t-muted">Scored</span>}>
      {j.gaps.length ? (
        <span className="job-learn__gaps">
          <span className="t-body-sm t-muted">Gaps:</span>
          {j.gaps.slice(0, 3).map((g) => <button key={g} type="button" className="topic-chip topic-chip--sm" onClick={() => onGap(g)} aria-label={`Start a topic on ${g}`}>{g}</button>)}
          {j.gaps.length > 3 ? <span className="t-body-sm t-muted">+{j.gaps.length - 3} more</span> : null}
        </span>
      ) : null}
    </JobRowShell>
  );
}

/** A job not scored yet: a small Score action on the same line, which becomes a one-line chip while it runs. */
function UnscoredRow({ j, facts }: { j: JobToLearn; facts: JobRow | undefined }) {
  return (
    <JobRowShell j={j} facts={facts}
      trailing={<RunButton action="score_job" target={{ kind: "job", company_slug: j.company_slug, id: j.id }} label="Score" look="cell"
        ariaLabel={`Score ${displayName(j.title)} at ${displayName(j.company_name)}`} />} />
  );
}

/**
 * From your jobs: "Scored" (fit ring, top gaps) and "Not scored yet" (Score, or Score all). Every row opens its job.
 * A job scored here doesn't vanish: it stays in place as its result (fit, gaps) for the rest of the session.
 */
export function JobsToLearn({ hub, onGap }: { hub: LearnHub; onGap: (gap: string) => void }) {
  const facts = useJobFacts();
  const runs = useClaudeRuns();
  // Jobs this session scored (or is scoring) stay listed where they were, turned into their result.
  const scoredHere = useMemo(() => {
    const out = new Map<string, "running" | "done">();
    for (const r of runs.data ?? []) {
      if (r.action !== "score_job" || r.target.kind !== "job") continue;
      const k = keyOf(r.target);
      if (out.has(k)) continue; // runs come newest first
      if (isActiveRun(r.status)) { watched.add(k); out.set(k, "running"); }
      else if (r.status === "succeeded" && watched.has(k)) out.set(k, "done");
    }
    return out;
  }, [runs.data]);
  const [seen] = useState(() => new Map<string, JobToLearn>());
  for (const j of hub.unscored) seen.set(keyOf(j), j);
  const scoredByKey = new Map(hub.scored.map((j) => [keyOf(j), j]));
  // Not scored yet, plus the ones that turned into a score this session (kept in their place).
  const notScored = [...seen.values()].filter((j) => hub.unscored.some((u) => keyOf(u) === keyOf(j)) || scoredHere.has(keyOf(j)));
  const [tab, setTab] = useState<"scored" | "unscored">(() => (hub.scored.length || !hub.unscored.length ? "scored" : "unscored"));
  const [all, setAll] = useState(false);
  if (!hub.scored.length && !notScored.length) return null;
  const list = tab === "scored" ? hub.scored : notScored;
  // "Score all": the listed jobs that still have no score and aren't being scored, through Home's queue (ScoreMany).
  const total = hub.unscored_total ?? hub.unscored.length;
  const toScore = hub.unscored.filter((j) => !scoredHere.has(keyOf(j)));
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <Card className="stack" aria-labelledby="jobs-learn-title" data-tour="learn-jobs">
      <SectionTitle icon={Icons.jobs} title="From your jobs" id="jobs-learn-title" />
      <Tabs label="Jobs to learn from" value={tab} sticky={false} onChange={(t) => { setTab(t as "scored" | "unscored"); setAll(false); }}
        tabs={[{ id: "scored", label: "Scored", count: hub.scored.length }, { id: "unscored", label: "Not scored yet", count: total }]}>
        {tab === "unscored" ? (
          <div className="job-learn__batch">
            <Text role="body-sm" muted className="grow">
              Scoring shows your fit and the gaps for each job.
            </Text>
            {toScore.length > 1 ? (
              <ScoreMany jobs={toScore} label={toScore.length === total ? `Score all ${toScore.length}` : `Score these ${toScore.length}`}
                ariaLabel={`Score ${toScore.length === total ? "all" : "these"} ${toScore.length} jobs not scored yet`} />
            ) : null}
          </div>
        ) : null}
        {!list.length ? (
          <Text role="body-sm" muted>{tab === "scored" ? "No scored jobs with gaps yet. Score a job to see what to study." : "Every job here has a score."}</Text>
        ) : (
          <ul className="list-plain job-learn">
            {shown.map((j) => {
              const k = keyOf(j);
              const result = tab === "unscored" && scoredHere.get(k) === "done" ? (scoredByKey.get(k) ?? { ...j, gaps: [] }) : null;
              return result ? <ScoredRow key={k} j={result} facts={facts.get(k)} fresh onGap={onGap} />
                : tab === "scored" ? <ScoredRow key={k} j={j} facts={facts.get(k)} fresh={false} onGap={onGap} />
                : <UnscoredRow key={k} j={j} facts={facts.get(k)} />;
            })}
          </ul>
        )}
        {list.length > SHOWN || (tab === "unscored" && total > list.length) ? (
          <div className="job-learn__foot">
            {list.length > SHOWN ? <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show ${list.length - SHOWN} more`}</Button> : <span />}
            {tab === "unscored" && total > list.length ? <Button size="sm" variant="ghost" onClick={() => navigate({ screen: "jobs" })}>All {total} jobs</Button> : null}
          </div>
        ) : null}
      </Tabs>
    </Card>
  );
}
