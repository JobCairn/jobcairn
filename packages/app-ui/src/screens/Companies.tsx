import { Button, Input, Select, Table, Text, type Column } from "@careeros/brand";
import { JOB_STATUSES, STAGE_ORDER, type CompanyRow } from "@careeros/contract";
import { useLoad } from "../bridge-context";
import { CompanyMark, hostOf, openJobsText, statusesText } from "../companies/parts";
import { DateText } from "../components/DateText";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { EmptyState, ErrorState, Loading, ScreenHead } from "../components/States";
import { FitCell, SponsorCell, StatusCell } from "../jobs/cells/cells";
import { fitView } from "../jobs/cells/meta";
import { plural, SPONSOR_STATUS_ORDER, sponsorStatus, sponsorStatusKey } from "../format";
import { useKept } from "../nav";
import { navigate } from "../router";
import { routePage, writePage } from "../components/listPage";
import { placesOf, regionForPlaces } from "../sponsors/region";
import { useSponsorshipFocus } from "../useSponsorshipFocus";
import "../styles/tables.css";

type Show = "" | "open" | "applied" | "none";
type Tri = "" | "yes" | "no" | "unknown";
const APPLIED: readonly string[] = ["Applied", "Interview", "Offer"];
const SHOW: Record<Exclude<Show, "">, (r: CompanyRow) => boolean> = {
  open: (r) => r.open_jobs > 0,
  applied: (r) => JOB_STATUSES.some((s) => APPLIED.includes(s) && r.statuses[s]),
  none: (r) => r.jobs === 0,
};

const NAME_COL: Column<CompanyRow> = {
  key: "name", header: "Company", alwaysOn: true, sortValue: (r) => r.name.toLowerCase(),
  text: (r) => [displayName(r.name), ...r.aliases.map(displayName)].join(" / "),
  render: (r) => (
    <span className="company-cell">
      <CompanyMark name={r.name} />
      <span className="cell-two">
        <Text role="body" as="span">{displayName(r.name)}</Text>
        {r.website || r.aliases.length ? (
          <Text role="body-sm" muted as="span">{[r.website ? hostOf(r.website) : "", r.aliases.length ? `Also ${r.aliases.map(displayName).join(", ")}` : ""].filter(Boolean).join(" · ")}</Text>
        ) : null}
      </span>
    </span>
  ),
};
const JOBS_COL: Column<CompanyRow> = {
  key: "jobs", header: "Open jobs", width: "8.5rem", sortValue: (r) => r.open_jobs * 1000 + r.jobs, firstSort: "desc", text: openJobsText,
  render: (r) => <Text role="body-sm" muted={r.open_jobs === 0} as="span">{openJobsText(r)}</Text>,
};
const FIT_COL: Column<CompanyRow> = {
  key: "fit", header: "Best fit", align: "center", width: "6.5rem", sortValue: (r) => r.best_fit, firstSort: "desc",
  text: (r) => (r.best_fit === null ? (r.jobs ? "Not scored" : "") : fitView(r.best_fit)?.label ?? ""),
  render: (r) => (r.jobs ? <FitCell fit={r.best_fit} /> : <Text role="body-sm" muted as="span">None</Text>),
};
const STAGE_COL: Column<CompanyRow> = {
  key: "stage", header: "Your applications", width: "10rem", sortValue: (r) => (r.stage ? STAGE_ORDER.indexOf(r.stage) : null),
  text: (r) => (r.stage ? statusesText(r.statuses) : "No jobs yet"),
  render: (r) => (r.stage ? (
    <span className="company-stage" title={statusesText(r.statuses)}>
      <StatusCell status={r.stage} />
      {r.jobs > 1 ? <Text role="body-sm" muted as="span">{`+${r.jobs - 1}`}</Text> : null}
    </span>
  ) : <Text role="body-sm" muted as="span">No jobs yet</Text>),
};
const ACTIVITY_COL: Column<CompanyRow> = {
  key: "activity", header: "Last activity", width: "8.5rem", priority: "low", sortValue: (r) => r.last_activity || null, firstSort: "desc",
  render: (r) => <DateText value={r.last_activity} empty="None yet" />,
};
const MAIL_COL: Column<CompanyRow> = {
  key: "mail", header: "Emails", align: "end", width: "5.5rem", priority: "low", sortValue: (r) => r.mail, firstSort: "desc", text: (r) => String(r.mail),
  render: (r) => <Text role="body-sm" muted={r.mail === 0} as="span">{r.mail ? String(r.mail) : "None"}</Text>,
};
const SPONSOR_COL: Column<CompanyRow> = {
  key: "sponsor", header: "Sponsor score", width: "8.5rem", sortValue: (r) => r.sponsor.score, firstSort: "desc",
  text: (r) => `${r.sponsor.tier}, ${r.sponsor.score} of 100`,
  render: (r) => <SponsorCell score={r.sponsor.score} label="silent" reasons={r.sponsor.reasons} />,
};

/**
 * Every company in the workspace: where you stand with each. For people who need sponsorship it also carries the
 * sponsor score and the employers known only from the sponsor list; for everyone else there's no visa wording at all.
 */
export function CompaniesScreen() {
  const { showSponsorship, loading } = useSponsorshipFocus();
  const { data, error } = useLoad((b) => b.companies.list(), [], ["sponsors", "jobs", "mail"]);
  const profile = useLoad((b) => b.settings.get("profile"), [], ["settings"]);
  const [text, setText] = useKept("companies:text", () => "");
  const [show, setShow] = useKept<Show>("companies:show", () => "");
  const [status, setStatus] = useKept("companies:status", () => "");
  const [qld, setQld] = useKept<Tri>("companies:region", () => "");
  const sub = "Every company you have jobs, emails or research with. Click one to see everything about it.";
  const head = <ScreenHead title="Companies" sub={sub} settings={showSponsorship ? "companies" : undefined} />;

  if (error && !data) return <>{head}<ErrorState title="Companies can't be shown" text={errorSentence(error)} /></>;
  if (!data || loading) return <>{head}<Loading /></>;
  // List-only employers come from the sponsor list: they're sponsorship research, so only people who need it see them.
  const all = showSponsorship ? data : data.filter((r) => r.slug !== null);
  const region = showSponsorship ? regionForPlaces(placesOf(profile.data?.values as Record<string, unknown> | undefined)) : null;
  const q = text.trim().toLowerCase();
  const rows = all.filter((r) =>
    (!q || [r.name, ...r.aliases, r.website].some((n) => n.toLowerCase().includes(q)))
    && (!show || SHOW[show](r))
    && (!showSponsorship || !status || sponsorStatusKey(r.sponsor.status) === status)
    && (!region || !qld || (qld === "yes" ? r.sponsor.qld === true : qld === "no" ? r.sponsor.qld === false : r.sponsor.qld === null)));
  const filtersOn = !!(q || show || (showSponsorship && (status || qld)));
  const clear = () => { setText(""); setShow(""); setStatus(""); setQld(""); };

  if (all.length === 0) {
    return (
      <>
        {head}
        <EmptyState boxed text="No companies yet. A company appears here when you save a job with it or file an email from it."
          action={<Button variant="primary" onClick={() => navigate({ screen: "jobs" })}>Find jobs</Button>} />
      </>
    );
  }

  const columns = [NAME_COL, JOBS_COL, FIT_COL, STAGE_COL, ...(showSponsorship ? [SPONSOR_COL] : []), ACTIVITY_COL, MAIL_COL];
  const statuses = SPONSOR_STATUS_ORDER.filter((s) => all.some((r) => sponsorStatusKey(r.sponsor.status) === s));
  return (
    <>
      {head}
      {error ? <ErrorState title="Companies can't be refreshed" text={errorSentence(error)} /> : null}
      <div data-tour="companies-table">
        <Table caption="Companies" id="companies" columns={columns} rows={rows} rowKey={(r) => r.key} itemLabel="company"
          defaultSort={{ key: "activity", dir: "desc" }}
          filters={(
          <div className="filters filters--wrap" data-tour="companies-filters">
            <Input label="Find a company" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or website" />
            <Select label="Show" value={show} onChange={(e) => setShow(e.target.value as Show)}
              options={[{ value: "", label: "All companies" }, { value: "open", label: "With open jobs" }, { value: "applied", label: "Applied or further" }, { value: "none", label: "No jobs yet" }]} />
            {showSponsorship ? (
              <Select label="Sponsor status" value={status} onChange={(e) => setStatus(e.target.value)}
                options={[{ value: "", label: "Any status" }, ...statuses.map((s) => ({ value: s, label: sponsorStatus(s).text }))]} />
            ) : null}
            {region && all.some((r) => r.sponsor.qld !== null) ? (
              <Select label={`Office in ${region.name}`} value={qld} onChange={(e) => setQld(e.target.value as Tri)}
                options={[{ value: "", label: "Anywhere" }, { value: "yes", label: `In ${region.name}` }, { value: "no", label: `Not in ${region.name}` }, { value: "unknown", label: "Not recorded" }]} />
            ) : null}
          </div>
          )}
          resetKey={`${q}|${show}|${status}|${qld}`} page={routePage()} onPageChange={writePage}
          toolbar={(
            <>
              <Text role="body-sm" muted as="span">{rows.length === all.length ? plural(all.length, "company", "companies") : `${rows.length} of ${plural(all.length, "company", "companies")}`}</Text>
              {filtersOn ? <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button> : null}
            </>
          )}
          onRowActivate={(r) => navigate({ screen: "company", slug: r.key })}
          emptyText="No companies match these filters." />
      </div>
    </>
  );
}
