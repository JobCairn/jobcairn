import { Card, Icon, Icons, Text } from "@careeros/brand";
import type { EmailPreview, MailAddressView } from "@careeros/contract";
import { bytes } from "../format";

const people = (list: MailAddressView[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

/** The exact message: From, To, Cc, Subject, each attachment (name and size) and the plain-text body with the signature. */
export function EmailPreviewCard({ preview, note }: { preview: EmailPreview; note?: string }) {
  return (
    <Card className="stack email-preview" aria-label="Email preview">
      {preview.locked ? (
        <p role="alert" className="mail-warning"><Icon icon={Icons.locked} size="sm" /> You are attaching a file from a locked folder.</p>
      ) : null}
      {preview.problem ? <p role="alert" className="mail-warning">{preview.problem}</p> : null}
      <dl className="email-preview__head">
        <dt>From</dt><dd>{people([preview.from])}</dd>
        <dt>To</dt><dd>{people(preview.to) || "(nobody yet)"}</dd>
        {preview.cc.length ? <><dt>Cc</dt><dd>{people(preview.cc)}</dd></> : null}
        <dt>Subject</dt><dd>{preview.subject || "(no subject)"}</dd>
      </dl>
      {preview.attachments.length ? (
        <ul className="list-plain stack-tight" aria-label="Attachments">
          {preview.attachments.map((a) => (
            <li key={a.rel} className="row">
              <Icon icon={Icons.attach} size="sm" />
              <span title={a.name}>{a.name}</span>
              {a.size ? <Text role="body-sm" muted>{bytes(a.size)}</Text> : null}
              {a.locked ? <Text role="body-sm" className="mail-warning">from {a.locked}</Text> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <pre className="mail-preview" aria-label="Message as sent">{preview.text}</pre>
      {note ? <Text role="body-sm" muted>{note}</Text> : null}
    </Card>
  );
}
