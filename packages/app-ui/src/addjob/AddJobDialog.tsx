import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { Button, Dialog, Icons, Input, Select, Text, Textarea } from "@careeros/brand";
import {
  routeJobLink, WR_LABEL_TEXT, WR_LABELS, type JobAdded, type JobDraft, type JobPreview, type JobPreviewResult, type PreviewNeed, type WorkRightsLabel,
} from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { navigate } from "../router";
import "./addjob.css";

/** A pasted value is a link when it is one line that starts with https:// (anything else is the ad's text). */
export function asLink(v: string): string | null {
  const t = v.trim();
  return /^https:\/\/\S+$/i.test(t) ? t : null;
}

/** The hint under the box: where a link will be read from, in plain words. */
export function routeHint(value: string, chromeConnected: boolean | null): string {
  const t = value.trim();
  if (!t) return "Paste a link from a job site or a company's careers page, or paste the whole ad.";
  if (/^http:\/\//i.test(t)) return "Use the https:// link from the address bar.";
  const link = asLink(t);
  if (!link) return t.includes("\n") || t.length > 80 ? "The ad's text: the next step shows what was read from it." : "That doesn't look like a link. Paste the whole ad, or a link starting with https://.";
  const r = routeJobLink(link);
  if (!r) return "That doesn't look like a link.";
  if (r.kind === "ats") return `${r.site} job: its public details are read straight away.`;
  if (r.kind === "chrome") {
    return chromeConnected
      ? `${r.site} ad: read in your Chrome, in a new tab that closes when it's done.`
      : `${r.site} blocks apps from reading its pages, so it's read in your own Chrome. Connect Chrome first, or paste the ad's text below.`;
  }
  return `${r.site || "This site"} isn't read from the app. Paste the ad's text below as well.`;
}

type Step =
  | { kind: "source" }
  | { kind: "check"; preview: JobPreview }
  | { kind: "added"; job: JobAdded };

export interface AddJobDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * After saving. Without it the dialog shows "Added" with Score fit, Tailor resume and Open job. With it (Resumes'
   * "For a job ad"), the caller takes over and the dialog closes.
   */
  onAdded?: (job: JobAdded) => void;
  /** Save button text, for example "Save and tailor". */
  saveLabel?: string;
  title?: string;
}

const NEED_ACTION: Record<PreviewNeed, "paste" | "connect" | "setup" | "retry"> = {
  paste: "paste", connect_chrome: "connect", set_up_chrome: "setup", sign_in: "retry", check: "retry", busy: "paste", not_found: "paste", failed: "retry",
};

/**
 * "Add a job": paste a link or the ad's text (or drop a file), check what was read, save. Nothing is saved before Save.
 * A job site that blocks apps is read in the person's own Chrome when it's connected; otherwise they paste the text.
 */
export function AddJobDialog({ open, onClose, onAdded, saveLabel = "Save job", title = "Add a job" }: AddJobDialogProps) {
  const bridge = useBridge();
  const [step, setStep] = useState<Step>({ kind: "source" });
  const [value, setValue] = useState("");
  const [adText, setAdText] = useState("");
  const [problem, setProblem] = useState<Extract<JobPreviewResult, { ok: false }> | null>(null);
  const [busy, setBusy] = useState<"read" | "connect" | "save" | "file" | null>(null);
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const [chrome, setChrome] = useState<boolean | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  useEffect(() => {
    if (!open) return;
    setStep({ kind: "source" }); setValue(""); setAdText(""); setProblem(null); setError(""); setBusy(null);
  }, [open]);

  const link = asLink(value);
  const route = link ? routeJobLink(link) : null;
  const needsChrome = route?.kind === "chrome";
  useEffect(() => {
    if (!open || !needsChrome || !bridge.chrome) return;
    let on = true;
    bridge.chrome.state(false).then((s) => { if (on) setChrome(s.connected); }, () => { if (on) setChrome(false); });
    return () => { on = false; };
  }, [open, needsChrome, bridge]);

  // The second box (the ad's text for a link) shows once a link can't be read here, or for a site the app doesn't read.
  const showAdText = !!link && (!!problem || route?.kind === "paste" || (needsChrome && chrome === false) || adText.trim() !== "");
  const canRead = !!value.trim() && !/^http:\/\//i.test(value.trim()) && (!link || !!route);

  const handle = (r: JobPreviewResult) => {
    if (r.ok) { setProblem(null); setStep({ kind: "check", preview: r.preview }); return; }
    setProblem(r);
    if (NEED_ACTION[r.need] === "paste") setTimeout(() => textRef.current?.focus(), 0);
  };

  const read = async () => {
    setError(""); setBusy("read");
    try {
      handle(await bridge.jobs.preview(link ? { url: link, ...(adText.trim() ? { text: adText } : {}) } : { text: value }));
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };

  const connect = async () => {
    if (!bridge.chrome) return;
    setError(""); setBusy("connect");
    try {
      const s = await bridge.chrome.connect();
      setChrome(s.connected);
      if (s.connected) { setBusy("read"); handle(await bridge.jobs.preview({ url: link! })); }
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };

  const fromFile = async (path: string | null) => {
    if (!path) return;
    setError(""); setBusy("file");
    try { handle(await bridge.jobs.previewFile(path)); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };
  const pick = async () => { try { await fromFile(await bridge.files.pick()); } catch (e) { setError(errorText(e)); } };
  const drop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) void fromFile(bridge.pathForFile(f));
  };

  const save = async (draft: JobDraft) => {
    setError(""); setBusy("save");
    try {
      const job = await bridge.jobs.add(draft, "Saved");
      if (!job.created) {
        setStep((s) => (s.kind === "check" ? { ...s, preview: { ...s.preview, duplicate: { company_slug: job.company_slug, id: job.id, title: job.title, company_name: job.company_name, by: "title" } } } : s));
        return;
      }
      if (onAdded) { onAdded(job); return; }
      setStep({ kind: "added", job });
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };

  const go = (r: Parameters<typeof navigate>[0]) => { onClose(); navigate(r); };

  if (step.kind === "check") {
    return (
      <CheckStep open={open} onClose={onClose} title={title} preview={step.preview} busy={busy === "save"} error={error} saveLabel={saveLabel}
        onBack={() => { setStep({ kind: "source" }); setError(""); }} onSave={(d) => void save(d)}
        onOpen={(slug, id) => go({ screen: "job", slug, id })} />
    );
  }

  if (step.kind === "added") {
    const j = step.job;
    return (
      <Dialog open={open} onClose={onClose} title="Job added"
        actions={<><Button onClick={onClose}>Done</Button><Button variant="primary" onClick={() => go({ screen: "job", slug: j.company_slug, id: j.id })}>Open job</Button></>}>
        <div className="addjob stack">
          <Text role="body">{`${j.title} at ${j.company_name} is in your jobs, saved to your shortlist.`}</Text>
          <Text role="body-sm" muted>What next? Claude can score how well you fit, or write a resume and cover letter for this ad. The company's page shows what's known about its sponsorship.</Text>
          <div className="addjob__next">
            <Button icon={Icons.target} onClick={() => go({ screen: "job", slug: j.company_slug, id: j.id, tab: "score", start: true })}>Score fit</Button>
            <Button icon={Icons.file} onClick={() => go({ screen: "apply", slug: j.company_slug, id: j.id })}>Tailor resume</Button>
            <Button icon={Icons.company} onClick={() => go({ screen: "company", slug: j.company_slug })}>{`About ${j.company_name}`}</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const action = problem ? NEED_ACTION[problem.need] : null;
  return (
    <Dialog open={open} onClose={onClose} title={title}
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canRead} loading={busy === "read"} title={canRead ? undefined : "Paste a link or the ad's text first"} onClick={() => void read()}>
          {busy === "read" ? "Reading…" : "Continue"}
        </Button>
      </>}>
      <div className={`addjob stack${over ? " is-over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
        <Textarea label="Job link or ad text" rows={link || !value ? 2 : 6} value={value} placeholder="https://… or the whole ad"
          aria-describedby={problem ? undefined : hintId} onChange={(e) => { setValue(e.target.value); setProblem(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && asLink(value) && canRead) { e.preventDefault(); void read(); } }} />
        {/* The alert below says the same thing in more detail, so the hint steps aside while it shows. */}
        {problem ? null : <Text role="body-sm" muted id={hintId} className="addjob__hint">{routeHint(value, chrome)}</Text>}

        {problem ? (
          <div className="addjob__problem" role="alert">
            <Text role="body">{problem.text}</Text>
            <div className="row">
              {action === "connect" && bridge.chrome ? <Button size="sm" variant="primary" loading={busy === "connect"} onClick={() => void connect()}>Connect Chrome</Button> : null}
              {action === "setup" ? <Button size="sm" title="Set up Search in my Chrome" onClick={() => go({ screen: "settings", tab: "connections", c: "chrome" })}>Chrome setup</Button> : null}
              {action === "retry" ? <Button size="sm" onClick={() => void read()}>Try again</Button> : null}
            </div>
          </div>
        ) : null}

        {showAdText ? (
          <Textarea ref={textRef} label="The ad's text" rows={6} value={adText} onChange={(e) => setAdText(e.target.value)}
            help="Open the ad in your browser, select all its text and paste it here. The link is kept with the job." />
        ) : null}

        <div className="addjob__file">
          <Text role="body-sm" muted as="span">Have the ad as a file? Drop it here, or</Text>
          <Button size="sm" variant="ghost" icon={Icons.file} loading={busy === "file"} onClick={() => void pick()}>Choose file</Button>
        </div>
        {error ? <Text role="body-sm" className="addjob__error" as="p">{error}</Text> : null}
      </div>
    </Dialog>
  );
}

const VIA: Record<JobPreview["via"], string> = {
  ats: "Read from the employer's job page.", chrome: "Read in your Chrome. The tab is closed.", text: "Read from the text you pasted.", file: "Read from your file.",
};

/** Step 2: everything that was read, editable, then Save. */
function CheckStep({ open, onClose, title, preview, busy, error, saveLabel, onBack, onSave, onOpen }: {
  open: boolean; onClose: () => void; title: string; preview: JobPreview; busy: boolean; error: string; saveLabel: string;
  onBack: () => void; onSave: (d: JobDraft) => void; onOpen: (slug: string, id: string) => void;
}) {
  const [d, setD] = useState<JobDraft>(preview.draft);
  useEffect(() => setD(preview.draft), [preview.draft]);
  const set = <K extends keyof JobDraft>(k: K, v: JobDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const dup = preview.duplicate;
  const missing = [!d.company.trim() && "the company", !d.title.trim() && "the job title"].filter(Boolean) as string[];
  const why = missing.length ? `Add ${missing.join(" and ")} to save.` : "";
  return (
    <Dialog open={open} onClose={onClose} title={`${title}: check the details`}
      actions={<>
        <Button variant="ghost" onClick={onBack}>Back</Button>
        {dup ? <Button variant="primary" onClick={() => onOpen(dup.company_slug, dup.id)}>Open it</Button> : (
          <Button variant="primary" icon={Icons.add} disabled={!!why} loading={busy} title={why || undefined} onClick={() => onSave({ ...d, company: d.company.trim(), title: d.title.trim() })}>{saveLabel}</Button>
        )}
      </>}>
      <div className="addjob addjob--check stack">
        {dup ? (
          <div className="addjob__dup" role="status">
            <Text role="body">{`Already in your jobs: ${dup.title} at ${dup.company_name}.`}</Text>
            <Text role="body-sm" muted>{dup.by === "link" ? "It's the same ad." : "Same company and job title."} Open it instead of adding it twice.</Text>
          </div>
        ) : <Text role="body-sm" muted>{`${VIA[preview.via]} Check it and fix anything that's wrong.`}</Text>}
        {preview.warnings.map((w) => <Text key={w} role="body-sm" className="addjob__warn" as="p">{w} You can still save it.</Text>)}

        <div className="addjob__grid">
          <Input label="Job title" value={d.title} maxLength={200} onChange={(e) => set("title", e.target.value)} error={!d.title.trim() ? "Needed to save" : undefined} />
          <Input label="Company" value={d.company} maxLength={120} onChange={(e) => set("company", e.target.value)} error={!d.company.trim() ? "Needed to save" : undefined} />
          <Input label="Location" value={d.location} maxLength={120} placeholder="Not stated" onChange={(e) => set("location", e.target.value)} />
          <Select label="Work mode" value={d.work_mode} onChange={(e) => set("work_mode", e.target.value)}
            options={[{ value: "", label: "Not stated" }, ...["Remote", "Hybrid", "On-site"].map((m) => ({ value: m, label: m })), ...(d.work_mode && !["Remote", "Hybrid", "On-site"].includes(d.work_mode) ? [{ value: d.work_mode, label: d.work_mode }] : [])]} />
          <Input label="Salary" value={d.salary} maxLength={120} placeholder="Not stated" onChange={(e) => set("salary", e.target.value)} />
          <Input label="Job type" value={d.job_type} maxLength={40} placeholder="Not stated" onChange={(e) => set("job_type", e.target.value)} />
          <Input label="Posted" type="date" value={d.posted} onChange={(e) => set("posted", e.target.value)}
            help={d.posted ? undefined : "Not stated in the ad."} />
        </div>

        <div className="addjob__rights">
          <Select label="Work rights in the ad" value={d.rights} onChange={(e) => set("rights", e.target.value as WorkRightsLabel)}
            options={WR_LABELS.map((l) => ({ value: l, label: l === "silent" ? "Not mentioned" : WR_LABEL_TEXT[l] }))} />
          {d.rights_quotes.length ? (
            <figure className="addjob__quote">
              <figcaption className="t-body-sm">The ad says</figcaption>
              {d.rights_quotes.map((q) => <blockquote key={q} className="t-body-sm">{q}</blockquote>)}
            </figure>
          ) : <Text role="body-sm" muted>Nothing in the ad about visas or work rights.</Text>}
        </div>

        <Textarea label="The ad" rows={6} value={d.jd_text} onChange={(e) => set("jd_text", e.target.value)} help="Saved with the job, so Claude can score it and tailor your resume to it." />
        {error ? <Text role="body-sm" className="addjob__error" as="p">{error}</Text> : null}
      </div>
    </Dialog>
  );
}
