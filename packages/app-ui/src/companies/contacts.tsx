import { useState, type ReactNode } from "react";
import { Button, Icons, Pill, Select, Text, useToast } from "@careeros/brand";
import { CONTACT_KIND_LABELS, CONTACT_KINDS, FINAL_STATUSES, hasContacts, type CompanyContacts, type ContactEmail, type JobRow } from "@careeros/contract";
import { DateText } from "../components/DateText";
import { displayName } from "../components/displayName";
import { DraftEditor, EMPTY_DRAFT } from "../components/DraftEditor";
import { EmptyState } from "../components/States";
import { hostOf, openable, useOpenLink } from "./parts";

/** Shown above every list of published contacts. */
export const PUBLISHED_NOTE = "Only addresses the company publishes. Check before sending.";
const CLOSED = new Set<string>(FINAL_STATUSES);

/** Copies a value and says so; on failure, says how to copy it by hand. */
export function useCopy() {
  const toast = useToast();
  return async (value: string, what: string) => {
    try { await navigator.clipboard.writeText(value); toast({ tone: "success", text: `${what} copied` }); }
    catch { toast({ tone: "danger", text: "Couldn't copy. Select the text and copy it instead." }); }
  };
}

/**
 * The Contacts tab: the careers page and job board (opened in the browser), then the emails the company publishes,
 * grouped by kind with where each was found. "Email" opens the usual draft editor with the address filled in.
 * Drafts live on a job, so it files the draft on one of this company's jobs (the first open one unless the person
 * picks another); with no job saved, Email is off and says why. Nothing is sent without approval in Approvals.
 */
export function CompanyContactsPanel({ name, slug, contacts, jobs, research }: {
  name: string; slug: string; contacts: CompanyContacts | null; jobs: JobRow[];
  /** The Research company button, for the empty state. */
  research: ReactNode;
}) {
  const open = useOpenLink();
  const copy = useCopy();
  const [jobId, setJobId] = useState(() => (jobs.find((j) => !CLOSED.has(j.status)) ?? jobs[0])?.id ?? "");
  const [to, setTo] = useState("");
  const who = displayName(name);

  if (to && jobId) {
    return <DraftEditor key={to} slug={slug} id={jobId} draftId="" initial={{ ...EMPTY_DRAFT, to }} files={[]} onClose={() => setTo("")} />;
  }
  if (!hasContacts(contacts)) {
    return (
      <EmptyState boxed text={`No careers page or contact emails for ${who} yet. Research company finds the careers page and the addresses the company publishes.`}
        action={research} />
    );
  }
  const noJob = "Save a job with this company first. Email drafts are kept with a job.";
  const link = (url: string, label: string) => (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className="row">
          <Button size="sm" variant="secondary" icon={Icons.openExternal} title={url} onClick={() => open(url, `the ${label.toLowerCase()}`)}>{`Open ${hostOf(url)}`}</Button>
          <Button size="sm" variant="ghost" icon={Icons.copy} aria-label={`Copy the ${label.toLowerCase()} link`} onClick={() => void copy(url, "Link")}>Copy</Button>
        </span>
      </dd>
    </div>
  );
  const groups = CONTACT_KINDS.map((k) => ({ kind: k, emails: contacts.emails.filter((e) => e.kind === k) })).filter((g) => g.emails.length);
  const row = (e: ContactEmail) => (
    <li key={e.address} className="row company-contact">
      <span className="grow">
        <Text role="body" as="div" className="company-contact__address">{e.address}</Text>
        <Text role="body-sm" muted as="div">
          {openable(e.source_url) ? <button type="button" className="company-link company-link--sm" title={e.source_url} onClick={() => open(e.source_url, "the source page")}>{`Found on ${hostOf(e.source_url)}`}</button> : null}
          {e.found_on ? <> · <DateText value={e.found_on} /></> : null}
        </Text>
      </span>
      {e.confirmed ? null : <Pill tone="warning" title="Claude couldn't confirm this address on the page.">Not confirmed</Pill>}
      <Button size="sm" variant="ghost" icon={Icons.copy} aria-label={`Copy ${e.address}`} onClick={() => void copy(e.address, "Address")}>Copy</Button>
      <Button size="sm" icon={Icons.compose} aria-label={`Email ${e.address}`} disabled={!jobId} title={jobId ? undefined : noJob} onClick={() => setTo(e.address)}>Email</Button>
    </li>
  );

  return (
    <div className="stack company-contacts">
      <p role="note" className="company-contacts__note"><Text role="body-sm" muted as="span">{PUBLISHED_NOTE}</Text></p>
      {contacts.careers_url || contacts.ats_board_url || contacts.linkedin_url || contacts.phone ? (
        <dl className="company-facts">
          {contacts.careers_url ? link(contacts.careers_url, "Careers page") : null}
          {contacts.ats_board_url ? link(contacts.ats_board_url, "Job board") : null}
          {contacts.linkedin_url ? link(contacts.linkedin_url, "LinkedIn page") : null}
          {contacts.phone ? <div><dt>Phone</dt><dd>{contacts.phone}</dd></div> : null}
        </dl>
      ) : null}
      {groups.length ? (
        <section aria-label="Emails" className="stack-tight">
          {jobs.length > 1 ? (
            <Select label="Keep email drafts with" help="Drafts are kept with one of your jobs here." value={jobId} onChange={(ev) => setJobId(ev.target.value)}
              options={jobs.map((j) => ({ value: j.id, label: displayName(j.title) }))} />
          ) : !jobs.length ? <Text role="body-sm" muted>{noJob}</Text> : null}
          {groups.map((g) => (
            <div key={g.kind} className="stack-tight">
              <h3 className="company-sub">{CONTACT_KIND_LABELS[g.kind]}</h3>
              <ul className="list-plain stack-tight" aria-label={`${CONTACT_KIND_LABELS[g.kind]} emails`}>{g.emails.map(row)}</ul>
            </div>
          ))}
        </section>
      ) : <Text role="body-sm" muted>{`No published email addresses found for ${who}.`}</Text>}
      {contacts.notes ? <Text role="body-sm" muted>{contacts.notes}</Text> : null}
      {contacts.dropped ? <Text role="body-sm" muted>{`${contacts.dropped === 1 ? "1 entry was" : `${contacts.dropped} entries were`} left out: no valid address or no https source page.`}</Text> : null}
    </div>
  );
}
