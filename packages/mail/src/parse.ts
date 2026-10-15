/// <reference path="./vendor-types.d.ts" />
import crypto from "node:crypto";
import { simpleParser, type AddressEntry, type AddressObject } from "mailparser";
import type { EmailAddress } from "@careeros/core";

export interface ParsedAttachment { part: string; name: string; size: number; type: string; cid: string; inline: boolean; content: Buffer }
export interface ParsedMessage {
  /** RFC 5322 `<local@domain>` form. Neither the local- nor the domain-part can contain '/',
   * '\\', a ".." substring, or be made up of nothing but dots (see `ID_SHAPE`/`isSafeIdPart`
   * below): it contains no path separators or traversal components. That is *not* the same as
   * "safe to use as a file name" (fix round 2, ruling 3 -- this module does not promise
   * filesystem safety: reserved device names, trailing dots/spaces, NUL, length limits on a
   * given filesystem, and anything else platform-specific are this parser's problem to keep out
   * of, not a caller's to re-check). Hash it (or otherwise derive a short, charset-safe name from
   * it) before using it as a file name. */
  message_id: string;
  synthetic_id: boolean; in_reply_to: string; references: string[];
  /** Same shape and the same "no path separators or traversal components, but still hash before
   * using as a file name" rule as `message_id`. */
  thread_key: string;
  from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; reply_to: EmailAddress[]; subject: string; date: string | null;
  text: string; html: string; attachments: ParsedAttachment[]; auth: "pass" | "fail" | "none";
}

/**
 * A hostile or pathologically malformed MIME structure that the underlying stream splitter
 * (`@zone-eu/mailsplit`) refuses to parse at all, as a stream-level guard against resource
 * exhaustion -- specifically today, "Max allowed child nodes exceeded" (more than 1000 MIME
 * parts in the message) and "Max header size for a MIME node exceeded" (one MIME part's own
 * header block is too big). These are structural DoS guards, not something retrying or
 * stripping can route around (unlike the oversized-HTML case in `parseMessage` below), so
 * `parseMessage` never tries to recover from one itself -- it surfaces this typed, documented
 * error (`code: "too_complex"`) and leaves the decision (reject the message? quarantine it? ask
 * the sender to resend?) to the caller.
 */
export class MailParseError extends Error {
  readonly code: "too_complex" = "too_complex";
  constructor(message: string) {
    super(message);
    this.name = "MailParseError";
  }
}

// --- bounds (ruling 1) ---------------------------------------------------------------------------
// Raw mail arrives over the public internet. Every limit below resolves one of two ways: a quiet
// truncation (a field is capped; parsing still succeeds) or a clean, typed rejection (a plain
// Error for the raw-byte cap below, or a MailParseError -- see above -- for a MIME structure
// mailsplit itself refuses to parse). What never happens is an uncaught crash, a hang, or a
// message silently corrupted deep inside the MIME parser: a hostile message always either parses
// (with some fields truncated) or fails cleanly with an error the caller can act on.

/** Matches MAX_INCOMING_BYTES in packages/services/src/files.ts and legacy.ts's MAX_BYTES: the
 * one size cap already used elsewhere in this codebase for untrusted incoming payloads. Checked
 * before simpleParser ever sees the buffer, so an oversized message cannot make the MIME parser
 * do any work at all. */
const MAX_RAW_BYTES = 25 * 1024 * 1024;
/** Per address field (to/cc/reply_to). A real message has a handful of recipients; a forged one
 * can list thousands in a single header. Capped by stopping `addresses()` outright once reached,
 * not just by slicing the result, so the cap also bounds our own CPU work, not merely memory. */
const MAX_ADDRESSES = 500;
/** References chain length. RFC 5322 doesn't bound this, and `references` already dedupes, so a
 * forged chain of thousands of ids is cheap for a sender to produce and would otherwise make
 * `thread_key`/history lookups do unbounded work downstream. */
const MAX_REFERENCES = 100;
/** Attachment count. mailparser has already parsed every part by the time we see `p.attachments`
 * (bounded in turn by MAX_RAW_BYTES), so this cap bounds what *we* retain and sanitize, keeping
 * the first N in mailparser's list order -- which is what keeps "part" numbers stable release to
 * release, per the brief's note that a part number must always find the same attachment again. */
const MAX_ATTACHMENTS = 200;
/** Authentication-Results header instances considered. `authResult` only ever reads index 0 (see
 * below), so this just stops us building an unbounded array when a forged message carries
 * thousands of fake instances of this header. */
const MAX_AUTH_LINES = 50;
const MAX_SUBJECT_LENGTH = 2000;
const MAX_NAME_LENGTH = 300;
const MAX_ADDRESS_LENGTH = 320;
/** Attachment name cap, in UTF-8 *bytes* (ruling 6), not characters: a byte-oriented filesystem
 * or a fixed-width column elsewhere in the product cares about bytes, and a name full of 3-byte
 * CJK characters would otherwise sail past a character-count cap while still being far larger on
 * disk. See `capAttachmentNameBytes`. */
const MAX_ATTACHMENT_NAME_BYTES = 200;
const MAX_TYPE_LENGTH = 200;
const MAX_CID_LENGTH = 300;

// --- sanitizing header-derived text (ruling 2) ---------------------------------------------------
// Subject, names, message-ids and references end up in file names, timeline text and threading
// lookups, so none of them may carry a CR/LF (fake log/file lines), any other C0/C1 control, or
// any \p{Default_Ignorable_Code_Point} character (zero-width spaces/joiners, bidi
// embedding/override/isolate controls, variation selectors, tag characters -- the same property
// redact.ts's INVISIBLE strips, and for the same reason: a renderer is expected to show nothing
// for these, which makes them perfect for hiding a '/' or a fake line break from a human
// reviewing a subject or a file name). mailparser decodes RFC 2047 encoded-words for us, and a
// decoded value can carry any of these raw -- they are not limited to what arrived literally in
// the header bytes (see the "encoded subject/name" tests), so this strip runs on the already
// *decoded* text mailparser hands back, not just the raw header line.
const BAD = /[\x00-\x1f\x7f-\x9f]|\p{Default_Ignorable_Code_Point}/gu;

/** For prose (subject, display names): a run of bad characters collapses to one space, so
 * "John\r\nSmith" becomes "John Smith" rather than the word-merging "JohnSmith" outright removal
 * would produce. */
function cleanText(s: string | undefined, max: number): string {
  return (s ?? "").replace(BAD, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The local- and domain-part character class deliberately excludes '/' and '\\' in addition to
 * '<', '>', '@' and whitespace (fix round 1, ruling 1): RFC 5322's `atext` technically permits
 * both in a dot-atom, but letting either through would mean `message_id`/`thread_key` could carry
 * a path separator straight from a forged header. This rules out the obvious traversal
 * primitives (see `isSafeIdPart` below too); it is not a promise that the result is safe to use
 * as a raw file name on every filesystem (fix round 2, ruling 3 -- see the `message_id` doc on
 * `ParsedMessage`).
 */
const ID_SHAPE = /^<([^<>@\s/\\]{1,200})@([^<>@\s/\\]{1,253})>$/;

/**
 * Rejects the two traversal shapes the character class alone can't: a ".." substring anywhere in
 * a part (e.g. "<../../etc@x>" has no '/' character once you only look at what's between '<' and
 * '@', but ".." is still ".." ), and a part made up of nothing but dots (e.g. "<.@.>" or
 * "<..@..>") -- neither contains a path separator, but both are exactly the components a path
 * traversal is built from once something downstream joins them onto a directory.
 */
function isSafeIdPart(part: string): boolean {
  return !part.includes("..") && !/^\.+$/.test(part);
}

// Known inconsistency, left as-is (fix round 2): Message-ID reads mailparser's own
// already-charset-decoded value, while References and In-Reply-To (below) read the raw,
// undecoded header bytes directly (needed to catch the whitespace-split and
// comment-then-no-angle-bracket bugs documented on `extractReferences`/`extractInReplyTo`) -- so
// for an id containing 200 non-ASCII (e.g. CJK) characters, already hostile/malformed input since
// RFC 5322 atext is ASCII-only, the `{1,200}`/`{1,253}` length caps below can end up counting a
// slightly different notion of "200 characters" depending on which of the two paths produced it.

/** mailparser already wraps a Message-ID/In-Reply-To token in '<' and '>' even when the original
 * header had neither (`ensureMessageIDFormat`), and never itself checks for a sane
 * `<local@domain>` shape or for path-unsafe content. A token that doesn't match one (no '@' at
 * all, whitespace inside either part, a path separator, a ".." substring, or an all-dots part) is
 * therefore treated as if the header were missing: dropped from references/in_reply_to, or - for
 * message_id - replaced by a synthetic id. */
function cleanId(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  const cleaned = raw.replace(BAD, "");
  const m = ID_SHAPE.exec(cleaned);
  if (!m) return "";
  const [, local, domain] = m;
  if (!isSafeIdPart(local!) || !isSafeIdPart(domain!)) return "";
  return cleaned;
}

/** Matches a complete `<...>`-bracketed span, whatever it contains -- including an internal
 * space. Used only for References (see `extractReferences`): unlike In-Reply-To/Message-ID,
 * which mailparser treats as one opaque string, it tokenizes References by splitting the *whole*
 * raw header value on whitespace first and only then wrapping each fragment in '<'/'>'
 * (fix round 1, ruling 7) -- so a single malformed id containing a literal space, e.g.
 * "<a b@c>", is split into two fragments "<a" and "b@c>", each independently re-bracketed into
 * "<a>" and "<b@c>". The second fragment then looks like a perfectly well-formed, if fabricated,
 * reference that was never actually in the message. Matching "<...>" spans directly against the
 * *raw* header text instead keeps "<a b@c>" as the one token it really is; `cleanId` then
 * correctly rejects it whole (its content has a space in it, which `ID_SHAPE` excludes), rather
 * than yielding a made-up `<b@c>`. */
const BRACKETED_ID = /<[^<>]*>/g;

function extractReferences(headerLines: { key: string; line: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of headerLines) {
    if (h.key !== "references") continue;
    const raw = h.line.replace(/^references:\s*/i, "");
    for (const m of raw.matchAll(BRACKETED_ID)) {
      const id = cleanId(m[0]);
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
        if (out.length >= MAX_REFERENCES) return out;
      }
    }
  }
  return out;
}

/**
 * Reads In-Reply-To directly from the raw header text and keeps the first "<...>" span that
 * actually passes `cleanId` -- not just the first span found, full stop (fix round 3, ruling 5;
 * originally fix round 2, ruling 6, for the narrower "first span, no comment" case). Scanning with
 * `extractReferences`'s own `BRACKETED_ID`/`matchAll` instead of a single `.exec()` means a span
 * that `cleanId` rejects (e.g. one with an internal space, like `References`'s own
 * whitespace-split-fragment problem -- see `extractReferences`'s doc and fix round 1, ruling 7) is
 * simply skipped in favour of the next one, rather than discarding the whole header: given
 * `"<a b@c> <d@e>"`, the first span has a space in it and fails `ID_SHAPE`, so this returns
 * `"<d@e>"` instead of giving up and returning "". This also still keeps `"<a@b>"` from
 * `"<a@b> (comment)"` (mailparser's own `ensureMessageIDFormat` only checks whether the *whole*
 * header value starts with '<' and ends with '>' -- given that input, it already starts with '<',
 * so it just appends a stray '>' at the very end, "<a@b> (comment)>", which then fails `ID_SHAPE`
 * outright and the whole, otherwise perfectly valid, id would be lost if we trusted mailparser's
 * own `p.inReplyTo` instead of reading the raw header ourselves). An unbracketed value with no
 * "<...>" span at all (e.g. a bare `a@b`) is deliberately left as "" rather than treated as an id
 * in its own right -- RFC 5322 requires the angle brackets, and there is no shape here to validate
 * the way `ID_SHAPE` validates a real `<local@domain>`. When more than one In-Reply-To header is
 * present, the last one wins, mirroring mailparser's own single-value collapsing rule (and this
 * module's own handling of duplicate Date/Message-ID/Subject/From headers).
 */
function extractInReplyTo(headerLines: { key: string; line: string }[]): string {
  const lines = headerLines.filter((h) => h.key === "in-reply-to");
  if (!lines.length) return "";
  const raw = lines[lines.length - 1]!.line.replace(/^in-reply-to:\s*/i, "");
  for (const m of raw.matchAll(BRACKETED_ID)) {
    const id = cleanId(m[0]);
    if (id) return id;
  }
  return "";
}

// --- attachment names (ruling 3, tightened by fix round 1 ruling 6, hardened by fix round 2) ------

/** Windows-reserved filename characters (fix round 1, ruling 6): harmless on this platform today,
 * but a name this parser produces may end up written to disk or round-tripped through a tool
 * that runs there, so none of these should ever reach a caller. */
const RESERVED_CHARS = /[:*?"<>|]/g;

/**
 * Fix round 2, ruling 1 (CRITICAL ReDoS): the previous version of this rule was
 * `/\.{2,}(?=[A-Za-z0-9]{1,10}$)/`, an *unanchored* repeat (`\.{2,}`) gated by a lookahead that
 * can fail. A regex engine tries that pattern starting at every position in the string, and at
 * each position a failing lookahead forces it to backtrack the greedy `\.{2,}` one dot at a time
 * before giving up and moving to the next start position -- O(run length) wasted work at each of
 * O(run length) positions, i.e. quadratic. 80,000 dots followed by "!" (which never satisfies the
 * lookahead, so every position's backtracking is wasted) measured at over 11 seconds locally,
 * consistent with the reviewer's reported 44s. There is no way to keep this as a single
 * "search anywhere, with a trailing lookahead" regex and fix the complexity -- the fix is to stop
 * searching: this function looks at the end of the string directly with plain index arithmetic
 * (bounded by a fixed 10-character tail scan, then one single backward pass counting the dot run
 * once), which is O(n) with a very small constant, not O(n^2), and is also a second, independent
 * layer under the `MAX_RAW_ATTACHMENT_NAME_CODEPOINTS` cap in `cleanAttachmentName` below (fix
 * round 2, ruling 1 also asks for that input-size cap regardless of any individual rule's own
 * complexity, since a future change to any rule could reintroduce a similar bug).
 *
 * Behaviour is unchanged from the old regex: a dot-run of 2+ immediately followed by nothing but
 * 1-10 ASCII alphanumeric characters through the end of the string collapses to a single dot plus
 * that trailing text ("...pdf" -> "_.pdf", preserving the extension's separating dot, unlike the
 * bare `PATH_BAD` collapse-to-"_" below which would otherwise lose it entirely). Anything that
 * doesn't fit this exact shape (fewer than 2 trailing alnum characters, more than 10, or anything
 * other than a dot immediately before the tail) is left untouched here and falls through to
 * `PATH_BAD`, which still neutralizes it, just without preserving a fake "extension".
 */
function collapseTrailingDotsBeforeExt(s: string): string {
  const len = s.length;
  let tailLen = 0;
  while (tailLen < 10 && tailLen < len) {
    const code = s.charCodeAt(len - 1 - tailLen);
    const isAlnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!isAlnum) break;
    tailLen++;
  }
  if (tailLen === 0 || tailLen === len) return s; // no alnum tail, or the whole string is the tail (no room for a dot run before it)
  let dotCount = 0;
  while (dotCount < len - tailLen && s.charCodeAt(len - tailLen - 1 - dotCount) === 46 /* '.' */) dotCount++;
  if (dotCount < 2) return s;
  return s.slice(0, len - tailLen - dotCount) + "_." + s.slice(len - tailLen);
}

/** A run of one or more path separators, or two-or-more consecutive dots (the ".." traversal
 * shape), anywhere in the name -- not just a leading "../": "a/../../etc/passwd" and
 * "a\\..\\..\\etc" both lose every separator and traversal run, so whatever later joins this name
 * onto a directory can never escape it. A single "." (an ordinary file extension) is untouched.
 * Linear and safe: unlike `TRAILING_DOTS_BEFORE_EXT` above, nothing follows either alternative
 * that could fail and force backtracking -- once `\.{2,}` or `[\\/]+` matches here, the match is
 * final, so there is nothing to retry (confirmed empirically against a 200k-character run of
 * each). */
const PATH_BAD = /[\\/]+|\.{2,}/g;

/** A name made of nothing but dots and whitespace (".", ". .", "", "   ") (fix round 1,
 * ruling 6): none of these survive as a usable file name, so they fall back to
 * `attachment-<part>` immediately, before any other substitution runs (substitution would
 * otherwise turn e.g. ".." into "_" and this check would never see the all-dots shape). */
const ONLY_DOTS_AND_SPACE = /^[.\s]*$/;

/** A leading '-' (could be read as a CLI flag by something downstream), '~' (shell/home-dir
 * expansion) (fix round 1, ruling 6), or '.' (a hidden file on any Unix-like filesystem; fix
 * round 2, ruling 5). Only the first character is affected. */
const LEADING_SPECIAL = /^[-~.]/;

/** U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR (fix round 2, ruling 5): not covered by
 * `\p{Default_Ignorable_Code_Point}` (`BAD`) -- they are real, visible-ish line-break characters,
 * not formatting controls a renderer is expected to hide -- but still line-break-like enough to
 * confuse a naive line-based log or file listing, or (historically) some JS parsers, if left in a
 * file name. */
const LINE_PARA_SEP = /[\u2028\u2029]/g;

/** Windows' long-reserved device names (fix round 2, ruling 5; widened by fix round 3, ruling 2):
 * "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM0"-"COM9", and "LPT0"-"LPT9", matched
 * case-insensitively and whether or not an extension follows -- "con.txt" is exactly as reserved
 * as "con" on that OS, since the check is against the name before the *first* dot, not the whole
 * string. COM/LPT also accept the Unicode superscript digits (COM¹/²/³, i.e. "COM"
 * + superscript 1/2/3), which Windows treats the same as the plain-digit forms -- `com0`/`lpt0`
 * are reserved too (confirmed against Windows' own device-name list, which isn't limited to
 * 1-9). `\s*` between the reserved word and the dot/end (instead of requiring either
 * immediately) catches a device name followed by trailing spaces before an extension
 * (`"CON .txt"` -- Windows resolves this the same as `"CON.txt"`), matched against the name
 * *after* the earlier pipeline step has already trimmed genuinely trailing spaces/dots, so this
 * only ever sees spaces that sit before a real extension, not a run that was going to be trimmed
 * away anyway. A name that collides with one of these can silently address a device instead of an
 * ordinary file when written to disk on Windows. Matching stops right after the reserved word plus
 * any such whitespace (`\s*(?:\.|$)`) so "console" or "comet" are correctly left alone -- anchored
 * at `^` with only fixed-length alternatives, a single bounded digit/superscript class, and a
 * bounded `\s*` that can't itself backtrack against the rest of the pattern, this has no
 * unbounded-repeat-plus-assertion shape and cannot be quadratic. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(?:\.|$)/i;

/** Hard ceiling on the raw attachment name length, in Unicode code points, applied before any
 * other processing in `cleanAttachmentName` (fix round 2, ruling 1): independent of any single
 * rule being provably linear on its own, bounding the input size bounds the absolute worst case
 * for the whole pipeline, including against a rule a future change might accidentally make
 * quadratic again. 1024 is far larger than any real file name (typical filesystem limits are
 * 255 bytes/characters); mailparser's own decoded filename can otherwise be arbitrarily long
 * (bounded only by `MAX_RAW_BYTES`), so this is applied unconditionally. */
const MAX_RAW_ATTACHMENT_NAME_CODEPOINTS = 1024;

/** Truncates `s` to at most `max` Unicode code points (not UTF-16 code units), so a surrogate
 * pair is never split. The fast path avoids the `for...of` walk entirely for the overwhelmingly
 * common case of a name already shorter than the cap: UTF-16 code-unit length is always >= code
 * point count, so if the code-unit length already fits, the code-point count fits too. */
function sliceCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (i >= max) break;
    out += ch;
    i++;
  }
  return out;
}

/**
 * Truncates `s` to at most `maxBytes` UTF-8 bytes, cutting only on a Unicode code-point boundary
 * (fix round 1, ruling 6): iterating with `for...of` yields whole code points one at a time, even
 * astral ones represented as a UTF-16 surrogate pair, so a 4-byte emoji is either included whole
 * or omitted whole -- this can never emit half of a surrogate pair the way a byte-offset
 * `Buffer.slice` or a UTF-16-code-unit `String.slice` could.
 */
function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

/** Caps `name` at `maxBytes` UTF-8 bytes, keeping a short trailing extension (if any) intact by
 * truncating only the part before it. */
function capAttachmentNameBytes(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name, "utf8") <= maxBytes) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 11 ? name.slice(dot) : "";
  const extBytes = Buffer.byteLength(ext, "utf8");
  const base = ext ? name.slice(0, dot) : name;
  return truncateUtf8(base, Math.max(0, maxBytes - extBytes)) + ext;
}

/**
 * Re-applies the trailing dot/space trim after the byte cap (fix round 3, ruling 1):
 * `capAttachmentNameBytes` truncates purely on a byte budget, with no awareness of where it lands,
 * so a cut can end exactly on a '.' or ' ' that the earlier trim pass -- which ran *before* the cap
 * -- never saw (e.g. 199 "a"s + " " + 50 "b"s, or the same with "." instead of the space: neither
 * has a short-enough trailing run for `capAttachmentNameBytes` to treat as a real extension, so the
 * whole name is truncated as one run and the 200-byte cut lands right on the separator). Falls back
 * to `attachment-<part>` in the residual case where nothing at all survives the combination of the
 * cap and this trim, mirroring the identical fallback used earlier in `cleanAttachmentName` for an
 * all-dots-and-space name. Exported and unit-tested directly (like `cleanAddress`'s NUL-byte test)
 * because `cleanAttachmentName`'s own `LEADING_SPECIAL` step guarantees a real, non-dot/space
 * character always survives at the very start of whatever reaches `capAttachmentNameBytes` through
 * the full pipeline today, so this exact "nothing survives" branch isn't reachable through a real
 * mail message -- this is defence in depth against a future change to that guarantee, not dead code
 * to delete.
 */
function finishAttachmentName(capped: string, part: string): string {
  let trimmed = capped.replace(/[.\s]+$/, "");
  // Fix round 4 (task 7 review carry-over): the Windows-reserved-device-name check now runs here,
  // after the byte cap and this re-trim, instead of earlier in `cleanAttachmentName` on the uncapped
  // `cleaned` string. A name like "CON" + 300 spaces + "x" doesn't match `WINDOWS_RESERVED` before
  // the cap (the reserved word must be followed by only whitespace then a dot-or-end, and here it's
  // followed by "x"), but the byte cap then truncates away that trailing letter (and most of the
  // spaces, since there's no recognizable short extension), and the re-trim above strips the
  // newly-trailing spaces, leaving exactly "CON" -- the bare reserved name, which the earlier,
  // pre-cap check already had its one chance to catch and missed. Checking again here, against the
  // name as it will actually be returned, closes that gap.
  if (WINDOWS_RESERVED.test(trimmed)) trimmed = `_${trimmed}`;
  return trimmed || `attachment-${part}`;
}

/** Strips controls/ignorables (same `BAD` as prose, but *not* replaced with a space here --
 * merging two words in a file name is harmless, unlike in a sentence), line/paragraph separators,
 * Windows-reserved characters, and path-traversal characters, including the Unicode bidi-override
 * trick the brief names ("invoice<RLO>fdp.exe" displays as if it ends in ".pdf" when it's really
 * ".exe") -- that's one of the Default_Ignorable_Code_Point characters `BAD` already covers, so no
 * separate handling is needed. Trims trailing dots/spaces (both silently stripped by Windows, so
 * left alone they could make two different names collide on disk), replaces a leading '-'/'~'/'.'
 * and a Windows-reserved device name, falls back to a name built from the stable part number when
 * nothing usable survives, and caps the length in UTF-8 bytes while keeping a short trailing
 * extension. The declared content `type` is carried through as metadata only (ruling 3); it is
 * never used to decide anything security-relevant here or in any caller. The raw input is capped
 * at `MAX_RAW_ATTACHMENT_NAME_CODEPOINTS` *before* any of the above runs (fix round 2, ruling 1). */
function cleanAttachmentName(name: string | undefined, part: string): string {
  const capped = sliceCodePoints(name ?? "", MAX_RAW_ATTACHMENT_NAME_CODEPOINTS);
  const stripped = capped.replace(BAD, "").replace(LINE_PARA_SEP, "");
  if (ONLY_DOTS_AND_SPACE.test(stripped)) return `attachment-${part}`;
  let cleaned = stripped.replace(RESERVED_CHARS, "_");
  cleaned = collapseTrailingDotsBeforeExt(cleaned);
  cleaned = cleaned.replace(PATH_BAD, "_");
  cleaned = cleaned.trim().replace(/[.\s]+$/, "");
  cleaned = cleaned.replace(LEADING_SPECIAL, "_");
  // The Windows-reserved-device-name check used to run right here, against this uncapped `cleaned`
  // string. It now runs inside `finishAttachmentName`, after the byte cap and that function's own
  // re-trim -- see the comment there (fix round 4, task 7 review carry-over) for why: checking here,
  // before the byte cap can truncate away whatever came after the reserved word, missed a name like
  // "CON" + 300 spaces + a letter, which only looks like the bare reserved name "CON" *after* the cap.
  if (!cleaned) return `attachment-${part}`;
  return finishAttachmentName(capAttachmentNameBytes(cleaned, MAX_ATTACHMENT_NAME_BYTES), part);
}

// --- addresses (ruling 2, tightened by fix round 1) -----------------------------------------------

/**
 * mailparser's own address parsing is already the authority on what counts as an address (see
 * Task 1's EmailAddress / isEmailAddress ruling: that validator is for addresses the user is
 * about to send *to*, not for recording whatever a sender's mail client claims as a
 * From/To/Cc/Reply-To -- real mail in the wild is looser than RFC 5322's grammar). But the address
 * *string* itself must never carry a control, C1, or Default_Ignorable character (the same `BAD`
 * class as everywhere else -- including bidi overrides, which are Default_Ignorable): one of
 * those hiding inside what looks like an address is a spoofing attempt (e.g. an RLO making a
 * punycode-ish domain display reversed, or a zero-width space splitting a domain so a naive
 * substring check misses it), not a formatting quirk to politely clean up. So unlike names and
 * subjects, a hit here doesn't get space-collapsed and kept -- the *whole entry* is dropped
 * (fix round 1, ruling 2): if anything was stripped, or what's left is empty, or it doesn't match
 * the bare `local@domain` shape (no whitespace, exactly one '@'-separated pair), the address never
 * shows up anywhere in the parsed result.
 */
function cleanAddress(raw: string): string {
  const stripped = raw.replace(BAD, "");
  if (stripped !== raw) return "";
  const trimmed = stripped.trim();
  if (!trimmed || !/^[^\s@]+@[^\s@]+$/.test(trimmed)) return "";
  return trimmed.slice(0, MAX_ADDRESS_LENGTH);
}

function addresses(v: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  const out: EmailAddress[] = [];
  const seen = new Set<string>();
  const walk = (list: AddressEntry[]): void => {
    for (const a of list) {
      if (out.length >= MAX_ADDRESSES) return;
      if (a.group) {
        walk(a.group);
        continue;
      }
      if (!a.address) continue;
      const address = cleanAddress(a.address);
      if (!address) continue;
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: cleanText(a.name, MAX_NAME_LENGTH), address });
    }
  };
  for (const o of Array.isArray(v) ? v : v ? [v] : []) {
    if (out.length >= MAX_ADDRESSES) break;
    walk(o.value);
  }
  return out;
}

// --- dates (ruling 6, replaced by fix round 1 ruling 3) -------------------------------------------

const DOW_PREFIX = /^(?:mon|tue|wed|thu|fri|sat|sun)\s*,\s*/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** RFC 5322 §4.3's obsolete named zones, mapped to UTC offset in minutes (the same sign
 * convention as a "+hhmm"/"-hhmm" zone: positive means local time is ahead of UTC). */
const OBS_ZONES: Record<string, number> = {
  ut: 0, utc: 0, gmt: 0, est: -5 * 60, edt: -4 * 60, cst: -6 * 60, cdt: -5 * 60, mst: -7 * 60, mdt: -6 * 60, pst: -8 * 60, pdt: -7 * 60,
};
/**
 * [day-of-week ","] handled separately by `DOW_PREFIX`, then: 1-2 digit day, English month
 * abbreviation, 2-5 digit year (2-5 so a 5-digit year can be matched and then explicitly
 * rejected by `mapObsYear` rather than silently failing to match at all and giving a less
 * specific null), hh:mm[:ss], and a zone that is either "+hhmm"/"-hhmm" or one of the RFC 5322
 * obsolete named zones, optionally followed by a CFWS comment. Every numeric component is
 * range-checked by the caller, not by this regex.
 */
const DATE_RE = /^(\d{1,2})\s+([a-z]{3})\s+(\d{2,5})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(?:([+-])(\d{2})(\d{2})|([a-z]{2,4}))\s*(?:\([^()]*\))?$/i;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(monthIdx: number, year: number): number {
  return monthIdx === 1 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[monthIdx]!;
}

/** Maps a 2-5 digit year token per RFC 5322 §4.3's obsolete year rule: a 2-digit year 00-49 is
 * 20xx, 50-99 is 19xx; any 3-digit year is 1900+n. A 4-digit year is used as-is. A 1-digit or
 * 5-digit token isn't a valid RFC 5322 year in any form, so it's rejected outright (returns
 * `null`) rather than guessed at -- this is what makes a 5-digit year like "10000" invalid
 * instead of silently becoming some huge year. */
function mapObsYear(digits: string): number | null {
  if (digits.length === 4) return Number(digits);
  if (digits.length === 2) {
    const n = Number(digits);
    return n <= 49 ? 2000 + n : 1900 + n;
  }
  if (digits.length === 3) return 1900 + Number(digits);
  return null;
}

/**
 * A strict, from-scratch RFC 5322 §3.3 date-time parser (no new dependency, fix round 1 ruling
 * 3): mailparser's own `new Date(value)` is both too permissive (JavaScript's `Date` constructor
 * accepts all sorts of non-RFC formats, and silently "fixes up" an impossible date like Feb 31 by
 * rolling it into March) and -- separately -- surprising in a way the old `parseDate` doc already
 * covers: an unparsable value becomes mailparser's substituted "now" rather than invalid. This
 * parser accepts exactly: an optional day-of-week, a 1-2 digit day, an English month
 * abbreviation, a 2/3/4-digit year (2 and 3-digit years are the RFC 5322 §4.3 obsolete forms,
 * mapped by `mapObsYear`), an hh:mm[:ss] time with range checks (hour <= 23, minute/second <=
 * 59), and a zone that is either a strict +/-hhmm offset (hh <= 14, mm <= 59) or one of the RFC
 * 5322 obsolete named zones (UT/GMT and the US EST/EDT/CST/CDT/MST/MDT/PST/PDT), plus the modern
 * "UTC" name (not itself an RFC 5322 obsolete zone, but common enough in the wild that fix round 2
 * added it rather than reject it). Every component is range-checked, including the nominal day
 * against the actual number of days in that nominal month/year (so Feb 31 is rejected outright,
 * never rolled into March, and the leap-year test for Feb 29 uses the *nominal* year the header
 * actually states). The 1900-9999 year bound, however, is checked on the *final* UTC instant --
 * after the zone offset has been applied -- not on the nominal year parsed out of the header (fix
 * round 2, ruling 4): a date very close to midnight on 1 Jan or 31 Dec can cross a year boundary
 * once its offset is applied (e.g. "31 Dec 9999 23:30 -0100" is really 1 Jan 10000 00:30 UTC), and
 * checking only the nominal year would wrongly accept an instant that actually falls outside
 * 1900-9999, or wrongly reject one that's nominally just outside the range but actually falls back
 * inside it once shifted to UTC. The result is always built without ever going through the
 * two-argument `Date`/`Date.UTC` year parameter (see `buildUtcInstant` below for why), and never
 * through the local `Date` constructor or `new Date(string)`, so it can never depend on the
 * host's time zone. Anything that doesn't match this exactly -- including a value that is
 * otherwise a real date format but just isn't RFC 5322 shaped -- gives `null`.
 */
function parseRfc5322Date(raw: string): string | null {
  const noDow = raw.trim().replace(DOW_PREFIX, "");
  const m = DATE_RE.exec(noDow);
  if (!m) return null;
  const [, dayStr, monthStr, yearStr, hourStr, minuteStr, secondStr, zsign, zhh, zmm, zname] = m;
  const monthIdx = MONTHS.indexOf(monthStr!.toLowerCase());
  if (monthIdx === -1) return null;
  const year = mapObsYear(yearStr!);
  if (year === null) return null;
  const day = Number(dayStr);
  if (day < 1 || day > daysInMonth(monthIdx, year)) return null;
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = secondStr !== undefined ? Number(secondStr) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes: number;
  if (zsign) {
    const zh = Number(zhh);
    const zm = Number(zmm);
    if (zh > 14 || zm > 59) return null;
    offsetMinutes = (zsign === "-" ? -1 : 1) * (zh * 60 + zm);
  } else {
    const zone = OBS_ZONES[zname!.toLowerCase()];
    if (zone === undefined) return null;
    offsetMinutes = zone;
  }
  const utcMs = buildUtcInstant(year, monthIdx, day, hour, minute, second) - offsetMinutes * 60_000;
  const d = new Date(utcMs);
  if (Number.isNaN(d.getTime())) return null;
  const finalYear = d.getUTCFullYear();
  if (finalYear < 1900 || finalYear > 9999) return null;
  return d.toISOString();
}

/**
 * Builds a UTC instant from calendar fields without `Date.UTC`'s well-known two-digit-year
 * footgun (fix round 2, ruling 4 regression found while moving the year-range check after the
 * zone offset): per spec, `Date.UTC` (and the multi-argument `Date` constructor) silently add
 * 1900 to any year argument from 0 to 99 inclusive -- `Date.UTC(1, 0, 1, ...)` is 1 Jan **1901**,
 * not 1 Jan 0001. A 4-digit year token in a Date header can legitimately be e.g. "0001" (year 1,
 * `mapObsYear` returns it unchanged since it's already 4 digits), which would otherwise silently
 * reappear 1900 years later and sail past the 1900-9999 bound check instead of being rejected as
 * the out-of-range year it actually is. `Date.prototype.setUTCFullYear` has no such special case
 * (it sets exactly the year given, for any value), so this starts from the UTC epoch and sets
 * every field explicitly through the setters instead.
 */
function buildUtcInstant(year: number, monthIdx: number, day: number, hour: number, minute: number, second: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, monthIdx, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

/**
 * mailparser does NOT leave an unparsable Date header invalid or absent: internally it runs
 * `new Date(value)` and, if that's `NaN`, silently substitutes `new Date()` -- the moment the
 * message happened to be parsed (verified experimentally against mailparser 3.9.36; the shipped
 * vendor types don't capture this because `p.date` really is always a valid `Date` when the
 * header is present, just not necessarily derived from it). Trusting `p.date` would therefore
 * turn a garbled Date header into a fabricated "now" timestamp instead of the `null` ruling 6
 * requires. We re-read the raw header line(s) ourselves and parse independently with
 * `parseRfc5322Date`; when more than one Date header is present we keep the last, mirroring
 * mailparser's own single-value collapsing rule for this header.
 */
function parseDate(headerLines: { key: string; line: string }[]): string | null {
  const lines = headerLines.filter((h) => h.key === "date");
  if (!lines.length) return null;
  const raw = lines[lines.length - 1]!.line.replace(/^date:\s*/i, "").trim();
  return parseRfc5322Date(raw);
}

// --- auth (ruling 4, tightened by fix round 1, quoted-string hardened by fix round 2) -------------

/**
 * Splits an Authentication-Results header value into its top-level ';'-separated segments (the
 * first is the authserv-id, the rest are resinfo items), with RFC 5322 "(...)" comments removed
 * (nested ones handled by depth-counting) in one linear pass that also understands RFC 5322
 * quoted-strings (`"..."`, with `\` escaping a following character) -- but, per fix round 3,
 * ruling 4, quote-tracking is only ever active at depth 0 (outside any comment). This replaces
 * the fix-round-2 version, which let a quote toggle on even *inside* a comment: a forged resinfo
 * property value can plant a bare, unescaped `"` inside a comment specifically to flip that
 * tracking on, after which the comment's own real, unescaped closing ')' was being swallowed as
 * "quoted content" instead of actually closing the comment -- leaving the comment artificially
 * held open for the rest of the line and silently dropping everything genuine that followed it,
 * including a real trailing "dmarc=fail" (confirmed experimentally: a bare `"` inside an spf
 * comment, as in `(domain of "x designates)`, made the real closing ')' disappear into a
 * never-closed quote, and the whole rest of the line -- a real `dmarc=fail` included -- vanished
 * with it). Per RFC 5322, a comment's `ctext` has no quoted-string production of its own; the only
 * escaping mechanism *inside* a comment is `quoted-pair` (a bare `\` followed by any one
 * character, consumed as a single opaque unit) -- so inside a comment, `"` is just ordinary ctext
 * (dropped like everything else), and a `\` followed by any character (in particular a `\)`) is
 * skipped as one escaped unit rather than ever being read as the comment's real close. Quoted
 * strings are therefore only recognized at depth 0, exactly where RFC 5322 actually allows them;
 * a forged `"` inside a comment can no longer interfere with the comment's own closing ')', nor
 * with top-level ';' splitting once that comment legitimately closes. `dmarcVerdict` below only
 * ever looks at a segment's *first* token, so a forged value that ends up buried mid-segment
 * (rather than becoming -- or prematurely ending -- a segment of its own) is still never read as
 * that segment's method=result, even where the comment's content isn't perfectly reconstructed.
 * The whole thing remains a single forward scan with one depth counter and one boolean, so it
 * stays linear regardless of how many quotes, parens or ';' characters a hostile line contains
 * (verified with a 1M-character quote/paren string).
 */
function splitResinfoSegments(line: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      // Only ever entered at depth 0 (below), so a quoted string's content is always kept.
      current += ch;
      if (ch === "\\" && i + 1 < line.length) {
        current += line[++i];
        continue;
      }
      if (ch === '"') inQuotes = false;
      continue;
    }
    if (depth > 0) {
      // Inside a comment: '"' is plain ctext here, not a quote-string opener (fix round 3,
      // ruling 4) -- a comment is closed only by its own matching, unescaped ')'. A '\' followed
      // by any character is ccontent's own "quoted-pair" and is consumed as one escaped unit, so a
      // backslash-escaped ')' can never be mistaken for the comment's real close.
      if (ch === "\\" && i + 1 < line.length) {
        i++;
        continue;
      }
      if (ch === "(") {
        depth++;
        continue;
      }
      if (ch === ")") {
        depth--;
        continue;
      }
      continue; // every other character inside a comment is dropped
    }
    if (ch === '"') {
      inQuotes = true;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") continue; // an unmatched ')' at depth 0: ignore, never go negative
    if (ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/**
 * The verdict collected from every resinfo segment whose method is literally "dmarc=" -- never a
 * substring match anywhere in the line, and never just the first one found (fix round 2, ruling
 * 2): each segment's result is the text immediately after "dmarc=", up to the next whitespace (the
 * rest of a resinfo item is free-form reason/property text, e.g. "spf=pass smtp.mailfrom=...").
 * `segments` must already exclude the authserv-id segment (index 0) and already have comments and
 * quoted strings handled by `splitResinfoSegments`.
 *
 * Combining multiple results (there is normally at most one, but a forged header can add more):
 * a "fail" anywhere wins outright, regardless of how many other results disagree with it --
 * DMARC failing even once is the signal that matters for phishing, and must not be out-voted or
 * shadowed by a forged "pass" planted elsewhere in the same line. Short of that, if every result
 * agrees, that shared result decides ("pass" stays "pass"; anything else, e.g. all "none" or all
 * "temperror", is "none"). If the results disagree and none of them is "fail", the line is simply
 * untrustworthy as a whole and this gives "none" rather than arbitrarily picking whichever result
 * happened to be collected first or last.
 */
function dmarcVerdict(segments: string[]): "pass" | "fail" | "none" {
  const results: string[] = [];
  for (const seg of segments) {
    const token = seg.trim().split(/\s+/)[0] ?? "";
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    if (token.slice(0, eq).toLowerCase() === "dmarc") results.push(token.slice(eq + 1).toLowerCase());
  }
  if (results.some((r) => r === "fail")) return "fail";
  if (results.length > 0 && results.every((r) => r === results[0])) {
    return results[0] === "pass" ? "pass" : "none";
  }
  return "none";
}

/**
 * Trusts only the Authentication-Results header, and only its topmost instance (`lines[0]`) --
 * never any instance further down, even if `lines[0]` is missing, unparsable, or doesn't match
 * `authservId`. On the public mail path each hop prepends its own headers above whatever is
 * already there, so the first (topmost) occurrence of this header in the message is the one
 * added *last*, by the server that handed the message to us directly; a spoofing sender can
 * plant any number of forged Authentication-Results lines further down (wherever their own
 * outbound MTA happened to put them), and those must never override the real one, win a
 * fallback, or even be consulted.
 *
 * Topmost position alone isn't enough, though: a message that never touched our receiving
 * server at all (so there's no real Authentication-Results header anywhere) can still have a
 * forged one at the top, planted by the sender's own MTA. The `authservId` check closes that
 * gap -- it only trusts the topmost line when its authserv-id (the identity the *receiving*
 * server stamps on the header it adds, e.g. "mx.google.com" for Gmail) matches the id we
 * actually expect from our own receiving server; otherwise there is no real verdict to read, so
 * the result is "none" rather than trusting (or even inspecting the dmarc= of) a line that could
 * be entirely sender-controlled. This task (3b) only ever receives Gmail mail, hence the
 * "mx.google.com" default; `authservId` is a parameter so a later provider can pass its own
 * receiving server's id without changing this function. Mail that never got a real Gmail-added
 * header at all -- items in Sent, or purely intra-Workspace mail that never transited external
 * SMTP -- has no verifiable signal here either way: whatever is topmost is still what's trusted
 * (or, lacking a match, "none"). A header with no top-level ';' at all isn't validly structured
 * (RFC 7601 always has at least one ';'-separated resinfo, even a bare "none"), so
 * `splitResinfoSegments` producing only one segment -- meaning there was no real ';' -- also gives
 * "none", rather than treating the whole string as the authserv-id.
 *
 * The verdict is read ONLY from the resinfo segment(s) whose method is "dmarc=" (`dmarcVerdict`),
 * never a substring match over the raw line: DMARC is the check that ties authentication to the
 * visible From: domain, which is what a human reading the message actually sees and what matters
 * for phishing -- SPF/DKIM can each individually pass on a domain that isn't the one shown to the
 * recipient, and (per the reviewer's spoof strings) a forged "dmarc=pass"/"dmarc=fail" can be
 * planted inside another resinfo's free-form text, its comment, or a quoted string inside either,
 * without ever being a real dmarc result.
 */
export function authResult(lines: string[], authservId = "mx.google.com"): "pass" | "fail" | "none" {
  const segments = splitResinfoSegments(lines[0] ?? "");
  if (segments.length < 2) return "none";
  const id = (segments[0]!.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (id !== authservId.trim().toLowerCase()) return "none";
  return dmarcVerdict(segments.slice(1));
}

// --- public API --------------------------------------------------------------------------------

export function syntheticMessageId(raw: Buffer): string {
  return `<${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32)}.synthetic${"@"}localhost>`;
}

export function normalizeSubject(s: string): string {
  let out = s.trim();
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/^(?:re|fwd?|aw|sv)\s*:\s*/i, "");
  }
  return out.trim();
}

const PARSE_OPTIONS = {
  keepCidLinks: true,
  skipImageLinks: true,
  skipTextLinks: true,
  skipTextToHtml: true,
  maxHtmlLengthToParse: 2_000_000,
};

/** mailparser emits this as a non-fatal internal error (it still produces a result with a
 * placeholder `text`), but `simpleParser`'s promise wrapper settles -- and so rejects -- on the
 * *first* event, error or not, so a too-long HTML body otherwise surfaces as a thrown Error
 * instead of a parsed message (fix round 1, ruling 5). Retrying once with `skipHtmlToText: true`
 * avoids the conversion entirely (no length check is reached at all on that path), at the cost of
 * an empty `text` for a message whose only body is HTML -- a large HTML-only newsletter then
 * still parses, which is the point; a sender who also included a text/plain alternative is
 * unaffected either way. */
const TOO_LONG_HTML = /^HTML too long for parsing \d+ bytes$/;

async function parseWithMailparser(raw: Buffer) {
  try {
    return await simpleParser(raw, PARSE_OPTIONS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // mailsplit tags its own size-limit errors with `.code === "EMAXLEN"`; relying on that
    // (rather than the message text alone) is what actually distinguishes a structural "this
    // MIME tree is too complex to parse" rejection from everything else `simpleParser` can
    // reject with.
    if ((err as { code?: string } | undefined)?.code === "EMAXLEN") {
      throw new MailParseError(message);
    }
    if (TOO_LONG_HTML.test(message)) {
      return await simpleParser(raw, { ...PARSE_OPTIONS, skipHtmlToText: true });
    }
    throw err;
  }
}

export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  if (raw.length > MAX_RAW_BYTES) {
    throw new Error(`Message is ${raw.length} bytes, over the ${MAX_RAW_BYTES}-byte limit.`);
  }
  const p = await parseWithMailparser(raw);

  const ownId = p.headers.has("message-id") ? cleanId(p.messageId) : "";
  const message_id = ownId || syntheticMessageId(raw);
  const references = extractReferences(p.headerLines);
  const in_reply_to = extractInReplyTo(p.headerLines);
  const date = parseDate(p.headerLines);

  const authLines = p.headerLines
    .filter((h) => h.key === "authentication-results")
    .slice(0, MAX_AUTH_LINES)
    .map((h) => h.line.replace(/^authentication-results:\s*/i, ""));

  const attachments: ParsedAttachment[] = p.attachments.slice(0, MAX_ATTACHMENTS).map((a, i) => {
    const part = String(i + 1);
    return {
      part,
      name: cleanAttachmentName(a.filename, part),
      size: a.size ?? a.content.length,
      type: cleanText(a.contentType || "application/octet-stream", MAX_TYPE_LENGTH).toLowerCase(),
      cid: cleanText(a.cid, MAX_CID_LENGTH),
      inline: a.contentDisposition === "inline" || a.related === true,
      content: a.content,
    };
  });

  return {
    message_id,
    synthetic_id: !ownId,
    in_reply_to,
    references,
    thread_key: references[0] ?? (in_reply_to || message_id),
    from: addresses(p.from)[0] ?? { name: "", address: "unknown" },
    to: addresses(p.to),
    cc: addresses(p.cc),
    reply_to: addresses(p.replyTo),
    subject: cleanText(p.subject, MAX_SUBJECT_LENGTH),
    date,
    text: p.text ?? "",
    html: p.html || "",
    attachments,
    auth: authResult(authLines),
  };
}

// Exported only for direct unit testing of a sanitizer that the public parseMessage() pipeline
// can't exercise end-to-end for every hostile input (e.g. a raw NUL byte inside an address never
// survives mailparser's own header decoding to reach this function in practice -- verified
// experimentally -- so there is no raw mail message that lets a test reach this code path through
// parseMessage() alone). Exposing it directly lets a test prove this module's own defense works
// regardless of what any particular mailparser version happens to already strip upstream.
//
// @internal Not part of the package's public API (fix round 2, ruling 7): `index.ts` re-exports
// this module by an explicit, named list rather than `export *`, and deliberately leaves
// `cleanAddress` off that list. Import it directly from "./parse.js" (as this module's own test
// file does) rather than from the package root.
//
// @internal `cleanAttachmentName` is exported alongside `cleanAddress` for the same reason and
// under the same rule (fix round 3, ruling 3): a timing guard for its ReDoS fix needs to drive it
// directly with a 1,000,000-character name, and doing that through `parseMessage` would mostly be
// timing mailparser/mailsplit's own header handling (and, past a certain size, would trip
// mailsplit's separately-tested 1 MB header-size guard before ever reaching this function), not
// this function's own linearity.
export { cleanAddress, cleanAttachmentName, finishAttachmentName };
