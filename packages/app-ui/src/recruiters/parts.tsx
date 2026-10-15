import { cx, Icon, Icons, Pill, Text, type PillTone } from "@careeros/brand";
import { AGENCY_STATUS_LABELS, type AgencyRow, type AgencySource, type AgencyStatus } from "@careeros/contract";
import { DateText } from "../components/DateText";
import { displayName } from "../components/displayName";
import { openable, useOpenLink } from "../companies/parts";
import { boardBySite, boardByUrl } from "../source/boards";
import { BoardIcon } from "../source/SourceBadge";

/** Only details the agency publishes itself; shown on the list, the agency's page and in the email composer. */
export const RECRUITER_NOTE = "Only contact details recruiters publish. Check before sending.";

/** "Technology, Government · Sampletown · since 2009": specialty, area and the year it started, when known. */
export function agencySubtitle(a: Pick<AgencyRow, "specialties" | "cities" | "since">): string {
  return [a.specialties.slice(0, 3).join(", "), a.cities.slice(0, 3).join(", "), a.since ? `since ${a.since}` : ""].filter(Boolean).join(" · ");
}

/** Why Email is off, or "" when it can open a draft: it needs a published address (no saved job is needed). */
export function emailBlocker(a: Pick<AgencyRow, "email">): string {
  return a.email ? "" : "No published email address yet.";
}

const STATUS_TONE: Record<AgencyStatus, PillTone> = { to_contact: "neutral", contacted: "accent", replied: "success", meeting: "success", not_a_fit: "warning" };
export function AgencyStatusPill({ status }: { status: AgencyStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{AGENCY_STATUS_LABELS[status]}</Pill>;
}

/** The star toggle: on the list's rows and in the agency page's header. */
export function StarButton({ a, onToggle, size = "sm" }: { a: Pick<AgencyRow, "name" | "favourite">; onToggle: () => void; size?: "sm" | "md" }) {
  const name = displayName(a.name);
  return (
    <button type="button" className={cx("agency-star", `agency-star--${size}`, a.favourite && "agency-star--on")} aria-pressed={a.favourite}
      aria-label={a.favourite ? `Unstar ${name}` : `Star ${name}`} title={a.favourite ? "Starred" : "Star"} onClick={onToggle}>
      <Icon icon={Icons.favourite} size={size} />
    </button>
  );
}

/** Where it was found, oldest first; an older record has none. */
export const sourcesOf = (a: Pick<AgencyRow, "sources">): AgencySource[] => (a.sources ?? []).filter((s) => s.name.trim());
/** "SEEK", "SEEK +2", or "" with no sources. */
export const sourcesText = (a: Pick<AgencyRow, "sources">) => {
  const s = sourcesOf(a);
  return s.length ? `${s[0]!.name}${s.length > 1 ? ` +${s.length - 1}` : ""}` : "";
};

/** A source's board logo when it's a known board (by name, then by page), else nothing: the name always shows. */
function SourceMark({ s }: { s: AgencySource }) {
  const board = boardBySite(s.name) ?? (openable(s.url) ? boardByUrl(s.url) : undefined);
  return board ? <BoardIcon id={board.id} size="sm" /> : null;
}

/** The list's Found on cell: the first source's mark and name, then "+N", like a job's source badge. */
export function SourcesCell({ a }: { a: Pick<AgencyRow, "sources"> }) {
  const s = sourcesOf(a);
  if (!s.length) return <Text role="body-sm" muted as="span">Not recorded</Text>;
  return (
    <span className="agency-source" title={s.map((x) => x.name).join(", ")}>
      <SourceMark s={s[0]!} />
      <Text role="body-sm" as="span" truncate>{s[0]!.name}</Text>
      {s.length > 1 ? <Text role="body-sm" muted as="span">{`+${s.length - 1}`}</Text> : null}
    </span>
  );
}

/** The agency page's Found on list: each source by name, opening its page when it has a safe one, and when. */
export function SourcesList({ a }: { a: Pick<AgencyRow, "sources" | "name"> }) {
  const open = useOpenLink();
  const s = sourcesOf(a);
  if (!s.length) return <Text role="body-sm" muted as="p">Not recorded. Agencies found from now on show where they turned up.</Text>;
  return (
    <ul className="list-plain stack-tight" aria-label="Found on">
      {s.map((x, i) => (
        <li key={`${x.name}-${x.url}-${i}`} className="row agency-source">
          <SourceMark s={x} />
          {openable(x.url)
            ? <button type="button" className="company-link" title={x.url} aria-label={`Open where ${displayName(a.name)} was found on ${x.name}`} onClick={() => open(x.url, x.name)}>{x.name}</button>
            : <Text role="body" as="span">{x.name}</Text>}
          {x.found_at ? <DateText value={x.found_at} /> : null}
        </li>
      ))}
    </ul>
  );
}
