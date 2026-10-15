import { useEffect, useId, useState } from "react";
import { Button, Checkbox, cx, Icon, Icons, Input, Pill, Select, Text, Textarea } from "@careeros/brand";
import { AGENCY_STATUS_LABELS, AGENCY_STATUSES, type AgencyPatch, type AgencyRow, type AgencyStatus } from "@careeros/contract";
import { displayName } from "../components/displayName";
import { hostOf, openable, useOpenLink } from "../companies/parts";
import { useCopy } from "../companies/contacts";
import { plural } from "../format";
import { fmtWhen } from "../reading/dates";

/** Only details the agency publishes itself; shown on every card and in the email composer. */
export const RECRUITER_NOTE = "Only contact details recruiters publish. Check before sending.";

/** "Technology, Government · Sampletown · since 2009": specialty, area and the year it started, when known. */
export function agencySubtitle(a: Pick<AgencyRow, "specialties" | "cities" | "since">): string {
  return [a.specialties.slice(0, 3).join(", "), a.cities.slice(0, 3).join(", "), a.since ? `since ${a.since}` : ""].filter(Boolean).join(" · ");
}

/** Why Email is off, or "" when it can open a draft: it needs a published address (no saved job is needed). */
export function emailBlocker(a: Pick<AgencyRow, "email">): string {
  return a.email ? "" : "No published email address yet.";
}

/**
 * One agency on the Recruiters screen: select box and star, name and subtitle, tags, what it is hiring for now, the
 * team page note, its published contacts (email, phone, links), then the person's own tracking: status, contacted
 * and follow-up dates, and notes. Every change saves at once through `onChange` (notes when the box loses focus).
 */
export function AgencyCard({ a, selected, onSelect, onChange, onEmail, showSponsorship }: {
  a: AgencyRow; selected: boolean; onSelect: (on: boolean) => void; onChange: (patch: AgencyPatch) => void; onEmail: () => void; showSponsorship: boolean;
}) {
  const open = useOpenLink();
  const copy = useCopy();
  const headId = useId();
  const [notes, setNotes] = useState(a.tracking.notes);
  useEffect(() => setNotes(a.tracking.notes), [a.tracking.notes]);
  const name = displayName(a.name);
  const sub = agencySubtitle(a);
  const why = emailBlocker(a);
  const link = (url: string, label: string) => openable(url)
    ? <Button key={url + label} size="sm" variant="ghost" icon={Icons.openExternal} title={url} onClick={() => open(url, `${name}'s ${label.toLowerCase()}`)}>{label}</Button>
    : null;
  const best = a.best_contact.name && openable(a.best_contact.source_url) ? a.best_contact : null;

  return (
    <article className={cx("card", "agency-card", selected && "agency-card--selected")} aria-labelledby={headId}>
      <div className="agency-card__head">
        <Checkbox label={`Select ${name}`} className="agency-card__select" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        <button type="button" className={cx("agency-card__star", a.favourite && "agency-card__star--on")} aria-pressed={a.favourite}
          aria-label={a.favourite ? `Unstar ${name}` : `Star ${name}`} onClick={() => onChange({ favourite: !a.favourite })}>
          <Icon icon={Icons.favourite} size="sm" />
        </button>
        <div className="agency-card__title">
          <h2 id={headId} className="agency-card__name">{name}</h2>
          {sub ? <Text role="body-sm" muted as="div">{sub}</Text> : null}
        </div>
      </div>

      {a.all_tags.length ? <ul className="agency-card__tags" aria-label="Tags">{a.all_tags.map((t) => <li key={t}><Pill>{t}</Pill></li>)}</ul> : null}
      {a.hiring_summary ? <Text role="body" as="p" className="agency-card__summary">{a.hiring_summary}</Text> : null}
      {a.jobs.length ? (
        <Text role="body-sm" muted as="p" className="agency-card__jobs">
          {`${plural(a.jobs.filter((j) => j.open).length, "open job")} saved from them`}
          {showSponsorship && a.sponsor_jobs ? ` · ${plural(a.sponsor_jobs, "ad")} open to visa holders` : ""}
        </Text>
      ) : null}
      {a.team_note.text && openable(a.team_note.source_url) ? (
        <div className="agency-card__team" role="note">
          <Text role="body-sm" muted as="span">{a.team_note.text}</Text>{" "}
          <button type="button" className="company-link company-link--sm" onClick={() => open(a.team_note.source_url, "the team page")}>{`Source: ${hostOf(a.team_note.source_url)}`}</button>
        </div>
      ) : null}
      {best ? (
        <Text role="body-sm" as="p">
          {`Best reached through ${best.name}`}{" "}
          <button type="button" className="company-link company-link--sm" onClick={() => open(best.source_url, "the page that names them")}>{`(${hostOf(best.source_url)})`}</button>
        </Text>
      ) : null}

      <div className="agency-card__contact" role="group" aria-label={`Contact ${name}`}>
        <Button size="sm" variant="primary" icon={Icons.compose} disabled={!!why} title={why || undefined} aria-label={`Email ${name}`} onClick={onEmail}>Email</Button>
        {a.email ? (
          <span className="agency-card__address">
            <Text role="body-sm" as="span">{a.email}</Text>
            <Button size="sm" variant="ghost" icon={Icons.copy} aria-label={`Copy ${a.email}`} onClick={() => void copy(a.email, "Address")} />
          </span>
        ) : null}
        {a.phone ? <Button size="sm" variant="ghost" icon={Icons.phone} aria-label={`Copy phone number ${a.phone}`} title="Copy the number" onClick={() => void copy(a.phone, "Phone number")}>{a.phone}</Button> : null}
        {link(a.website, "Website")}
        {link(a.about_url, "About / team")}
        {a.city_links.map((c) => link(c.url, `${c.city} contact`))}
        {/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\/company\//i.test(a.linkedin_url) ? link(a.linkedin_url, "LinkedIn") : null}
      </div>

      <div className="agency-card__track">
        <Select label="Status" value={a.tracking.status} onChange={(e) => onChange({ status: e.target.value as AgencyStatus })}
          options={AGENCY_STATUSES.map((s) => ({ value: s, label: AGENCY_STATUS_LABELS[s] }))} />
        <Input label="Contacted" type="date" value={a.tracking.contacted_on} onChange={(e) => onChange({ contacted_on: e.target.value })} />
        <Input label="Follow up" type="date" value={a.tracking.follow_up_on} onChange={(e) => onChange({ follow_up_on: e.target.value })} />
      </div>
      <Textarea label="Notes" hideLabel rows={2} placeholder="Notes: who you spoke to, roles mentioned, next steps..." value={notes}
        onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== a.tracking.notes) onChange({ notes }); }} />
      {a.activity.length ? (
        <details className="agency-card__timeline">
          <summary>{`Timeline (${a.activity.length})`}</summary>
          {/* The company and job pages' timeline list. Replies come from mail sync; no open tracking (see agencyActivity). */}
          <ul className="list-plain timeline" aria-label={`${name} timeline`}>
            {a.activity.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <Text role="body-sm" muted>{fmtWhen(e.at) || e.at}</Text>
                <span>
                  <Text role="body" as="div">{e.event}</Text>
                  {e.note ? <Text role="body-sm" muted as="div">{e.note}</Text> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}
