import { useState } from "react";
import { Button, Checkbox, Dialog, Input, Pill, Select, Table, Text, useToast, type Column } from "@careeros/brand";
import { AGENCY_STATUS_LABELS, AGENCY_STATUSES, agencyFacets, filterAgencies, localDate, type AgencyPatch, type AgencyRow } from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { ActionButton } from "../components/ActionButton";
import { CompanyMark, hostOf } from "../companies/parts";
import { DateText } from "../components/DateText";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { routePage, writePage } from "../components/listPage";
import { EmptyState, ErrorState, Loading, ScreenHead } from "../components/States";
import { plural } from "../format";
import { useKept } from "../nav";
import { navigate } from "../router";
import { BulkEmail } from "../recruiters/BulkEmail";
import { AgencyStatusPill, RECRUITER_NOTE, SourcesCell, sourcesOf, sourcesText, StarButton } from "../recruiters/parts";
import { useSponsorshipFocus } from "../useSponsorshipFocus";
import "../styles/tables.css";
import "../recruiters/recruiters.css";

const WORKSPACE = { kind: "workspace" } as const;
const TAGS_SHOWN = 3;

const NAME_COL: Column<AgencyRow> = {
  key: "name", header: "Agency", alwaysOn: true, minWidth: "13rem", sortValue: (r) => r.name.toLowerCase(), text: (r) => displayName(r.name),
  render: (r) => (
    <span className="company-cell">
      <CompanyMark name={r.name} />
      <span className="cell-two">
        <Text role="body" as="span">{displayName(r.name)}</Text>
        {r.website ? <Text role="body-sm" muted as="span">{[hostOf(r.website), r.since ? `since ${r.since}` : ""].filter(Boolean).join(" · ")}</Text> : null}
      </span>
    </span>
  ),
};
const CITIES_COL: Column<AgencyRow> = {
  key: "cities", header: "Cities", width: "9rem", text: (r) => r.cities.join(", "), sortValue: (r) => r.cities[0]?.toLowerCase() ?? null,
  render: (r) => <Text role="body-sm" truncate muted={!r.cities.length}>{r.cities.length ? r.cities.join(", ") : "Not recorded"}</Text>,
};
const TAGS_COL: Column<AgencyRow> = {
  key: "tags", header: "Tags", width: "13rem", priority: "low", sortable: false, text: (r) => r.all_tags.join(", "),
  render: (r) => (r.all_tags.length ? (
    <span className="agency-tags" aria-label={`Tags: ${r.all_tags.join(", ")}`}>
      {r.all_tags.slice(0, TAGS_SHOWN).map((t) => <Pill key={t}>{t}</Pill>)}
      {r.all_tags.length > TAGS_SHOWN ? <Text role="body-sm" muted as="span">{`+${r.all_tags.length - TAGS_SHOWN}`}</Text> : null}
    </span>
  ) : <Text role="body-sm" muted as="span">None</Text>),
};
const HIRING_COL: Column<AgencyRow> = {
  key: "hiring", header: "Hiring for", minWidth: "12rem", sortable: false, text: (r) => r.hiring_summary,
  render: (r) => <Text role="body-sm" truncate muted={!r.hiring_summary}>{r.hiring_summary || "Not recorded"}</Text>,
};
const FOUND_COL: Column<AgencyRow> = {
  key: "found", header: "Found on", width: "8.5rem", priority: "low", text: sourcesText, sortValue: (r) => sourcesText(r).toLowerCase() || null,
  render: (r) => <SourcesCell a={r} />,
};
const STATUS_COL: Column<AgencyRow> = {
  key: "status", header: "Status", width: "7.5rem", text: (r) => AGENCY_STATUS_LABELS[r.tracking.status], sortValue: (r) => AGENCY_STATUSES.indexOf(r.tracking.status),
  render: (r) => <AgencyStatusPill status={r.tracking.status} />,
};
const FOLLOW_COL: Column<AgencyRow> = {
  key: "follow", header: "Follow up", width: "7.5rem", sortValue: (r) => r.tracking.follow_up_on || null,
  render: (r) => <DateText value={r.tracking.follow_up_on} empty="None" />,
};

/**
 * Recruiters: recruitment agencies in one sortable table, like Companies. Search, tag, city, where they were found and
 * (for people who need sponsorship) a sponsorship-signal filter, all kept when you come back from an agency's page.
 * Tick rows to email them (BulkEmail) or mark them contacted in one go; click a row for the agency's own page
 * (Recruiter.tsx). Agencies come from Find recruiters (Claude, published pages only) and from recruiter job ads you save.
 */
export function RecruitersScreen() {
  const bridge = useBridge();
  const toast = useToast();
  const { run, busy } = useAction();
  const { showSponsorship } = useSponsorshipFocus();
  const { data, error } = useLoad((b) => b.recruiters.list(), [], ["recruiters", "jobs", "claude", "mail"]);
  const [q, setQ] = useKept("recruiters:q", () => "");
  const [tag, setTag] = useKept("recruiters:tag", () => "");
  const [city, setCity] = useKept("recruiters:city", () => "");
  const [src, setSrc] = useKept("recruiters:source", () => "");
  const [sponsor, setSponsor] = useKept("recruiters:sponsor", () => false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);

  const head = <ScreenHead title="Recruiters" sub="Recruitment agencies that place people in your roles. Click one to see everything about it."
    right={<span data-tour="recruiters-find"><ActionButton action="find_recruiters" target={WORKSPACE} variant="primary" size="md" /></span>} />;
  if (error && !data) return <>{head}<ErrorState title="Recruiters can't be shown" text={errorSentence(error)} /></>;
  if (!data) return <>{head}<Loading /></>;
  if (!data.length) {
    return <>{head}<EmptyState boxed text="No recruiters yet. Find recruiters asks Claude to look up agencies for your roles and cities. Agencies also appear here when you save a job a recruiter advertised." /></>;
  }

  const facets = agencyFacets(data);
  const sources = [...new Set(data.flatMap((r) => sourcesOf(r).map((s) => s.name.trim())))].sort((a, b) => a.localeCompare(b));
  const rows = filterAgencies(data, { q, tag, city, sponsor: showSponsorship && sponsor })
    .filter((r) => !src || sourcesOf(r).some((s) => s.name.trim().toLowerCase() === src.toLowerCase()));
  const filtersOn = !!(q.trim() || tag || city || src || (showSponsorship && sponsor));
  const clear = () => { setQ(""); setTag(""); setCity(""); setSrc(""); setSponsor(false); };
  const chosen = data.filter((r) => picked.has(r.slug));
  const select = (slug: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(slug); else n.delete(slug); return n; });
  const change = (slug: string, patch: AgencyPatch) => void bridge.recruiters.update(slug, patch).catch((e: unknown) => toast({ tone: "danger", text: `Couldn't save: ${errorText(e)}` }));
  const markContacted = () => run("contacted", async () => {
    const today = localDate(new Date());
    for (const a of chosen) await bridge.recruiters.update(a.slug, { contacted_on: today });
    setPicked(new Set());
  }, `Marked ${plural(chosen.length, "agency", "agencies")} contacted`);

  // The tick box's name is for screen readers only; the row itself says which agency it is.
  const selectCol: Column<AgencyRow> = {
    key: "select", header: "", width: "2.75rem", align: "center", alwaysOn: true, sortable: false, inDetail: false,
    render: (r) => (
      <input type="checkbox" className="agency-select" aria-label={`Select ${displayName(r.name)}`} checked={picked.has(r.slug)}
        onChange={(e) => select(r.slug, e.target.checked)} />
    ),
  };
  const starCol: Column<AgencyRow> = {
    key: "star", header: "Star", width: "4rem", align: "center", firstSort: "desc", sortValue: (r) => (r.favourite ? 1 : 0), text: (r) => (r.favourite ? "Starred" : ""),
    isEmpty: () => false, inDetail: false, render: (r) => <StarButton a={r} onToggle={() => change(r.slug, { favourite: !r.favourite })} />,
  };
  const columns = [selectCol, starCol, NAME_COL, CITIES_COL, TAGS_COL, HIRING_COL, FOUND_COL, STATUS_COL, FOLLOW_COL];

  return (
    <>
      {head}
      <p role="note" className="agency-note"><Text role="body-sm" muted as="span">{RECRUITER_NOTE}</Text></p>
      <div data-tour="recruiters-table">
        <Table caption="Recruiters" id="recruiters" columns={columns} rows={rows} rowKey={(r) => r.slug} itemLabel="agency"
          filters={(
            <div className="filters filters--wrap" role="search" aria-label="Filter recruiters" data-tour="recruiters-filters">
              <Input label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, specialty or role" />
              <Select label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} options={[{ value: "", label: "All tags" }, ...facets.tags.map((t) => ({ value: t, label: t }))]} />
              <Select label="City" value={city} onChange={(e) => setCity(e.target.value)} options={[{ value: "", label: "All cities" }, ...facets.cities.map((c) => ({ value: c, label: c }))]} />
              {sources.length ? (
                <Select label="Found on" value={src} onChange={(e) => setSrc(e.target.value)} options={[{ value: "", label: "Anywhere" }, ...sources.map((s) => ({ value: s, label: s }))]} />
              ) : null}
              {showSponsorship ? <Checkbox label="Ads open to visa holders" checked={sponsor} onChange={(e) => setSponsor(e.target.checked)} /> : null}
            </div>
          )}
          resetKey={`${q}|${tag}|${city}|${src}|${sponsor}`} page={routePage()} onPageChange={writePage}
          toolbar={(
            <>
              <Text role="body-sm" muted as="span">{rows.length === data.length ? plural(data.length, "agency", "agencies") : `${rows.length} of ${plural(data.length, "agency", "agencies")}`}</Text>
              {filtersOn ? <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button> : null}
              {rows.length && chosen.length < rows.length ? (
                <Button size="sm" variant="ghost" aria-label={`Tick all ${plural(rows.length, "agency", "agencies")} shown`} onClick={() => setPicked(new Set([...picked, ...rows.map((r) => r.slug)]))}>Select all</Button>
              ) : null}
              {chosen.length ? (
                <span className="row agency-bulk" role="toolbar" aria-label="Selected recruiters" data-tour="recruiters-bulk">
                  <Text role="body-sm" as="span">{`${chosen.length} selected`}</Text>
                  <Button size="sm" onClick={() => setBulk(true)}>Email selected</Button>
                  <Button size="sm" loading={busy === "contacted"} onClick={() => void markContacted()}>Mark contacted</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
                </span>
              ) : null}
            </>
          )}
          onRowActivate={(r) => navigate({ screen: "recruiter", slug: r.slug })}
          emptyText="No recruiters match these filters." />
      </div>
      <Dialog open={bulk} onClose={() => setBulk(false)} title={`Email ${plural(chosen.length, "recruiter")}`}>
        {bulk ? <BulkEmail agencies={chosen} onDone={() => { setBulk(false); setPicked(new Set()); }} /> : null}
      </Dialog>
    </>
  );
}
