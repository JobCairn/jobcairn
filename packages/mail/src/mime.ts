import type { CanonicalMessage, EmailAddress } from "@careeros/core";
import MailComposer, { type MailComposerAttachment } from "nodemailer/lib/mail-composer";

// RFC 2047 caps a single encoded word at 75 characters (prefix, charset, encoding, payload and
// suffix all included). "=?UTF-8?B?" is 10 characters and the closing "?=" is 2, leaving this much
// room for the base64 payload itself.
const ENCODED_WORD_PREFIX = "=?UTF-8?B?";
const ENCODED_WORD_SUFFIX = "?=";
const MAX_BASE64_PAYLOAD = 75 - ENCODED_WORD_PREFIX.length - ENCODED_WORD_SUFFIX.length;

/**
 * Encodes `value` as one or more RFC 2047 "=?UTF-8?B?...?=" words, none longer than 75 characters,
 * joined by a single space. Splits only on Unicode code-point boundaries (never inside a
 * multi-byte UTF-8 sequence), by growing each chunk one whole code point at a time and stopping
 * before the chunk's base64 payload would exceed the 75-character word limit -- so every word
 * decodes cleanly on its own. A standards-compliant decoder (RFC 2047 section 6.2) treats
 * whitespace *between* adjacent encoded words as insignificant and discards it when reconstructing
 * the original text, so the single space this join inserts reproduces the exact original string on
 * decode, with nothing added and nothing split. Deterministic: a pure function of the input text.
 */
function splitIntoEncodedWords(value: string): string {
  const codePoints = Array.from(value);
  const words: string[] = [];
  let i = 0;
  while (i < codePoints.length) {
    let chunk = codePoints[i]!;
    let j = i + 1;
    while (j < codePoints.length) {
      const candidate = chunk + codePoints[j];
      if (Buffer.from(candidate, "utf8").toString("base64").length > MAX_BASE64_PAYLOAD) break;
      chunk = candidate;
      j++;
    }
    words.push(`${ENCODED_WORD_PREFIX}${Buffer.from(chunk, "utf8").toString("base64")}${ENCODED_WORD_SUFFIX}`);
    i = j;
  }
  return words.join(" ");
}

/**
 * nodemailer only mime-encodes a header value when it already contains a quote character or a
 * non-ASCII byte (see its `encodeWords`: the match it looks for is a quote, or any code point in
 * the range a non-ASCII character would fall in). A subject or display name that is otherwise
 * plain ASCII, but happens to *contain* the literal text of an RFC 2047 encoded word --
 * "=?utf-8?q?FAKE?=", say, typed by a recipient or planted by an attacker -- doesn't trip that
 * check, so it would reach the header unescaped. A decoding client (including our own
 * parseMessage) would then treat that literal text as a genuine encoded word and silently
 * substitute its decoded form for whatever was actually typed. This is the carried requirement
 * from Task 3's review: force such a value into one or more real encoded words ourselves (see
 * `splitIntoEncodedWords`), so the literal "=?" text never appears on the wire outside of (and
 * therefore is never mistaken for the start of) mime-word framing. The resulting string is pure
 * ASCII with no quote character, so nodemailer's own header/address encoding and line folding pass
 * it through unchanged -- folding only ever breaks at the spaces between words (see
 * `splitIntoEncodedWords`'s doc comment), never inside one, so every physical header line still
 * stays well under the 998-character hard limit regardless of how long the original text was.
 */
function escapeEncodedWordLookalike(value: string): string {
  return value.includes("=?") ? splitIntoEncodedWords(value) : value;
}

/**
 * Mail package review, Task 8 fix round 2 ("what the recruiter sees wins"): a literal RFC 2047
 * encoded word in an attachment's file name is refused upstream, in core's `resolveAttachment`
 * (packages/core/src/drafts.ts, alongside its other name checks), before a `CanonicalMessage` is
 * ever built -- so the preview, the approval digest and the wire always agree on what the name is,
 * instead of this module silently re-encoding it on the way out (an earlier version of this fix
 * did exactly that, via a now-removed RFC 2231 + encoded-word wrap; see the removed
 * `attachmentOptions`/`rfc2231PercentEncode` in git history and the fix-round-2 report entry for
 * why). This check is defense in depth for a `CanonicalMessage` built directly, bypassing that
 * check (as this module's own tests do).
 */
function assertNoEncodedWordInAttachmentName(name: string): void {
  if (name.includes("=?")) {
    throw new Error(`An attachment name can't contain "=?". Rename the file and try again.`);
  }
}

/**
 * Per RFC 5322 `atext`, an address local part may contain both '=' and '?' -- so
 * `fake=?utf-8?q?FAKE?=@example.com` is a structurally valid address core's own `isEmailAddress`
 * accepts. RFC 2047 section 5 says an encoded word must never appear in an addr-spec at all, and
 * whether a literal "=?...?=" there gets decoded, blanked, or left alone is entirely up to
 * whatever mail-parsing library a recipient (or our own parseMessage) happens to use -- not
 * something this module can rely on another library getting right. Refuse outright instead.
 */
function assertNoEncodedWordInLocalPart(a: EmailAddress): void {
  const at = a.address.lastIndexOf("@");
  const local = at < 0 ? a.address : a.address.slice(0, at);
  if (local.includes("=?")) {
    throw new Error(`"${a.address}" can't be used: an address can't contain "=?" before the "@".`);
  }
}

function safeAddress(a: EmailAddress): EmailAddress {
  assertNoEncodedWordInLocalPart(a);
  return { name: escapeEncodedWordLookalike(a.name), address: a.address };
}

/**
 * The boundary nodemailer derives from `baseBoundary` is `--_NmP-careeros-<draft id>-Part_<n>`
 * (prefix + baseBoundary + a per-part counter). If the body or an attachment's bytes happened to
 * contain the `careeros-<draft id>` substring itself, a multipart reader that isn't as careful
 * about matching the *whole* boundary line could be confused into treating that content as a part
 * delimiter. Refuse to build rather than risk it, independent of how unlikely an accidental
 * collision is -- the input here can be attacker- or user-controlled (a resume, a pasted reply).
 */
function assertNoBoundaryCollision(m: CanonicalMessage, contents: Buffer[]): void {
  const needle = `careeros-${m.draft_id}`;
  if (m.text.includes(needle)) {
    throw new Error("The message body can't contain the text that forms this draft's MIME boundary.");
  }
  for (const c of contents) {
    if (c.includes(needle)) {
      throw new Error("An attachment can't contain the text that forms this draft's MIME boundary.");
    }
  }
}

/**
 * Builds the exact message SMTP sends. The boundary comes from the draft id and the Message-ID and
 * Date were stamped when the email was proposed, so the bytes depend only on the inputs core
 * hashes for the approval: build the same `CanonicalMessage` and the same attachment bytes twice,
 * anywhere, any time, and you get the same bytes back.
 */
export async function buildMime(m: CanonicalMessage, contents: Buffer[]): Promise<Buffer> {
  assertNoBoundaryCollision(m, contents);
  const attachments: MailComposerAttachment[] = m.attachments.map((a, i) => {
    assertNoEncodedWordInAttachmentName(a.name);
    return { filename: a.name, content: contents[i], contentType: a.type };
  });
  const options = {
    from: safeAddress(m.from),
    to: m.to.map(safeAddress),
    cc: m.cc.length ? m.cc.map(safeAddress) : undefined,
    subject: escapeEncodedWordLookalike(m.subject),
    text: m.text,
    messageId: m.message_id,
    date: new Date(m.date),
    inReplyTo: m.in_reply_to || undefined,
    references: m.references.length ? m.references : undefined,
    attachments,
    baseBoundary: `careeros-${m.draft_id}`,
    textEncoding: "quoted-printable" as const,
    newline: "\r\n",
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  return new MailComposer(options).compile().build();
}

/** To and Cc only -- there is no Bcc: `CanonicalMessage` has no field for one (core's `checkDraft`
 * refuses a "bcc" draft header outright), so there's nothing here that could leak one. */
export function envelopeFor(m: CanonicalMessage): { from: string; to: string[] } {
  return { from: m.from.address, to: [...m.to, ...m.cc].map((a) => a.address) };
}
