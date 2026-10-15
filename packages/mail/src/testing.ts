// Fictional message builders for tests and the end-to-end fixture. Addresses are built by concatenation on purpose.
export const addr = (user: string, domain: string) => user + "@" + domain;
export const ALEX = addr("alex", "example.com");
export const TALENT = addr("talent", "example.org");

export interface RawOptions {
  from?: string; fromName?: string; to?: string; cc?: string; replyTo?: string; subject?: string;
  /** null leaves the header out. */
  date?: string | null;
  /** The part before the @ of the Message-ID; null leaves the header out. */
  id?: string | null;
  inReplyTo?: string; references?: string; auth?: string; text?: string; html?: string;
  attachments?: { name: string; type: string; content: Buffer; cid?: string }[];
  extraHeaders?: string[];
}

const b64 = (b: Buffer) => b.toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();

/** A small RFC 5322 message. Plain text unless html or attachments are given. */
export function rawMessage(o: RawOptions = {}): Buffer {
  const h: string[] = [];
  if (o.auth) h.push(`Authentication-Results: ${o.auth}`);
  h.push(`From: ${o.fromName ? `"${o.fromName}" ` : ""}<${o.from ?? TALENT}>`);
  h.push(`To: <${o.to ?? ALEX}>`);
  if (o.cc) h.push(`Cc: <${o.cc}>`);
  if (o.replyTo) h.push(`Reply-To: <${o.replyTo}>`);
  h.push(`Subject: ${o.subject ?? "Interview for AI Engineer"}`);
  if (o.date !== null) h.push(`Date: ${o.date ?? "Wed, 14 Jan 2026 09:00:00 +0000"}`);
  if (o.id !== null) h.push(`Message-ID: <${o.id ?? "m1"}${"@"}example.org>`);
  if (o.inReplyTo) h.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references) h.push(`References: ${o.references}`);
  h.push(...(o.extraHeaders ?? []), "MIME-Version: 1.0");
  const text = o.text ?? "Hi Alex,\r\n\r\nCould you talk on Friday?\r\n\r\nAcme Talent";
  if (!o.html && !o.attachments?.length) {
    return Buffer.from([...h, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", text, ""].join("\r\n"), "utf8");
  }
  const parts: string[] = [
    "--outer", "Content-Type: multipart/alternative; boundary=\"alt\"", "",
    "--alt", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", text,
  ];
  if (o.html) parts.push("--alt", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", o.html);
  parts.push("--alt--");
  for (const a of o.attachments ?? []) {
    parts.push("--outer", `Content-Type: ${a.type}; name="${a.name}"`,
      a.cid ? `Content-Disposition: inline; filename="${a.name}"` : `Content-Disposition: attachment; filename="${a.name}"`,
      ...(a.cid ? [`Content-ID: <${a.cid}>`] : []), "Content-Transfer-Encoding: base64", "", b64(a.content));
  }
  parts.push("--outer--", "");
  return Buffer.from([...h, "Content-Type: multipart/mixed; boundary=\"outer\"", "", ...parts].join("\r\n"), "utf8");
}
