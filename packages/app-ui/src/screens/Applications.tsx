import { useMemo, useState } from "react";
import { Button, Icons, Pill, Select, Tabs, Text } from "@careeros/brand";
import { followUpIsDue, followUpLimitText, type JobRow, type SponsorshipFocus } from "@careeros/contract";
import { useLoad } from "../bridge-context";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { EmptyState, ErrorState, Loading, ScreenHead } from "../components/States";
import { rightsTone, useCandidate } from "../candidate";
import { navigate } from "../router";
import { SourceBadge } from "../source/SourceBadge";
import { RightsCell } from "../jobs/cells/cells";
import { OfferComparison } from "../jobs/OfferComparison";
import { QuietBanner } from "../applications/QuietBanner";
import { resolveBoard } from "../source/boards";
import {
  STAGES, defaultStage, filterPrepare, rememberStage, rememberedStage, stageCounts, stageRows, waitingKeys,
  type PrepareFilter, type StageId,
} from "../applications/stages";

const PAGE = 10;
const ACTION: Record<StageId, { label: string; primary?: boolean }> = {
  prepare: { label: "Prepare" }, progress: { label: "Continue", primary: true }, waiting: { label: "Review" },
  sent: { label: "View" }, interviews: { label: "View" }, closed: { label: "View" },
};

function Row({ r, stage, focus }: { r: JobRow; stage: StageId; focus: SponsorshipFocus }) {
  const tone = rightsTone(r.wr_label, focus);
  // Sent and no reply by the follow-up day: the row says so and its button opens the ready follow-up draft.
  const due = stage === "sent" && followUpIsDue(r.follow_up_on, new Date());
  // Two follow-ups sent: no third is offered, and the row says why.
  const limit = followUpLimitText(r.follow_ups ?? 0);
  const action = due ? { label: "Follow up", primary: true } : ACTION[stage];
  const sub = [displayName(r.company_name), r.location ? displayName(r.location) : ""].filter(Boolean).join(" · ");
  return (
    <li className="app-row app-row--stage">
      <SourceBadge job={r} size="sm" />
      <button type="button" className="app-row__main" onClick={() => navigate({ screen: "job", slug: r.company_slug, id: r.id })}>
        {/* The title wraps instead of truncating, so it never needs a tooltip covering the next row. */}
        <span className="app-row__title">{displayName(r.title)}</span>
        <span className="app-row__sub">{sub}</span>
        {due ? <span className="app-row__due"><Pill tone="warning">Follow up due</Pill></span> : null}
        {stage === "sent" && limit ? <span className="app-row__due" title={limit}><Pill tone="neutral">Followed up twice</Pill></span> : null}
      </button>
      <span className="app-row__fit" aria-label={r.fit !== null ? `Fit ${r.fit}` : "Not scored"} title={r.fit !== null ? "Fit score" : "Not scored yet"}>{r.fit !== null ? r.fit : "–"}</span>
      <span className="app-row__salary">{r.salary_text ? displayName(r.salary_text) : <span className="t-muted">Salary not stated</span>}</span>
      {tone ? <RightsCell label={r.wr_label} focus={focus} /> : <span />}
      <Button size="sm" variant={action.primary ? "primary" : "secondary"} icon={stage === "prepare" || stage === "progress" ? Icons.apply : undefined}
        onClick={() => navigate(due ? { screen: "job", slug: r.company_slug, id: r.id, tab: "outreach" } : { screen: "apply", slug: r.company_slug, id: r.id })} aria-label={`${action.label}: ${displayName(r.title)}`}>{action.label}</Button>
    </li>
  );
}

function PrepareBar({ rows, f, onChange }: { rows: JobRow[]; f: PrepareFilter; onChange: (f: PrepareFilter) => void }) {
  const boards = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) { const b = resolveBoard(r); m.set(b.id, b.name); }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  return (
    <div className="app-filter" role="group" aria-label="Filter jobs to prepare">
      <Select label="Sort" value={f.sort} onChange={(e) => onChange({ ...f, sort: e.target.value as PrepareFilter["sort"] })}
        options={[{ value: "best", label: "Best match" }, { value: "fit", label: "Fit" }, { value: "newest", label: "Newest" }]} />
      {boards.length > 1 ? (
        <Select label="Source" value={f.source} onChange={(e) => onChange({ ...f, source: e.target.value })}
          options={[{ value: "", label: "Any source" }, ...boards.map(([value, label]) => ({ value, label }))]} />
      ) : null}
      <button type="button" className="filter-chip" aria-pressed={f.fit70} onClick={() => onChange({ ...f, fit70: !f.fit70 })}>Fit 70+</button>
    </div>
  );
}

/**
 * Applications, by stage: To prepare · In progress · Waiting for your OK · Sent · Interviews · Closed, each a tab
 * with its count. Opens on In progress when there is any, else To prepare, and remembers your pick this session.
 */
export function ApplicationsScreen() {
  const { data, error } = useLoad((b) => b.jobs.list({ limit: 500 }), [], ["jobs"]);
  const approvals = useLoad((b) => b.approvals.list(), [], ["approvals"]);
  const candidate = useCandidate();
  const [picked, setPicked] = useState<StageId | null>(() => rememberedStage());
  const [f, setF] = useState<PrepareFilter>({ sort: "best", fit70: false, source: "" });
  const [shown, setShown] = useState(PAGE);
  if (error && !data) return <ErrorState title="Applications can't be shown" text={errorSentence(error)} />;
  if (!data || !candidate) return <Loading />;
  const focus = candidate.focus;
  const waiting = waitingKeys(approvals.data ?? []);
  const counts = stageCounts(data.rows, waiting);
  const stage = defaultStage(counts, picked);
  const base = stageRows(stage, data.rows, waiting);
  const rows = stage === "prepare" ? filterPrepare(base, f) : [...base].sort((a, b) => b.last_activity.localeCompare(a.last_activity));
  const def = STAGES.find((s) => s.id === stage)!;
  const pick = (s: string) => { setPicked(s as StageId); rememberStage(s as StageId); setShown(PAGE); };
  return (
    <>
      <ScreenHead title="Applications" sub="Prepare, review and send applications. Nothing is ever sent without your OK." settings="applications" />
      <QuietBanner />
      <OfferComparison />
      <div data-tour="apps-stages">
        <Tabs label="Application stages" value={stage} onChange={pick} tabs={STAGES.map((s) => ({ id: s.id, label: s.label, count: counts[s.id] }))}>
          <section className="stack" aria-label={`${def.label} (${counts[stage]})`}>
            {stage === "prepare" && base.length ? <div data-tour="apps-filter"><PrepareBar rows={base} f={f} onChange={(n) => { setF(n); setShown(PAGE); }} /></div> : null}
            {rows.length ? (
              <>
                <ul className="list-plain app-list">{rows.slice(0, shown).map((r) => <Row key={`${r.company_slug}/${r.id}`} r={r} stage={stage} focus={focus} />)}</ul>
                {rows.length > shown ? (
                  <div className="row">
                    <Button variant="ghost" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</Button>
                    <Text role="body-sm" muted>{shown} of {rows.length}</Text>
                  </div>
                ) : null}
              </>
            ) : stage === "prepare" && base.length ? (
              <EmptyState text="No jobs match these filters." action={<Button variant="ghost" onClick={() => setF({ sort: f.sort, fit70: false, source: "" })}>Clear filters</Button>} />
            ) : stage === "prepare" ? (
              <EmptyState boxed text={def.empty} action={<Button icon={Icons.jobs} onClick={() => navigate({ screen: "jobs" })}>Open Jobs</Button>} />
            ) : <EmptyState text={def.empty} />}
          </section>
        </Tabs>
      </div>
    </>
  );
}
