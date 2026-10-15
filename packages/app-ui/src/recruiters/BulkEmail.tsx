import { useState } from "react";
import { Button, Checkbox, Select, Text, useToast } from "@careeros/brand";
import { recruiterEmailDraft, sponsorshipLine, type AgencyRow } from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { EMPTY_DRAFT } from "../components/DraftEditor";
import { plural } from "../format";
import { emailBlocker } from "./AgencyCard";
import { meFromProfile } from "./RecruiterEmail";
import { useSponsorshipFocus } from "../useSponsorshipFocus";

/** At most this many drafts in one go: recruiters remember mass mail, and a few personal emails do better. */
export const BULK_CAP = 20;
const NONE = "";

/**
 * Email selected: one general-enquiry draft per agency (never several agencies on one To line), each kept with the
 * agency's company folder and written from the profile, with the sponsorship question when it applies and the resume
 * chosen once here. Drafts wait in Mail › Drafts and Approvals; nothing is sent until each one is approved.
 */
export function BulkEmail({ agencies, onDone }: { agencies: AgencyRow[]; onDone: () => void }) {
  const bridge = useBridge();
  const toast = useToast();
  const { run, busy } = useAction();
  const { prioritiseSponsorship } = useSponsorshipFocus();
  const profile = useLoad((b) => b.settings.get("profile"), [], ["settings"]);
  const library = useLoad((b) => b.resumes.list(), [], ["jobs"]);
  const own = library.data?.base ?? [];
  const [resume, setResume] = useState<string | null>(null);
  const [sponsor, setSponsor] = useState(true);
  const picked = resume ?? own[0]?.rel ?? NONE;
  const reachable = agencies.filter((a) => !emailBlocker(a));
  const batch = reachable.slice(0, BULK_CAP);
  const noAddress = agencies.length - reachable.length;
  const over = reachable.length - batch.length;

  const go = () => run("bulk-email", async () => {
    const me = meFromProfile((profile.data?.values ?? {}) as Record<string, unknown>);
    let saved = 0;
    const failed: string[] = [];
    for (const a of batch) {
      try {
        await bridge.recruiters.mailbox(a.slug);
        const attach = picked ? [(await bridge.recruiters.attachResume(a.slug, "", picked)).rel] : [];
        const t = recruiterEmailDraft({ me, agency: a, job: null, sponsorship: prioritiseSponsorship && sponsor, attached: attach.length > 0 });
        await bridge.mail.drafts.save(a.slug, "", "", { ...EMPTY_DRAFT, to: a.email, subject: t.subject, body: t.body, attach });
        saved++;
      } catch (e) { failed.push(`${a.name}: ${errorText(e)}`); }
    }
    const skipped = [noAddress ? `${plural(noAddress, "agency", "agencies")} skipped: no published address.` : "", over ? `${over} left for another batch.` : "", failed.length ? `Couldn't draft ${failed.join("; ")}.` : ""];
    toast({ tone: saved ? "success" : "danger", text: [`${plural(saved, "draft")} saved in Mail › Drafts.`, ...skipped, "Nothing is sent until you approve it."].filter(Boolean).join(" ") });
    onDone();
  });

  return (
    <div className="stack recruiter-email">
      <Text role="body-sm" as="p">{`One general enquiry each to ${plural(batch.length, "agency", "agencies")}, written from your profile. You can edit every draft before approving it.`}</Text>
      {noAddress ? <Text role="body-sm" muted as="p">{`${plural(noAddress, "agency", "agencies")} without a published address will be skipped.`}</Text> : null}
      <p role="note" className="agency-note"><Text role="body-sm" muted as="span">
        {`Up to ${BULK_CAP} at a time. Recruiters notice mass emails; a few that fit your roles do better than many.${over ? ` ${over} more selected than that: send these first.` : ""}`}
      </Text></p>
      {own.length ? (
        <Select label="Resume to attach" value={picked} onChange={(e) => setResume(e.target.value)}
          options={[...own.map((r) => ({ value: r.rel, label: r.name })), { value: NONE, label: "No resume" }]}
          help="One of your own resumes. Tailored resumes belong to a job, so they aren't used for general enquiries." />
      ) : <Text role="body-sm" muted as="p">No resume in your profile yet, so the drafts go without one.</Text>}
      {prioritiseSponsorship ? (
        <Checkbox label="Ask about sponsorship" help={sponsorshipLine(meFromProfile((profile.data?.values ?? {}) as Record<string, unknown>).visa_subclass)}
          checked={sponsor} onChange={(e) => setSponsor(e.target.checked)} />
      ) : null}
      <div className="row">
        <Button variant="primary" disabled={!batch.length || !profile.data} loading={busy === "bulk-email"} onClick={() => void go()}>
          {`Write ${plural(batch.length, "draft")}`}
        </Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
