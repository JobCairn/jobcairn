import { useState } from "react";
import { Button, Card, Icons, Pill, Text, useToast } from "@careeros/brand";
import {
  LINKEDIN_NOTE_MAX, fitLinkedIn, followUpIsDue, followUpOn, followUpTemplate, parseOutreach, thankYouTemplate, type DraftInput, type JobDetail,
} from "@careeros/contract";
import { fmtDay, parseDay } from "../reading/dates";
import { useLoad } from "../bridge-context";
import { ActionButton } from "../components/ActionButton";
import { DraftEditor, EMPTY_DRAFT } from "../components/DraftEditor";
import { copyText } from "./copy";
import { PeopleYouKnow } from "./PeopleYouKnow";
import "./outreach.css";


/**
 * Job › Outreach: honest ways to get noticed. A short note to the hiring manager that names one real result (Claude
 * drafts it from your own files), ready to open as a Mail draft or copy for LinkedIn. Nothing is ever sent from here:
 * a draft waits for you in Mail, and sending still needs your OK.
 */
export function OutreachPanel({ slug, id, d, broken }: { slug: string; id: string; d: JobDetail; broken: boolean }) {
  const [editing, setEditing] = useState<DraftInput | null>(null);
  if (editing) {
    return <DraftEditor key="outreach" slug={slug} id={id} draftId="" initial={editing} files={d.files} onClose={() => setEditing(null)} />;
  }
  return (
    <div className="stack job-panel outreach">
      <FollowUpCard d={d} onMail={setEditing} />
      <NoteCard slug={slug} id={id} broken={broken} onMail={setEditing} />
      <PeopleYouKnow company={d.company?.name ?? slug} title={d.job.title} onMail={broken ? undefined : setEditing} />
    </div>
  );
}

function NoteCard({ slug, id, broken, onMail }: { slug: string; id: string; broken: boolean; onMail: (d: DraftInput) => void }) {
  const toast = useToast();
  const md = useLoad((b) => b.files.readText(`companies/${slug}/jobs/${id}/outreach.md`).catch(() => ""), [slug, id], ["jobs"]);
  const note = md.data ? parseOutreach(md.data) : null;
  const linkedin = note?.linkedin ? fitLinkedIn(note.linkedin) : "";
  const copy = async (text: string, what: string) => toast(await copyText(text) ? { tone: "success", text: `${what} copied` } : { tone: "danger", text: "Couldn't copy. Select the text and copy it instead." });
  return (
    <Card className="stack" aria-label="Note to the hiring manager">
      <div className="row row--between">
        <Text role="heading-2" as="h3">Note to the hiring manager</Text>
        {broken ? null : <ActionButton action="outreach_note" target={{ kind: "job", company_slug: slug, id }} />}
      </div>
      <Text role="body-sm" muted>
        A 3 to 4 line note that names one real result from your own files, plus a LinkedIn connection note. You choose who gets it; nothing is sent from here.
      </Text>
      {note ? (
        <>
          {note.subject ? <Text role="body-sm" as="div"><strong>Subject:</strong> {note.subject}</Text> : null}
          <div className="outreach__text">{note.body}</div>
          <div className="row">
            <Button size="sm" icon={Icons.mail} onClick={() => onMail({ ...EMPTY_DRAFT, subject: note.subject, body: note.body })} aria-label="Open in Mail">Mail</Button>
            <Button size="sm" variant="ghost" onClick={() => void copy(note.body, "Note")}>Copy note</Button>
          </div>
          {linkedin ? (
            <div className="stack-tight">
              <Text role="label" as="div">LinkedIn connection note</Text>
              <div className="outreach__text">{linkedin}</div>
              <div className="row">
                <Button size="sm" variant="ghost" aria-label="Copy for LinkedIn" onClick={() => void copy(linkedin, "LinkedIn note")}>Copy</Button>
                <Text role="body-sm" muted>{`${Array.from(linkedin).length} of ${LINKEDIN_NOTE_MAX} characters`}</Text>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

/** "Follow up due" after applying (with a ready follow-up draft), or a thank-you draft after an interview. */
function FollowUpCard({ d, onMail }: { d: JobDetail; onMail: (d: DraftInput) => void }) {
  const j = d.job;
  const company = d.company?.name ?? j.company_slug;
  if (j.status === "Applied") {
    const on = followUpOn(j);
    if (!on) return null;
    const due = followUpIsDue(on, new Date());
    const onDay = parseDay(on);
    const applied = [...j.timeline].reverse().find((e) => e.event === "Status: Applied")?.at.slice(0, 10);
    const t = followUpTemplate({ title: j.title, company, appliedOn: applied });
    return (
      <Card className="stack" aria-label="Follow-up">
        <div className="row row--between">
          <Text role="heading-2" as="h3">Follow-up</Text>
          {due ? <Pill tone="warning">Follow up due</Pill> : <Pill tone="neutral">{`Follow up on ${onDay ? fmtDay(onDay) : on}`}</Pill>}
        </div>
        <Text role="body-sm" muted>A short, polite check-in a week after applying keeps your application in mind. Add who it goes to; it waits in Mail until you send it.</Text>
        <div className="row"><Button size="sm" variant={due ? "primary" : "secondary"} icon={Icons.mail} aria-label="Open follow-up draft" onClick={() => onMail({ ...EMPTY_DRAFT, ...t })}>Follow-up draft</Button></div>
      </Card>
    );
  }
  if (j.status === "Interview") {
    const t = thankYouTemplate({ title: j.title, company });
    return (
      <Card className="stack" aria-label="Thank-you note">
        <Text role="heading-2" as="h3">Thank-you note</Text>
        <Text role="body-sm" muted>Send a short thank-you within a day of the interview. Add one thing you talked about before you send it.</Text>
        <div className="row"><Button size="sm" icon={Icons.mail} aria-label="Open thank-you draft" onClick={() => onMail({ ...EMPTY_DRAFT, ...t })}>Thank-you draft</Button></div>
      </Card>
    );
  }
  return null;
}
