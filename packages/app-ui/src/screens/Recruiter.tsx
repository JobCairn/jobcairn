import { useEffect, useState } from "react";
import { Button, cx, Dialog, Icons, Input, Pill, Select, Table, Tabs, Text, Textarea, useToast, type Column } from "@careeros/brand";
import { AGENCY_STATUS_LABELS, AGENCY_STATUSES, linkedinCompanyPage, type AgencyJob, type AgencyPatch, type AgencyRow, type AgencyStatus, type JobStatus } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { CompanyMark, hostOf, openable, useOpenLink } from "../companies/parts";
import { useCopy } from "../companies/contacts";
import { DateText } from "../components/DateText";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { StatusCell } from "../jobs/cells/cells";
import { plural } from "../format";
import { BackLink, usePageName } from "../nav";
import { fmtWhen } from "../reading/dates";
import { navigate, type Route } from "../router";
import { RecruiterEmail } from "../recruiters/RecruiterEmail";
import { emailBlocker, RECRUITER_NOTE, SourcesList, StarButton } from "../recruiters/parts";
import { useSponsorshipFocus } from "../useSponsorshipFocus";
import "../styles/tables.css";
import "../recruiters/recruiters.css";

const TABS = ["overview", "contacts", "jobs", "timeline"] as const;
type Tab = (typeof TABS)[number];

export function RecruiterScreen({ route }: { route: Route }) {
  if (route.screen !== "recruiter") return <Loading />;
  return <><BackLink route={route} /><RecruiterView slug={route.slug} tab={(TABS as readonly string[]).includes(route.tab ?? "") ? (route.tab as Tab) : "overview"} /></>;
}

const JOB_COLS: Column<AgencyJob>[] = [
  { key: "role", header: "Role", alwaysOn: true, wrap: true, sortValue: (j) => j.title, text: (j) => j.title, render: (j) => <Text role="body" as="div" className="role-title">{displayName(j.title)}</Text> },
  { key: "where", header: "Location", width: "11rem", priority: "low", text: (j) => j.location, render: (j) => <Text role="body-sm" truncate>{j.location}</Text> },
  { key: "type", header: "Type", width: "7rem", priority: "low", text: (j) => j.job_type, render: (j) => <Text role="body-sm" truncate>{j.job_type}</Text> },
  { key: "status", header: "Status", width: "7rem", text: (j) => j.status, render: (j) => <StatusCell status={j.status as JobStatus} /> },
];

/** "Sampletown · since 2009 · 1 open job": the header's facts in words. */
function headerFacts(a: AgencyRow): string {
  const open = a.jobs.filter((j) => j.open).length;
  return [a.cities.slice(0, 3).join(", ") + (a.cities.length > 3 ? ` and ${a.cities.length - 3} more` : ""), a.since ? `since ${a.since}` : "",
    a.jobs.length ? plural(open, "open job") : ""].filter(Boolean).join(" · ");
}

/**
 * One recruitment agency, laid out like a job or company page: header with star, status and Email, then tabs for the
 * overview (what it's hiring for, where it was found, your tracking), its published contacts, people and pages, the
 * jobs you saved from it, and its timeline. It reads the same list the Recruiters screen shows and saves through
 * recruiters.update, so nothing about the record format changes. Email opens the RecruiterEmail draft flow.
 */
function RecruiterView({ slug, tab }: { slug: string; tab: Tab }) {
  const bridge = useBridge();
  const toast = useToast();
  const openLink = useOpenLink();
  const { showSponsorship } = useSponsorshipFocus();
  const { data, error } = useLoad((b) => b.recruiters.list(), [], ["recruiters", "jobs", "claude", "mail"]);
  const a = data?.find((r) => r.slug === slug);
  const [emailTo, setEmailTo] = useState<string | null>(null);
  usePageName(a ? displayName(a.name) : undefined);

  if (error && !data) {
    return <ErrorState title="This recruiter can't be shown" text={errorSentence(error)} action={<Button onClick={() => navigate({ screen: "recruiters" })}>All recruiters</Button>} />;
  }
  if (!data) return <Loading />;
  if (!a) return <EmptyState boxed text="This recruiter isn't in your workspace." action={<Button onClick={() => navigate({ screen: "recruiters" })}>All recruiters</Button>} />;

  const name = displayName(a.name);
  const change = (patch: AgencyPatch) => void bridge.recruiters.update(a.slug, patch).catch((e: unknown) => toast({ tone: "danger", text: `Couldn't save: ${errorText(e)}` }));
  const site = openable(a.website) ? a.website : "";
  const why = emailBlocker(a);
  const contactCount = a.contacts.length + a.people.length;
  const facts = headerFacts(a);

  return (
    <>
      {error ? <ErrorState title="This recruiter can't be refreshed" text={errorSentence(error)} /> : null}
      <header className="job-head company-head" data-tour="recruiter-head">
        <div className="company-head__main">
          <CompanyMark name={a.name} size="lg" />
          <div className="job-head__main">
            <h1 className={cx("t-display", "job-head__title", a.name.length > 48 && "job-head__title--long")} title={name}>{name}</h1>
            <div className="row job-head__meta">
              {site ? <button type="button" className="company-link" title={`Open ${site}`} onClick={() => openLink(site, "the website")}>{hostOf(site)}</button> : null}
              {facts ? <Text role="body" muted as="span">{facts}</Text> : null}
            </div>
          </div>
        </div>
        <div className="job-head__actions">
          <StarButton a={a} size="md" onToggle={() => change({ favourite: !a.favourite })} />
          <div className="inline-field" data-tour="recruiter-status">
            <span className="inline-field__label" aria-hidden="true">Status</span>
            <Select label="Status" hideLabel value={a.tracking.status} onChange={(e) => change({ status: e.target.value as AgencyStatus })}
              options={AGENCY_STATUSES.map((s) => ({ value: s, label: AGENCY_STATUS_LABELS[s] }))} />
          </div>
          {site ? <Button icon={Icons.openExternal} onClick={() => openLink(site, "the website")}>Open website</Button> : null}
          <Button variant="primary" icon={Icons.compose} disabled={!!why} title={why || undefined} aria-label={`Email ${name}`} data-tour="recruiter-email" onClick={() => setEmailTo(a.email)}>Email</Button>
        </div>
      </header>

      <Tabs label="Recruiter sections" value={tab} onChange={(t) => navigate({ screen: "recruiter", slug, tab: t })}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "contacts", label: "Contacts", count: contactCount },
          { id: "jobs", label: "Jobs", count: a.jobs.length },
          { id: "timeline", label: "Timeline", count: a.activity.length },
        ]}>
        {tab === "overview" ? <Overview a={a} showSponsorship={showSponsorship} onChange={change} /> : null}
        {tab === "contacts" ? <Contacts a={a} onEmail={setEmailTo} /> : null}
        {tab === "jobs" ? (
          <div className="stack job-panel" data-tour="recruiter-jobs">
            {a.jobs.length ? (
              <Table caption={`Jobs from ${name}`} columns={JOB_COLS} rows={a.jobs} rowKey={(j) => `${j.company_slug}/${j.id}`} itemLabel="job"
                onRowActivate={(j) => navigate({ screen: "job", slug: j.company_slug, id: j.id })} />
            ) : <EmptyState boxed text="No jobs saved from this agency yet. A job a recruiter advertised links here when you save it." />}
          </div>
        ) : null}
        {tab === "timeline" ? (
          <div className="stack job-panel">
            {a.activity.length ? (
              // The company and job pages' timeline list. Replies come from mail sync; no open tracking (see agencyActivity).
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
            ) : <EmptyState boxed text="Nothing has happened here yet. Emails, replies and your status changes show up here." />}
          </div>
        ) : null}
      </Tabs>
      <Dialog open={emailTo !== null} onClose={() => setEmailTo(null)} title={`Email ${name}`}>
        {emailTo !== null ? <RecruiterEmail a={{ ...a, email: emailTo }} onClose={() => setEmailTo(null)} /> : null}
      </Dialog>
    </>
  );
}

/** What it's hiring for, the facts, where it was found, and the person's own tracking beside them. */
function Overview({ a, showSponsorship, onChange }: { a: AgencyRow; showSponsorship: boolean; onChange: (p: AgencyPatch) => void }) {
  const open = useOpenLink();
  const [notes, setNotes] = useState(a.tracking.notes);
  useEffect(() => setNotes(a.tracking.notes), [a.tracking.notes]);
  const openJobs = a.jobs.filter((j) => j.open).length;
  const saveNotes = () => { if (notes !== a.tracking.notes) onChange({ notes }); };

  return (
    <div className="recruiter-overview">
      <div className="stack">
        <section aria-label="Hiring for" className="stack-tight">
          <h2 className="company-sub">Hiring for</h2>
          <Text role="body" as="p" muted={!a.hiring_summary}>{a.hiring_summary || "Not recorded yet. Find recruiters fills this in from the agency's own pages."}</Text>
          {a.team_note.text && openable(a.team_note.source_url) ? (
            <p role="note" className="agency-team">
              <Text role="body-sm" muted as="span">{a.team_note.text}</Text>{" "}
              <button type="button" className="company-link company-link--sm" onClick={() => open(a.team_note.source_url, "the team page")}>{`Source: ${hostOf(a.team_note.source_url)}`}</button>
            </p>
          ) : null}
        </section>
        <dl className="company-facts">
          {a.specialties.length ? <div><dt>Specialties</dt><dd>{a.specialties.join(", ")}</dd></div> : null}
          {a.all_tags.length ? <div><dt>Tags</dt><dd><ul className="agency-tags list-plain" aria-label="Tags">{a.all_tags.map((t) => <li key={t}><Pill>{t}</Pill></li>)}</ul></dd></div> : null}
          {a.cities.length ? <div><dt>Cities</dt><dd>{a.cities.join(", ")}</dd></div> : null}
          {a.since ? <div><dt>Since</dt><dd>{a.since}</dd></div> : null}
          <div><dt>Jobs saved from them</dt><dd>{a.jobs.length ? `${plural(a.jobs.length, "job")}, ${openJobs} open` : "None yet"}</dd></div>
          {showSponsorship ? (
            <div><dt>Ads open to visa holders</dt><dd>{a.sponsor_jobs ? `${plural(a.sponsor_jobs, "open ad")} offer sponsorship or accept visas` : "None of their saved ads say so yet"}</dd></div>
          ) : null}
        </dl>
        <section aria-label="Where it was found" className="stack-tight" data-tour="recruiter-sources">
          <h2 className="company-sub">Found on</h2>
          <SourcesList a={a} />
        </section>
      </div>
      <section className="card stack agency-track" aria-label="Your tracking" data-tour="recruiter-track">
        <h2 className="company-sub">Your tracking</h2>
        <Input label="Contacted" type="date" value={a.tracking.contacted_on} onChange={(e) => onChange({ contacted_on: e.target.value })} />
        <Input label="Follow up" type="date" value={a.tracking.follow_up_on} onChange={(e) => onChange({ follow_up_on: e.target.value })}
          help="Set five business days after you contact them, unless you pick a date." />
        <Textarea label="Notes" rows={5} placeholder="Who you spoke to, roles mentioned, next steps..." value={notes}
          onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} />
        <div className="row">
          <Button size="sm" disabled={notes === a.tracking.notes} onClick={saveNotes}>Save notes</Button>
        </div>
      </section>
    </div>
  );
}

/** Published emails and phones (each with the page it's on), named recruiters, and the agency's own pages. */
function Contacts({ a, onEmail }: { a: AgencyRow; onEmail: (to: string) => void }) {
  const open = useOpenLink();
  const copy = useCopy();
  const name = displayName(a.name);
  const emails = a.contacts.filter((c) => c.kind === "email");
  const phones = a.contacts.filter((c) => c.kind === "phone");
  const best = a.best_contact.name && openable(a.best_contact.source_url) ? a.best_contact : null;
  const found = (url: string, on = "") => (
    <Text role="body-sm" muted as="div">
      {openable(url) ? <button type="button" className="company-link company-link--sm" title={url} onClick={() => open(url, "the source page")}>{`Found on ${hostOf(url)}`}</button> : null}
      {on ? <> · <DateText value={on} /></> : null}
    </Text>
  );
  const links = [
    { url: a.website, label: "Website" }, { url: a.about_url, label: "About / team" },
    ...a.city_links.map((c) => ({ url: c.url, label: `${c.city} contact` })),
    ...(linkedinCompanyPage(a.linkedin_url) ? [{ url: a.linkedin_url, label: "LinkedIn" }] : []),
  ].filter((l) => openable(l.url));

  return (
    <div className="stack job-panel" data-tour="recruiter-contacts">
      <p role="note" className="company-contacts__note"><Text role="body-sm" muted as="span">{RECRUITER_NOTE}</Text></p>
      {best ? (
        <Text role="body-sm" as="p">
          {`Best reached through ${best.name}`}{" "}
          <button type="button" className="company-link company-link--sm" onClick={() => open(best.source_url, "the page that names them")}>{`(${hostOf(best.source_url)})`}</button>
        </Text>
      ) : null}
      <section aria-label="Emails" className="stack-tight">
        <h2 className="company-sub">Emails</h2>
        {emails.length ? (
          <ul className="list-plain stack-tight">
            {emails.map((c) => (
              <li key={c.value} className="row company-contact">
                <span className="grow">
                  <Text role="body" as="div" className="company-contact__address">{c.value}</Text>
                  {c.label ? <Text role="body-sm" as="div">{c.label}</Text> : null}
                  {found(c.source_url, c.found_on)}
                </span>
                {c.confirmed ? null : <Pill tone="warning" title="Claude couldn't confirm this address on the page.">Not confirmed</Pill>}
                <Button size="sm" variant="ghost" icon={Icons.copy} aria-label={`Copy ${c.value}`} onClick={() => void copy(c.value, "Address")}>Copy</Button>
                <Button size="sm" icon={Icons.compose} aria-label={`Email ${c.value}`} onClick={() => onEmail(c.value)}>Email</Button>
              </li>
            ))}
          </ul>
        ) : <Text role="body-sm" muted as="p">{`No agency-wide email published for ${name}.`}</Text>}
      </section>
      <section aria-label="Phones" className="stack-tight">
        <h2 className="company-sub">Phones</h2>
        {phones.length ? (
          <ul className="list-plain stack-tight">
            {phones.map((c) => (
              <li key={c.value} className="row company-contact">
                <span className="grow">
                  <Text role="body" as="div">{c.value}</Text>
                  {c.label ? <Text role="body-sm" as="div">{c.label}</Text> : null}
                  {found(c.source_url, c.found_on)}
                </span>
                {/* Phone links are blocked in the app, so the number is copied instead. */}
                <Button size="sm" variant="ghost" icon={Icons.phone} aria-label={`Copy phone number ${c.value}`} onClick={() => void copy(c.value, "Phone number")}>Copy</Button>
              </li>
            ))}
          </ul>
        ) : <Text role="body-sm" muted as="p">No phone number published.</Text>}
      </section>
      <section aria-label="People" className="stack-tight">
        <h2 className="company-sub">People</h2>
        {a.people.length ? (
          <ul className="list-plain stack-tight">
            {a.people.map((p) => (
              <li key={p.name} className="row company-contact">
                <span className="grow">
                  <Text role="body" as="div">{displayName(p.name)}</Text>
                  {p.title || p.specialties.length ? <Text role="body-sm" as="div">{[p.title, p.specialties.join(", ")].filter(Boolean).join(" · ")}</Text> : null}
                  {p.email || p.phone ? <Text role="body-sm" as="div" className="company-contact__address">{[p.email, p.phone].filter(Boolean).join(" · ")}</Text> : null}
                  {found(p.source_url)}
                </span>
                {p.email ? <Button size="sm" variant="ghost" icon={Icons.copy} aria-label={`Copy ${p.email}`} onClick={() => void copy(p.email, "Address")}>Copy</Button> : null}
                {p.phone ? <Button size="sm" variant="ghost" icon={Icons.phone} aria-label={`Copy phone number ${p.phone}`} onClick={() => void copy(p.phone, "Phone number")}>Copy</Button> : null}
                {p.email ? <Button size="sm" icon={Icons.compose} aria-label={`Email ${p.email}`} onClick={() => onEmail(p.email)}>Email</Button> : null}
              </li>
            ))}
          </ul>
        ) : <Text role="body-sm" muted as="p">No named recruiters published yet.</Text>}
      </section>
      <section aria-label="Links" className="stack-tight">
        <h2 className="company-sub">Links</h2>
        {links.length ? (
          <dl className="company-facts">
            {links.map((l) => (
              <div key={l.label + l.url}>
                <dt>{l.label}</dt>
                <dd>
                  <span className="row">
                    <Button size="sm" variant="secondary" icon={Icons.openExternal} title={l.url} aria-label={`Open ${name}'s ${l.label.toLowerCase()}`} onClick={() => open(l.url, `${name}'s ${l.label.toLowerCase()}`)}>{`Open ${hostOf(l.url)}`}</Button>
                    <Button size="sm" variant="ghost" icon={Icons.copy} aria-label={`Copy the ${l.label.toLowerCase()} link`} onClick={() => void copy(l.url, "Link")}>Copy</Button>
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        ) : <Text role="body-sm" muted as="p">No pages recorded yet.</Text>}
      </section>
    </div>
  );
}
