import { useState } from "react";
import { Button, Dialog, Icons, Text, useToast } from "@careeros/brand";
import type { ApprovalView } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { displayName } from "./displayName";
import { EmailPreviewCard } from "./EmailPreview";

/**
 * The two ways out of an email send whose outcome is unknown (`a.unsure`): Mark as sent (records it, sends nothing)
 * and Send again (shows the exact message again; the services refuse it if the email changed since it was approved).
 * Both ask first.
 */
export function UnsureSend({ a, onDone }: { a: ApprovalView; onDone?: (v: ApprovalView) => void }) {
  const bridge = useBridge();
  const toast = useToast();
  const [ask, setAsk] = useState<null | "mark" | "again">(null);
  const [busy, setBusy] = useState(false);
  const problem = a.email?.problem || (a.email ? "" : "This email can't be shown again, so it can't be sent again. Check Gmail's Sent folder, then mark it as sent or make a new draft.");

  const run = async (kind: "mark" | "again") => {
    setBusy(true);
    try {
      const v = kind === "mark" ? await bridge.mail.send.markSent(a.id) : await bridge.mail.send.again(a.id, a.digest, true);
      setAsk(null);
      toast(v.status === "failed"
        ? { tone: "danger", text: `It didn't send: ${displayName(v.result_note || "Gmail refused it")}` }
        : { tone: "success", text: kind === "mark" ? "Marked as sent" : displayName(v.result_note || "Sent") });
      onDone?.(v);
    } catch (e) {
      toast({ tone: "danger", text: displayName(errorText(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row">
        <Button icon={Icons.check} onClick={() => setAsk("mark")}>Mark sent</Button>
        <Button variant="primary" icon={Icons.send} disabled={!!problem} title={problem || undefined} onClick={() => setAsk("again")}>Send again</Button>
      </div>
      {problem ? <Text role="body-sm" muted>{displayName(problem)}</Text> : null}
      <Dialog open={ask === "mark"} onClose={() => setAsk(null)} title="Mark this email as sent?"
        actions={<>
          <Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void run("mark")}>Mark sent</Button>
        </>}>
        <Text role="body">Nothing is sent. Do this when you can see the email in Gmail&apos;s Sent folder. The job&apos;s timeline gets &quot;Email sent&quot;.</Text>
      </Dialog>
      <Dialog open={ask === "again"} onClose={() => setAsk(null)} title="Send this email again?"
        actions={<>
          <Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
          <Button variant="primary" icon={Icons.send} loading={busy} onClick={() => void run("again")}>Send again</Button>
        </>}>
        <div className="stack">
          <Text role="body">If the first one did go out, they will get it twice. The Sent mail already synced is checked first, and nothing is sent if the email is there.</Text>
          {a.email ? <EmailPreviewCard preview={a.email} note="This exact message will be sent." /> : null}
        </div>
      </Dialog>
    </>
  );
}
