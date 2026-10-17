import { Button, cx, Icons, Table, Tabs, Text, type Column } from "@careeros/brand";
import { JOB_STATUSES, RESEARCH_STALE_DAYS, researchAgeText, type ActionTarget, type CompanyFile, type JobRow } from "@careeros/contract";
import { useBridge, useLoad } from "../bridge-context";
import { ActionButton } from "../components/ActionButton";
import { DateText } from "../components/DateText";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { friendlyFile, showInFolderLabel } from "../components/files";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { CompanyContactsPanel } from "../companies/contacts";
import { CompanyMail, CompanyMark, hostOf, openable, SponsorDetails, useOpenLink } from "../companies/parts";
import { FitCell, SponsorCell, StatusCell } from "../jobs/cells/cells";
import { fitView } from "../jobs/cells/meta";
import { bytes, plural } from "../format";
import { fmtWhen } from "../reading/dates";
import { BackLink, usePageName } from "../nav";
import { navigate, type Route } from "../router";
import { SourceBadge } from "../source/SourceBadge";
import { useSponsorshipFocus } from "../useSponsorshipFocus";
import { useFileViewer } from "../viewer";
import { MoreMenu } from "../mail/MoreMenu";
import { useDelete } from "../trash";
import { PeopleYouKnow } from "../outreach/PeopleYouKnow";
import "../styles/tables.css";

/** The header's job count in words: "1 open job", "2 of 3 jobs open", "2 jobs, none open". */
const headerJobsText = (c: { jobs: number; open_jobs: number }) =>
  !c.jobs ? "No jobs saved yet"
    : c.open_jobs === c.jobs ? plural(c.jobs, "open job")
      : c.open_jobs === 0 ? `${plural(c.jobs, "job")}, none open` : `${c.open_jobs} of ${plural(c.jobs, "job")} open`;
const TABS = ["jobs", "mail", "contacts", "research", "timeline", "sponsorship"] as const;
type Tab = (typeof TABS)[number];

export function CompanyScreen({ route }: { route: Route }) {
  if (route.screen !== "company") return <Loading />;
  return <><BackLink route={route} /><CompanyView slug={route.slug} tab={(TABS as readonly string[]).includes(route.tab ?? "") ? (route.tab as Tab) : "jobs"} /></>;
}

const jobCols = (sponsorship: boolean): Column<JobRow>[] => [
  {
    key: "role", header: "Role", alwaysOn: true, wrap: true, sortValue: (r) => r.title, text: (r) => r.title,
    render: (r) => (
      <div className="role-cell">
        <SourceBadge job={r} size="sm" className="role-cell__source" />
        <div className="role-cell__text"><Text role="body" as="div" className="role-title">{r.title}</Text>{r.client ? <Text role="body-sm" muted as="div">{`Client ${r.client}`}</Text> : null}</div>
      </div>
    ),
  },
  { key: "where", header: "Location", width: "11rem", priority: "low", text: (r) => [r.location, r.work_mode].filter(Boolean).join(" · "),
    render: (r) => <Text role="body-sm" truncate>{[r.location, r.work_mode].filter(Boolean).join(" · ")}</Text> },
  { key: "fit", header: "Fit", align: "center", width: "5.5rem", sortValue: (r) => r.fit, firstSort: "desc", text: (r) => fitView(r.fit)?.label ?? "Not scored",
    render: (r) => <FitCell fit={r.fit} /> },
  ...(sponsorship ? [{ key: "sponsor", header: "Sponsor", width: "8rem", sortValue: (r: JobRow) => r.sponsor, firstSort: "desc" as const,
    render: (r: JobRow) => <SponsorCell score={r.sponsor} label={r.wr_label} reasons={r.sponsor_reasons} /> }] : []),
  { key: "found", header: "Found", width: "7rem", priority: "low", sortValue: (r) => r.found_at, firstSort: "desc", render: (r) => <DateText value={r.found_at} empty="Unknown" /> },
  { key: "status", header: "Status", width: "7rem", text: (r) => r.status, sortValue: (r) => JOB_STATUSES.indexOf(r.status), render: (r) => <StatusCell status={r.status} /> },
];

const fileTitle = (f: CompanyFile) => f.label || friendlyFile(f.path).title;
/** "notes/call.md" -> "In notes · Text". */
const fileMeta = (f: CompanyFile) => [f.path.includes("/") ? `In ${f.path.split("/")[0]}` : "", friendlyFile(f.path).type, bytes(f.size)].filter(Boolean).join(" · ");

function CompanyView({ slug, tab }: { slug: string; tab: Tab }) {
  const bridge = useBridge();
  const openLink = useOpenLink();
  const { showSponsorship, loading } = useSponsorshipFocus();
  const { data: d, error } = useLoad((b) => b.companies.get(slug), [slug], ["sponsors", "jobs", "mail"]);
  const viewer = useFileViewer((d?.files ?? []).map((f) => ({ rel: f.rel, title: fileTitle(f), at: f.at })));
  const del = useDelete();
  usePageName(d ? displayName(d.company.name) : undefined);

  if (error && !d) {
    return <ErrorState title="This company can't be shown" text={errorSentence(error)} action={<Button onClick={() => navigate({ screen: "companies" })}>All companies</Button>} />;
  }
  if (!d || loading) return <Loading />;
  const c = d.company;
  // A list-only employer is sponsorship research: someone who doesn't need sponsorship never lands on one.
  if (!c.slug && !showSponsorship) {
    return <EmptyState boxed text="This company isn't in your workspace." action={<Button onClick={() => navigate({ screen: "companies" })}>All companies</Button>} />;
  }
  const shown: Tab = tab === "sponsorship" && !showSponsorship ? "jobs" : tab;
  const target: ActionTarget | null = c.slug ? { kind: "company", company_slug: c.slug } : null;
  const site = c.website && openable(c.website) ? c.website : "";
  const where = d.locations.slice(0, 3).join(" · ") + (d.locations.length > 3 ? ` and ${d.locations.length - 3} more` : "");
  const noFolder = "Save a job with this company first. Claude needs its folder to save the research.";

  return (
    <>
      {error ? <ErrorState title="This company can't be refreshed" text={errorSentence(error)} /> : null}
      <header className="job-head company-head" data-tour="company-head">
        <div className="company-head__main">
          <CompanyMark name={c.name} size="lg" />
          <div className="job-head__main">
            <h1 className={cx("t-display", "job-head__title", c.name.length > 48 && "job-head__title--long")} title={displayName(c.name)}>{displayName(c.name)}</h1>
            <div className="row job-head__meta">
              {site ? (
                <button type="button" className="company-link" title={`Open ${site}`} onClick={() => openLink(site, "the website")}>
                  {hostOf(site)}
                </button>
              ) : null}
              {where ? <Text role="body" muted as="span">{where}</Text> : null}
              <Text role="body" muted as="span">{headerJobsText(c)}</Text>
              {c.aliases.length ? <Text role="body-sm" muted as="span">{`Also ${c.aliases.map(displayName).join(", ")}`}</Text> : null}
            </div>
          </div>
        </div>
        <div className="job-head__actions">
          {site ? <Button icon={Icons.openExternal} onClick={() => openLink(site, "the website")}>Open website</Button> : null}
          {target && d.research?.stale ? (
            <span className="row">
              <Text role="body-sm" muted as="span" id="company-research-age">{researchAgeText(d.research.days)}</Text>
              <ActionButton action="research_company" target={target} size="md" label="Refresh" again ariaLabel={`Refresh the research on ${displayName(c.name)}`} />
            </span>
          ) : target ? <ActionButton action="research_company" target={target} size="md" /> : (
            <span className="row"><Button size="md" disabled aria-describedby="company-research-why">Research company</Button><Text role="body-sm" muted id="company-research-why">{noFolder}</Text></span>
          )}
          {/* Only a company with a folder can be deleted; a list-only employer is sponsorship research, not the person's item. */}
          {c.slug ? (
            <MoreMenu label="More company actions" size="md" items={[{
              id: "delete", label: "Delete company", tone: "danger",
              onSelect: () => del.ask([{ kind: "company", company_slug: c.slug! }], {
                label: "Delete company", onDeleted: () => navigate({ screen: "companies" }), onRestored: () => navigate({ screen: "company", slug }),
              }),
            }]} />
          ) : null}
        </div>
      </header>
      {del.element}

      <Tabs label="Company sections" value={shown} onChange={(t) => navigate({ screen: "company", slug, tab: t })}
        tabs={[
          { id: "jobs", label: "Jobs", count: d.jobs.length },
          { id: "mail", label: "Mail", count: c.mail },
          { id: "contacts", label: "Contacts", count: d.contacts?.emails.length ?? 0 },
          { id: "research", label: "Research", count: d.files.length },
          { id: "timeline", label: "Timeline", count: d.timeline.length },
          ...(showSponsorship ? [{ id: "sponsorship", label: "Sponsorship" }] : []),
        ]}>
        {shown === "jobs" ? (
          <div className="stack job-panel" data-tour="company-jobs">
            {d.jobs.length ? (
              <Table caption={`Jobs at ${displayName(c.name)}`} columns={jobCols(showSponsorship)} rows={d.jobs} rowKey={(r) => r.id} itemLabel="job"
                onRowActivate={(r) => navigate({ screen: "job", slug: r.company_slug, id: r.id })} />
            ) : (
              <EmptyState boxed text="No jobs saved with this company yet. Find jobs adds them here when they turn up."
                action={<Button onClick={() => navigate({ screen: "jobs" })}>Open Jobs</Button>} />
            )}
            <PeopleYouKnow company={c.name} />
          </div>
        ) : null}
        {shown === "mail" ? (
          <div className="job-panel">{c.slug ? <CompanyMail slug={c.slug} /> : <EmptyState boxed text="No emails with this company yet." />}</div>
        ) : null}
        {shown === "contacts" ? (
          <div className="job-panel">
            {c.slug && target ? (
              <CompanyContactsPanel name={c.name} slug={c.slug} contacts={d.contacts} jobs={d.jobs}
                research={<ActionButton action="research_company" target={target} variant="primary" size="md" />} />
            ) : <EmptyState boxed text={noFolder} />}
          </div>
        ) : null}
        {shown === "research" ? (
          <div className="stack job-panel">
            {d.research && target ? (
              <div className="row" data-research-age={d.research.stale ? "stale" : "fresh"}>
                <Text role="body-sm" muted={!d.research.stale} as="p">
                  {d.research.stale
                    ? `${researchAgeText(d.research.days)}. Research older than ${RESEARCH_STALE_DAYS} days may be out of date, so Claude won't reuse it when scoring or tailoring until it's refreshed.`
                    : `${researchAgeText(d.research.days)}.`}
                </Text>
                {d.research.stale ? <ActionButton action="research_company" target={target} label="Refresh" again ariaLabel={`Refresh the research on ${displayName(c.name)}`} /> : null}
              </div>
            ) : null}
            {d.files.length ? (
              <ul className="list-plain" data-tour="company-files">
                {d.files.map((f) => (
                  <li key={f.rel} className="row job-file">
                    <button type="button" className="company-file" onClick={() => viewer.open(f.rel)}>
                      <span className="company-file__name">{fileTitle(f)}</span>
                      <Text role="body-sm" muted as="span">{[fileMeta(f), fmtWhen(f.at) ? `Changed ${fmtWhen(f.at)}` : ""].filter(Boolean).join(" · ")}</Text>
                    </button>
                    <Button size="sm" variant="ghost" icon={Icons.show} aria-label={`View ${fileTitle(f)}`} onClick={() => viewer.open(f.rel)}>View</Button>
                    <Button size="sm" variant="ghost" icon={Icons.showInFolder} title={showInFolderLabel()} aria-label={`${showInFolderLabel()}: ${fileTitle(f)}`} onClick={() => void bridge.files.reveal(f.rel)}>{showInFolderLabel()}</Button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState boxed text={target ? "No research or notes yet. Ask Claude to research this company, or add files to its folder." : noFolder}
                action={target ? <ActionButton action="research_company" target={target} variant="primary" size="md" /> : undefined} />
            )}
            {viewer.element}
          </div>
        ) : null}
        {shown === "timeline" ? (
          <div className="stack job-panel">
            {d.timeline.length ? (
              <ul className="list-plain timeline">
                {d.timeline.map((e, i) => (
                  <li key={`${e.at}-${e.job_id}-${i}`}>
                    <Text role="body-sm" muted>{fmtWhen(e.at) || e.at}</Text>
                    <span>
                      <Text role="body" as="div">{e.event}</Text>
                      {e.note ? <Text role="body-sm" muted as="div">{e.note}</Text> : null}
                      <button type="button" className="company-link company-link--sm" onClick={() => navigate({ screen: "job", slug: c.slug!, id: e.job_id, tab: "timeline" })}>{displayName(e.job_title)}</button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <EmptyState boxed text="Nothing has happened here yet. Status changes, notes and emails on this company's jobs show up here." />}
          </div>
        ) : null}
        {shown === "sponsorship" && showSponsorship ? (
          <div className="stack job-panel" data-tour="company-sponsor">
            <div className="row row--between">
              <Text role="body-sm" muted>{`What you know about whether ${displayName(c.name)} sponsors visas. ${c.sponsor.evidence.length ? `${plural(c.sponsor.evidence.length, "piece")} of evidence on file.` : "No evidence on file yet."}`}</Text>
              {target ? <ActionButton action="research_company" target={target} label="Check again" ariaLabel={`Check ${displayName(c.name)} again`} /> : (
                <span className="row"><Button size="sm" disabled aria-describedby="company-check-why">Check again</Button><Text role="body-sm" muted id="company-check-why">{noFolder}</Text></span>
              )}
            </div>
            <SponsorDetails c={c} />
          </div>
        ) : null}
      </Tabs>
    </>
  );
}

