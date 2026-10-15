// --- invisible characters -------------------------------------------------------------------------

// Zero-width space/joiner/non-joiner, the BOM, the bidi embedding/override/isolate controls, the
// soft hyphen, variation selectors, the combining grapheme joiner (U+034F, category Mn - not Cf),
// Mongolian/Hangul/Khmer invisible fillers (U+180B-180F, U+3164, U+115F/1160, U+17B4/17B5), tag
// characters (U+E0000-E0FFF) and more all match the single `Default_Ignorable_Code_Point` Unicode
// binary property - a purpose-built category for exactly this: characters a renderer is expected
// to not show. Any of these, dropped next to '@' or inside a domain, would otherwise hide a whole
// address from the character-class scans below, so they're stripped before any other detection
// runs.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

// --- secrets ------------------------------------------------------------------------------------

function toBase64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** encodeURIComponent throws a URIError on a lone surrogate; a secret is never allowed to make redaction throw. */
function safeEncode(s: string): string | null {
  try { return encodeURIComponent(s); } catch { return null; }
}

/**
 * Every exact and encoded form of every secret that should disappear from a log line: the secret
 * as given, with internal whitespace removed (Google shows App Passwords with spaces), each as
 * base64 and base64url, padded and unpadded, and each percent-encoded. Sorted longest-first so a
 * short variant can't shadow a longer one that contains it. Invisible characters are stripped from
 * the secret first, since `redact()` strips them from the line before matching, and a secret that
 * contains one (e.g. a soft hyphen) would otherwise never match.
 */
function secretVariants(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const rawSecret of secrets) {
    const secret = String(rawSecret).replace(INVISIBLE, "");
    const bases = new Set([secret, secret.replace(/\s+/g, "")]);
    for (const base of bases) {
      if (!base) continue;
      const b64 = toBase64(base);
      const b64NoPad = b64.replace(/=+$/, "");
      const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_");
      const b64urlNoPad = b64url.replace(/=+$/, "");
      for (const v of [base, b64, b64NoPad, b64url, b64urlNoPad, safeEncode(base)]) {
        if (v && v.length >= 4) out.add(v);
      }
      // Fix round 1: a truncated base64 form (a log line cut short) still gives most of the
      // secret away, so every prefix of 12 characters or more goes too. Base64 is case-sensitive,
      // so these stay exact matches. At most a few dozen extra strings per secret.
      for (const enc of [b64NoPad, b64urlNoPad]) {
        for (let n = 12; n < enc.length; n++) out.add(enc.slice(0, n));
      }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Task 10: what may sit between any two characters of a secret in a log line: whitespace, ASCII
 * and Unicode hyphens and dashes (U+2010-U+2015, the en and em dash among them), '.', '_', '+',
 * or a percent-encoded space. One source string so the stripping pass and the pattern can't drift.
 */
const SEP_SOURCE = "(?:[\\s\\-\u2010-\u2015._+]|%20)";
const SEPARATORS = new RegExp(`${SEP_SOURCE}+`, "gu");

/** Removes every separator run, repeating until stable so a "%20" that only forms after an inner removal ("%2%200") goes too. */
function compactSecret(s: string): string {
  let out = s;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(SEPARATORS, "");
  }
  return out;
}

/**
 * Fix round 1, widened in Task 10: one pattern per secret that matches it in any letter case and
 * with any run of separators (see SEP_SOURCE) between any two characters ("ABCD EFGH IJKL MNOP",
 * "abcd-efgh", "abcd.efgh", "abcd%20efgh"). Built from the secret with every separator removed
 * (compactSecret), so no character of the pattern can itself be eaten by a separator run: each
 * `SEP*` is followed by a fixed character it can't consume, which keeps matching linear (no
 * backtracking between neighbouring separator runs). The one multi-character separator, "%20",
 * can only collide with a pattern '%' followed by "20", and compactSecret leaves no "%20" in the
 * secret. Applies to the secret and its percent-encoded form (percent escapes are case-insensitive
 * hex); base64 forms are case-sensitive and are matched exactly in secretVariants.
 */
function fuzzySecretPatterns(secrets: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  const seen = new Set<string>();
  for (const rawSecret of secrets) {
    const compact = compactSecret(String(rawSecret).replace(INVISIBLE, ""));
    const encoded = safeEncode(compact);
    for (const form of encoded === null ? [compact] : [compact, compactSecret(encoded)]) {
      const chars = Array.from(form);
      if (chars.length < 4 || seen.has(form.toLowerCase())) continue;
      seen.add(form.toLowerCase());
      // Every character is escaped as a code point (\u{...}), so nothing in a secret, a lone
      // surrogate included, can change the pattern's meaning or make it invalid.
      const body = chars.map((c) => `\\u{${c.codePointAt(0)!.toString(16)}}`).join(`${SEP_SOURCE}*`);
      try { out.push(new RegExp(body, "giu")); } catch { /* never let a secret make redaction throw */ }
    }
  }
  return out;
}

interface CompiledSecrets { key: string; variants: string[]; patterns: RegExp[] }
/** Task 10: redact runs once per log line, so the variants and patterns are built once per secrets array. */
const COMPILED = new WeakMap<readonly string[], CompiledSecrets>();
const NO_SECRETS: CompiledSecrets = { key: "", variants: [], patterns: [] };

function compiled(secrets: readonly string[]): CompiledSecrets {
  if (secrets.length === 0) return NO_SECRETS;
  // The key is the array's current content, so an array changed in place is rebuilt, not served stale.
  const key = JSON.stringify(secrets);
  const hit = COMPILED.get(secrets);
  if (hit && hit.key === key) return hit;
  const next = { key, variants: secretVariants(secrets), patterns: fuzzySecretPatterns(secrets) };
  COMPILED.set(secrets, next);
  return next;
}

// --- unicode-aware, linear-time email address detection ------------------------------------------

const LOCAL_CHAR = /[\p{L}\p{N}\p{M}._%+-]/u;
const DOMAIN_CHAR = /[\p{L}\p{N}\p{M}-]/u;
const LETTER = /\p{L}/u;

interface Span {
  start: number;
  end: number;
}

/**
 * Finds email address spans in `chars` (one array element per code point) in O(n): for each `@`
 * it expands left over local-part characters and right over domain characters, then looks for the
 * right-most `.` followed by at least two letters (the TLD). No regex is run over the whole
 * string, so this can't go quadratic the way `/[...]+@[...]+\.[...]{2,}/` does when there's no `@`
 * or many of them: that pattern's `+` has to be tried, and backtracked, at every start position.
 * Handles internationalised domains (`müller@münchen.de`) via `\p{L}`; punycode (`xn--...`) is
 * plain ASCII, so it was already covered. `\p{M}` includes combining marks, so a decomposed
 * accent (e.g. a bare combining acute after the base letter) stays part of the address instead
 * of breaking the local-part or domain scan.
 */
function findEmailSpans(chars: readonly string[]): Span[] {
  const n = chars.length;
  const spans: Span[] = [];
  let i = 0;
  while (i < n) {
    if (chars[i] !== "@") {
      i++;
      continue;
    }
    const at = i;

    let l = at;
    while (l > 0 && LOCAL_CHAR.test(chars[l - 1])) l--;
    if (l === at) {
      i = at + 1;
      continue; // no local part, not an address
    }

    let maxEnd = at + 1;
    while (maxEnd < n && (DOMAIN_CHAR.test(chars[maxEnd]) || chars[maxEnd] === ".")) maxEnd++;

    // Right-most '.' in the domain run that's followed by at least two letters (the TLD). This
    // mirrors what a greedy-then-backtrack regex would settle on, without the backtracking.
    let dot = -1;
    for (let d = maxEnd - 1; d > at; d--) {
      if (chars[d] === "." && d + 2 < maxEnd && LETTER.test(chars[d + 1]) && LETTER.test(chars[d + 2])) {
        dot = d;
        break;
      }
    }
    if (dot === -1) {
      i = at + 1;
      continue; // domain chars but no valid TLD, not an address
    }

    let end = dot + 1;
    while (end < maxEnd && LETTER.test(chars[end])) end++;

    spans.push({ start: l, end });
    i = end;
  }
  return spans;
}

// --- bare long opaque tokens (SASL continuation lines etc.) --------------------------------------

const TOKEN_CHAR = /[A-Za-z0-9+/_-]/;
const MIN_TOKEN_LEN = 20;

/**
 * Finds runs of base64/base64url-alphabet characters at least `MIN_TOKEN_LEN` long (with up to two
 * trailing `=` padding characters), in O(n). A bare continuation line in an IMAP/SMTP transcript
 * (a raw `AUTHENTICATE`/`LOGIN`/XOAUTH2 payload with no keyword on the same line) is just such a
 * token; logs are diagnostic, so losing it is acceptable. Runs of a single repeated character
 * (e.g. a filler string in a test) are not opaque tokens and are left alone.
 */
function findTokenSpans(chars: readonly string[]): Span[] {
  const n = chars.length;
  const spans: Span[] = [];
  let i = 0;
  while (i < n) {
    if (!TOKEN_CHAR.test(chars[i])) {
      i++;
      continue;
    }
    const start = i;
    let allSame = true;
    let j = i;
    while (j < n && TOKEN_CHAR.test(chars[j])) {
      if (chars[j] !== chars[start]) allSame = false;
      j++;
    }
    let end = j;
    let pad = 0;
    while (end < n && chars[end] === "=" && pad < 2) {
      end++;
      pad++;
    }
    if (j - start >= MIN_TOKEN_LEN && !allSame) spans.push({ start, end });
    i = end;
  }
  return spans;
}

// --- applying spans --------------------------------------------------------------------------------

function replaceSpans(chars: readonly string[], spans: readonly Span[], placeholder: string): string {
  if (spans.length === 0) return chars.join("");
  let out = "";
  let i = 0;
  for (const { start, end } of spans) {
    out += chars.slice(i, start).join("");
    out += placeholder;
    i = end;
  }
  out += chars.slice(i).join("");
  return out;
}

// --- control characters -----------------------------------------------------------------------------

// CR, LF, form feed, vertical tab, NEL (U+0085) and the Unicode line/paragraph separators all
// collapse to a single space (a run of several becomes one), so one input can't be made to look
// like several log lines. Any other C0/C1 control character is stripped outright (tab is left
// alone: it doesn't fake a new line).
const LINE_BREAK = /[\r\n\f\v\u0085\u2028\u2029]+/g;
const OTHER_CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g;

// --- public API --------------------------------------------------------------------------------------

/**
 * Makes a log line safe to keep: no secrets (exact, whitespace-collapsed, base64/base64url or
 * percent-encoded), no IMAP or SMTP auth tokens (including a bare base64 continuation line with no
 * keyword), no email addresses (including internationalised ones, and ones with an invisible
 * character planted next to '@' or inside the domain), one line, at most 500 characters. Every
 * mail log line goes through this.
 */
export function redact(line: string, secrets: readonly string[] = []): string {
  // Strip invisible formatting characters first: unlike every other step, which looks for
  // something and redacts it, a character here can only ever defeat detection, never carry
  // information worth keeping.
  let out = String(line).replace(INVISIBLE, "");

  const { variants, patterns } = compiled(secrets);
  for (const v of variants) out = out.split(v).join("[secret]");
  for (const re of patterns) out = out.replace(re, "[secret]");

  out = out
    .replace(/\b(AUTH(?:ENTICATE)?\s+(?:PLAIN|LOGIN|XOAUTH2)\s+)\S+/gi, "$1[secret]")
    .replace(/\b(LOGIN\s+)("[^"]*"|\S+)\s+("[^"]*"|\S+)/g, "$1[address] [secret]");

  let chars: readonly string[] = Array.from(out);
  out = replaceSpans(chars, findEmailSpans(chars), "[address]");

  chars = Array.from(out);
  out = replaceSpans(chars, findTokenSpans(chars), "[token]");

  out = out.replace(LINE_BREAK, " ").replace(OTHER_CONTROL, "");

  return out.slice(0, 500);
}
