import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Button, Icon, Icons, Input, Tabs, Text, Textarea, cx, useToast } from "@careeros/brand";
import type { DraftDetail, DraftInput, JobFile, MailMessageView } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { EmailPreviewCard } from "./EmailPreview";
import { AddressField } from "../mail/AddressField";
import { WriteWithClaude, type Applied, type EmailPurpose } from "../mail/WriteWithClaude";
import { navigate } from "../router";
import { useFileViewer } from "../viewer";
import "../mail/compose.css";

export const EMPTY_DRAFT: DraftInput = { to: "", cc: "", subject: "", body: "", attach: [], in_reply_to: "", references: [], purpose: "" };

/**
 * What Write with Claude starts on: a reply answers an email; a draft opened from the follow-up or thank-you
 * templates (Outreach) keeps that purpose, so Claude's grounding and the follow-up limit apply; else an application.
 */
export function draftPurpose(d: Pick<DraftInput, "in_reply_to" | "subject">): EmailPurpose {
  if (d.in_reply_to) return "reply";
  if (/^\s*following up:/i.test(d.subject)) return "follow_up";
  if (/^\s*thank you:/i.test(d.subject)) return "thank_you";
  return "application";
}

/** A reply goes to Reply-To when there is one, else the sender, and carries In-Reply-To and References so Gmail threads it. */
export function replyInput(v: MailMessageView): DraftInput {
  const who = v.reply_to[0] ?? v.from;
  return {
    ...EMPTY_DRAFT,
    to: who.name ? `${who.name} <${who.address}>` : who.address,
    subject: /^re:/i.test(v.subject.trim()) ? v.subject.trim() : `Re: ${v.subject.trim()}`,
    in_reply_to: v.message_id,
    references: [...v.references.filter((r) => r !== v.message_id), v.message_id].slice(-20),
  };
}

const ATTACH_NAMES: [RegExp, string][] = [[/^resume\b/i, "Tailored resume"], [/^cover-?letter\b/i, "Cover letter"], [/^claims\b/i, "Claim check"], [/^answers\b/i, "Answers"]];

/** "Tailored resume · resume.md": a friendly name for known application files, then the file name. Never the folder path. */
export function attachLabel(f: Pick<JobFile, "path">): string {
  const name = f.path.split("/").pop() ?? f.path;
  const known = f.path.startsWith("application/") ? ATTACH_NAMES.find(([re]) => re.test(name))?.[1] : undefined;
  return known ? `${known} · ${name}` : name;
}

/** Why Review and send is off, or undefined when it can go to Approvals. */
export function sendBlocker(d: Pick<DraftInput, "to" | "subject">): string | undefined {
  return !d.to.trim() ? "Add who it goes to first." : !d.subject.trim() ? "Add a subject first." : undefined;
}

/** The signature as one quiet line: "Alex Example · AI Engineer". */
export function signatureLine(sig: string): string {
  return sig.split("\n").map((l) => l.trim()).filter(Boolean).join(" · ");
}

export function DraftEditor({ slug, id, draftId, initial, files, onClose, attachNote, attachSwap }: {
  slug: string; id: string; draftId: string; initial: DraftInput; files: JobFile[]; onClose: () => void;
  /** Shown under the attachments (the Email application's "sent as a text file" note). */
  attachNote?: ReactNode;
  /** Ticked file -> its replacement (a newly exported PDF for its Markdown); applied when it changes, keeping the rest of the draft. */
  attachSwap?: Record<string, string>;
}) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const hintId = useId();
  const [input, setInput] = useState<DraftInput>(initial);
  const [current, setCurrent] = useState(draftId);
  const [saved, setSaved] = useState<DraftDetail | null>(null);
  const [view, setView] = useState<"write" | "preview">("write");
  const [showCc, setShowCc] = useState(!!initial.cc.trim());
  /** What the fields held before Claude's last change, for Undo. */
  const [before, setBefore] = useState<Pick<DraftInput, "to" | "subject" | "body"> | null>(null);
  const status = useLoad((b) => b.mail.status(), [], ["mail"]);
  const set = (patch: Partial<DraftInput>) => { setInput((d) => ({ ...d, ...patch })); setSaved(null); };
  const swapKey = JSON.stringify(attachSwap ?? {});
  useEffect(() => {
    const swap = JSON.parse(swapKey) as Record<string, string>;
    if (!Object.keys(swap).length) return;
    setInput((d) => {
      const next = [...new Set(d.attach.map((r) => swap[r] ?? r))];
      return next.join("\n") === d.attach.join("\n") ? d : { ...d, attach: next };
    });
  }, [swapKey]);
  const sig = status.data?.signature.trim() ?? "";
  const live = `${input.body.replace(/\s+$/, "")}${sig ? `\n\n${sig}` : ""}\n`;
  // Attachments come only from this job's folder; drafts themselves are never attached.
  const attachable = files.filter((f) => f.exists && !f.path.startsWith("emails/drafts/"));
  const viewer = useFileViewer(attachable.map((f) => ({ rel: f.rel, title: attachLabel(f), at: f.at })));
  const sendWhy = sendBlocker(input);

  const save = async (): Promise<DraftDetail> => {
    const d = await bridge.mail.drafts.save(slug, id, current, input);
    setCurrent(d.view.draft_id);
    setSaved(d);
    return d;
  };
  const onSave = () => run("save", save, "Draft saved");
  // run() reports a failure as a toast and returns undefined; close only when the proposal was made.
  const onSend = async () => {
    const ok = await run("send", async () => {
      const d = await save();
      await bridge.mail.drafts.propose(slug, id, d.view.draft_id);
      return true;
    });
    if (!ok) return;
    toast({ text: "The email is waiting in Approvals. Nothing is sent until you approve it.", tone: "success" });
    onClose();
  };
  // Claude reads the saved copy, so the draft is saved (quietly) before each request.
  // Quietly: no "exactly what will be sent" card, since the text is about to change.
  const saveForClaude = async (): Promise<string> => {
    const d = await bridge.mail.drafts.save(slug, id, current, input);
    setCurrent(d.view.draft_id);
    return d.view.draft_id;
  };
  const apply = useCallback((a: Applied) => {
    setInput((d) => {
      setBefore({ to: d.to, subject: d.subject, body: d.body });
      return { ...d, subject: a.subject || d.subject, body: a.body, ...(a.to && !d.to.trim() ? { to: a.to } : {}) };
    });
    setSaved(null);
    setView("write");
  }, []);
  const undo = () => { if (before) { set(before); setBefore(null); } };
  const purpose = draftPurpose(initial);

  return (
    <form className="stack draft-editor compose" aria-label="Email draft" onSubmit={(e) => { e.preventDefault(); void onSave(); }}>
      <Text role="heading-2" as="h2">{draftId ? "Edit draft" : initial.in_reply_to ? "Reply" : "New email"}</Text>
      {/* Write with Claude reads a job's ad and score, so a company's own email (no job) is written by hand. */}
      {id ? <WriteWithClaude slug={slug} id={id} initialPurpose={purpose} hasBody={!!input.body.trim()} toEmpty={!input.to.trim()}
        save={saveForClaude} onApply={apply} onUndo={undo} canUndo={!!before} /> : null}

      <div className="compose__fields">
        <div className="compose__to">
          <AddressField label="To" value={input.to} onChange={(v) => set({ to: v })} />
          {!showCc ? <button type="button" className="compose__cc-link" onClick={() => setShowCc(true)}>Add Cc</button> : null}
        </div>
        {showCc ? <AddressField label="Cc" value={input.cc} onChange={(v) => set({ cc: v })} autoFocus={!initial.cc.trim()} /> : null}
        <Input label="Subject" value={input.subject} onChange={(e) => set({ subject: e.target.value })} />
      </div>

      <div className="compose__body">
        <Tabs label="Message view" sticky={false} value={view} onChange={(v) => setView(v as "write" | "preview")}
          tabs={[{ id: "write", label: "Write" }, { id: "preview", label: "Preview" }]}>
          {view === "write" ? (
            <Textarea label="Message" hideLabel rows={12} value={input.body} placeholder="Write your message, or use Draft above." onChange={(e) => set({ body: e.target.value })} />
          ) : (
            <pre className="mail-preview compose__preview" aria-label="Message preview">{live}</pre>
          )}
        </Tabs>
        <p className="compose__sig">
          {sig ? <><Text role="body-sm" muted as="span">Signature added below:</Text> <span className="compose__sig-text" title={sig}>{signatureLine(sig)}</span></>
            : <Text role="body-sm" muted as="span">No signature yet.</Text>}
          <button type="button" className="wwc__link" onClick={() => navigate({ screen: "settings", tab: "connections", c: "email" })}>{sig ? "Edit" : "Add one"}</button>
        </p>
      </div>

      {attachable.length ? (
        <fieldset className="compose__files">
          <legend className="field__label">Attach from this job&apos;s folder</legend>
          <div className="compose__file-list">
            {attachable.map((f) => {
              const on = input.attach.includes(f.rel);
              const name = attachLabel(f);
              return (
                <span key={f.rel} className={cx("file-chip", on && "is-on")}>
                  <button type="button" className="file-chip__toggle" aria-pressed={on} title={on ? `Attached: ${name}` : `Attach ${name}`}
                    onClick={() => set({ attach: on ? input.attach.filter((r) => r !== f.rel) : [...input.attach, f.rel] })}>
                    <Icon icon={on ? Icons.check : Icons.attach} size="sm" />
                    <span className="file-chip__name">{name}</span>
                  </button>
                  <button type="button" className="file-chip__view" aria-label={`View ${name}`} title={`View ${name}`} onClick={() => viewer.open(f.rel, name)}>
                    <Icon icon={Icons.show} size="sm" />
                  </button>
                </span>
              );
            })}
          </div>
        </fieldset>
      ) : <Text role="body-sm" muted>Files in this job&apos;s folder can be attached here.</Text>}
      {attachNote}
      {saved?.preview ? <EmailPreviewCard preview={saved.preview} note="This is exactly what will be sent if you approve it." /> : null}
      <div className="compose__foot">
        <div className="compose__foot-left">
          <Button type="submit" icon={Icons.save} loading={busy === "save"}>Save draft</Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <div className="compose__foot-right">
          {sendWhy ? <span id={hintId} className="compose__hint">{sendWhy}</span> : null}
          <span className="compose__send" title={sendWhy}>
            <Button variant="primary" icon={Icons.send} disabled={!!sendWhy} aria-describedby={sendWhy ? hintId : undefined} loading={busy === "send"} aria-label="Review and send" onClick={() => void onSend()}>Review &amp; send</Button>
          </span>
        </div>
      </div>
      {viewer.element}
    </form>
  );
}
