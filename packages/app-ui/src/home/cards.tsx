// Home dashboard cards that are lists or text rather than charts.
import { Button, Card, Text, SectionTitle, Icons } from "@careeros/brand";
import { type HomeAnalytics, type HomeSummary, type JobRef, type RankedJob, type SponsorshipFocus, type StaleJob } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";
import { plural } from "../format";
import { navigate, type Route } from "../router";
import { SourceBadge } from "../source/SourceBadge";
import { ActionButton, WORKSPACE } from "../components/ActionButton";
import { PrepareButton, RunButton } from "./runs";
import { ageText, coachText, money, pct, reasonText, stayText, todaySentence } from "./copy";

const jobRoute = (j: JobRef, tab?: string): Route => ({ screen: "job", slug: j.company_slug, id: j.id, ...(tab ? { tab } : {}) });

function JobLink({ job }: { job: JobRef }) {
  return (
    <a className="job-link" href={`#/job/${job.company_slug}/${job.id}`}>
      <span className="job-link__title">{job.title}</span>
      <span className="job-link__company t-body-sm t-muted">{job.company_name}</span>
    </a>
  );
}

// ---- Today --------------------------------------------------------------------------------

interface Chip { text: string; route: Route; tone?: "accent" | "plain" }

/**
 * Where "N unread emails" goes: that job's Mail tab when every unread email is a reply on one job,
 * otherwise the Mail screen, so the count always matches what the page shows.
 */
export function unreadRoute(h: HomeSummary): Route {
  const replies = h.nextUp.filter((n) => n.kind === "reply");
  const one = replies[0];
  const sameJob = !!one && replies.length === h.unreadMail && replies.every((r) => r.company_slug === one.company_slug && r.id === one.id);
  return sameJob ? { screen: "job", slug: one.company_slug!, id: one.id!, tab: "mail" } : { screen: "mail" };
}

export function TodayCard({ h }: { h: HomeSummary }) {
  const a = h.analytics;
  // Most urgent first: only four fit, so unread mail (someone wrote back) comes before routine shortcuts like
  // follow-ups, the drop box or setting a deadline, which wait for a free slot.
  const chips: Chip[] = [];
  if (a.sponsorship === "primary" && a.today.readySponsored) chips.push({ text: `${plural(a.today.readySponsored, "role")} with sponsorship`, route: { screen: "jobs", label: "sponsorship_offered" }, tone: "accent" });
  if (h.pendingApprovals) chips.push({ text: `${plural(h.pendingApprovals, "approval")} waiting`, route: { screen: "approvals" }, tone: "accent" });
  if (h.pendingRequests) chips.push({ text: `${plural(h.pendingRequests, "access request")} waiting`, route: { screen: "privacy" }, tone: "accent" });
  if (h.unreadMail) chips.push({ text: plural(h.unreadMail, "unread email"), route: unreadRoute(h), tone: "accent" });
  if (a.today.followUpsDue) chips.push({ text: `${plural(a.today.followUpsDue, "follow-up")} due`, route: { screen: "jobs", status: "Applied" } });
  if (h.inboxCount) chips.push({ text: `${plural(h.inboxCount, "file")} in your drop box`, route: { screen: "inbox" } });
  if (a.today.searchDeadline === null) chips.push({ text: "Set a search deadline", route: { screen: "settings", tab: "search" } });
  // An unfinished draft takes a free slot only (it waits for the person, not the other way round).
  const draft = h.nextUp.find((n) => n.kind === "draft");
  if (draft) chips.push({ text: "Finish your email draft", route: { screen: "job", slug: draft.company_slug!, id: draft.id!, tab: "mail" } });
  return (
    <Card aria-label="Today" className="home-card today" data-tour="home-today">
      <Text role="body-sm" as="h2" muted className="today__title">Today</Text>
      <p className="today__sentence t-heading-2">{todaySentence(a, h.total)}</p>
      {/* No roles yet: the sentence says "run a search", so the way to run one sits right under it. */}
      {h.total ? null : <div className="today__start"><ActionButton action="find_jobs" target={WORKSPACE} variant="primary" /></div>}
      {chips.length ? (
        <ul className="today__chips" aria-label="Shortcuts">
          {chips.slice(0, 4).map((c) => (
            <li key={c.text}><button type="button" className={`chip${c.tone === "accent" ? " chip--accent" : ""}`} onClick={() => navigate(c.route)}>{c.text}</button></li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// ---- Funnel -------------------------------------------------------------------------------

export function FunnelCard({ f }: { f: HomeAnalytics["funnel"] }) {
  const first = f.stages[0]!.reached;
  return (
    <Card aria-label="Pipeline" className="home-card" data-tour="home-pipeline">
      <div className="home-card__head">
        <SectionTitle icon={Icons.checklist} title="Pipeline" />
        <Text role="body-sm" muted>How many roles reached each stage, how many moved on, and how long they usually wait.</Text>
      </div>
      <div className="funnel-head" aria-hidden="true">
        <span>Stage</span><span /><span /><span>From previous</span><span>Here now</span><span>Usual stay</span>
      </div>
      <ol className="funnel">
        {f.stages.map((s, i) => (
          <li key={s.stage} className={`funnel-row${s.reached ? "" : " is-empty"}`} aria-label={`${s.label}: ${s.reached}`}>
            <span className="funnel-row__label">{s.label}</span>
            <span className="funnel-row__value t-heading-2 num" aria-hidden={s.reached ? undefined : true}>{s.reached || ""}</span>
            {s.reached ? (
              <span className="funnel-row__track" aria-hidden="true"><span style={{ width: `${first ? Math.max(2, (s.reached / first) * 100) : 0}%` }} /></span>
            ) : <span className="funnel-row__coach t-body-sm">{coachText(s.stage, f)}</span>}
            {s.reached ? (
              <span className="funnel-row__stats t-body-sm t-muted">
                <span className="funnel-row__conv" title={i > 0 && s.conversion !== null ? `${pct(s.conversion)} of ${f.stages[i - 1]!.label.toLowerCase()} got this far` : undefined}>
                  {i > 0 && s.conversion !== null ? <>{pct(s.conversion)}<span className="sr-only"> of {f.stages[i - 1]!.label.toLowerCase()}</span></> : null}
                </span>
                <span className="funnel-row__now">{s.now}<span className="sr-only"> here now</span></span>
                <span className="funnel-row__stay">{s.medianDays !== null ? <><span className="sr-only">usually </span>{stayText(s.medianDays).replace("about ", "")}</> : null}</span>
              </span>
            ) : null}
            {f.showTrends && s.reached ? (
              <span className={`funnel-row__trend t-body-sm t-muted${s.thisWeek > s.lastWeek ? " trend--up" : ""}`}>+{s.thisWeek} this week, {s.lastWeek} the week before</span>
            ) : null}
          </li>
        ))}
      </ol>
      {!f.showTrends && first ? <Text role="body-sm" muted>Weekly trends show after two weeks of history.</Text> : null}
    </Card>
  );
}

// ---- Next up ------------------------------------------------------------------------------

const ACTION_TEXT: Record<RankedJob["action"], string> = { score: "Score", prepare: "Prepare", follow_up: "Follow up", practise: "Practise" };

/**
 * The one action that most moves the search forward: practising for an interview, else (for people who need
 * sponsorship) preparing an ad that says it sponsors.
 */
function primaryJob(jobs: RankedJob[], focus: SponsorshipFocus): RankedJob | undefined {
  return jobs.find((j) => j.action === "practise") ?? (focus === "primary" ? jobs.find((j) => j.action === "prepare" && j.wr_label === "sponsorship_offered") : undefined);
}

const NEXT_UP_SUB: Record<SponsorshipFocus, string> = {
  primary: "Interviews first, then ads that say they sponsor, follow-ups, and the best fits.",
  secondary: "Interviews first, then follow-ups, then the best fits.",
  off: "Interviews first, then follow-ups, then the best fits.",
};

/** One Next up row. Score and Prepare run Claude Code for this row; Follow up and Practise open the right screen. */
function NextRow({ j, primary, focus }: { j: RankedJob; primary: boolean; focus: SponsorshipFocus }) {
  const variant = primary ? "primary" : "secondary";
  const name = `${ACTION_TEXT[j.action]} ${j.title} at ${j.company_name}`;
  return (
    <li className="next-row">
      <div className="next-row__main">
        <JobLink job={j} />
        <span className={`next-row__reason t-body-sm${focus === "primary" && j.wr_label === "sponsorship_offered" ? " is-sponsor" : ""}`}>
          {reasonText(j, focus)}
        </span>
      </div>
      <span className="next-row__age t-body-sm t-muted"><SourceBadge job={j} size="sm" />{ageText(j)}</span>
      {j.action === "score" ? <RunButton action="score_job" job={j} label="Score" variant={variant} className="next-row__action" />
        : j.action === "prepare" ? <PrepareButton job={j} variant={variant} className="next-row__action" />
          : (
            <Button size="sm" variant={variant} className="next-row__action" aria-label={name}
              onClick={() => navigate(j.action === "follow_up" ? jobRoute(j, "outreach") : { screen: "learn", job: `${j.company_slug}/${j.id}` })}>{ACTION_TEXT[j.action]}</Button>
          )}
    </li>
  );
}

export function NextUpCard({ jobs, total, focus }: { jobs: RankedJob[]; total: number; focus: SponsorshipFocus }) {
  const primary = primaryJob(jobs, focus);
  return (
    <Card aria-label="Next up section" className="home-card" data-tour="home-next">
      <div className="home-card__head">
        <SectionTitle icon={Icons.target} title="Next up" />
        <Text role="body-sm" muted>{NEXT_UP_SUB[focus]}</Text>
      </div>
      {jobs.length === 0 ? <Text role="body" muted>Nothing to act on. New roles from your next search will show here.</Text> : (
        <ol className="next-list" aria-label="Next up">
          {jobs.map((j) => <NextRow key={`${j.company_slug}/${j.id}`} j={j} primary={j === primary} focus={focus} />)}
        </ol>
      )}
      {total > jobs.length ? (
        <div className="home-card__foot"><Text role="body-sm" muted>{total - jobs.length} more to act on.</Text><Button variant="ghost" size="sm" onClick={() => navigate({ screen: "jobs" })}>All jobs</Button></div>
      ) : null}
    </Card>
  );
}

// ---- Going stale --------------------------------------------------------------------------

export function StaleCard({ jobs }: { jobs: StaleJob[] }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const shown = jobs.slice(0, 5);
  const archive = (j: StaleJob) => run(`archive:${j.company_slug}/${j.id}`, () => bridge.jobs.setStatus(j.company_slug, j.id, "Skipped", "Archived from Home: posted over 3 weeks ago"), `Archived ${j.title}`);
  return (
    <Card aria-label="Going stale" className="home-card">
      <div className="home-card__head">
        <SectionTitle icon={Icons.history} title="Going stale" />
        <Text role="body-sm" muted>Posted over 3 weeks ago and not applied for. Act or archive.</Text>
      </div>
      {jobs.length === 0 ? <Text role="body-sm" muted>Nothing stale. Every open role is under 3 weeks old.</Text> : (
        <ul className="stale-list">
          {shown.map((j) => (
            <li key={`${j.company_slug}/${j.id}`} className="stale-row">
              <div className="grow"><JobLink job={j} /><span className="t-body-sm t-muted">{ageText(j)}</span></div>
              <div className="stale-row__actions">
                <Button size="sm" variant="ghost" loading={busy === `archive:${j.company_slug}/${j.id}`} aria-label={`Archive ${j.title} at ${j.company_name}`} onClick={() => void archive(j)}>Archive</Button>
                <PrepareButton job={j} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {jobs.length > shown.length ? <Text role="body-sm" muted>And {plural(jobs.length - shown.length, "more role")}.</Text> : null}
    </Card>
  );
}

// ---- Sources ------------------------------------------------------------------------------

export function SourcesCard({ rows }: { rows: HomeAnalytics["sources"] }) {
  return (
    <Card aria-label="Sources" className="home-card">
      <div className="home-card__head">
        <SectionTitle icon={Icons.searches} title="Sources" />
        <Text role="body-sm" muted>Results seen in logged searches, roles kept, and applications, by site.</Text>
      </div>
      {rows.length === 0 ? <Text role="body-sm" muted>No searches or roles yet.</Text> : (
        <table className="mini-table">
          <thead><tr><th scope="col">Site</th><th scope="col" className="num">Seen</th><th scope="col" className="num">Kept</th><th scope="col" className="num">Applied</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.site}>
                <th scope="row">{r.site}</th>
                <td className="num" title={r.searches ? `${plural(r.searches, "search", "searches")} logged` : "No searches logged"}>{r.seen ?? "–"}</td>
                <td className="num">{r.kept}</td>
                <td className="num">{r.applied}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---- 482 salary check ---------------------------------------------------------------------

export function SalaryCard({ s }: { s: HomeAnalytics["salary"] }) {
  const { core, specialist, from } = s.thresholds;
  const rows: [string, string, number][] = [
    ["At or above the Specialist Skills threshold", `${money(specialist)} or more`, s.specialist.count],
    ["Between the Core Skills and Specialist thresholds", `${money(core)} to ${money(specialist - 1)}`, s.core.count],
    ["Below the Core Skills threshold", `under ${money(core)}`, s.below.count],
  ];
  const year = from.slice(0, 4);
  const superNoted = [s.specialist, s.core, s.below].flatMap((b) => b.jobs).filter((j) => j.note).length;
  return (
    <Card aria-label="482 salary check" className="home-card">
      <div className="home-card__head">
        <SectionTitle icon={Icons.salary} title="482 salary check" />
        <Text role="body-sm" muted>Stated yearly salaries on your {plural(s.shortlisted, "shortlisted role")}, using the lower end of each range. An "up to" figure has no lower end, so it counts as not stated.</Text>
      </div>
      {s.shortlisted === 0 ? <Text role="body-sm" muted>Shortlist roles to see how their salaries compare.</Text> : (
        <>
          <dl className="salary-bands">
            {rows.map(([label, range, n]) => (
              <div key={label} className="salary-band"><dt>{label}<span className="t-body-sm t-muted">{range}</span></dt><dd className="t-heading-2 num">{n}</dd></div>
            ))}
            <div className="salary-band salary-band--unstated"><dt>Salary not stated<span className="t-body-sm t-muted">or not a yearly figure</span></dt><dd className="t-heading-2 num">{s.notStated.count}</dd></div>
          </dl>
          {s.notStated.count ? (
            <ul className="unstated-list" aria-label="Roles without a stated salary">
              {s.notStated.jobs.slice(0, 4).map((j) => (
                <li key={`${j.company_slug}/${j.id}`}><JobLink job={j} />{j.note ? <span className="t-body-sm t-muted">{j.note}</span> : null}</li>
              ))}
              {s.notStated.count > 4 ? <li className="t-body-sm t-muted">and {s.notStated.count - 4} more</li> : null}
            </ul>
          ) : null}
        </>
      )}
      {superNoted ? <Text role="body-sm" muted>{plural(superNoted, "package includes", "packages include")} super, so {superNoted === 1 ? "it is" : "they are"} compared on base pay (the package less 12% super).</Text> : null}
      <Text role="body-sm" muted>Thresholds as published from 1 July {year}. They change every July, so check the Home Affairs website.</Text>
    </Card>
  );
}
