import { useState } from "react";
import { Button, Checkbox, Icons, Select, Text } from "@careeros/brand";
import { fileKind, recruiterEmailDraft, sponsorshipLine, type AgencyRow, type DraftInput, type JobFile } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { ActionButton } from "../components/ActionButton";
import { DraftEditor, EMPTY_DRAFT } from "../components/DraftEditor";
import { displayName } from "../components/displayName";
import { Loading } from "../components/States";
import { applicationAttachments } from "../screens/Apply";
import { placesOf } from "../sponsors/region";
import { useSponsorshipFocus } from "../useSponsorshipFocus";
import { RECRUITER_NOTE } from "./AgencyCard";

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

/**
 * Email a recruiter like an application: pick the live job it's about, or a general enquiry. About a job, the
 * draft is kept with that job and attaches its tailored resume when there is one (its exported PDF or Word file
 * first, like Email application), or offers Tailor first. A general enquiry (and any agency with no saved job) is
 * kept with the agency's company folder instead, set up the first time. Either way you can attach one of your own
 * resumes. The template comes from your profile; people who need sponsorship get the sponsorship question, which
 * they can turn off. "Write the email" opens the usual draft editor; nothing is ever sent without your OK.
 */
export function RecruiterEmail({ a, onClose }: { a: AgencyRow; onClose: () => void }) {
  const bridge = useBridge();
  const { run, busy } = useAction();
  const { prioritiseSponsorship } = useSponsorshipFocus();
  const live = a.jobs.filter((j) => j.open);
  const [about, setAbout] = useState(live[0]?.id ?? GENERAL);
  const [sponsor, setSponsor] = useState(true);
  const [mine, setMine] = useState("");
  const [added, setAdded] = useState<JobFile | null>(null);
  const [writing, setWriting] = useState<{ slug: string; id: string; initial: DraftInput; files: JobFile[] } | null>(null);
  const job = live.find((j) => j.id === about) ?? null;
  const key = job ? [job.company_slug, job.id] : ["", ""];
  const apply = useLoad((b) => (job ? b.apply.state(job.company_slug, job.id) : Promise.resolve(null)), key, ["jobs", "claude"]);
  const exp = useLoad((b) => (job ? b.docs.state(job.company_slug, job.id) : Promise.resolve(null)), key, ["jobs", "claude"]);
  const profile = useLoad((b) => b.settings.get("profile"), [], ["settings"]);
  const library = useLoad((b) => b.resumes.list(), [], ["jobs"]);

  if (writing) {
    return <DraftEditor slug={writing.slug} id={writing.id} draftId="" files={writing.files} onClose={onClose} initial={writing.initial} />;
  }
  if (job && !apply.data && !apply.error) return <Loading />;
  const tailored = job ? applicationAttachments({ files: apply.data?.files ?? [] }, exp.data ?? null).attach.find(isResume) : undefined;
  const resume = tailored ?? added?.rel;
  const own = library.data?.base ?? [];
  const picked = mine || own[0]?.rel || "";
  const v = (profile.data?.values ?? {}) as Record<string, unknown>;
  const me = meFromProfile(v);
  const asks = prioritiseSponsorship && sponsor;
  const owner = job ? { slug: job.company_slug, id: job.id } : { slug: a.slug, id: "" };

  const attachMine = () => run("attach-resume", async () => {
    if (!job) await bridge.recruiters.mailbox(a.slug);
    const r = await bridge.recruiters.attachResume(owner.slug, owner.id, picked);
    const name = r.rel.split("/").pop()!;
    setAdded({ path: r.rel.split("/").slice(job ? 4 : 2).join("/"), rel: r.rel, label: "Your resume", at: new Date().toISOString(), exists: true, size: null, kind: fileKind(name) });
  }, "Resume added");
  const write = () => run("write", async () => {
    if (!job) await bridge.recruiters.mailbox(a.slug);
    const t = recruiterEmailDraft({ me, agency: a, job: job ? { title: job.title, location: job.location } : null, sponsorship: asks, attached: !!resume });
    setWriting({
      ...owner, files: [...(job ? apply.data?.files ?? [] : []), ...(added ? [added] : [])],
      initial: { ...EMPTY_DRAFT, to: a.email, subject: t.subject, body: t.body, attach: resume ? [resume] : [] },
    });
  });

  return (
    <div className="stack recruiter-email">
      <p role="note" className="agency-note"><Text role="body-sm" muted as="span">{RECRUITER_NOTE}</Text></p>
      <Select label="What it's about" value={about} onChange={(e) => { setAbout(e.target.value); setAdded(null); }}
        options={[...live.map((j) => ({ value: j.id, label: displayName(j.title) })), { value: GENERAL, label: "General enquiry" }]}
        help={job ? undefined : `Kept with ${displayName(a.name)} in your mail, not with a job.`} />
      <section aria-label="Resume" className="stack-tight">
        {tailored ? <Text role="body-sm" as="p">{`Your tailored resume for ${displayName(job!.title)} is attached.`}</Text>
          : added ? <Text role="body-sm" as="p">Your resume is attached.</Text> : (
            <>
              <Text role="body-sm" muted as="p">{job ? "No tailored resume for this job yet. Tailor it first, or attach one of your resumes." : "Attach one of your resumes, or send without one."}</Text>
              <div className="row">
                {job ? <ActionButton action="tailor_application" target={{ kind: "job", company_slug: job.company_slug, id: job.id }} label="Tailor first" ariaLabel="Tailor first" /> : null}
                {own.length > 1 ? <Select label="Your resume" hideLabel value={picked} onChange={(e) => setMine(e.target.value)} options={own.map((r) => ({ value: r.rel, label: r.name }))} /> : null}
                {own.length ? <Button size="sm" icon={Icons.attach} loading={busy === "attach-resume"} onClick={() => void attachMine()}>Attach resume</Button>
                  : <Text role="body-sm" muted as="span">No resume in your profile yet.</Text>}
              </div>
            </>
          )}
      </section>
      {prioritiseSponsorship ? (
        <Checkbox label="Ask about sponsorship" help={sponsorshipLine(me.visa_subclass)} checked={sponsor} onChange={(e) => setSponsor(e.target.checked)} />
      ) : null}
      <div className="row">
        <Button variant="primary" icon={Icons.compose} loading={busy === "write"} onClick={() => void write()}>Write email</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
