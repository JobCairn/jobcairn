import { useState } from "react";
import { Button, Icons, Pill, Text } from "@careeros/brand";
import type { DraftInput, JobFile, MailRow } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { DRAFT_STATUS } from "../screens/Mail";
import { DraftEditor, EMPTY_DRAFT, replyInput } from "./DraftEditor";
import { MessageViewer } from "./MessageViewer";
import { EmptyState, ErrorState, Loading } from "./States";
import { MailList } from "../mail/MailList";
import { useFillHeight } from "../mail/useFillHeight";

interface Editing { draftId: string; initial: DraftInput }

/** Messages grouped by thread, newest first inside a thread and newest thread first. */
function threads(rows: MailRow[]): MailRow[][] {
  const map = new Map<string, MailRow[]>();
  for (const r of rows) map.set(r.thread_key || r.ref, [...(map.get(r.thread_key || r.ref) ?? []), r]);
  return [...map.values()].map((t) => t.sort((a, b) => b.date.localeCompare(a.date))).sort((a, b) => b[0]!.date.localeCompare(a[0]!.date));
}

export function JobMail({ slug, id, files }: { slug: string; id: string; files: JobFile[] }) {
  const bridge = useBridge();
  const { run } = useAction();
  const [open, setOpen] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [splitRef, height] = useFillHeight<HTMLDivElement>();
  const list = useLoad((b) => b.mail.list({ company_slug: slug, id, includeCompany: true }), [slug, id], ["mail"]);
  const drafts = useLoad((b) => b.mail.drafts.list(slug, id), [slug, id], ["mail", "approvals"]);

  const edit = (draftId: string) => run(`edit-${draftId}`, async () => {
    const d = await bridge.mail.drafts.get(slug, id, draftId);
    setEditing({ draftId, initial: d.draft });
  });

  if (editing) {
    return <DraftEditor key={editing.draftId || "new"} slug={slug} id={id} draftId={editing.draftId} initial={editing.initial} files={files} onClose={() => setEditing(null)} />;
  }
  return (
    <div className="stack">
      <div className="row row--between">
        <Text role="body-sm" muted>Emails for this job and its company. Company emails can be moved onto this job.</Text>
        <Button icon={Icons.compose} data-tour="job-mail-new" onClick={() => setEditing({ draftId: "", initial: EMPTY_DRAFT })}>New email</Button>
      </div>
      {drafts.data?.length ? (
        <ul className="list-plain stack-tight job-mail__drafts" aria-label="Drafts">
          {drafts.data.map((d) => {
            const [label, tone] = DRAFT_STATUS[d.status] ?? ["Draft", "neutral"];
            const subject = d.subject || "(no subject)";
            return (
              <li key={d.draft_id} className="row">
                <span className="grow">
                  <Text role="body" as="div">{subject}</Text>
                  {d.note ? <Text role="body-sm" className="field__error" as="div">{d.note}</Text> : null}
                </span>
                <Pill tone={tone}>{label}</Pill>
                {d.status === "draft" || d.status === "failed" ? <Button size="sm" aria-label={`Edit ${subject}`} onClick={() => void edit(d.draft_id)}>Edit</Button> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="mail-split mail-split--fill" ref={splitRef} style={height ? { height } : undefined}>
        <div className="mail-split__list">
          {list.error && !list.data ? <ErrorState title="Mail can't load" text={list.error} /> : !list.data ? <Loading /> : list.data.rows.length === 0 ? (
            <EmptyState boxed text="No emails for this job yet." />
          ) : (
            // Grouped by thread (newest thread first); only company mail gets a tag, since everything else is this job's.
            <MailList rows={threads(list.data.rows).flat()} open={open} onOpen={setOpen} label="Threads" tagFor={(r) => (r.job_id ? null : { short: "Company mail", full: `${r.company_name}: company mail, not yet on a job` })} />
          )}
        </div>
        <div className="mail-split__viewer">
          {open ? <MessageViewer key={open} mailRef={open} showMove fill here={{ slug, id }} onReply={(v) => setEditing({ draftId: "", initial: replyInput(v) })} /> : (
            <div className="mail-split__empty"><EmptyState text={list.data?.rows.length ? "Choose an email to read it. Use the arrow keys or J and K to move through the list." : "Nothing to read yet."} /></div>
          )}
        </div>
      </div>
    </div>
  );
}
