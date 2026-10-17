import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Checkbox, Icons, Select, Text, Textarea } from "@careeros/brand";
import {
  fileKind, isActiveRun, NOTE_MAX, noteProblems, outputNames, recruiterEmailDraft, sponsorshipLine, topicLabel,
  type ActionTarget, type AgencyRow, type DraftInput, type JobFile,
} from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { formatElapsed, useClaudeRun } from "../claude";
import { useElapsed } from "../claude/run-helpers";
import { ActionButton } from "../components/ActionButton";
import { DraftEditor, EMPTY_DRAFT } from "../components/DraftEditor";
import { displayName } from "../components/displayName";
import { Loading } from "../components/States";
import { CLAUDE_SETTINGS, navigate } from "../router";
import { applicationAttachments } from "../screens/Apply";
import { placesOf } from "../sponsors/region";
import { useSponsorshipFocus } from "../useSponsorshipFocus";
import { RECRUITER_NOTE } from "./parts";
import "./recruiter-email.css";

const GENERAL = "general";
const isResume = (rel: string) => /(^|\/)resume\.(pdf|docx?|md)$/i.test(rel);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

/** The candidate, from the profile's values, for the email template. */
export function meFromProfile(v: Record<string, unknown>) {
  const contact = (v.contact ?? {}) as Record<string, unknown>;
  const targets = (v.targets ?? {}) as Record<string, unknown>;
  return {
    name: str(contact.name), roles: strs(targets.roles), seniority: str(targets.seniority), cities: placesOf(v),
    visa_subclass: str(((v.work_rights ?? {}) as Record<string, unknown>).visa_subclass),
  };
}

type How = "template" | "claude";
type ResumeChoice = "mine" | "tailor" | "none";

/** The name of the general resume version made for an agency (Resumes screen), and the focus Claude writes it to. */
export function agencyVariant(a: Pick<AgencyRow, "name" | "specialties">, roles: string[]): { name: string; label: string } {
  const focus = (a.specialties.length ? a.specialties : roles).slice(0, 3).join(", ");
  return { name: topicLabel(`For ${a.name}`), label: topicLabel(`${focus ? `${focus} roles` : "the roles"} that ${a.name} recruits for`) };
}

/** A radio group drawn as the app's segmented choice, with a visible legend. */
function Choice<T extends string>({ legend, value, options, onChange, disabled }: {
  legend: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <fieldset className="recruiter-email__choice" disabled={disabled}>
      <legend className="recruiter-email__legend"><Text role="label" as="span">{legend}</Text></legend>
      <div className="segmented" role="radiogroup" aria-label={legend}>
        {options.map((o) => (
          <label key={o.value} className="segmented__option">
            <input type="radio" name={legend} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span className="segmented__text">{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Email a recruiter like an application: pick the live job it's about, or a general enquiry. About a job, the
 * draft is kept with that job and attaches its tailored resume when there is one (its exported PDF or Word file
 * first, like Email application), or offers Tailor first. A general enquiry (and any agency with no saved job) is
 * kept with the agency's company folder instead, set up the first time; it can attach one of your resumes, a resume
 * Claude tailors for this agency (a general version on the Resumes screen, made once and reused), or none.
 * The email comes from the template (instant) or from Claude (spec 2026-10-17-recruiter-email-claude), with your
 * note if you add one; people who need sponsorship get the sponsorship question, which they can turn off. Either
 * way it opens in the usual draft editor, addressed to the agency's published address; nothing is sent without your OK.
 */
export function RecruiterEmail({ a, onClose }: { a: AgencyRow; onClose: () => void }) {
  const bridge = useBridge();
  const { run, busy } = useAction();
  const { prioritiseSponsorship } = useSponsorshipFocus();
  const live = a.jobs.filter((j) => j.open);
  const [about, setAbout] = useState(live[0]?.id ?? GENERAL);
  const [how, setHow] = useState<How>("template");
  const [note, setNote] = useState("");
  const [sponsor, setSponsor] = useState(true);
  const [mine, setMine] = useState("");
  const [choice, setChoice] = useState<ResumeChoice | null>(null);
  const [added, setAdded] = useState<JobFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState<{ slug: string; id: string; initial: DraftInput; files: JobFile[] } | null>(null);
  const job = live.find((j) => j.id === about) ?? null;
  const key = job ? [job.company_slug, job.id] : ["", ""];
  const apply = useLoad((b) => (job ? b.apply.state(job.company_slug, job.id) : Promise.resolve(null)), key, ["jobs", "claude"]);
  const exp = useLoad((b) => (job ? b.docs.state(job.company_slug, job.id) : Promise.resolve(null)), key, ["jobs", "claude"]);
  const profile = useLoad((b) => b.settings.get("profile"), [], ["settings"]);
  const library = useLoad((b) => b.resumes.list(), [], ["jobs", "claude"]);
  const v = (profile.data?.values ?? {}) as Record<string, unknown>;
  const me = meFromProfile(v);

  // Claude's email: about a job it sits beside the job, a general enquiry in the agency's company folder.
  const action = job ? "recruiter_job_email" : "recruiter_email";
  const target = useMemo<ActionTarget>(() => (job ? { kind: "job", company_slug: job.company_slug, id: job.id } : { kind: "company", company_slug: a.slug }), [job, a.slug]);
  const claude = useClaudeRun(action, target);
  const mineRun = useRef<{ runId: string; started: string; owner: { slug: string; id: string }; files: JobFile[]; attach: string[] } | null>(null);
  const emailRun = claude.run;
  const emailActive = !!emailRun && isActiveRun(emailRun.status) && mineRun.current?.runId === emailRun.id;
  const elapsed = useElapsed(emailActive ? emailRun : null);

  // The resume version for this agency: found by name, so it is made once and reused.
  const variantFor = agencyVariant(a, me.roles);
  const variant = (library.data?.variants ?? []).find((x) => x.name === variantFor.name) ?? null;
  const variantTarget = useMemo<ActionTarget>(() => ({ kind: "resume_variant", variant: variant?.variant ?? "none", label: variantFor.label }), [variant?.variant, variantFor.label]);
  const tailorRun = useClaudeRun("tailor_resume_variant", variantTarget);
  const tailoring = !!variant && !!tailorRun.run && isActiveRun(tailorRun.run.status);

  // When the email run this dialog started finishes, read Claude's text and open the editor (never on mount).
  useEffect(() => {
    const m = mineRun.current;
    if (!m || !emailRun || emailRun.id !== m.runId || isActiveRun(emailRun.status)) return;
    mineRun.current = null;
    if (emailRun.status !== "succeeded") { setError(emailRun.status === "cancelled" ? null : emailRun.error || "Claude didn't finish. Try again."); return; }
    void (async () => {
      try {
        const r = await bridge.recruiters.suggestion(m.owner.slug, m.owner.id);
        if (!r.suggestion || Date.parse(r.suggestion.at) < Date.parse(m.started) - 1_000) { setError(r.problem || "Claude didn't write a draft. Try again."); return; }
        setWriting({ ...m.owner, files: m.files, initial: { ...EMPTY_DRAFT, to: a.email, subject: r.suggestion.subject, body: r.suggestion.body, attach: m.attach } });
      } catch (e) { setError(errorText(e)); }
    })();
  }, [emailRun, bridge, a.email]);

  if (writing) {
    return <DraftEditor slug={writing.slug} id={writing.id} draftId="" files={writing.files} onClose={onClose} initial={writing.initial} />;
  }
  if (job && !apply.data && !apply.error) return <Loading />;
  const tailored = job ? applicationAttachments({ files: apply.data?.files ?? [] }, exp.data ?? null).attach.find(isResume) : undefined;
  const own = library.data?.base ?? [];
  const picked = mine || own[0]?.rel || "";
  const pick: ResumeChoice = choice ?? (own.length ? "mine" : "none");
  // About a job: its tailored resume, else one you attached. A general enquiry: only what the chosen option attached.
  const resume = job ? tailored ?? added?.rel : pick === "none" ? undefined : added?.rel;
  const asks = prioritiseSponsorship && sponsor;
  const owner = job ? { slug: job.company_slug, id: job.id } : { slug: a.slug, id: "" };
  const problems = how === "claude" && note.trim() ? noteProblems(note, outputNames(action)) : [];
  const engine = claude.engine;
  const notReady = !!engine && !engine.ready;
  const needsTailor = !job && pick === "tailor" && !added;
  const files = () => [...(job ? apply.data?.files ?? [] : []), ...(added ? [added] : [])];

  const asFile = (rel: string, label: string): JobFile => {
    const name = rel.split("/").pop()!;
    return { path: rel.split("/").slice(job ? 4 : 2).join("/"), rel, label, at: new Date().toISOString(), exists: true, size: null, kind: fileKind(name) };
  };
  const attachMine = () => run("attach-resume", async () => {
    if (!job) await bridge.recruiters.mailbox(a.slug);
    const r = await bridge.recruiters.attachResume(owner.slug, owner.id, picked);
    setAdded(asFile(r.rel, "Your resume"));
  }, "Resume added");
  const tailor = () => run("tailor", async () => {
    const slug = variant?.variant ?? (await bridge.resumes.newVariant(variantFor.name)).variant;
    await bridge.claude.run("tailor_resume_variant", { kind: "resume_variant", variant: slug, label: variantFor.label }, {});
  });
  const attachTailored = () => run("attach-tailored", async () => {
    const r = await bridge.recruiters.attachVariant(a.slug, variant!.variant);
    setAdded(asFile(r.rel, `Your resume for ${displayName(a.name)}`));
  }, "Resume added");
  const write = () => run("write", async () => {
    setError(null);
    if (!job) await bridge.recruiters.mailbox(a.slug);
    const attach = resume ? [resume] : [];
    if (how === "template") {
      const t = recruiterEmailDraft({ me, agency: a, job: job ? { title: job.title, location: job.location } : null, sponsorship: asks, attached: !!resume });
      setWriting({ ...owner, files: files(), initial: { ...EMPTY_DRAFT, to: a.email, subject: t.subject, body: t.body, attach } });
      return;
    }
    // Explicit options every time: an empty request would make the engine reuse saved ones. The sponsorship option
    // exists only for people who need sponsorship; the agency is named only about a job (main checks both).
    const options = { attached: !!resume, ...(prioritiseSponsorship ? { sponsorship: sponsor } : {}), ...(job ? { agency: a.slug } : {}) };
    const r = await claude.start({ options, note: note.trim() });
    mineRun.current = { runId: r.id, started: r.started_at, owner, files: files(), attach };
  });

  const resumePart: ReactNode = job ? (
    tailored ? <Text role="body-sm" as="p">{`Your tailored resume for ${displayName(job.title)} is attached.`}</Text>
      : added ? <Text role="body-sm" as="p">Your resume is attached.</Text> : (
        <>
          <Text role="body-sm" muted as="p">No tailored resume for this job yet. Tailor it first, or attach one of your resumes.</Text>
          <div className="row">
            <ActionButton action="tailor_application" target={{ kind: "job", company_slug: job.company_slug, id: job.id }} label="Tailor first" ariaLabel="Tailor first" />
            {own.length > 1 ? <Select label="Your resume" hideLabel value={picked} onChange={(e) => setMine(e.target.value)} options={own.map((r) => ({ value: r.rel, label: r.name }))} /> : null}
            {own.length ? <Button size="sm" icon={Icons.attach} loading={busy === "attach-resume"} onClick={() => void attachMine()}>Attach resume</Button>
              : <Text role="body-sm" muted as="span">No resume in your profile yet.</Text>}
          </div>
        </>
      )
  ) : (
    <>
      <Choice legend="Resume" value={pick} onChange={(c) => { setChoice(c); setAdded(null); }} options={[
        { value: "mine", label: "Attach one of your resumes" }, { value: "tailor", label: "Tailor a resume for this agency" }, { value: "none", label: "No resume" },
      ]} />
      {pick === "mine" ? (
        added ? <Text role="body-sm" as="p">Your resume is attached.</Text>
          : own.length ? (
            <div className="row">
              {own.length > 1 ? <Select label="Your resume" hideLabel value={picked} onChange={(e) => setMine(e.target.value)} options={own.map((r) => ({ value: r.rel, label: r.name }))} /> : null}
              <Button size="sm" icon={Icons.attach} loading={busy === "attach-resume"} onClick={() => void attachMine()}>Attach resume</Button>
            </div>
          ) : <Text role="body-sm" muted as="p">No resume in your profile yet.</Text>
      ) : null}
      {pick === "tailor" ? (
        added ? <Text role="body-sm" as="p">{`Your resume for ${displayName(a.name)} is attached.`}</Text>
          : tailoring ? <Text role="body-sm" as="p" aria-live="polite">{`Claude is writing your resume for ${displayName(a.name)}… It's saved in Resumes.`}</Text>
          : variant?.ready ? (
            <div className="row">
              <Text role="body-sm" as="span">{`Your resume for ${displayName(a.name)} is ready.`}</Text>
              <Button size="sm" icon={Icons.attach} loading={busy === "attach-tailored"} onClick={() => void attachTailored()}>Attach resume</Button>
            </div>
          ) : (
            <div className="row">
              <Text role="body-sm" muted as="span">{`Claude writes a version of your resume aimed at the roles ${displayName(a.name)} recruits for.`}</Text>
              {notReady ? <Button size="sm" icon={Icons.ai} onClick={() => navigate(CLAUDE_SETTINGS)} title="Claude Code needs a one-time setup first.">Claude setup</Button>
                : <Button size="sm" icon={Icons.ai} loading={busy === "tailor"} disabled={!engine} onClick={() => void tailor()}>Tailor resume</Button>}
            </div>
          )
      ) : null}
    </>
  );

  const writeOff = emailActive || problems.length > 0 || needsTailor || (how === "claude" && (!engine || notReady));
  const writeWhy = needsTailor ? "Attach the tailored resume first, or pick another resume option."
    : how === "claude" && notReady ? "Claude Code needs a one-time setup first." : problems[0];

  return (
    <div className="stack recruiter-email">
      <p role="note" className="agency-note"><Text role="body-sm" muted as="span">{RECRUITER_NOTE}</Text></p>
      <Select label="What it's about" value={about} disabled={emailActive} onChange={(e) => { setAbout(e.target.value); setAdded(null); }}
        options={[...live.map((j) => ({ value: j.id, label: displayName(j.title) })), { value: GENERAL, label: "General enquiry" }]}
        help={job ? undefined : `Kept with ${displayName(a.name)} in your mail, not with a job.`} />
      <Choice legend="How to write it" value={how} disabled={emailActive} onChange={setHow} options={[
        { value: "template", label: "Use the template" }, { value: "claude", label: "Have Claude write it" },
      ]} />
      {how === "claude" ? (
        <div className="stack-tight">
          <Textarea className="recruiter-email__note" label="Anything to add or ask?" value={note} maxLength={NOTE_MAX} disabled={emailActive}
            rows={5} placeholder="For example: I'm available from November; ask about contract roles"
            help={`Optional. Claude uses your profile, your resume and what's saved about this agency. ${Array.from(note).length.toLocaleString("en-AU")} of ${NOTE_MAX.toLocaleString("en-AU")} characters.`}
            aria-invalid={problems.length ? true : undefined} onChange={(e) => setNote(e.target.value)} />
          {problems.length ? <p role="alert" className="field__error">{problems[0]}</p> : null}
          {notReady ? (
            <div className="row">
              <Text role="body-sm" muted as="span">Claude Code needs a one-time setup first.</Text>
              <Button size="sm" icon={Icons.ai} onClick={() => navigate(CLAUDE_SETTINGS)}>Claude setup</Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <section aria-label="Resume" className="stack-tight">{resumePart}</section>
      {prioritiseSponsorship ? (
        <Checkbox label="Ask about sponsorship" help={sponsorshipLine(me.visa_subclass)} checked={sponsor} disabled={emailActive} onChange={(e) => setSponsor(e.target.checked)} />
      ) : null}
      {error ? <p role="alert" className="field__error">{error}</p> : null}
      <div className="row">
        <Button variant="primary" icon={how === "claude" ? Icons.ai : Icons.compose} loading={busy === "write" || emailActive} disabled={writeOff}
          title={writeWhy} onClick={() => void write()}>Write email</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {emailActive ? (
          <span className="recruiter-email__run" role="status">
            <span className="crun__pulse" aria-hidden="true" />
            <Text role="body-sm" as="span">{emailRun.status === "queued" ? "Waiting for Claude…" : "Claude is writing…"}</Text>
            <span className="recruiter-email__time" aria-label={`Time taken ${formatElapsed(elapsed)}`}>{formatElapsed(elapsed)}</span>
            <Button size="sm" variant="ghost" onClick={() => void claude.cancel()} aria-label="Stop Claude writing the email">Stop</Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
