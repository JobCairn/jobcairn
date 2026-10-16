import type { EmailAddress, EmailMatchKind } from "@careeros/core";
import senders from "../data/job-senders.json" with { type: "json" };

export interface JobInfo { id: string; title: string; status: string; last_activity: string }
export interface CompanyInfo {
  slug: string; name: string; aliases: string[]; website: string; recruiter_email: string; email_match: string[]; jobs: JobInfo[];
  /**
   * A recruitment agency with no company folder yet (recruiters/<slug>/agency.json only). It matches by its website's
   * domain and its addresses like a company, but never by its name in a subject (rule 5) or as a suggestion: a job
   * alert naming a big agency must not be filed under it. Sync makes its company folder before filing.
   */
  agency_only?: boolean;
  /**
   * The agency's published addresses (its site, its people, its own ads), matched exactly but only after no company
   * matched by its own website's domain: an ad can name the client's address.
   */
  agency_addresses?: string[];
}
export interface HeaderInfo { direction: "in" | "out"; from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; subject: string }
export interface MatchResult { company_slug: string; job_id: string; matched_by: EmailMatchKind }
export interface JobSenders { domains: string[]; words: string[] }
export interface IgnoreList { senders: string[]; domains: string[] }

export const JOB_SENDERS: JobSenders = senders as JobSenders;

const STOP = new Set(["and", "the", "for", "with", "of", "in", "at", "to", "a", "an"]);
const ACTIVE = new Set(["Applying", "Applied", "Interview"]);

const lc = (s: string) => s.trim().toLowerCase();

// --- domain comparison (case-insensitive, trailing-dot-tolerant, IDN-consistent, no URL syntax) ----

/**
 * Domain/host characters this module ever treats as potentially meaningful: Unicode letters,
 * combining marks (so a decomposed accented character isn't rejected), digits, '.', and '-'.
 * Fix round 1: anything else -- '/', '\', '#', '?', '%', ':', the CJK "ideographic full stop" used
 * as a look-alike for '.', etc. -- means the string isn't really a bare domain at all (it's URL
 * syntax, a percent-escape, a port, or a confusable separator), so `toAsciiDomain` rejects it
 * outright instead of asking `URL` to make sense of it. This is what closes the spoof where a
 * sender's address has a domain-part like "acme.example.com/.evil.net": handing that whole string
 * to `new URL()` quietly discards "/.evil.net" as a path and returns the hostname
 * "acme.example.com" -- the real company's domain -- as if the address had legitimately been at
 * that domain. Empirically (see the test file),
 * `new URL()` does exactly this kind of silent, dangerous normalization for every one of
 * '/','\','#','?','%2e' (percent-decoded to '.'), and ':80' (a port, stripped from `.hostname`).
 */
const DOMAIN_CHARS = /^[\p{L}\p{M}\p{N}.-]+$/u;
/** A plain-ASCII fast path: real domains are overwhelmingly ASCII, and checking this (a simple,
 * flag-less character class -- no `/u`, no `/i`, both of which measured meaningfully slower in
 * local benchmarking at the volumes `matchCompany` can see, e.g. 10,000 companies x 100 email_match
 * domains) lets `toAsciiDomain` skip both the Unicode-aware `DOMAIN_CHARS` test and the punycode
 * step entirely for the common case. */
const ASCII_DOMAIN = /^[a-zA-Z0-9.-]+$/;
const ASCII_ONLY = /^[\x00-\x7f]*$/;

// --- RFC 3492 Punycode encoding (bootstring), used only by toAsciiDomain below -----------------
//
// Deliberately NOT the WHATWG URL host parser's IDNA/UTS46 pipeline: that pipeline's "mapping" step
// folds a fullwidth Latin form (e.g. "ａｃｍｅ", U+FF41 etc.) down to its plain-ASCII look-alike
// ("acme") before encoding -- verified experimentally (`new URL("https://ａｃｍｅ.com").hostname`
// gives "acme.com" directly, no "xn--" at all) -- which would silently treat a fullwidth domain as
// if it were the real one. A raw Punycode encode of the label's actual code points, with no
// compatibility mapping, keeps "ａｃｍｅ" encoded as its own distinct "xn--mi7ceg5a" rather than
// folding it to "acme" (confirmed against Node's own deprecated `punycode.toASCII`, which uses the
// same non-mapping algorithm and gives the identical "xn--mi7ceg5a"). Fix round 2: refusing to treat
// a fullwidth label as equivalent to its plain-ASCII look-alike is a fail-closed choice -- a
// fullwidth label is simply never folded into matching its ASCII counterpart -- not a claim that
// this encoder specifically detects or defends against homograph attacks in general (confusable
// Unicode look-alikes are a much broader problem than this module takes on). The WHATWG parser also
// recognizes and renormalizes IPv4-literal-looking hosts (e.g. "0x7f.1" -> "127.0.0.1"); this
// encoder, having no such special-casing, leaves "0x7f.1" untouched, so it never collides with a
// real "127.0.0.1".
const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;
const PUNY_DELIMITER = "-";

function punycodeAdapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / PUNY_DAMP) : Math.floor(delta / 2);
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
}

const punycodeDigit = (digit: number): string => String.fromCharCode(digit + 22 + (digit < 26 ? 75 : 0));

/** Encodes one dot-free label's code points per RFC 3492. Operates on an array of Unicode code
 * points (via `Array.from`, which iterates whole code points, never half a surrogate pair). */
function punycodeEncodeLabel(input: string): string {
  const codePoints = Array.from(input, (ch) => ch.codePointAt(0)!);
  let n = PUNY_INITIAL_N;
  let delta = 0;
  let bias = PUNY_INITIAL_BIAS;
  const basic = codePoints.filter((cp) => cp < 0x80);
  let out = basic.map((cp) => String.fromCharCode(cp)).join("");
  const basicLength = basic.length;
  let handled = basicLength;
  if (basicLength > 0) out += PUNY_DELIMITER;
  while (handled < codePoints.length) {
    let m = Infinity;
    for (const cp of codePoints) if (cp >= n && cp < m) m = cp;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const cp of codePoints) {
      if (cp < n) delta++;
      if (cp === n) {
        let q = delta;
        for (let k = PUNY_BASE; ; k += PUNY_BASE) {
          const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
          if (q < t) break;
          out += punycodeDigit(t + ((q - t) % (PUNY_BASE - t)));
          q = Math.floor((q - t) / (PUNY_BASE - t));
        }
        out += punycodeDigit(q);
        bias = punycodeAdapt(delta, handled + 1, handled === basicLength);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return out;
}

/** RFC 1035's own DNS limits -- reused here (fix round 2, item 2) as a practical, standards-aligned
 * cap on `toAsciiDomain`'s input, checked *before* the punycode step: 63 code points per label, 253
 * characters for the whole dotted domain. `punycodeEncodeLabel` is quadratic in the number of
 * distinct code points in a label (its inner loop scans every remaining code point once per unique
 * value still to be encoded), and this path is reachable both through `domainMatches` (fed by
 * whatever a forged sender address's domain-part contains) and through purely local, trusted
 * configuration (a company's own `website`/`email_match` text, which could still be mistakenly huge
 * from a copy-paste error) -- either way, a real domain is always far under both limits, so
 * rejecting anything over them costs nothing for legitimate input and bounds the encoder's worst
 * case to a small constant regardless of what a forged or oversized value contains. */
const MAX_LABEL_CODEPOINTS = 63;
const MAX_DOMAIN_CHARS = 253;

/**
 * Normalizes a domain to the form domain comparisons are done in throughout this module: Unicode
 * NFC-normalized (fix round 2 -- see below) and lowercased, with exactly one trailing dot stripped
 * (an "FQDN" written with a trailing "." is the same domain as without one; two or more trailing
 * dots are left alone rather than collapsed, since that isn't standard FQDN notation and there's no
 * safe way to guess what was meant), validated against `DOMAIN_CHARS` (fix round 1 -- see that
 * constant's doc) and the length caps above, and in ASCII/punycode form for any internationalized
 * label (via `punycodeEncodeLabel`, not `URL`'s own IDNA step -- see the punycode section's doc
 * above for why). A string containing anything outside `DOMAIN_CHARS` -- URL syntax, a
 * percent-escape, a port, a confusable separator -- or over either length cap, returns "" (never
 * matches anything), *before* any IDNA/punycode processing is attempted.
 *
 * The `.normalize("NFC")` (fix round 2, item 2) runs before anything else, including the
 * `DOMAIN_CHARS` gate: a decomposed ("NFD") and a composed ("NFC") spelling of the same word --
 * e.g. "café" written as "e" + a combining acute accent vs. the single precomposed "é" -- are both
 * valid letter/mark sequences under `DOMAIN_CHARS` and would otherwise punycode-encode to two
 * *different* strings for what is visually and semantically the same domain, so a website entered
 * in one form would silently fail to match a sender address arriving in the other. Normalizing both
 * to NFC first means they always encode identically.
 */
function toAsciiDomain(input: string): string {
  const lowered = lc(input.normalize("NFC"));
  const trimmed = lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
  if (!trimmed) return "";
  if (ASCII_DOMAIN.test(trimmed)) return trimmed; // fast path: no Unicode check or punycode needed
  if (!DOMAIN_CHARS.test(trimmed)) return "";
  if (ASCII_ONLY.test(trimmed)) return trimmed;
  const labels = trimmed.split(".");
  if (trimmed.length > MAX_DOMAIN_CHARS || labels.some((label) => [...label].length > MAX_LABEL_CODEPOINTS)) return "";
  return labels.map((label) => (ASCII_ONLY.test(label) ? label : `xn--${punycodeEncodeLabel(label)}`)).join(".");
}

/** True suffix match on a label boundary, after normalizing both sides (case, trailing dot, IDN
 * form, URL-syntax rejection -- see `toAsciiDomain`). "acme.com" matches "acme.com" and
 * "mail.acme.com", but never "evilacme.com" (no label boundary), "acme.com.evil.net" (the match has
 * to be a suffix, not a prefix) or "acme.co" (no match at all) -- the `.` immediately before `base`
 * in the `endsWith` check is what enforces the label boundary; a plain `endsWith(base)` without it
 * would let "evilacme.com" match "acme.com". Never matches on an empty base (nor an empty, i.e.
 * unparseable or URL-syntax-rejected, domain). */
export function domainMatches(domain: string, base: string): boolean {
  const b = toAsciiDomain(base);
  if (!b) return false;
  const d = toAsciiDomain(domain);
  return !!d && (d === b || d.endsWith(`.${b}`));
}

export const domainOf = (address: string): string => toAsciiDomain(address.slice(address.lastIndexOf("@") + 1));

/** Extracts a website's domain. May strip a scheme and path from a real website URL first (e.g.
 * "https://acme.com/careers" gives "acme.com") -- that's a legitimate, expected shape for this
 * locally-configured field, unlike an email address's domain-part, which should never contain a
 * path at all. The host `URL` extracts is then re-validated through the same `toAsciiDomain` used
 * everywhere else (fix round 1), so a company's configured website gets the identical
 * character-class and IDN handling as any other domain compared in this module. */
export function websiteDomain(website: string): string {
  const w = website.trim();
  if (!w) return "";
  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(w) ? w : `https://${w}`).hostname;
  } catch {
    return "";
  }
  const d = toAsciiDomain(hostname);
  return d.includes(".") ? d.replace(/^www\./, "") : "";
}

/** Precomputed once at module load (the job-board list is static data, not attacker input), so the
 * per-company domain check in `matchCompany` (run up to `companies.length` times per message) never
 * re-normalizes these 29-ish strings on every call -- see the module doc comment on `matchCompany`
 * for why that matters at scale. */
const JOB_BOARD_DOMAINS = JOB_SENDERS.domains.map(toAsciiDomain).filter(Boolean);
export const isBoardDomain = (normalizedDomain: string): boolean =>
  JOB_BOARD_DOMAINS.some((d) => normalizedDomain === d || normalizedDomain.endsWith(`.${d}`));

// --- free-mail hosts (fix round 1, item 7) -------------------------------------------------------

/**
 * Public free-mail hosts. The brief's own Step 3 sample hardcodes this list (it is not part of
 * `job-senders.json`, which is reserved for public job-board/ATS domains and words per the task
 * instructions) -- so this is the brief's list, carried over verbatim, not an invented one. It is
 * deliberately non-exhaustive (concern: flagged in the handback report).
 */
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "aol.com", "gmx.com", "fastmail.com", "bigpond.com",
]);
const FREEMAIL_LIST = [...FREEMAIL];

/** A same-brand, country-specific TLD variant of a known free-mail provider (e.g. "yahoo.com.au"
 * for "yahoo.com", "outlook.com.au" for "outlook.com") is recognized generically, by replacing a
 * ".com.<cc>" or ".co.<cc>" tail (a two-letter country code) with plain ".com" and re-checking that
 * against the same list -- rather than hardcoding a long list of country domains, per the task's
 * "without inventing a big list" instruction. This only ever *adds* matches on top of the brief's
 * own list; it never changes what counts as "the list" itself. */
const COUNTRY_TLD_TAIL = /\.(?:com|co)\.[a-z]{2}$/;

function endsWithAny(domain: string, list: string[]): boolean {
  return list.some((f) => domain === f || domain.endsWith(`.${f}`));
}

/** A domain counts as free-mail if it equals a `FREEMAIL` entry, is a subdomain of one (e.g.
 * "mail.yahoo.com"), or is that entry's common country-TLD variant (e.g. "yahoo.com.au"). `domain`
 * is assumed already normalized (via `toAsciiDomain`/`websiteDomain`). */
export function isFreemailDomain(domain: string): boolean {
  if (!domain) return false;
  if (endsWithAny(domain, FREEMAIL_LIST)) return true;
  const asDotCom = domain.replace(COUNTRY_TLD_TAIL, ".com");
  return asDotCom !== domain && endsWithAny(asDotCom, FREEMAIL_LIST);
}

// --- company-name / word / phrase matching against a subject (or other free text) ------------------

/** Splits text into lowercase "words": runs of Unicode letters, combining marks, and digits.
 * Fix round 1, item 5: combining marks (`\p{M}`) are kept *inside* a token rather than treated as a
 * separator -- a Devanagari (and many other scripts') word is normally a base letter followed by
 * one or more combining vowel/virama marks, and splitting on them would shatter a single real word
 * into unrelated fragments (verified: "नमस्ते" without this fix splits to ["नमस","त"], losing the
 * marks and the word's integrity; with it, it stays ["नमस्ते"]). A single `String.prototype.split`
 * call is linear in the input's length (the character class has no nested/ambiguous repetition, so
 * it can't backtrack), and is run at most once per message/text -- never once per company -- which
 * is what keeps subject-vs-phrase matching below from ever costing
 * `companies.length * subject.length` work. */
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

/** Counts only `\p{L}`/`\p{N}` code points across a tokenized phrase's words -- deliberately *not*
 * `\p{M}` combining marks, even though `tokenize` keeps them inside the token string itself (fix
 * round 1, item 5): a combining mark adds no independent "substance" toward whether a name is long
 * enough to be meaningful for matching, only to keeping the letter it's attached to intact. Used by
 * `bestNameMatch`'s `MIN_NAME_LENGTH` gate so a name made of one real letter plus decorative marks
 * (e.g. the Devanagari fixture in match.test.ts, one consonant plus three vowel signs) is still
 * correctly excluded, the same as "C++" (one real letter, "c") is. */
function letterDigitCount(words: string[]): number {
  let n = 0;
  for (const w of words) for (const ch of w) if (/\p{L}|\p{N}/u.test(ch)) n++;
  return n;
}

interface TrieNode { children: Map<string, TrieNode>; hits: number[] }
const trieNode = (): TrieNode => ({ children: new Map(), hits: [] });

/** A name/alias/email_match-word/job-word longer than this many words is excluded from phrase
 * matching entirely (defence in depth): no real entry is anywhere near this long, and bounding it
 * keeps the per-token scan in `scanPhraseTrie` at a fixed worst-case depth regardless of how many
 * entries feed the trie or how they're shaped. Documented together with `MAX_PHRASE_CHARS` below,
 * since the two work as a pair: this one bounds trie *depth*, the other bounds the *tokenize() call
 * itself* ahead of building any trie entry. */
const MAX_PHRASE_WORDS = 20;
/** Fix round 1, item 2: a raw string longer than this is rejected by one cheap `.length` check
 * *before* ever calling `tokenize()` on it -- `buildPhraseTrie` already drops an entry whose
 * *tokenized* form exceeds `MAX_PHRASE_WORDS`, but by then the (potentially expensive) tokenize()
 * call has already run. A 10,000-character alias, repeated across 10,000 companies, is exactly the
 * hostile shape this guards: with this check, each one costs a single length comparison instead of
 * a full tokenize pass. 50 characters/word x `MAX_PHRASE_WORDS` is already a generous allowance --
 * no real company name or job word is anywhere close. */
const MAX_PHRASE_CHARS = MAX_PHRASE_WORDS * 50;

/**
 * A word-level trie over a list of (already-tokenized) phrases, each tagged with the index of the
 * candidate it came from. Building it costs `sum(words.length)` across every entry -- proportional
 * to the companies' own configured name/alias/email_match/job-word text, which is this app's local
 * data, not attacker input -- and is independent of the subject being scanned.
 */
function buildPhraseTrie(entries: string[][]): TrieNode {
  const root = trieNode();
  entries.forEach((words, idx) => {
    if (!words.length || words.length > MAX_PHRASE_WORDS) return;
    let node = root;
    for (const w of words) {
      let child = node.children.get(w);
      if (!child) {
        child = trieNode();
        node.children.set(w, child);
      }
      node = child;
    }
    node.hits.push(idx);
  });
  return root;
}

/**
 * Scans `tokens` against `root` and returns the indices of every phrase that appears as a
 * contiguous run of whole words somewhere in it. This is the heart of why subject/phrase matching
 * stays linear under hostile input (a 100k-character subject and 10,000 companies): for each start
 * position `i` the inner `while` only ever walks as deep as the trie goes (bounded by
 * `MAX_PHRASE_WORDS`, a small constant), *regardless of how many entries fed the trie* -- so the
 * tree-walk itself costs `O(tokens.length * MAX_PHRASE_WORDS)`, not `O(tokens.length *
 * entries.length)`.
 *
 * Fix round 1, item 2 (the second half of staying linear): when many entries share an identical
 * name (e.g. 10,000 companies literally all named "Acme"), they all land on the *same* trie node,
 * whose `hits` array then holds all 10,000 indices. Visiting that one node is cheap, but without the
 * `visited` guard below, every one of the (possibly tens of thousands of) subject positions where
 * "acme" occurs would re-copy the *entire* 10,000-entry `hits` array into `found` -- measured at
 * O(occurrences x hits-per-node) without the guard, which is quadratic in exactly this "many
 * identical names, many occurrences" shape. `visited` (a `Set` of trie-node references, reset once
 * per scan) ensures a given node's hits are ever copied into `found` once per scan, not once per
 * position reached -- bringing the total cost of all the `found.add` calls combined down to
 * `O(total candidates)`, matching the "O(tokens*depth + candidates)" the fix calls for.
 */
function scanPhraseTrie(tokens: string[], root: TrieNode): Set<number> {
  const found = new Set<number>();
  const visited = new Set<TrieNode>();
  for (let i = 0; i < tokens.length; i++) {
    let node = root.children.get(tokens[i]!);
    let depth = 0;
    while (node) {
      if (node.hits.length && !visited.has(node)) {
        visited.add(node);
        for (const idx of node.hits) found.add(idx);
      }
      depth++;
      if (depth >= MAX_PHRASE_WORDS || i + depth >= tokens.length) break;
      node = node.children.get(tokens[i + depth]!);
    }
  }
  return found;
}

/** A name/alias shorter than this, counting only letters/digits (see `letterDigitCount`), is never
 * matched against free text -- mirrors the brief's own minimum-length rule, so a one- or
 * two-letter name (or a name that's mostly punctuation, like "C++") can't match almost anything.
 * `email_match`/job-word phrase matching (`buildTaggedPhrases` below) uses this same threshold, but
 * against the *raw* trimmed string length instead -- deliberately not the letter/digit count,
 * since an entry like "C++" (3 raw characters) is meant to keep matching there exactly as the
 * brief's original `wholeWord` helper would (fix round 1, item 1's "C++" test), even though its
 * tokenized form has only one real letter and is therefore excluded from *name* matching. */
const MIN_NAME_LENGTH = 3;

/**
 * Finds the best (longest, per spec §3.2's "longest name wins" tie-break) company whose `coreName`
 * or any alias appears as a run of whole words somewhere in `text`. Shared by `matchCompany`'s rule
 * 5 (subject) and `suggestCompany` (subject + display name) so there is exactly one phrase-matching
 * implementation, with exactly one complexity story, rather than two call sites each independently
 * re-deriving "is this name whole-word-present" against potentially huge free text.
 *
 * Fix round 1, item 4: ties (two companies whose matched name is the same length) are broken by
 * which company comes first in `companies` -- *not* by which name happens to appear earlier in
 * `text`. `hits` (from `scanPhraseTrie`) is a `Set`, and iterating it directly would resolve ties by
 * subject-scan discovery order instead; iterating `candidates` (built in `companies` order) and
 * only consulting `hits` for membership keeps the tie-break tied to list order regardless of where
 * in the text each name was found.
 */
function bestNameMatch(companies: CompanyInfo[], text: string): { company: CompanyInfo; name: string } | null {
  const candidates: { company: CompanyInfo; name: string; words: string[] }[] = [];
  for (const c of companies) {
    for (const raw of [coreName(c.name), ...c.aliases]) {
      const name = raw.trim();
      if (!name.length || name.length > MAX_PHRASE_CHARS) continue;
      const words = tokenize(name);
      if (!words.length || letterDigitCount(words) < MIN_NAME_LENGTH) continue;
      candidates.push({ company: c, name, words });
    }
  }
  if (!candidates.length) return null;
  const trie = buildPhraseTrie(candidates.map((c) => c.words));
  const hits = scanPhraseTrie(tokenize(text), trie);
  let best: { company: CompanyInfo; name: string } | null = null;
  for (let idx = 0; idx < candidates.length; idx++) {
    if (!hits.has(idx)) continue;
    const cand = candidates[idx]!;
    if (!best || cand.name.length > best.name.length) best = { company: cand.company, name: cand.name };
  }
  return best;
}

/** Strips a trailing legal-entity suffix (optionally comma-separated), repeatedly, so e.g.
 * "Example Labs Pty Ltd" -> "Example Labs" and "Acme Corp" -> "Acme". Falls back to the trimmed
 * original if stripping would otherwise leave nothing (a name that is *only* "Pty Ltd" is not a
 * real company name, so there is nothing sensible to strip down to). */
const LEGAL = /\s*(?:,\s*)?\b(?:pty\.?\s*ltd\.?|pty|ltd\.?|limited|inc\.?|corp\.?|corporation|llc|plc|gmbh|group|australia)\s*$/i;
export function coreName(name: string): string {
  let out = name.trim();
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(LEGAL, "").trim();
  }
  return out || name.trim();
}

// --- tagged-phrase matching, shared by email_match words and job words (fix round 1, item 1) ------

/**
 * Builds (tokenized phrase, caller-supplied tag) pairs from a list of candidate strings, applying
 * the same `MAX_PHRASE_CHARS` cheap-length-first guard as `bestNameMatch`, and -- unless
 * `enforceMinLength` is explicitly false -- the brief's original raw-string-length gate
 * (`MIN_NAME_LENGTH`, counting every character, not just letters/digits -- see the doc on that
 * constant for why this differs from `bestNameMatch`'s gate). The `tag` lets many raw strings map
 * back to one caller-meaningful identity: `matchCompany`'s rule 4 tags every `email_match` word
 * with its owning company's index (several words, one company), and `isJobRelated` tags both the
 * singular and a pluralized ("...s") copy of each job word with that word's own index (one word,
 * two phrase variants).
 *
 * Fix round 2, item 1: `isJobRelated` passes `enforceMinLength: false` -- `job-senders.json`'s own
 * `words` list is short, locally-configured data (like a company's `email_match`), but unlike
 * `email_match`, a short, real job-related abbreviation (e.g. "CV", "HR") must still match: the gate
 * was silently dropping any such word below 3 characters before it ever reached the trie, a
 * regression this fix closes. `email_match` keeps the gate (`enforceMinLength` defaults to true),
 * since an `email_match` word that short is far more likely to be noise than a real company
 * identifier, and the brief's original `wholeWord` helper enforced this same length there.
 */
function buildTaggedPhrases(items: { tag: number; text: string }[], enforceMinLength = true): { entries: string[][]; tags: number[] } {
  const entries: string[][] = [];
  const tags: number[] = [];
  for (const { tag, text } of items) {
    const trimmed = text.trim();
    if ((enforceMinLength && trimmed.length < MIN_NAME_LENGTH) || trimmed.length > MAX_PHRASE_CHARS) continue;
    const words = tokenize(trimmed);
    if (!words.length) continue;
    entries.push(words);
    tags.push(tag);
  }
  return { entries, tags };
}

/** Returns every distinct `tag` whose phrase appears as a contiguous run of whole words somewhere in
 * `text` -- one trie build, one scan, regardless of how many `items` there are (see
 * `scanPhraseTrie`'s doc for the complexity story this relies on). Tolerant of punctuation the way
 * `tokenize` always is: an entry like "acme-labs" matches a subject containing "Acme Labs", since
 * both normalize to the same two-word token sequence (this is a deliberate, accepted broadening
 * beyond the brief's original literal-regex `wholeWord`, kept because the spec only asks for whole
 * words, not exact punctuation). `enforceMinLength` is forwarded to `buildTaggedPhrases` (fix round
 * 2, item 1). */
function phraseTagsInText(items: { tag: number; text: string }[], text: string, enforceMinLength = true): Set<number> {
  const { entries, tags } = buildTaggedPhrases(items, enforceMinLength);
  if (!entries.length) return new Set();
  const trie = buildPhraseTrie(entries);
  const hitEntries = scanPhraseTrie(tokenize(text), trie);
  const hitTags = new Set<number>();
  for (const i of hitEntries) hitTags.add(tags[i]!);
  return hitTags;
}

// --- counterparts (never the user's own address, never a display name) -----------------------------

/** The people a message is "with": the sender for incoming mail, the recipients (to + cc) for sent
 * mail. `own` (the user's own address, case-insensitively) is always excluded -- your own address
 * can never count as a counterpart, so e.g. a company whose `recruiter_email` happens to equal
 * `own` can never match through this path. Only `.address` is ever read here (and by everything
 * downstream that consumes this list); `.name` (a display name) is never used for matching. */
export function counterparts(h: HeaderInfo, own = ""): EmailAddress[] {
  const list = h.direction === "in" ? [h.from] : [...h.to, ...h.cc];
  const ownLc = lc(own);
  return list.filter((a) => !ownLc || lc(a.address) !== ownLc);
}

// --- company / job matching --------------------------------------------------------------------

/**
 * Matching order per spec §3.2, first hit wins, each rule checked across every company before
 * moving to the next: (1) `recruiter_email`; (2) an address in `email_match`; (3) a counterpart's
 * domain equal to or under the company website's domain (never a free-mail or job-board domain);
 * (4) a domain or whole-word *phrase* in `email_match`; (5) the company name (legal suffix
 * stripped) or an alias, as whole words in the subject, longest name wins. Display names are never
 * consulted.
 *
 * Performance note (hostile input: a 100k-char subject, 10k companies, up to 10k x 100 email_match
 * domains): rules 1-3 only ever do cheap, pre-normalized string/Set work per company (counterpart
 * domains are normalized once, up front, not once per company or per email_match entry -- fix round
 * 1, item 2). Rule 4's domain-type `email_match` entries are each normalized exactly once per call
 * (not once per counterpart -- same fix), and its word-type entries, plus rule 5, are each answered
 * by a single shared trie scan over the subject, not a re-test per company (see `phraseTagsInText`/
 * `bestNameMatch`). See match.test.ts's timing-guard tests for measured bounds.
 */
export function matchCompany(h: HeaderInfo, companies: CompanyInfo[], own = ""): { company: CompanyInfo; matched_by: EmailMatchKind } | null {
  const people = counterparts(h, own).map((a) => lc(a.address));
  const normDomains = [...new Set(people.map(domainOf).filter(Boolean))];
  // System mail (no-reply, notifications, account notices) says nothing about who the company is: a
  // platform's own account mail must never file itself under that platform as an employer. So it never
  // matches by domain, and only matches a company that owns the sending domain when the subject names one
  // of that company's jobs. The addresses the user set up by hand (rules 1 and 2) still count.
  const system = people.length > 0 && people.every(isSystemAddress);

  const byRecruiter = companies.find((c) => !!c.recruiter_email && people.includes(lc(c.recruiter_email)));
  if (byRecruiter) return { company: byRecruiter, matched_by: "recruiter" };

  const byAddress = companies.find((c) => c.email_match.some((m) => m.includes("@") && people.includes(lc(m))));
  if (byAddress) return { company: byAddress, matched_by: "email_match" };

  const byDomain = system ? undefined : companies.find((c) => {
    const d = websiteDomain(c.website);
    return !!d && !isFreemailDomain(d) && !isBoardDomain(d) && normDomains.some((x) => x === d || x.endsWith(`.${d}`));
  });
  if (byDomain) return { company: byDomain, matched_by: "domain" };

  const byAgencyAddress = companies.find((c) => !!c.agency_addresses?.some((a) => people.includes(a)));
  if (byAgencyAddress) return { company: byAgencyAddress, matched_by: "email_match" };

  // Rule 4: a domain or whole-word phrase in email_match. Word-type entries (no "@", no ".") are
  // gathered across *every* company and answered by a single shared phrase scan over the subject
  // (fix round 1, items 1 and 2); domain-type entries are checked per company, but each is
  // normalized only once (not once per counterpart in `normDomains`).
  const wordEntries: { tag: number; text: string }[] = [];
  companies.forEach((c, ci) => {
    for (const m of c.email_match) {
      if (!m.includes("@") && !m.includes(".")) wordEntries.push({ tag: ci, text: m });
    }
  });
  const wordHitCompanies = phraseTagsInText(wordEntries, h.subject);
  const byWord = companies.find((c, ci) => {
    if (wordHitCompanies.has(ci)) return true;
    return !system && c.email_match.some((m) => {
      if (m.includes("@") || !m.includes(".")) return false;
      const mb = toAsciiDomain(m);
      // A whole free-mail or job-board domain never counts: only an exact address there can (rule 2).
      return !!mb && normDomains.some((x) => x === mb || x.endsWith(`.${mb}`)) && !isFreemailDomain(mb) && !isBoardDomain(mb);
    });
  });
  if (byWord) return { company: byWord, matched_by: "email_match" };

  const named = companies.filter((c) => !c.agency_only);
  const candidates = system ? named.filter((c) => !ownsDomain(c, normDomains) || jobByTitle(c, h.subject) !== "") : named;
  const byName = bestNameMatch(candidates, h.subject);
  return byName ? { company: byName.company, matched_by: "subject" } : null;
}

/**
 * Local parts that a machine sends from, never a person: no-reply, notification, alert, account and bounce
 * senders, with any prefix or suffix tag ("noreply-accounts", "jobs-noreply", "notifications+abc").
 * Recruiting mailboxes a person reads (careers@, talent@, jobs@, hr@, recruiting@, info@) are not in it.
 */
const SYSTEM_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|alerts?|accounts?|account[-_.]?security|security[-_.]?alerts?|security)(?:[-_.+].*)?$/i;
const SYSTEM_TAG = /(?:^|[-_.+])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?)(?:[-_.+]|$)/i;

/** True for an automated sender address (see `SYSTEM_LOCAL`). Only the address is read, never a display name. */
export function isSystemAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  const local = (at < 0 ? address : address.slice(0, at)).trim();
  return !!local && (SYSTEM_LOCAL.test(local) || SYSTEM_TAG.test(local));
}

/** Whether one of the (normalized) sender domains is the company's own: its website, or a domain in email_match. */
function ownsDomain(c: CompanyInfo, normDomains: string[]): boolean {
  const own = [websiteDomain(c.website), ...c.email_match.filter((m) => !m.includes("@") && m.includes(".")).map(toAsciiDomain)].filter(Boolean);
  return own.some((d) => normDomains.some((x) => x === d || x.endsWith(`.${d}`)));
}

const titleWords = (title: string): string[] => [...new Set(tokenize(title).filter((w) => w.length >= 2 && !STOP.has(w)))];

/** The job whose title words all appear in the subject (most words wins, most recent breaks a tie), or "". */
function jobByTitle(c: CompanyInfo, subject: string): string {
  const subjectWords = new Set(tokenize(subject));
  const byTitle = c.jobs
    .map((j) => ({ j, words: titleWords(j.title) }))
    .filter((x) => x.words.length > 0 && x.words.every((w) => subjectWords.has(w)))
    .sort((a, b) => b.words.length - a.words.length || b.j.last_activity.localeCompare(a.j.last_activity));
  return byTitle[0]?.j.id ?? "";
}

/** The only job if there's just one; else the job whose title words all appear in the subject (most
 * words wins, most recent breaks a tie); else the most recently active job (Applying/Applied/
 * Interview); else "" (the company folder itself, no specific job). */
export function pickJob(c: CompanyInfo, subject: string): string {
  if (c.jobs.length === 1) return c.jobs[0]!.id;
  const byTitle = jobByTitle(c, subject);
  if (byTitle) return byTitle;
  const active = c.jobs.filter((j) => ACTIVE.has(j.status)).sort((a, b) => b.last_activity.localeCompare(a.last_activity));
  return active[0]?.id ?? "";
}

export function matchMessage(h: HeaderInfo, companies: CompanyInfo[], own = ""): MatchResult | null {
  const m = matchCompany(h, companies, own);
  return m ? { company_slug: m.company.slug, job_id: pickJob(m.company, h.subject), matched_by: m.matched_by } : null;
}

// --- job-related rule (editable data, data/job-senders.json) ----------------------------------------

/** True if the message looks job-related: a counterpart on a known job-board/ATS domain, or a job
 * word or phrase (optionally pluralized, e.g. "interview"/"interviews", "job offer"/"job offers") as
 * a whole-word run in the subject. Used to route mail that didn't match any known company (see
 * Inbox-Triage in the project's mail workflow) without ever substring-matching inside an unrelated
 * word (e.g. "role" inside "Controller" or "rolex") -- the subject is tokenized into whole words
 * first, so a token either equals a job word (or that word plus one trailing "s") or it doesn't.
 * Fix round 1, item 1: a multi-word or hyphenated job phrase ("job offer", "follow-up") is matched
 * as a contiguous phrase via the same shared trie/scan machinery as rule 4's email_match words, not
 * a single-token Set lookup (which could never match a phrase containing a space or hyphen at all).
 */
export function isJobRelated(h: HeaderInfo, list: JobSenders = JOB_SENDERS): boolean {
  const boardDomains = list.domains.map(toAsciiDomain).filter(Boolean);
  const onBoard = counterparts(h).some((a) => {
    const d = domainOf(a.address);
    return boardDomains.some((bd) => d === bd || d.endsWith(`.${bd}`));
  });
  if (onBoard) return true;
  const phraseItems = list.words.flatMap((w, i) => {
    const trimmed = w.trim();
    return [{ tag: i, text: trimmed }, { tag: i, text: `${trimmed}s` }];
  });
  return phraseTagsInText(phraseItems, h.subject, false).size > 0;
}

/** A soft suggestion for mail that didn't match any known company outright: first, whether the
 * sender's domain looks like it was built from the company's name (e.g.
 * "examplelabs-mail.example.org" from "Example Labs Pty Ltd"); failing that, whether the company's
 * name is mentioned as whole words in the subject or the sender's *display name* (unlike
 * `matchCompany`, a display name is fair game here -- this is a suggestion for a human to confirm,
 * not an automatic match). Returns the single best (longest name, ties broken by list order --
 * see `bestNameMatch`) suggestion, or null.
 *
 * Fix round 1, item 6: reusing `bestNameMatch` here means this path also considers aliases and
 * picks the *longest* matching name rather than the first company found in list order, which is a
 * small, deliberate deviation from a simpler "first mention wins" reading of the original spec --
 * accepted so there is exactly one phrase-matching implementation (and one complexity story) in
 * this module rather than a second, parallel one just for suggestions. */
export function suggestCompany(h: HeaderInfo, all: CompanyInfo[]): { company_slug: string; company_name: string; reason: string } | null {
  const companies = all.filter((c) => !c.agency_only);
  const domain = domainOf(h.from.address).replace(/[^a-z0-9]/g, "");
  for (const c of companies) {
    const squashed = coreName(c.name).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (squashed.length >= 4 && domain.includes(squashed)) {
      return { company_slug: c.slug, company_name: c.name, reason: `The sender's domain looks like ${c.name}.` };
    }
  }
  const named = bestNameMatch(companies, `${h.subject} ${h.from.name}`);
  return named ? { company_slug: named.company.slug, company_name: named.company.name, reason: `The email mentions ${named.company.name}.` } : null;
}

// --- ignore list ---------------------------------------------------------------------------------

export function isIgnored(address: string, ignore: IgnoreList): boolean {
  const a = lc(address);
  if (ignore.senders.some((s) => lc(s) === a)) return true;
  const d = domainOf(a);
  return ignore.domains.some((base) => domainMatches(d, base));
}

/**
 * Whether a domain (or an address's domain) may be linked to a company or agency as a whole: not free mail (gmail,
 * outlook, yahoo, icloud and the rest, with country variants) and not a job board. Only an exact address may be
 * linked there.
 */
export function linkableDomain(domainOrAddress: string): boolean {
  const d = domainOrAddress.includes("@") ? domainOf(domainOrAddress) : toAsciiDomain(domainOrAddress);
  return !!d && d.includes(".") && !isFreemailDomain(d) && !isBoardDomain(d);
}
