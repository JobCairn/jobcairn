import { Button, Card, Icon, Icons, Pill, Text } from "@careeros/brand";
import type { MailUpdate } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { displayName } from "../components/displayName";

const keyOf = (u: MailUpdate) => `${u.company_slug}/${u.job_id}|${u.to}|${u.ref}`;

/**
 * Mail: "Updates from your mail", the status changes emails suggest (an interview invite, a no, an offer, or an
 * application you hadn't marked). Each row says why, links to the email, and changes the job only when you press
 * Update. Dismiss forgets it. Hidden when nothing is waiting.
 */
export function MailUpdates({ onOpen }: { onOpen: (ref: string) => void }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const { data, reload } = useLoad((b) => b.mail.updates.list(), [], ["mail", "jobs"]);
  if (!data?.length) return null;
  const accept = (u: MailUpdate) => run(`accept:${keyOf(u)}`, async () => {
    try { return await bridge.mail.updates.accept(u.company_slug, u.job_id, u.to, u.ref); } finally { reload(); }
  }, `${displayName(u.job_title)} moved to ${u.to}`);
  const dismiss = (u: MailUpdate) => run(`dismiss:${keyOf(u)}`, async () => {
    try { return await bridge.mail.updates.dismiss(u.company_slug, u.job_id, u.to, u.ref); } finally { reload(); }
  });
  return (
    <Card className="stack mail-updates" role="region" aria-label="Updates from your mail">
      <div className="row">
        <Icon icon={Icons.mail} size="sm" />
        <Text role="body" as="h2" className="grow"><strong>Updates from your mail</strong></Text>
        <Text role="body-sm" muted>Nothing changes until you choose.</Text>
      </div>
      <ul className="list-plain mail-updates__list">
        {data.map((u) => {
          const job = `${displayName(u.job_title)} at ${displayName(u.company_name)}`;
          return (
            <li key={keyOf(u)} className="mail-updates__row">
              <div className="mail-updates__text">
                <span className="mail-updates__job">
                  <strong>{displayName(u.job_title)}</strong>
                  <Text role="body-sm" muted as="span"> · {displayName(u.company_name)}</Text>
                </span>
                <Text role="body-sm" muted>{u.note} Now {u.status}.</Text>
              </div>
              <Pill tone={u.to === "Rejected" ? "neutral" : "accent"} title={`Suggested status: ${u.to}`}>{u.to}</Pill>
              <div className="mail-updates__actions">
                <Button size="sm" variant="ghost" icon={Icons.mail} onClick={() => onOpen(u.ref)} aria-label={`Open email: ${job}`}>Open email</Button>
                <Button size="sm" variant="primary" loading={busy === `accept:${keyOf(u)}`} onClick={() => void accept(u)}
                  aria-label={`Update to ${u.to}: ${job}`}>Update to {u.to}</Button>
                <Button size="sm" variant="ghost" loading={busy === `dismiss:${keyOf(u)}`} onClick={() => void dismiss(u)}
                  aria-label={`Dismiss: ${job}`}>Dismiss</Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
