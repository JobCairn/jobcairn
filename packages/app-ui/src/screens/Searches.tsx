import { useState } from "react";
import { Input, Select, Table, Text, type Column, type DetailField } from "@careeros/brand";
import { boardRank, type SearchRow } from "@careeros/contract";
import { useLoad } from "../bridge-context";
import { routePage, writePage } from "../components/listPage";
import { DateText } from "../components/DateText";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { ActionButton, WORKSPACE } from "../components/ActionButton";
import { EmptyState, ErrorState, Loading, ScreenHead } from "../components/States";
import { leadingNumber, plural } from "../format";
import "../styles/tables.css";

const RECENT = "Run in the last 7 days";
/** How each search ran. Searches logged before the app recorded this say so instead of guessing. */
const MODE_LABEL: Record<SearchRow["mode"], string> = { chrome: "Your Chrome", web: "Web search", "": "Not recorded" };

/** "81 (c. 30 relevant)" shows as "81" with a dotted underline; the full text is in the tooltip and the drawer. */
function Count({ text }: { text: string }) {
  const n = leadingNumber(text);
  if (n === null) return <Text role="body-sm" muted as="span">{text ? displayName(text) : "–"}</Text>;
  // Keep a trailing "+" ("2,000+"): dropping it would understate the count.
  const shown = `${n.toLocaleString("en-AU")}${/^\D{0,3}?[\d,.]+\s*\+/.test(text.trim()) ? "+" : ""}`;
  const more = text.trim() !== String(n) && text.trim() !== shown;
  return <span className={more ? "count has-more" : "count"}><Text role="numeric" as="span">{shown}</Text></span>;
}

const COLUMNS: Column<SearchRow>[] = [
  {
    key: "at", header: "When", width: "9.5rem", sortValue: (r) => r.at, firstSort: "desc",
    render: (r) => (
      <span className="when-cell">
        <span className={r.recent ? "recent-dot" : "recent-dot recent-dot--off"} aria-hidden="true" />
        {r.recent ? <span className="sr-only">{RECENT}</span> : null}
        <DateText value={r.at} />
      </span>
    ),
    detail: (r) => <DateText value={r.at} hint />,
  },
  // Sorts in the one board order (LinkedIn, SEEK, Indeed, Glassdoor, Jora, other boards, ATS sources), not A to Z.
  { key: "site", header: "Site", width: "8rem", text: (r) => displayName(r.site), sortValue: (r) => boardRank(r.site), render: (r) => <Text role="body-sm" as="span">{displayName(r.site)}</Text> },
  { key: "mode", header: "Searched in", width: "8rem", priority: "low", hideWhenEmpty: true, isEmpty: (r) => !r.mode, text: (r) => MODE_LABEL[r.mode], sortValue: (r) => MODE_LABEL[r.mode],
    render: (r) => <Text role="body-sm" as="span" muted={!r.mode}>{MODE_LABEL[r.mode]}</Text> },
  { key: "query", header: "Query", text: (r) => displayName(r.query), render: (r) => <Text role="body" as="span">{displayName(r.query)}</Text> },
  { key: "location", header: "Location", width: "11rem", priority: "low", text: (r) => displayName(r.location), render: (r) => <Text role="body-sm" as="span">{displayName(r.location)}</Text> },
  {
    key: "results", header: "Results", align: "end", width: "6.5rem", text: (r) => displayName(r.results), sortValue: (r) => leadingNumber(r.results), firstSort: "desc",
    render: (r) => <Count text={r.results} />,
  },
  {
    key: "kept", header: "Kept", align: "end", width: "5rem", text: (r) => displayName(r.kept), sortValue: (r) => leadingNumber(r.kept), firstSort: "desc",
    render: (r) => <Count text={r.kept} />,
  },
  { key: "notes", header: "Notes", wrap: true, text: (r) => displayName(r.notes), render: (r) => <Text role="body-sm" muted as="span">{displayName(r.notes)}</Text> },
];

type When = "" | "recent" | "older";

export function SearchesScreen() {
  const { data, error } = useLoad((b) => b.searches.list(), [], ["searches"]);
  const [text, setText] = useState("");
  const [site, setSite] = useState("");
  const [when, setWhen] = useState<When>("");
  if (error && !data) return <ErrorState title="Searches can't be shown" text={errorSentence(error)} />;
  if (!data) return <Loading />;
  // A reload can fail (the search log became unreadable) while we still hold the last-known
  // rows. Show the error over the stale table instead of pretending it's current.
  const broken = !!error;
  const q = text.trim().toLowerCase();
  const rows = data.rows.filter((r) =>
    (!site || r.site === site)
    && (!when || (when === "recent" ? r.recent : !r.recent))
    && (!q || [r.query, r.location, r.notes, r.site].some((v) => v.toLowerCase().includes(q))));
  const recentCount = data.rows.filter((r) => r.recent).length;

  const detail = (r: SearchRow) => {
    const fields: DetailField[] = [
      { label: "When", value: <><DateText value={r.at} hint />{r.recent ? <Text role="body-sm" muted>{`${RECENT}, so Claude won't repeat it yet.`}</Text> : null}</> },
      { label: "Site", value: displayName(r.site) },
      { label: "Searched in", value: r.mode === "chrome" ? "Your Chrome, signed in as you" : r.mode === "web" ? "Web search (Search in my Chrome wasn't used)" : "Not recorded (logged before this was kept)" },
      { label: "Location", value: displayName(r.location) },
      { label: "Results", value: displayName(r.results) },
      { label: "Kept", value: displayName(r.kept) },
      { label: "Notes", value: displayName(r.notes), wide: true },
    ];
    return { title: displayName(r.query) || "Search", fields };
  };

  return (
    <>
      <ScreenHead title="Searches" sub="Every search Claude ran. Searches from the last 7 days are skipped, so nothing is repeated. Select a row to see it in full."
        right={data.rows.length ? <ActionButton action="find_jobs" target={WORKSPACE} variant="primary" /> : undefined} settings="searches" />
      {broken ? <ErrorState title="Searches can't be refreshed" text={errorSentence(error)} /> : null}
      {data.rows.length === 0 && !broken ? (
        // First use: nothing to filter yet, so say what fills this log and offer the way to start it.
        <EmptyState boxed text="No searches yet. Each time Claude looks for jobs, the search is logged here so it isn't repeated within 7 days."
          action={<ActionButton action="find_jobs" target={WORKSPACE} variant="primary" />} />
      ) : (<>
      <Table caption="Searches" id="searches" columns={COLUMNS} rows={rows} rowKey={(r) => `${r.at}|${r.site}|${r.query}|${r.location}`} itemLabel="search"
        filters={(
          <div className="filters">
            <Input label="Find a search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Query, place or note" />
            <Select label="Site" value={site} onChange={(e) => setSite(e.target.value)} options={[{ value: "", label: "All sites" }, ...data.sites.map((s) => ({ value: s, label: displayName(s) }))]} />
            <Select label="When" value={when} onChange={(e) => setWhen(e.target.value as When)}
              options={[{ value: "", label: "Any time" }, { value: "recent", label: "Last 7 days" }, { value: "older", label: "Older than 7 days" }]} />
          </div>
        )}
        toolbar={(
          <p className="legend t-body-sm t-muted">
            {`${rows.length !== data.rows.length ? `${rows.length} of ` : ""}${plural(data.rows.length, "search", "searches")}. `}
            <span className="recent-dot" aria-hidden="true" />
            {`${recentCount} in the last 7 days. Open a row for the full search.`}
          </p>
        )}
        resetKey={`${q}|${site}|${when}`} page={routePage()} onPageChange={writePage}
        defaultSort={{ key: "at", dir: "desc" }} detail={detail}
        emptyText={data.rows.length === 0 ? "No searches yet. This log fills in as Claude logs each search." : "No searches match these filters."} />
      </>)}
    </>
  );
}
