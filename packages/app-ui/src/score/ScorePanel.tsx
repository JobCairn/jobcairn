import { useId, useState, type ReactElement } from "react";
import { Button, Card, cx, Icon as BrandIcon, Icons, Pill, Text } from "@careeros/brand";
import { topicSlug, type ActionTarget, type JobDetail, type ScoreItem, type ScoreResult, type SkillSuggestion, type SponsorshipFocus } from "@careeros/contract";
import { ActionButton } from "../components/ActionButton";
import { sponsorReasons } from "../jobs/cells/cells";
import { Markdown } from "../components/Markdown";
import { EmptyState } from "../components/States";
import { StartTopicDialog } from "../learn/StartTopicDialog";
import { fmtDayOf } from "../reading/dates";
import { navigate } from "../router";
import { RunButton } from "./RunButton";
import { gapsOf, metLine, STATUS, TIER_TONE } from "./tiers";
import "./score.css";

export interface ScorePanelProps {
  d: JobDetail;
  /** The job's workspace folder, for images in the write-up. */
  base: string;
  /** Null when the job can't be changed (it failed to reload): no actions are offered. */
  target: Extract<ActionTarget, { kind: "job" }> | null;
  focus: SponsorshipFocus;
  /** Start scoring on open when it isn't scored yet (the one-click Score from the Jobs list). */
  autoStart?: boolean;
}

/**
 * Job › Score: a score card (fit, tier, interview odds, must-haves, what would change it, next steps) over the full
 * write-up, which stays folded away. Everything Claude wrote is shown in plain words, never as file paths.
 */
export function ScorePanel({ d, base, target, focus, autoStart }: ScorePanelProps) {
  const score = d.score ?? null;
  const report = d.scoreReport;
  const scored = !!score || d.job.scores.fit.value !== null || !!report;

  if (!scored) {
    return (
      <div className="stack job-panel">
        <EmptyState boxed text="Not scored yet. Claude reads the ad and your experience, then gives a fit score, your interview odds and a must-have checklist."
          action={target ? <ActionButton action="score_job" target={target} variant="primary" size="md" autoStart={autoStart} /> : undefined} />
      </div>
    );
  }

  return (
    <div className="stack job-panel score-panel">
      {score ? <ScoreCard score={score} d={d} target={target} focus={focus} /> : (
        <Card className="score-card score-card--thin">
          <Text role="body">This write-up has no fit number we could read.</Text>
          {target ? <ThinActions target={target} /> : null}
        </Card>
      )}
      {report ? (
        <details className="score-writeup" open={!score}>
          <summary><Icon />Full write-up</summary>
          <div className="score-writeup__body"><Markdown text={report} baseDir={base} plain /></div>
        </details>
      ) : null}
    </div>
  );
}

function ThinActions({ target }: { target: Extract<ActionTarget, { kind: "job" }> }) {
  const [panel, setPanel] = useState<ReactElement | null>(null);
  return <div className="stack"><div className="row"><RunButton action="score_job" target={target} label="Score again" onPanel={setPanel} /></div>{panel}</div>;
}

const Icon = () => <span className="score-writeup__chev" aria-hidden="true" />;

function ScoreCard({ score, d, target, focus }: { score: ScoreResult; d: JobDetail; target: ScorePanelProps["target"]; focus: SponsorshipFocus }) {
  const sp = d.job.scores.sponsor;
  const sponsorText = `${sp.value ?? "not set"}${sp.tier ? ` · ${sp.tier}` : ""}`;
  const thin = score.source !== "structured" && !score.must_haves.length;
  return (
    <Card className="score-card" aria-labelledby="score-card-title">
      <h2 id="score-card-title" className="sr-only">Score</h2>
      <div className="score-card__head">
        <FitDial fit={score.fit} />
        <div className="score-card__verdict">
          <div className="row score-card__pills">
            {score.tier ? <Pill tone={TIER_TONE[score.tier]}>{score.tier}</Pill> : null}
            {focus === "primary" ? <Pill>Sponsor {sponsorText}</Pill> : null}
          </div>
          {score.recommendation ? <Text role="body" className="score-card__rec">{score.recommendation}</Text> : null}
          {score.summary ? <Text role="body-sm" muted>{score.summary}</Text> : null}
          {thin ? <Text role="body-sm" muted>Scored before the checklist was saved. Score again to see each must-have and what would change the score.</Text> : null}
          {focus === "secondary" ? <Text role="body-sm" muted>{`Sponsorship info: ${sponsorText}`}</Text> : null}
          {focus === "primary" && sp.reasons.length ? <ul className="score-card__reasons" aria-label="Why this sponsor estimate">{sponsorReasons(sp.reasons, Infinity).map((r, i) => <li key={i}>{r}</li>)}</ul> : null}
        </div>
        <dl className="score-card__facts">
          <div><dt>Interview odds</dt><dd>{score.interview_odds === null ? "Not set" : `${score.interview_odds}%`}</dd></div>
          {score.scored_at ? <div><dt>Scored</dt><dd>{fmtDayOf(score.scored_at)}</dd></div> : null}
        </dl>
      </div>

      {score.must_haves.length ? <Checklist title="Must-haves" items={score.must_haves} /> : null}
      {score.nice_to_haves.length ? <Checklist title="Nice-to-haves" items={score.nice_to_haves} quiet /> : null}

      {score.changes.length ? (
        <section className="score-card__section" aria-labelledby="score-changes">
          <h3 id="score-changes" className="score-card__h">What would change this</h3>
          <ul className="score-changes">{score.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      ) : null}

      {target ? <ScoreActions score={score} d={d} target={target} /> : null}
    </Card>
  );
}

/** The fit as a large number over a thin bar. The bar is drawn for sighted readers; the number says it all. */
function FitDial({ fit }: { fit: number | null }) {
  return (
    <div className="fit-dial">
      <span className="fit-dial__label">Fit</span>
      <span className="fit-dial__value t-hero">{fit ?? "–"}<span className="fit-dial__of t-body">/100</span></span>
      {fit !== null ? (
        <span className="fit-dial__bar" role="meter" aria-label="Fit score" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fit}>
          <span style={{ width: `${fit}%` }} />
        </span>
      ) : <span className="t-body-sm t-muted">Not set</span>}
    </div>
  );
}

function Checklist({ title, items, quiet = false }: { title: string; items: ScoreItem[]; quiet?: boolean }) {
  const id = useId();
  return (
    <section className={cx("score-card__section", quiet && "score-card__section--quiet")} aria-labelledby={id}>
      <div className="score-card__h-row">
        <h3 id={id} className="score-card__h">{title}</h3>
        <span className="t-body-sm t-muted">{metLine(items)}</span>
      </div>
      <ul className="must-list">{items.map((m, i) => <MustHave key={`${i}-${m.text}`} item={m} />)}</ul>
    </section>
  );
}

/** One requirement: status mark and words, the requirement, and its evidence on one line until opened. */
function MustHave({ item }: { item: ScoreItem }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[item.status];
  const ev = item.evidence.trim();
  const long = ev.length > 90;
  const body = (
    <>
      <span className={cx("must__mark", `must__mark--${st.tone}`)} aria-hidden="true">{st.mark}</span>
      <span className="must__main">
        <span className="must__text">{item.text}</span>
        {ev ? <span className={cx("must__ev", !open && "must__ev--clamp")}>{ev}</span> : null}
      </span>
      <span className="must__end">
        <span className={cx("must__status", `must__status--${st.tone}`)}>{st.label}</span>
        {long ? <BrandIcon icon={open ? Icons.collapse : Icons.expand} size="sm" className="must__chev" /> : null}
      </span>
    </>
  );
  return (
    <li className="must">
      {long ? (
        <button type="button" className="must__row must__row--btn" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? "Show less" : "Show all the evidence"}>
          {body}
        </button>
      ) : <div className="must__row">{body}</div>}
    </li>
  );
}

function ScoreActions({ score, d, target }: { score: ScoreResult; d: JobDetail; target: Extract<ActionTarget, { kind: "job" }> }) {
  const gaps = gapsOf(score, d.gaps);
  const [study, setStudy] = useState(false);
  const [panel, setPanel] = useState<ReactElement | null>(null);
  const hasResume = d.files.some((f) => f.path === "application/resume.md" && f.exists);
  const suggestions: SkillSuggestion[] = gaps.map((g) => ({ skill: g, slug: topicSlug(g), jobs: 1, total: 1, started: false }));
  return (
    <div className="score-card__foot">
      <div className="score-card__actions" role="group" aria-label="Next steps">
        {gaps.length ? <Button variant="primary" icon={Icons.learn} onClick={() => setStudy(true)}>Study gaps</Button> : null}
        {hasResume
          ? <Button icon={Icons.file} onClick={() => navigate({ screen: "resume", slug: target.company_slug, id: target.id, file: "resume.md" })}>Tailor resume</Button>
          : <RunButton action="tailor_application" target={target} label="Tailor resume" onPanel={setPanel} />}
        <RunButton action="score_job" target={target} label="Score again" variant="ghost" onPanel={setPanel} />
      </div>
      {panel}
      {gaps.length ? <StartTopicDialog open={study} onClose={() => setStudy(false)} initial={gaps[0]} suggestions={suggestions} /> : null}
    </div>
  );
}
