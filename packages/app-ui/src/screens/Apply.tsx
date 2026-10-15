import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, Card, cx, Icon, Icons, Pill, Text, useToast, PRODUCT_NAME, SectionTitle } from "@careeros/brand";
import { EXPORT_SOURCES, fileKind, type ActionTarget, type ApplyState, type DraftInput, type ExportSource, type ExportState, type JobFile } from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { ActionButton } from "../components/ActionButton";
import { RequestComposer } from "../composer";
import { DraftEditor } from "../components/DraftEditor";
import { EmailPreviewCard } from "../components/EmailPreview";
import { JobErrorBanner } from "../components/ErrorBanner";
import { ExportPanel } from "../components/ExportPanel";
import { useFileViewer } from "../viewer";
import { ExternalLink, hostLabel } from "../components/ExternalLink";
import { Markdown } from "../components/Markdown";
import { Loading, ScreenHead } from "../components/States";
import { BackLink, usePageName } from "../nav";
import { friendlyFile, showInFolderLabel } from "../components/files";
import { fmtDay, parseDay } from "../reading/dates";
import { APPLY_STEPS, navigate, type ApplyStepName, type Route } from "../router";
import { ListenButton } from "../listen";
import { EditResumeButton } from "../resume/EditResumeButton";
import { UnsureSend } from "../components/UnsureSend";
import { ProofHintCard } from "../outreach/ProofHintCard";

export const STEP_LABELS: Record<ApplyStepName, string> = { prepare: "Prepare", review: "Review", handoff: "Hand off", confirm: "Confirm" };
/** Why Next is not available yet on each step (what moves the application on). */
const WAITING: Record<ApplyStepName, string> = {
  prepare: "Next opens when Claude saves the application files.",
  review: "Request approval to continue.",
  handoff: "Approve the hand-off in Approvals to continue.",
  confirm: "",
};

const SENDABLE = /\.(pdf|docx?|md|txt)$/i;
/** Exported files win over the Markdown they were made from: PDF first, then Word. */
const PREFERRED_FORMATS = ["pdf", "docx"] as const;
const SOURCE_NAMES: Record<ExportSource, string> = { resume: "resume", "cover-letter": "cover letter" };

/**
 * What an email application attaches. A resume or cover letter goes as its exported PDF (or Word file) from
 * application/export when there is one; the Markdown only when nothing was exported (`textOnly` lists those).
 * `files` is what the editor offers: each source's exports first, then the Markdown, then the other files.
 */
export function applicationAttachments(s: Pick<ApplyState, "files">, exp: ExportState | null): {
  files: JobFile[]; attach: string[]; textOnly: ExportSource[];
  /** Markdown -> the export that replaces it, so a draft already open can swap in a PDF made later. */
  swap: Record<string, string>;
  /** Sources whose exports are older than the Markdown (edited since): those go as text until exported again. */
  stale: ExportSource[];
} {
  const files: JobFile[] = [];
  const stale: ExportSource[] = [];
  const swap: Record<string, string> = {};
  const attach: string[] = [];
  const textOnly: ExportSource[] = [];
  const sendable = (f: JobFile) => f.exists && SENDABLE.test(f.path) && !f.path.endsWith("PREPARE.md");
  for (const f of s.files.filter((x) => x.path.startsWith("application/"))) {
    const source = sendable(f) ? EXPORT_SOURCES.find((x) => f.path === `application/${x}.md`) : undefined;
    if (!source) { files.push(f); if (sendable(f)) attach.push(f.rel); continue; }
    const made = PREFERRED_FORMATS.flatMap((format) => exp?.files.filter((e) => e.source === source && e.format === format && e.exists && !e.problem) ?? [])
      .map((e): JobFile => ({ path: `application/export/${e.name}`, rel: e.path, label: e.name, at: e.at, exists: true, size: e.size, kind: fileKind(e.name) }));
    files.push(...made, f);
    // An export made before the last edit would send an older resume: the Markdown goes instead, with the note.
    const fresh = made.filter((e) => !f.at || !e.at || e.at >= f.at);
    if (fresh.length) { attach.push(fresh[0]!.rel); swap[f.rel] = fresh[0]!.rel; }
    else { attach.push(f.rel); textOnly.push(source); if (made.length) stale.push(source); }
  }
  return { files, attach, textOnly, swap, stale };
}

/** The email application, pre-filled: to the job's apply address, the application's sendable files ticked, marked as an application. */
export function emailApplicationDraft(s: ApplyState, exp: ExportState | null = null): DraftInput {
  return {
    to: s.apply_email ?? "", cc: "", subject: `Application for ${s.title}`,
    body: `Hi,\n\nPlease find my application for the ${s.title} role at ${s.company_name} attached.\n\nRegards,`,
    attach: applicationAttachments(s, exp).attach,
    in_reply_to: "", references: [], purpose: "apply",
  };
}

/** "Your resume will be sent as a text file. Export a PDF first for a cleaner look." */
export function textOnlyNote(sources: ExportSource[], stale: ExportSource[] = []): string {
  const names = sources.map((x) => SOURCE_NAMES[x]).join(" and ");
  if (stale.length && stale.length === sources.length) {
    return sources.length > 1
      ? `Your ${names} changed after their PDFs were made, so they will be sent as text files. Export new PDFs first for a cleaner look.`
      : `Your ${names} changed after its PDF was made, so it will be sent as a text file. Export a new PDF first for a cleaner look.`;
  }
  return sources.length > 1
    ? `Your ${names} will be sent as text files. Export PDFs first for a cleaner look.`
    : `Your ${names} will be sent as a text file. Export a PDF first for a cleaner look.`;
}

/**
 * The Email application form: the draft editor with the exported files ticked. When a resume or cover letter would
 * go as Markdown, a gentle note offers to export a PDF; after it is made, the PDF replaces the Markdown in the
 * draft (what was typed stays).
 */
function EmailApplication({ s, onClose }: { s: ApplyState; onClose: () => void }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const exp = useLoad((b) => b.docs.state(s.company_slug, s.id), [s.company_slug, s.id], ["jobs"]);
  // Wait for the export state once, so the first draft already has the PDF ticked (an error falls back to Markdown).
  if (!exp.data && !exp.error) return <Loading />;
  const picked = applicationAttachments(s, exp.data ?? null);
  const exportPdf = () => run("export-pdf", async () => {
    // Replace only when an older export is there (made before the last edit); otherwise nothing is overwritten.
    await bridge.docs.export(s.company_slug, s.id, picked.textOnly, ["pdf"], picked.stale.length > 0);
    exp.reload();
  }, "PDF saved in the application's export folder");
  return (
    <DraftEditor slug={s.company_slug} id={s.id} draftId="" initial={emailApplicationDraft(s, exp.data ?? null)} files={picked.files} onClose={onClose}
      attachSwap={picked.swap}
      attachNote={picked.textOnly.length ? (
        <div className="row mail-attach-note" role="note">
          <Text role="body-sm" muted>{textOnlyNote(picked.textOnly, picked.stale)}</Text>
          <Button size="sm" variant="secondary" icon={Icons.file} loading={busy === "export-pdf"} onClick={() => void exportPdf()}>{picked.textOnly.length > 1 ? "Export PDFs" : "Export PDF"}</Button>
        </div>
      ) : null} />
  );
}

export function ApplyScreen({ route }: { route: Route }) {
  if (route.screen !== "apply") return <Loading />;
  return <><BackLink route={route} /><ApplyView slug={route.slug} id={route.id} step={route.step} /></>;
}

/**
 * The steps as a navigator: steps already reached can be opened (the URL keeps the one you're on),
 * later ones are disabled with the reason in their tooltip. Arrow keys move between steps.
 */
function Stepper({ reached, view, onGo }: { reached: number; view: ApplyStepName; onGo: (s: ApplyStepName) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = Math.min(Math.max(i + d, 0), reached);
    onGo(APPLY_STEPS[n]!);
    refs.current[n]?.focus();
  };
  return (
    <nav aria-label="Application steps" data-tour="apply-steps">
      <ol className="stepper">
        {APPLY_STEPS.map((k, i) => {
          const done = i < reached;
          const future = i > reached;
          return (
            <li key={k} className={cx("stepper__item", done && "is-done", k === view && "is-viewing", future && "is-future")}>
              <button
                ref={(el) => { refs.current[i] = el; }} type="button" className="stepper__button"
                aria-current={k === view ? "step" : undefined} disabled={future} tabIndex={k === view ? 0 : -1}
                title={future ? `Finish ${STEP_LABELS[APPLY_STEPS[i - 1]!]} first` : done ? `${STEP_LABELS[k]} (done)` : STEP_LABELS[k]}
                onClick={() => onGo(k)} onKeyDown={(e) => onKey(e, i)}
              >
                <span className="stepper__num" aria-hidden="true">{done ? <Icon icon={Icons.check} size="sm" /> : i + 1}</span>
                <span className="stepper__label">{STEP_LABELS[k]}</span>
                {done ? <span className="sr-only"> (done)</span> : null}
                {future ? <span className="sr-only"> (not yet: finish {STEP_LABELS[APPLY_STEPS[i - 1]!]} first)</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepNav({ view, reached, onGo, action, waiting }: { view: number; reached: number; onGo: (s: ApplyStepName) => void; action?: ReactNode; waiting?: string }) {
  const last = view === APPLY_STEPS.length - 1;
  const blocked = view >= reached;
  const why = blocked ? waiting ?? WAITING[APPLY_STEPS[view]!] : "";
  return (
    <div className="step-nav" data-tour="apply-next">
      {/* No Back on the first step (a disabled Back has nothing useful to say); the spacer keeps Next on the right. */}
      {view === 0 ? <span aria-hidden="true" /> : <Button variant="ghost" icon={Icons.back} onClick={() => onGo(APPLY_STEPS[view - 1]!)}>Back</Button>}
      <span className="step-nav__end">
        {why ? <span className="action__why" id="step-nav-why"><Icon icon={Icons.info} size="sm" />{why}</span> : null}
        {action}
        {last ? null : (
          <Button disabled={blocked} aria-describedby={blocked ? "step-nav-why" : undefined} title={why || undefined}
            onClick={() => onGo(APPLY_STEPS[view + 1]!)}>Next<Icon icon={Icons.next} size="sm" /></Button>
        )}
      </span>
    </div>
  );
}

function ApplyView({ slug, id, step }: { slug: string; id: string; step?: ApplyStepName }) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const [emailing, setEmailing] = useState(false);
  const { data: s, error } = useLoad((b) => b.apply.state(slug, id), [slug, id], ["jobs", "approvals", "mail"]);
  usePageName(s ? `${s.title} application` : undefined);
  if (error && !s) return <JobErrorBanner error={error} />;
  if (!s) return <Loading />;
  // A reload can fail (the job was deleted, or the file became unreadable) while we still hold
  // the last-known state. Show the error and hide every control that would mutate the job
  // instead of trusting the stale snapshot.
  const broken = !!error;

  // "Tailor application" is the tailor action: apply.prepare first (PREPARE.md, status Applying), then the shared
  // hand-off (note, clipboard, Claude Desktop) with the same prompt.
  const job: ActionTarget = { kind: "job", company_slug: slug, id };
  const files = s.files.filter((f) => !f.path.endsWith("PREPARE.md"));
  const sourced = (s.claims ?? []).length > 0;
  const reached = s.step === "done" ? APPLY_STEPS.length - 1 : APPLY_STEPS.indexOf(s.step);
  // The step in the URL is shown only if it has been reached; otherwise the page follows progress.
  const view: ApplyStepName = s.step === "done" ? "confirm" : step && APPLY_STEPS.indexOf(step) <= reached ? step : APPLY_STEPS[reached]!;
  const vi = APPLY_STEPS.indexOf(view);
  const go = (k: ApplyStepName) => navigate({ screen: "apply", slug, id, ...(APPLY_STEPS.indexOf(k) === reached ? {} : { step: k }) });
  // One primary on Review: email is primary only when it is the only way in (no https apply link).
  const byEmail = !!s.apply_email;
  const emailOnly = byEmail && !s.url;
  const isEmail = s.approval?.action === "email_send";
  const askHandoff = (
    <>
      {byEmail ? <Button variant={emailOnly ? "primary" : "secondary"} icon={Icons.mail} aria-expanded={emailing} onClick={() => setEmailing(true)}>Email application</Button> : null}
      {emailOnly ? null : <Button variant="primary" icon={Icons.send} loading={busy === "handoff"} onClick={() => void run("handoff", () => bridge.apply.requestApproval(slug, id), "Hand-off is waiting in Approvals")} title="Ask for hand-off approval">Request approval</Button>}
    </>
  );

  return (
    <>
      <ScreenHead title={`Apply: ${s.title}`} sub={s.company_name}
        right={<Button icon={Icons.jobs} onClick={() => navigate({ screen: "job", slug, id })}>Open job</Button>} />
      {error ? <JobErrorBanner error={error} /> : null}
      {s.step !== "done" ? <Stepper reached={reached} view={view} onGo={go} /> : null}

      {s.step !== "done" && view === "prepare" ? (
        <Card className="stack apply-prepare" data-tour="apply-prepare">
          {/* Lane G hook: the request composer replaces the raw prompt block (options, note, always-on rules, files). */}
          {broken ? <Text role="body" muted>This job can't be prepared right now. See the message above.</Text> : <RequestComposer action="tailor_application" target={job} before={() => bridge.apply.prepare(slug, id)} />}
          {broken ? null : <ProofHintCard slug={slug} id={id} />}
        </Card>
      ) : null}

      {s.step !== "done" && view === "review" ? (
        <div className="stack">
          {s.approval && (s.approval.status === "declined" || s.approval.status === "failed") ? (
            <Card className="stack" role="alert">
              <Pill tone="danger">{`${isEmail ? "Email" : "Hand-off"} ${s.approval.status === "declined" ? "declined" : "failed"}`}</Pill>
              <Text role="body">{s.approval.result_note || (s.approval.status === "declined" ? `You declined the ${isEmail ? "email" : "hand-off"}.` : `The ${isEmail ? "email" : "hand-off"} didn't finish.`)}</Text>
            </Card>
          ) : null}
          <div className="split">
            <Card className="stack" data-tour="apply-files">
              <SectionTitle icon={Icons.file} title="Files" />
              <FileReview files={files} />
              <EditResumeButton slug={slug} id={id} files={files} variant="secondary" />
              {broken ? null : <div><ActionButton action="application_summary_video" target={job} /></div>}
            </Card>
            <Card className="stack" data-tour="apply-claims">
              <SectionTitle icon={Icons.checklist} title="Claims" />
              {sourced ? (
                <ul className="list-plain">
                  {(s.claims ?? []).map((c, i) => (
                    <li key={i}>
                      <Text role="body" as="div">{c.claim}</Text>
                      {c.source ? <Text role="body-sm" muted as="div">{c.source}</Text> : <Pill tone="warning">No source</Pill>}
                    </li>
                  ))}
                </ul>
              ) : (
                <><div><Pill tone="warning">Unchecked</Pill></div><Text role="body">No claim check yet. Ask Claude to check your resume's claims against your profile, so every claim can be traced.</Text></>
              )}
            </Card>
          </div>
          {byEmail && !broken ? <Text role="body-sm" muted>This job takes applications by email at {s.apply_email}.</Text> : null}
          {emailing && !broken ? (
            <Card className="stack" aria-label="Email application">
              <EmailApplication s={s} onClose={() => setEmailing(false)} />
            </Card>
          ) : null}
          {broken ? null : <ExportPanel slug={slug} id={id} variant="secondary" />}
        </div>
      ) : null}

      {s.step !== "done" && view === "handoff" ? (
        <div className="stack">
          <Card className="stack">
            {reached > vi ? (
              <Text role="body">{isEmail ? "The email was sent." : "The hand-off was approved."}</Text>
            ) : isEmail && s.approval?.unsure ? (
              <>
                <Text role="body">The email may not have gone out. Look in Gmail&apos;s Sent folder. If it&apos;s there, mark it as sent. If it isn&apos;t, send it again.</Text>
                {broken ? null : <UnsureSend a={s.approval} />}
              </>
            ) : s.approval?.status === "approved" ? (
              <Text role="body">{isEmail ? "The email may not have gone out. Open Approvals to check it." : "Hand-off approved, finishing…"}</Text>
            ) : isEmail ? (
              <>
                <Text role="body">The email is waiting for your approval. Approving sends exactly this:</Text>
                {s.approval?.email ? <EmailPreviewCard preview={s.approval.email} /> : <Text role="body" muted>The preview isn't available. Open Approvals to see why.</Text>}
              </>
            ) : (
              <>
                <Text role="body">The hand-off is waiting for your approval. Approving will:</Text>
                <ul>{(s.approval?.steps ?? []).map((st) => <li key={st}>{st}</li>)}</ul>
              </>
            )}
            <div className="row">
              <Button variant="primary" onClick={() => navigate({ screen: "approvals" })}>Open Approvals</Button>
            </div>
          </Card>
          {broken ? null : <ExportPanel slug={slug} id={id} variant="secondary" />}
        </div>
      ) : null}

      {s.step !== "done" && view === "confirm" ? (
        <Card className="stack">
          <Text role="body">{isEmail ? "The email was sent. Did the employer get everything they asked for?" : "The apply page and your files are open. Did you submit the application?"}</Text>
          <div className="row">
            {broken ? null : <Button variant="primary" loading={busy === "applied"} onClick={() => void run("applied", () => bridge.apply.markApplied(slug, id), "Marked as applied")}>I applied</Button>}
            <Button variant="ghost" onClick={() => navigate({ screen: "job", slug, id })}>Not yet</Button>
          </div>
        </Card>
      ) : null}

      {s.step !== "done" ? <StepNav view={vi} reached={reached} onGo={go} action={view === "review" && reached === vi && !broken ? askHandoff : undefined}
        waiting={view === "review" && byEmail ? (emailOnly ? "Email the application to continue." : "Request approval or email the application to continue.") : undefined} /> : null}

      {s.step === "done" ? <DoneCard s={s} files={files} /> : null}
    </>
  );
}

/** The record of a finished application: when, how, and which files went. */
function DoneCard({ s, files }: { s: ApplyState; files: JobFile[] }) {
  const job = useLoad((b) => b.jobs.get(s.company_slug, s.id), [s.company_slug, s.id], ["jobs"]);
  const j = job.data?.job;
  const applied = j ? [...j.timeline].reverse().find((e) => /\bapplied\b/i.test(e.event)) : undefined;
  // parseDay keeps a date-only "2026-10-08" on its own day in every time zone.
  const day = applied ? parseDay(applied.at) : null;
  const channel = s.url ? hostLabel(s.url) : "";
  return (
    <Card className="stack" aria-label="Application sent">
      <Text role="heading-2">Application sent</Text>
      <dl className="key-facts__grid">
        <div className="key-facts__row"><dt>Status</dt><dd>{j?.status ?? "Applied"}</dd></div>
        <div className="key-facts__row"><dt>Applied</dt><dd>{day ? fmtDay(day) : "Date not recorded"}</dd></div>
        <div className="key-facts__row"><dt>Applied through</dt><dd>{channel ? <ExternalLink href={s.url}>{channel}</ExternalLink> : "Not recorded"}</dd></div>
      </dl>
      {files.length ? <><Text role="body-sm" muted>Files in this application</Text><FileReview files={files} /></> : <Text role="body-sm" muted>No application files are saved for this job.</Text>}
      <div><Button onClick={() => navigate({ screen: "job", slug: s.company_slug, id: s.id, tab: "timeline" })}>See timeline</Button></div>
    </Card>
  );
}

function FileReview({ files }: { files: JobFile[] }) {
  const bridge = useBridge();
  const toast = useToast();
  const [sel, setSel] = useState<string | null>(null);
  // Open the cover letter first when there is one: it is the file people most want to read before a hand-off.
  const md = files.filter((f) => f.kind === "markdown");
  const current = files.find((f) => f.rel === sel) ?? md.find((f) => f.path.includes("cover-letter")) ?? md[0] ?? null;
  const text = useLoad((b) => (current?.kind === "markdown" ? b.files.readText(current.rel) : Promise.resolve("")), [current?.rel], ["jobs"]);
  const reveal = (rel: string) => void bridge.files.reveal(rel).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));
  const show = showInFolderLabel();
  const viewer = useFileViewer(files.map((f) => ({ rel: f.rel, title: friendlyFile(f.path, f.at).title, at: f.at })));
  return (
    <>
      {viewer.element}
      <ul className="list-plain file-list">
        {files.map((f) => {
          const ff = friendlyFile(f.path, f.at);
          return (
            <li key={f.rel} className={cx("file-list__item", f.rel === current?.rel && "is-current")}>
              <button type="button" className="file-list__open" title={f.path.split("/").pop()} aria-pressed={f.rel === current?.rel} onClick={() => (f.kind === "markdown" ? setSel(f.rel) : viewer.open(f.rel))}>
                <Icon icon={Icons.file} size="sm" />
                <span className="file-list__name">{ff.title}</span>
                <span className="file-list__type">{ff.type}</span>
              </button>
              <Button size="sm" variant="ghost" icon={Icons.show} aria-label={`View ${ff.title}`} title="View in the app" onClick={() => viewer.open(f.rel)} />
              <Button size="sm" variant="ghost" icon={Icons.showInFolder} aria-label={`${show}: ${ff.title}`} title={show} onClick={() => reveal(f.rel)} />
            </li>
          );
        })}
      </ul>
      {current?.kind === "markdown" ? (
        text.loading ? <Loading /> : text.error ? <Text role="body" muted>{text.error}</Text> : text.data ? <div className="stack"><div><ListenButton title={current.label} text={text.data} target="listen-apply-doc" source={current.rel} /></div><div id="listen-apply-doc" className="file-preview"><Markdown text={text.data} /></div></div> : null
      ) : null}
    </>
  );
}
