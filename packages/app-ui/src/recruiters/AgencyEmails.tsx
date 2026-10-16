import { useState } from "react";
import { Button, cx, Icons, Pill, Text, type PillTone } from "@careeros/brand";
import type { AgencyEmail, AgencyEmails, DraftInput } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";
import { DraftEditor, replyInput } from "../components/DraftEditor";
import { MessageViewer } from "../components/MessageViewer";
import { EmptyState } from "../components/States";
import { fmtDateTime } from "../format";
import { DRAFT_STATUS } from "../screens/Mail";
import "./emails.css";

interface Editing { slug: string; id: string; draftId: string; initial: DraftInput }

/**
 * An agency's Emails tab: the back-and-forth with it, thread by thread (newest thread first, oldest message first
 * inside), each message with its direction, the other side's address, date, subject and a line of its text. Clicking
 * mail opens it in the message viewer; a draft opens in the editor. Reply answers the newest message received, kept
 * where that message is filed (the agency, or the job it's about). Nothing is sent without your approval.
 */
export function AgencyEmailsPanel({ name, emails, onNew }: { name: string; emails: AgencyEmails; onNew: () => void }) {
  const bridge = useBridge();
  const { run, busy } = useAction();
  const [open, setOpen] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const latest = emails.threads.flatMap((t) => t.messages).find((m) => m.ref && m.ref === emails.latest_in) ?? null;

  const reply = (m: AgencyEmail) => run(`reply-${m.ref}`, async () => {
    const v = await bridge.mail.get(m.ref);
    setEditing({ slug: m.company_slug, id: m.job_id, draftId: "", initial: replyInput(v) });
  });
  const editDraft = (m: AgencyEmail) => run(`edit-${m.draft_id}`, async () => {
    const d = await bridge.mail.drafts.get(m.company_slug, m.job_id, m.draft_id!);
    setEditing({ slug: m.company_slug, id: m.job_id, draftId: m.draft_id!, initial: d.draft });
  });

  if (editing) return <DraftEditor key={editing.draftId || "new"} slug={editing.slug} id={editing.id} draftId={editing.draftId} initial={editing.initial} files={[]} onClose={() => setEditing(null)} />;
  if (!emails.total) {
    return <EmptyState boxed text={`No emails with ${name} yet. Mail from them shows here once it syncs, including from addresses you link in Mail to sort.`} action={<Button icon={Icons.compose} onClick={onNew}>Email</Button>} />;
  }

  return (
    <div className="stack agency-emails" data-tour="recruiter-emails">
      <div className="row row--between">
        <Text role="body-sm" muted>{`Your emails with ${name}, by conversation. Click one to read it.`}</Text>
        {latest ? (
          <Button icon={Icons.reply} loading={busy === `reply-${latest.ref}`} aria-label={`Reply to ${latest.who.address}: ${latest.subject || "(no subject)"}`} onClick={() => void reply(latest)}>Reply</Button>
        ) : null}
      </div>
      {emails.threads.map((t) => (
        <section key={t.key} className="agency-thread card" aria-label={`Conversation: ${t.subject || "(no subject)"}`}>
          <h3 className="t-body agency-thread__subject">{t.subject || "(no subject)"}</h3>
          <ol className="list-plain agency-thread__list">
            {t.messages.map((m, i) => {
              const mine = m.direction === "out";
              const label = `${mine ? "You → them" : "Them → you"}, ${m.who.address || "unknown"}, ${fmtDateTime(m.date)}: ${m.subject || "(no subject)"}`;
              const [draftLabel, tone]: [string, PillTone] = m.kind === "draft" ? DRAFT_STATUS[m.status ?? "draft"] ?? ["Draft", "neutral"] : ["", "neutral"];
              return (
                <li key={`${m.ref || m.draft_id}-${i}`} className={cx("agency-msg", mine ? "agency-msg--out" : "agency-msg--in", open === m.ref && m.ref && "is-open")}>
                  <button type="button" className="agency-msg__body" aria-label={label} aria-expanded={m.kind === "mail" ? open === m.ref : undefined}
                    onClick={() => (m.kind === "mail" ? setOpen(open === m.ref ? "" : m.ref) : void editDraft(m))}>
                    <span className="row agency-msg__head">
                      <Text role="body-sm" as="span" className="agency-msg__dir">{mine ? "You → them" : "Them → you"}</Text>
                      <Text role="body-sm" muted as="span" truncate>{m.who.address}</Text>
                      <Text role="body-sm" muted as="span">{fmtDateTime(m.date)}</Text>
                      {m.kind === "draft" ? <Pill tone={tone}>{draftLabel}</Pill> : null}
                    </span>
                    <Text role="body" as="span" truncate>{m.subject || "(no subject)"}</Text>
                    {m.snippet ? <Text role="body-sm" muted as="span" truncate>{m.snippet}</Text> : null}
                  </button>
                  {m.kind === "mail" && open === m.ref ? (
                    <div className="agency-msg__viewer">
                      <MessageViewer key={m.ref} mailRef={m.ref} onReply={(v) => setEditing({ slug: m.company_slug, id: m.job_id, draftId: "", initial: replyInput(v) })} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
