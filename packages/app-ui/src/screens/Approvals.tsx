import { useRef, useState } from "react";
import { Button, Card, Dialog, DetailList, Drawer, Icons, Pill, Table, Text, Textarea, useToast, type Column, type DetailField, type PillTone, SectionTitle } from "@careeros/brand";
import { isSafeHttpsUrl, type ApprovalStatus, type ApprovalView, type JobRow } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { DateText } from "../components/DateText";
import { EmailPreviewCard } from "../components/EmailPreview";
import { UnsureSend } from "../components/UnsureSend";
import { ErrorState, Loading, ScreenHead } from "../components/States";
import { navigate } from "../router";
import { plural } from "../format";
import { SourceBadge } from "../source/SourceBadge";
import "../styles/tables.css";

// created_by is free text on disk that Claude or the CLI can set to "app", so it never decides this label.
// Only a record the app remembers creating (and that hasn't changed since) reads "From you".
const fromLabel = (a: ApprovalView) => (a.from_app ? "From you" : "From Claude or the command line");

// "approved" normally never shows up here: approve() only returns once the action has
// finished (done/failed). The one way a pending-looking "approved" row survives to a list()
// call is a crash between the disk write and the action finishing (spec: known gap). That
// row must read as stuck, not as "in progress", and must never grow a second Approve button.
const STATUS: Record<ApprovalStatus, { text: string; tone: PillTone }> = {
  pending: { text: "Waiting", tone: "accent" },
  approved: { text: "Didn't finish", tone: "danger" },
  done: { text: "Done", tone: "success" },
  declined: { text: "Declined", tone: "neutral" },
  failed: { text: "Failed", tone: "danger" },
};

const NO_LINK_TEXT = "No link will open: it isn't a plain https address.";

/** The real navigation target for a payload URL: host only, via the shared isSafeHttpsUrl
 * rule (plain https, real hostname, no embedded username/password) so a userinfo prefix
 * can never read as a destination it isn't. Anything that fails the rule shows nothing. */
function safeHost(url: unknown): string {
  return isSafeHttpsUrl(url) ? new URL(String(url)).host : "";
}

/** True whenever a hand-off's url fails the safe-link rule - wrong scheme, malformed,
 * userinfo, the wrong type (a number, an array), an empty string, or simply missing. Every
 * real apply_handoff approval is proposed with a url (core and services both require one;
 * there is no url-less "reveal only" design), so any of these is always a problem, never a
 * legitimate alternate shape: the card must not promise a link will open, and Approve must
 * not be offered, until the url is fixed. */
function hasUnsafeUrl(a: ApprovalView): boolean {
  return a.action === "apply_handoff" && !isSafeHttpsUrl(a.payload.url);
}

function fileNames(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files.map((f) => displayName(String(f).split("/").pop() || String(f)));
}

/** A short, prominent line built from the payload rather than the free-text title: what this
 * approval will actually do. Title/summary still show underneath as secondary text. Names the
 * role (not just the company, which only shows in the secondary jobLabel line) so the headline
 * alone says which job is moving. */
function headline(a: ApprovalView, row: JobRow | undefined): string {
  const p = a.payload;
  if (a.action === "status_change") {
    const to = displayName(String(p.status ?? ""));
    if (!to) return displayName(a.title);
    if (!row) return `Move to ${to}`;
    return `${displayName(row.title)}: ${displayName(row.status)} → ${to}`;
  }
  if (a.action === "apply_handoff") {
    const host = safeHost(p.url);
    const n = fileNames(p.files).length;
    if (host && n) return `Open ${host} and reveal ${plural(n, "file")}`;
    if (host) return `Open ${host}`;
    if (n) return `Reveal ${plural(n, "file")}`;
  }
  return displayName(a.title);
}

/** The "what will happen" list, built entirely from the payload rather than the free-text
 * `steps` - which can say something that no longer matches the payload (stale, hand-edited,
 * or simply wrong: Claude or the CLI write `steps` and `payload` separately, so nothing
 * guarantees they agree) and, for a hand-off url, can hide its real host behind a userinfo
 * prefix. When the payload disagrees with `steps`, the payload wins. email_send has no
 * payload-built story yet (it's 3b), so it keeps showing its own `steps` as-is. */
function happeningSteps(a: ApprovalView): string[] {
  if (a.action === "status_change") {
    const to = displayName(String(a.payload.status ?? ""));
    return [`Set the job status to ${to}`, `Add a timeline event "Status: ${to}"`];
  }
  if (a.action === "apply_handoff") {
    const host = safeHost(a.payload.url);
    const names = fileNames(a.payload.files);
    // host is "" exactly when hasUnsafeUrl(a) is true (both come from isSafeHttpsUrl on
    // the same value), so there's no third "safe but somehow hostless" case to handle.
    return [
      host ? `Open ${host} in your browser` : NO_LINK_TEXT,
      names.length ? `Reveal ${plural(names.length, "file")} in the application folder: ${names.join(", ")}` : "Reveal the application folder",
    ];
  }
  return a.steps.map((s) => displayName(s));
}


const ACTION_TEXT: Record<ApprovalView["action"], string> = {
  status_change: "Change a job's status", apply_handoff: "Open an application and reveal files", email_send: "Send an email",
};
// Internal keys never shown as their own rows: the job is named instead, and ids/slugs mean nothing to a person.
const HIDDEN_KEYS = new Set(["company_slug", "id", "slug", "job_id", "approval_id"]);
const EMAIL_INTERNAL_KEYS = new Set(["draft_id", "sha256", "message_id", "date", "purpose"]);
const KEY_LABELS: Record<string, string> = { status: "New status", note: "Note", url: "Link", files: "Files", to: "To", cc: "Cc", subject: "Subject", body: "Message" };
const keyLabel = (k: string) => KEY_LABELS[k] ?? (k.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()));

/** Any payload value as plain words: lists become comma lists, nested objects become "Label: value" lines. Never JSON. */
function plainValue(v: unknown, depth = 0): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "string") return displayName(v);
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map((x) => plainValue(x, depth + 1)).filter(Boolean).join(", ");
  if (typeof v === "object" && depth < 3) {
    return Object.entries(v as Record<string, unknown>).filter(([k]) => !HIDDEN_KEYS.has(k))
      .map(([k, x]) => `${keyLabel(k)}: ${plainValue(x, depth + 1) || "not set"}`).join("\n");
  }
  return "";
}

/** The proposal as label/value pairs a person can read, built from the payload. */
function payloadFields(a: ApprovalView): DetailField[] {
  const p = a.payload;
  // An email's draft id, checksum and Message-ID mean nothing to a person; the exact message shows as its own preview.
  if (a.action === "email_send") {
    const rest = Object.entries(p).filter(([k]) => !HIDDEN_KEYS.has(k) && !EMAIL_INTERNAL_KEYS.has(k))
      .map(([k, v]) => ({ label: keyLabel(k), value: plainValue(v), wide: k === "body" }));
    return [...(p.purpose === "apply" ? [{ label: "Purpose", value: "Job application" }] : []), ...rest];
  }
  if (a.action === "apply_handoff") {
    const names = fileNames(p.files);
    return [
      { label: "Opens", value: safeHost(p.url) || NO_LINK_TEXT },
      { label: "Files", value: names.length ? <span className="file-chips">{names.map((n, i) => <span key={i} className="file-chip">{n}</span>)}</span> : "None" },
    ];
  }
  return Object.entries(p).filter(([k]) => !HIDDEN_KEYS.has(k) && (a.action !== "apply_handoff" || k !== "url"))
    .map(([k, v]) => ({ label: keyLabel(k), value: plainValue(v), wide: k === "body" }));
}

function approvalFields(a: ApprovalView, row: JobRow | undefined): DetailField[] {
  const decided = a.status !== "pending" && a.decided_at;
  return [
    { label: "Request", value: ACTION_TEXT[a.action] },
    ...(row ? [{
      label: "Job",
      value: (
        <span className="stack-tight">
          <button type="button" className="link-btn" onClick={() => navigate({ screen: "job", slug: row.company_slug, id: row.id })}>{`${displayName(row.title)} at ${displayName(row.company_name)}`}</button>
          <SourceBadge job={row} size="sm" showName />
          <span className="t-body-sm t-muted">{`Now ${row.status}. `}<button type="button" className="link-btn link-btn--quiet" onClick={() => navigate({ screen: "job", slug: row.company_slug, id: row.id, tab: "timeline" })} title="Open its notes and timeline">See timeline</button></span>
        </span>
      ),
    }] : []),
    ...payloadFields(a),
    { label: "Status", value: <Pill tone={STATUS[a.status].tone}>{a.status === "pending" ? "Waiting for you" : STATUS[a.status].text}</Pill> },
    { label: "From", value: fromLabel(a) },
    { label: "Asked", value: <DateText value={a.created_at} hint /> },
    ...(decided ? [{ label: "Decided", value: <DateText value={a.decided_at} hint /> }] : []),
    ...(a.result_note ? [{ label: "Result", value: displayName(a.result_note), wide: true }] : []),
    ...(a.summary ? [{ label: "Why", value: displayName(a.summary), wide: true }] : []),
  ];
}

/** Why an email can't be approved right now ("" when it can): no preview, or the preview found a problem. */
function emailProblem(a: ApprovalView): string {
  if (a.action !== "email_send") return "";
  return a.email ? a.email.problem : "This email can't be previewed. Decline it and propose it again.";
}

function ProposalSteps({ a }: { a: ApprovalView }) {
  return (
    <section className="drawer-section" aria-label="What will happen">
      <h3 className="drawer-section__title">{a.status === "pending" ? "What will happen" : "What it was set to do"}</h3>
      <ol className="proposal-steps" aria-label="What will happen">{happeningSteps(a).map((s, i) => <li key={i}><Text role="body" as="span">{s}</Text></li>)}</ol>
    </section>
  );
}

export function ApprovalsScreen() {
  const bridge = useBridge();
  const toast = useToast();
  const { data, error } = useLoad((b) => b.approvals.list(), [], ["approvals"]);
  // Only used to name the job and show its current status on a status_change card; its own
  // reload failures are not fatal to this screen, so they are not folded into `broken`.
  const jobs = useLoad((b) => b.jobs.list({ showIneligible: true, limit: 500 }), [], ["jobs"]);
  const started = useRef(new Set<string>());
  // A Set, not a single id: two different approvals can be mid-decision at once (Approve one,
  // then Decline another before the first resolves), and each card's loading/disabled state
  // must reflect only its own in-flight call, not whichever call happened to start last.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [declining, setDeclining] = useState<ApprovalView | null>(null);
  const [note, setNote] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  // The last email sent from this screen, so its result stays visible with a link to where it went.
  const [sent, setSent] = useState<ApprovalView | null>(null);

  // One decision per approval: a second click before the first call returns is ignored. The
  // services half refuses a second approve on disk too, so this is a UI-level belt, not the
  // only guard.
  const decide = async (id: string, fn: () => Promise<ApprovalView>, ok: string): Promise<ApprovalView | undefined> => {
    if (started.current.has(id)) return undefined;
    started.current.add(id);
    setBusyIds((s) => new Set(s).add(id));
    try {
      const a = await fn();
      // A resolved call isn't automatically good news: approve() can resolve with a "failed"
      // result instead of throwing, when the action itself couldn't finish. Only a real
      // success gets the success toast. result_note is payload-adjacent free text (written by
      // whatever executed the action), so it goes through displayName like everything else.
      toast(a.status === "failed"
        ? { tone: "danger", text: `It didn't finish: ${displayName(a.result_note || "see History below")}` }
        : { tone: "success", text: ok });
      return a;
    } catch (e) {
      started.current.delete(id);
      toast({ tone: "danger", text: displayName(errorText(e)) });
      return undefined;
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  if (error && !data) return <ErrorState title="Approvals can't be shown" text={errorSentence(error)} />;
  if (!data) return <Loading />;
  // A reload can fail (the workspace folder became unreadable, a file vanished) while we
  // still hold the last-known list. Show the error over the stale cards and hide every
  // control that would approve or decline something based on data we can no longer trust.
  const broken = !!error;

  // A stale or unreadable job list is worse than none: only trust it when it's current.
  const jobRowFor = (p: Record<string, unknown>): JobRow | undefined =>
    jobs.error ? undefined : jobs.data?.rows.find((r) => r.company_slug === p.company_slug && r.id === p.id);

  const noteOf = (a: ApprovalView) => a.result_note || (a.status === "approved" ? "This didn't finish last time. Nothing more will run by itself." : "");
  const historyColumns: Column<ApprovalView>[] = [
    { key: "status", header: "Outcome", width: "8.5rem", text: (a) => STATUS[a.status].text, render: (a) => <Pill tone={STATUS[a.status].tone}>{STATUS[a.status].text}</Pill> },
    {
      key: "what", header: "Request", text: (a) => [displayName(a.title), displayName(noteOf(a))].filter(Boolean).join(". "), sortValue: (a) => a.title,
      render: (a) => (
        <span className="cell-two">
          <Text role="body" as="span">{displayName(a.title)}</Text>
          {noteOf(a) ? <Text role="body-sm" muted as="span">{displayName(noteOf(a))}</Text> : null}
        </span>
      ),
    },
    { key: "from", header: "From", width: "11rem", text: fromLabel, render: (a) => <Text role="body-sm" muted as="span">{fromLabel(a)}</Text> },
    { key: "when", header: "When", width: "8.5rem", sortValue: (a) => a.decided_at || a.created_at, firstSort: "desc", render: (a) => <DateText value={a.decided_at || a.created_at} /> },
  ];
  const viewed = viewing ? data.find((a) => a.id === viewing && a.status === "pending") : undefined;

  const pending = data.filter((a) => a.status === "pending");
  // Approved email sends whose outcome is unknown: they get their own cards with Mark as sent and Send again.
  const unsure = data.filter((a) => a.unsure);
  const history = data.filter((a) => a.status !== "pending" && !a.unsure).sort((a, b) => (b.decided_at || b.created_at).localeCompare(a.decided_at || a.created_at));

  return (
    <>
      <ScreenHead title="Approvals" sub="Nothing that acts on your behalf runs until you approve it here." />
      {broken ? <ErrorState title="Approvals can't be refreshed" text={errorSentence(error)} /> : null}
      <div className="stack">
        {sent ? <SentNote a={sent} onClose={() => setSent(null)} /> : null}
        {unsure.map((a) => (
          <Card key={a.id} highlight aria-label={`Check: ${displayName(a.title)}`} className="stack">
            <div className="row row--between">
              <Text role="heading-2">Not sure this email went out</Text>
              <Pill tone="warning">Check it</Pill>
            </div>
            <Text role="body-sm" muted truncate>{displayName(a.title)}</Text>
            <Text role="body">Gmail didn&apos;t answer after the email was handed over, so it may or may not have gone. Look in Gmail&apos;s Sent folder. If it&apos;s there, mark it as sent. If it isn&apos;t, send it again.</Text>
            {broken ? null : <UnsureSend a={a} onDone={(v) => { if (v.status === "done") setSent(v); }} />}
          </Card>
        ))}
        {pending.length === 0 ? (
          <div className="stack approvals-empty">
            <Text role="body">Nothing is waiting for you.</Text>
            <Text role="body-sm" muted>When Claude wants to change a job or send something for you, it asks here first.</Text>
          </div>
        ) : pending.map((a) => {
          const isEmail = a.action === "email_send";
          const unsafeUrl = hasUnsafeUrl(a);
          const problem = emailProblem(a);
          const row = jobRowFor(a.payload);
          const jobLabel = a.action === "status_change" && row ? `${row.title} at ${row.company_name}` : undefined;
          const steps = happeningSteps(a);
          const headlineId = `approval-${a.id}-headline`;
          const stepsId = `approval-${a.id}-steps`;
          return (
            <Card key={a.id} highlight aria-label={displayName(a.title)} className="stack">
              <div className="row row--between">
                <Text role="heading-2" id={headlineId} truncate>{headline(a, row)}</Text>
                <Pill>{fromLabel(a)}</Pill>
              </div>
              {jobLabel && row ? (
                <span className="row approval-job">
                  <button type="button" className="link-btn" onClick={() => navigate({ screen: "job", slug: row.company_slug, id: row.id })}>{displayName(jobLabel)}</button>
                  <button type="button" className="link-btn link-btn--quiet" onClick={() => navigate({ screen: "job", slug: row.company_slug, id: row.id, tab: "timeline" })} aria-label={`See timeline: ${displayName(jobLabel)}`} title="Open this job's notes and timeline">See timeline</button>
                </span>
              ) : null}
              <Text role="body-sm" muted truncate>{displayName(a.title)}</Text>
              {a.summary ? <Text role="body-sm" muted truncate>{displayName(a.summary)}</Text> : null}
              <div className="approval-steps">
                <Text role="label">What will happen</Text>
                <ol aria-label="What will happen" id={stepsId}>{steps.map((s, i) => <li key={`${a.id}-${i}`}><Text role="body" truncate>{s}</Text></li>)}</ol>
              </div>
              {a.email ? <EmailPreviewCard preview={a.email} note={problem ? undefined : "This exact message will be sent."} /> : null}
              {problem && !a.email ? <p role="alert" className="mail-warning" id={`approval-${a.id}-problem`}>{problem}</p> : null}
              {!isEmail && unsafeUrl ? <Text role="body-sm" muted>This includes a web address that isn't a safe https link, so it can't be approved. Decline it instead.</Text> : null}
              {broken ? null : (
                <div className="row">
                  <Button variant="primary" icon={Icons.check} disabled={unsafeUrl || !!problem} loading={busyIds.has(a.id)}
                    aria-describedby={`${headlineId} ${stepsId}`} title={problem || undefined}
                    onClick={() => void decide(a.id, () => bridge.approvals.approve(a.id, a.digest), isEmail ? "Sent" : "Approved and done")
                      .then((r) => { if (isEmail && r?.status === "done") setSent(r); })}>Approve</Button>
                  <Button variant="ghost" icon={Icons.close} disabled={busyIds.has(a.id)} onClick={() => { setNote(""); setDeclining(a); }}>Decline</Button>
                  <Button variant="ghost" onClick={() => setViewing(a.id)} aria-label={`Details: ${displayName(a.title)}`} title="See full details">Details</Button>
                </div>
              )}
            </Card>
          );
        })}

        {history.length === 0 ? (
          <section className="quiet-section" aria-label="History">
            <SectionTitle icon={Icons.history} title="History" />
            <Text role="body-sm" muted>No decisions yet.</Text>
          </section>
        ) : (
          <Card className="stack">
            <SectionTitle icon={Icons.history} title="History" />
            <Table caption="History" columns={historyColumns} rows={history} rowKey={(a) => a.id} itemLabel="decision"
              detail={(a) => ({ title: headline(a, jobRowFor(a.payload)), subtitle: displayName(a.title), fields: approvalFields(a, jobRowFor(a.payload)), children: <ProposalSteps a={a} /> })} />
          </Card>
        )}
      </div>

      {viewed ? (
        <Drawer open onClose={() => setViewing(null)} title={headline(viewed, jobRowFor(viewed.payload))} subtitle={displayName(viewed.title)}>
          <DetailList fields={approvalFields(viewed, jobRowFor(viewed.payload))} />
          {viewed.email ? <EmailPreviewCard preview={viewed.email} /> : null}
          <ProposalSteps a={viewed} />
        </Drawer>
      ) : null}

      <Dialog open={declining !== null} onClose={() => setDeclining(null)} title="Decline this?"
        actions={<>
          <Button variant="ghost" onClick={() => setDeclining(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { const a = declining!; setDeclining(null); void decide(a.id, () => bridge.approvals.decline(a.id, note.trim()), "Declined"); }}>Decline</Button>
        </>}>
        <Textarea label="Reason (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Dialog>
    </>
  );
}

/** Where a sent email went: its job's Mail tab holds the sent copy. */
function SentNote({ a, onClose }: { a: ApprovalView; onClose: () => void }) {
  const slug = String(a.payload.company_slug ?? "");
  const id = String(a.payload.id ?? "");
  return (
    <Card className="row row--between" role="status" aria-label="Email sent">
      <Text role="body">{displayName(a.result_note || "Sent")}. The sent copy is saved with the {id ? "job" : "company"}.</Text>
      <span className="row">
        {slug && id ? <Button onClick={() => navigate({ screen: "job", slug, id, tab: "mail" })} title="Open it in the job&apos;s mail">Open mail</Button>
          : slug ? <Button onClick={() => navigate({ screen: "company", slug, tab: "mail" })} title="Open it in the company&apos;s mail">Open mail</Button> : null}
        <Button variant="ghost" onClick={onClose}>Dismiss</Button>
      </span>
    </Card>
  );
}
