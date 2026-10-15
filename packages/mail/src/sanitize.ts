/// <reference path="./vendor-types.d.ts" />
import sanitizeHtml from "sanitize-html";

export const MAIL_FRAME_CSP = "default-src 'none'; img-src careeros-mail: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export interface MailLink { href: string; text: string }
export interface SanitizedBody { html: string; remoteImages: string[]; links: MailLink[]; simplified: boolean }

const TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em", "font",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "small", "span", "strike",
  "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul",
];
const CELL = ["align", "valign", "width", "height", "colspan", "rowspan", "bgcolor", "nowrap"];
const ATTRS: Record<string, string[]> = {
  "*": ["style", "align", "dir", "lang", "title"],
  a: ["href"], img: ["src", "alt", "width", "height"], font: ["color", "size", "face"],
  table: ["width", "height", "border", "cellpadding", "cellspacing", "bgcolor", "align"], td: CELL, th: CELL, tr: ["align", "valign", "bgcolor"],
  col: ["span", "width"], colgroup: ["span", "width"], ol: ["start", "type"], li: ["value"],
};
/** Plain words, numbers, colours and rgb()/hsl() only: no url(), no other functions, no escapes, braces or at-rules. */
const SAFE_VALUE = /^(?=[\s\S]{0,200}$)(?:[-#%,.\s\w"'/!+]|(?:rgba?|hsla?)\([\d\s.,%/]*\))*$/i;
const STYLE_PROPS = [
  "color", "background", "background-color", "font", "font-size", "font-weight", "font-style", "font-family", "text-align", "text-decoration",
  "text-transform", "line-height", "letter-spacing", "white-space", "word-break", "overflow-wrap", "vertical-align", "display",
  "width", "min-width", "max-width", "height", "min-height", "max-height", "list-style-type", "table-layout", "border-collapse", "border-spacing",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-width", "border-style", "border-radius",
];
const STYLES = { "*": Object.fromEntries(STYLE_PROPS.map((p) => [p, [SAFE_VALUE]])) };
const DATA_IMAGE = /^data:image\/(?:png|gif|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const SCHEME = "careeros-mail://";
/** Bound how much input we ever feed the parser; see the cap note below sanitizeEmailHtml. */
const MAX_HTML_LENGTH = 2_000_000;
const MAX_TEXT_LENGTH = 1_000_000;
/** See the comment where this is used, in the simplified-fallback branch of
 * sanitizeEmailHtml: a tighter cap than MAX_TEXT_LENGTH, specifically for the one path where
 * escaping can multiply the character count before it's resanitized. */
const MAX_FALLBACK_TEXT_LENGTH = 100_000;
const MAX_LINKS = 2000;
const MAX_REMOTE_IMAGES = 2000;
/** Above either limit, sanitizeHtml's own parsing cost grows roughly quadratically with
 * nesting *depth* specifically (measured: ~400k nested divs in 2 MB took ~74s; 30k nested
 * table/tr/td took ~5.3s) - cheap for an attacker to send, expensive for us to parse. Tag
 * *count* alone isn't the problem (a flat run of thousands of void elements is cheap), which
 * is why this is high: it's a sanity ceiling, not the thing actually doing the work. */
const MAX_OPEN_TAGS = 20_000;
const MAX_NESTING_DEPTH = 500;
/** Independent of tag validity: a flood of '<' that never forms a recognised tag (round 2,
 * item 8) is still something we'd rather not hand to sanitizeHtml's own tokenizer at scale. */
const MAX_LT_COUNT = 100_000;
/** A single pathologically large `style="..."` value (round 2, item 8 - "199k style
 * declarations" was the reviewer's benchmark) makes postcss's parse of that one attribute
 * slow, regardless of how small and shallow the rest of the document is - tag/depth counting
 * alone can't see this, so it's checked separately. */
const MAX_STYLE_ATTR_CHARS = 8 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
// Elements that are never closed in real HTML, so counting them as "open" nesting would be
// wrong: 600 plain <br> or <img> tags in a row is flat, ordinary mail content, not depth.
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const STYLE_ATTR_RE = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function httpsUrl(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

const decode = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

/**
 * Linear, single-pass tag counter used only to decide whether `html` is cheap enough to hand
 * to sanitizeHtml. It does not need to understand HTML correctly (unclosed tags, comments are
 * all treated loosely) - it only needs to be conservative: never take more than O(n) time, and
 * never say "simple" about something that would actually be expensive to parse.
 *
 * Guaranteed linear: `i` only ever advances to a position found by `indexOf` searching
 * forward from the current position, so each character of `html` is visited by at most one
 * `indexOf("<", ...)` scan and one `indexOf(">", ...)` scan across the entire run - there is
 * no backtracking and no per-position retry, which is what makes a naive "find next '<'/'>'"
 * approach quadratic on adversarial input (e.g. a '<' at every position with no closing '>').
 * If a '>' can't be found for some '<', there cannot be another complete tag anywhere after
 * it either, so the scan stops immediately rather than retrying.
 *
 * Void elements (`VOID_ELEMENTS`) never increase `depth`, whether or not they're written with
 * a self-closing `/>`: 600 bare `<br>` or `<img>` tags are flat mail content, not 600 levels
 * of nesting, and must not be simplified away. They still count toward `openCount` - a flood
 * of 20,001 of them is still something we'd rather not hand to sanitizeHtml.
 */
function isTooComplex(html: string): boolean {
  let depth = 0;
  let maxDepth = 0;
  let openCount = 0;
  let totalLt = 0;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    totalLt++;
    if (totalLt > MAX_LT_COUNT) return true;
    let j = lt + 1;
    const closing = html[j] === "/";
    if (closing) j++;
    const c = j < n ? html[j] : "";
    if (!/[a-zA-Z]/.test(c)) { i = lt + 1; continue; } // comment, doctype, stray '<': not a tag we count
    let k = j;
    while (k < n && /[a-zA-Z0-9]/.test(html[k]!)) k++;
    const name = html.slice(j, k).toLowerCase();
    const gt = html.indexOf(">", j);
    if (gt === -1) break; // no more complete tags possible anywhere after this point
    const selfClosing = html[gt - 1] === "/";
    const isVoid = VOID_ELEMENTS.has(name);
    if (closing) {
      if (depth > 0) depth--;
    } else {
      openCount++;
      if (openCount > MAX_OPEN_TAGS) return true;
      if (!selfClosing && !isVoid) {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
        if (maxDepth > MAX_NESTING_DEPTH) return true;
      }
    }
    i = gt + 1;
  }
  return false;
}

/**
 * A single `style="..."` (or `style='...'`) value longer than `MAX_STYLE_ATTR_CHARS`, found
 * anywhere in `html`. One pass with a global regex - the `[^"]*`/`[^']*` groups are a simple
 * negated-class scan (no backtracking), so even a 2 MB single attribute value is one linear
 * scan, not a slow postcss parse. False positives (literal text that happens to look like
 * `style="..."`, outside any real tag) just route to the simplified fallback, which is safe.
 */
function hasOversizedStyleAttr(html: string): boolean {
  for (const m of html.matchAll(STYLE_ATTR_RE)) {
    const value = m[1] ?? m[2] ?? "";
    if (value.length > MAX_STYLE_ATTR_CHARS) return true;
  }
  return false;
}

/**
 * Linear fallback used only when `isTooComplex`/`hasOversizedStyleAttr` reject the input:
 * drop every `<...>` span (tags, comments, doctypes - whatever looks like markup) and keep the
 * rest as plain text, so `textToHtml` can escape and auto-link it safely. Same indexOf-based
 * scan as `isTooComplex`, so it's linear for the same reason; anything this misses (e.g. a
 * bare '<' used as "less than" rather than markup) is not a security concern, since
 * `textToHtml` HTML-escapes whatever comes out of here regardless.
 */
function stripTagsLinear(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) { out += html.slice(lt); break; } // no closing '>' left: keep the remainder as text
    i = gt + 1;
  }
  return out;
}

/**
 * Runs the actual allow-list sanitization (shared by the normal path and the simplified
 * fallback, round 2 item 2): every `https:` link becomes a numbered
 * `careeros-mail://link/<token>/<n>` placeholder and is recorded in `links`, `cid:`/`https:`
 * images are rewritten the same way regardless of which path produced `html`. Running the
 * fallback's (flat, already-escaped) output back through this is cheap: it's `<pre>` plus a
 * handful of `<a>` tags, no nesting to speak of.
 */
function runSanitize(html: string, token: string, imagesAllowed: boolean): { html: string; remoteImages: string[]; links: MailLink[] } {
  const remoteImages: string[] = [];
  const links: MailLink[] = [];
  const out = sanitizeHtml(html, {
    allowedTags: TAGS,
    allowedAttributes: ATTRS,
    allowedSchemes: [],
    allowedSchemesByTag: { a: ["careeros-mail"], img: ["careeros-mail", "data"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: false,
    allowedStyles: STYLES,
    parseStyleAttributes: true,
    disallowedTagsMode: "discard",
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "title", "head", "template", "xmp"],
    enforceHtmlBoundary: true,
    transformTags: {
      a: (_tag, attribs) => {
        const { href = "", target: _t, rel: _r, ...rest } = attribs;
        const url = httpsUrl(href.trim());
        if (!url || links.length >= MAX_LINKS) return { tagName: "a", attribs: rest };
        links.push({ href: url, text: "" });
        return { tagName: "a", attribs: { ...rest, href: `${SCHEME}link/${token}/${links.length - 1}` } };
      },
      img: (_tag, attribs) => {
        const { src = "", srcset: _s, ...rest } = attribs;
        const s = src.trim();
        if (/^cid:/i.test(s)) {
          const id = s.slice(4).replace(/^<|>$/g, "");
          const encoded = encodeURIComponent(id).replace(/\./g, "%2E");
          return { tagName: "img", attribs: { ...rest, src: `${SCHEME}cid/${token}/${encoded}` } };
        }
        const url = httpsUrl(s);
        if (url) {
          if (remoteImages.length >= MAX_REMOTE_IMAGES) return { tagName: "img", attribs: rest };
          remoteImages.push(url);
          const n = remoteImages.length - 1;
          return { tagName: "img", attribs: imagesAllowed ? { ...rest, src: `${SCHEME}img/${token}/${n}` } : rest };
        }
        return { tagName: "img", attribs: DATA_IMAGE.test(s) ? { ...rest, src: s } : rest };
      },
    },
  });
  // The visible text of each rewritten link, for the "this link goes somewhere else" warning.
  // Ignorable (invisible) characters are stripped *before* the length cap (round 2, item 4):
  // slicing first would let e.g. 300 zero-width characters consume the whole budget and push
  // the real "paypal.com" out of the stored text before anyone gets a chance to see it.
  const re = new RegExp(`<a[^>]*href="careeros-mail://link/${token}/(\\d+)"[^>]*>([\\s\\S]*?)</a>`, "g");
  for (const m of out.matchAll(re)) {
    const link = links[Number(m[1])];
    if (link && !link.text) link.text = decode(m[2] ?? "").replace(IGNORABLE, "").slice(0, MAX_LINK_TEXT);
  }
  return { html: out, remoteImages, links };
}

/**
 * Turns hostile email HTML into a small allow-listed subset. Every `https:` link is
 * rewritten to a numbered `careeros-mail://link/<token>/<n>` placeholder (the viewer
 * resolves `n` against `links`); every other scheme loses its `href`/`src` outright.
 * `cid:` images become `careeros-mail://cid/<token>/<content-id>`, with every `.` in the
 * content id percent-encoded (in addition to everything else `encodeURIComponent` already
 * escapes) so an id of only dots - e.g. `cid:..` - can never turn into a `..` path segment
 * wherever the viewer resolves this URL. `https:` images are always counted in
 * `remoteImages` (so the viewer can offer "show images") but only get a
 * `careeros-mail://img/<token>/<n>` source when `imagesAllowed` is true - otherwise the
 * `src` is dropped and nothing is fetched. `data:` images are kept only for the four
 * raster formats a mail client actually needs; `data:image/svg+xml` and anything else is
 * refused, since SVG can carry script and foreignObject/HTML content.
 *
 * Inline styles are filtered through a property allow-list whose values must match
 * `SAFE_VALUE`: plain words, numbers, `%`, punctuation used in colours/measurements, and
 * `rgb()/rgba()/hsl()/hsla()` only. No other function syntax, no backslash escapes, no
 * braces and no `@` survive, which rules out `url(...)`, `expression(...)`, `@import` and
 * escape-obfuscated property values. `<style>` elements (and `<script>`, and everything
 * else outside the tag allow-list) are discarded together with their content.
 *
 * The input is capped at `MAX_HTML_LENGTH` (2 MB) before it reaches the parser. Real
 * mail bodies are a few KB to a few hundred KB; multi-megabyte "HTML" is either a
 * generated report nobody will read in a viewer frame or an attempt to make the parser
 * do a lot of needless work, so we simply truncate rather than let sanitize-html run
 * over the whole thing. Even within that 2 MB, three other shapes can make sanitizeHtml
 * (or its style parsing) slow: nesting deeper than `MAX_NESTING_DEPTH`, more than
 * `MAX_OPEN_TAGS` tags, more than `MAX_LT_COUNT` '<' characters (whether or not they form
 * real tags), or any single `style` attribute over `MAX_STYLE_ATTR_CHARS`. Any of those
 * skip `sanitizeHtml` entirely and fall back to plain text, with `simplified: true` so the
 * viewer can tell the user why. The fallback's output still goes through the exact same
 * link/image rewriting as the normal path (via `runSanitize`, round 2 item 2) - a
 * `simplified: true` result still has its `https:` links in `links[]` and rewritten to
 * `careeros-mail://link/...`, not raw `<a href="https://...">`.
 *
 * `opts.token` is asserted to match `/^[A-Za-z0-9_-]+$/` (and the function throws
 * otherwise): it is spliced unescaped into every `careeros-mail://.../<token>/...` URL
 * this function produces, so a token containing e.g. `/` could let a caller-supplied value
 * reshape those URLs instead of just identifying the message.
 */
export function sanitizeEmailHtml(input: string, opts: { token: string; imagesAllowed: boolean }): SanitizedBody {
  if (!TOKEN_RE.test(opts.token)) throw new Error(`sanitizeEmailHtml: invalid token ${JSON.stringify(opts.token)}`);
  const capped = input.slice(0, MAX_HTML_LENGTH);
  if (isTooComplex(capped) || hasOversizedStyleAttr(capped)) {
    // Bounded separately from MAX_TEXT_LENGTH: stripTagsLinear doesn't shrink input that has
    // no closing '>' anywhere (there's nothing for it to recognise as a tag to discard), so a
    // pathological "mostly '<'" message can still be ~MAX_HTML_LENGTH characters after
    // stripping. Escaping that for display can grow it 4x ('<' -> '&lt;'), and resanitizing
    // the result (below) costs roughly linear time in that size - so it's capped tighter here
    // than the general plain-text cap, specifically for this already-degenerate path.
    const stripped = stripTagsLinear(capped).slice(0, MAX_FALLBACK_TEXT_LENGTH);
    const flat = textToHtml(stripped);
    return { ...runSanitize(flat, opts.token, opts.imagesAllowed), simplified: true };
  }
  return { ...runSanitize(capped, opts.token, opts.imagesAllowed), simplified: false };
}

// One pass over the input length (not four, each over a string that may have grown from the
// previous replace) - matters for the degenerate "almost entirely '<'" case the simplified
// fallback can hand this, where 4 sequential whole-string replaces would each be scanning an
// already-expanded string.
const ESC_RE = /[&<">]/g;
const ESC_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(ESC_RE, (c) => ESC_MAP[c]!);

const URL_SPAN = /https:\/\/[^\s<>"']+/g;
const TRAILING_PUNCT = ".,;:!?)]'";
/** A URL longer than this is vanishingly unlikely to be real; capping it bounds both the
 * work `trimTrailingPunctuation` does and the size of the href we ever emit (round 2, item 1).
 * Anything past the cap falls through to the next loop iteration as ordinary escaped text. */
const MAX_URL_SPAN = 2048;

/**
 * Trims trailing sentence punctuation that a `https://...` regex match swept up along with
 * the URL (e.g. the ")." in "(see https://x/y)."), while keeping a trailing ")" that closes a
 * "(" actually inside the URL (e.g. a MediaWiki-style "https://en.example.org/wiki/x_(y)").
 *
 * The paren counts are computed ONCE up front and then decremented as each trailing ")" is
 * removed (round 2, item 1): the previous version recounted `(`/`)` over the whole remaining
 * string on every iteration, which is O(n) work per trim and O(n²) overall - a URL followed by
 * 40,000 ')' took ~39s. This version is a single O(n) count plus O(k) trims (k = characters
 * actually removed), so the same input is linear.
 */
function trimTrailingPunctuation(raw: string): string {
  const url = raw.length > MAX_URL_SPAN ? raw.slice(0, MAX_URL_SPAN) : raw;
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < url.length; i++) {
    if (url[i] === "(") opens++;
    else if (url[i] === ")") closes++;
  }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1]!;
    if (!TRAILING_PUNCT.includes(last)) break;
    if (last === ")") {
      if (opens >= closes) break; // this ")" closes a "(" that's part of the URL: keep it
      closes--; // about to trim this ")": it no longer counts
    }
    end--;
  }
  return url.slice(0, end);
}

/**
 * Escapes plain text, keeps line breaks via `<pre>`, and links bare `https://` addresses so
 * they go through the same sanitizer/rewriter as HTML mail. URLs are found in the raw text
 * *before* escaping (stopping at `<`, `>`, `"`, `'` and whitespace) and trimmed of trailing
 * punctuation before anything is escaped, so a URL written as "<https://x/y>" or "(https://x/y)."
 * doesn't swallow the surrounding bracket/punctuation into the link (escaping first, then
 * matching, would turn the real `<`/`>` into `&lt;`/`&gt;`, which no longer stop the match -
 * that was the bug this avoids). Each matched span is capped at `MAX_URL_SPAN` before trimming
 * runs; whatever's past the cap falls through as ordinary escaped text on the next iteration.
 */
export function textToHtml(text: string): string {
  const capped = text.slice(0, MAX_TEXT_LENGTH);
  let out = "";
  let cursor = 0;
  for (const m of capped.matchAll(URL_SPAN)) {
    const start = m.index ?? 0;
    const url = trimTrailingPunctuation(m[0]);
    out += esc(capped.slice(cursor, start));
    out += `<a href="${esc(url)}">${esc(url)}</a>`;
    cursor = start + url.length;
  }
  out += esc(capped.slice(cursor));
  return `<pre>${out}</pre>`;
}

/**
 * The full document served to the sandboxed mail-viewer frame. `MAIL_FRAME_CSP` is
 * embedded as a `<meta>` tag (the frame is also sandboxed and served this CSP as a real
 * header where the transport supports it; the meta tag is the floor for anywhere that
 * isn't possible). There are no `<script>` tags and nothing in `bodyHtml` can break out
 * of the document: `sanitizeEmailHtml` already stripped `<html>`/`<head>`/`<body>` (they
 * are not in the tag allow-list, and `enforceHtmlBoundary` additionally resets parsing
 * state if a literal `<html>` sneaks in), so `bodyHtml` can only contain the allow-listed
 * inline tags placed inside this function's own `<body>`.
 */
export function renderMailDocument(bodyHtml: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${MAIL_FRAME_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    "<style>html{color-scheme:light}body{margin:0;padding:1rem;background:white;color:black;font:0.9375rem/1.5 system-ui,sans-serif;overflow-wrap:anywhere}",
    "img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap;font:inherit;margin:0}a{color:LinkText}",
    // In a narrow reader, fixed-width layout tables (width="600") shrink to fit instead of being cut off.
    "@media (max-width:680px){body{padding:0.75rem}table[width]{width:100%!important}td[width],th[width]{width:auto!important}img{height:auto!important}}</style>",
    `</head><body>${bodyHtml}</body></html>`,
  ].join("");
}

// U+3002 IDEOGRAPHIC FULL STOP, U+FF0E FULLWIDTH FULL STOP, U+FF61 HALFWIDTH IDEOGRAPHIC FULL
// STOP: all three render as "a dot between two labels" and are accepted by real IDN hosts,
// so "paypal。com" is a plausible rendering of "paypal.com" and must be matched as such.
// U+2024 ONE DOT LEADER and U+FE52 SMALL FULL STOP are instead handled by NFKC normalisation
// below (both decompose to U+002E), which also mops up a wide range of other compatibility
// look-alikes for free.
const FULLWIDTH_DOT = /[。．｡]/g;
// "Defanged" forms security tools and attackers alike sometimes write instead of a literal
// dot, specifically to dodge naive auto-linkers: "paypal[.]com", "paypal(.)com".
// "paypal . com" (space-separated) is a known miss - deliberately not handled, since a bare
// "." surrounded by word-boundary spaces is indistinguishable from ordinary sentence
// punctuation ("Visit paypal . com please") without much higher false-positive risk.
const DEFANGED_DOT = /\[\.\]|\(\.\)/g;
// Zero-width spaces/joiners, variation selectors, bidi controls, and anything else with the
// Default_Ignorable_Code_Point property: characters a renderer shows as nothing, so
// "paypal​.com" displays identically to "paypal.com" and must match the same way. Same
// property and reasoning as `redact.ts`'s `INVISIBLE`.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
// Link/anchor text is a few words at most in every legitimate case; this is just a linear-time
// guarantee against a pathological caller, not something real mail is expected to hit.
const MAX_LINK_TEXT = 10_000;
// A run of letters (any script - IDN hosts aren't ASCII-only), digits, dots and hyphens: the
// same "ends at any character outside [a-z0-9.-]" boundary the ruling specifies, generalised
// to \p{L}/\p{N} so a unicode homoglyph host in the text is captured as one token rather than
// split apart by its non-ASCII characters. "@" is deliberately not in this class, so a
// "decoy@realhost" userinfo trick in the text is always two separate tokens - the decoy before
// "@" and the real host after it - and either one mismatching the href is caught.
const HOST_TOKEN = /[\p{L}\p{N}.-]+/gu;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Normalises NFKC compatibility look-alikes (covers U+2024, U+FE52 and many others),
 * look-alike dot characters, and "defanged" dot forms, strips invisible formatting
 * characters, then caps the length - in that order, so padding the text with thousands of
 * invisible (or merely visible: 160 repeats of "x " is just as effective) characters can't be
 * used to push real content past the cap. */
function normalizeForHostScan(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(DEFANGED_DOT, ".").replace(FULLWIDTH_DOT, ".").replace(IGNORABLE, "").slice(0, MAX_LINK_TEXT);
}

/** Loose dotted-quad check (not range-validating beyond 0-255 per octet): good enough to tell
 * "this token is a real IPv4 literal" (whose last "label" is legitimately all-digits) apart
 * from "this token just happens to contain digits and dots". */
function isIPv4(token: string): boolean {
  const m = IPV4.exec(token);
  if (!m) return false;
  return m.slice(1, 5).every((part) => Number(part) <= 255);
}

/** Round 2, item 6: a token like "2.0" (from "Version 2.0") or "e.g" (from "e.g.") would
 * otherwise be accepted as host-like - `new URL` happily parses both as hostnames (and even
 * expands "2.0" to the IPv4 "2.0.0.0") - and falsely warn against an unrelated link. Requiring
 * the last label to carry at least two letters (unless the whole token is a real IPv4 literal,
 * whose last octet is legitimately numeric) rules out both without rejecting real hosts: every
 * real TLD and every real last DNS label in our other test cases has 2+ letters. */
function hasPlausibleHostShape(token: string): boolean {
  if (isIPv4(token)) return true;
  const lastLabel = token.slice(token.lastIndexOf(".") + 1);
  const letters = (lastLabel.match(/\p{L}/gu) ?? []).length;
  return letters >= 2;
}

/** Registrable-domain-ish comparison: `shown` is treated as naming `target` when they're equal,
 * equal modulo a leading "www.", or `target` is a subdomain of `shown`. No public-suffix-list
 * lookup - this is deliberately approximate, matching the existing (already-tested) behaviour
 * for e.g. "jobs.example.com" text against an "apply.jobs.example.com" link. */
function namesTarget(target: string, shown: string): boolean {
  const bare = shown.replace(/^www\./, "");
  return target === shown || target === bare || target.endsWith(`.${bare}`);
}

/**
 * Warns when the visible text of a link names a host that differs from where the link
 * actually goes. Deliberately simple and over-eager (false positives are cheap; a missed
 * mismatch is not):
 *
 * - The text is scanned for ALL host-like tokens (`HOST_TOKEN`), not just the first one found
 *   so prose like "evil.example then paypal.com" or a decoy-studded "paypal.com-login" is
 *   still caught even when some other token in the same text happens to match the real host.
 * - A token must contain at least one "." and have a plausible last label
 *   (`hasPlausibleHostShape`) to count as host-like - this is what keeps "Version 2.0" and
 *   "e.g." from being treated as hosts. Trailing "."/"-" are trimmed first (`SAFE_VALUE`'s
 *   "ends at any character outside [a-z0-9.-]" boundary means a token like "paypal.com." or
 *   "paypal.com," is still recognised as naming paypal.com).
 * - Each surviving token is passed through `new URL("https://" + token + "/").hostname`,
 *   which performs the same IDN-to-ASCII (punycode) normalisation the href side already gets,
 *   so a unicode look-alike host compares correctly either direction.
 * - The href's own host is normalised the same way (`new URL(href).hostname`, which is always
 *   the part after any userinfo - a decoy placed before "@" in the href itself never fools
 *   this), lowercased, and has one trailing "." stripped (an absolute-form DNS name like
 *   "example.com." is the same site as "example.com", not a mismatch).
 * - Returns on the FIRST token that doesn't name the target; returns "" if every host-like
 *   token in the text names the target, or if there are none.
 *
 * Known limitation (not fixed here): text is taken from whatever ended up inside the `<a>`
 * after sanitizing, with no awareness of CSS visibility - a `display:none`/`font-size:0`
 * span's text still counts as "the visible text" even though a human would never see it. See
 * the "hidden text inside <a>" test for the current (pinned, not corrected) behaviour.
 */
export function linkWarning(text: string, href: string): string {
  let target: string;
  try { target = new URL(href).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; }
  const normalized = normalizeForHostScan(text);
  for (const m of normalized.matchAll(HOST_TOKEN)) {
    const shown = m[0].replace(/[.-]+$/, "");
    if (!shown.includes(".")) continue;
    if (!hasPlausibleHostShape(shown)) continue;
    let shownHost: string;
    try { shownHost = new URL(`https://${shown}/`).hostname; } catch { continue; }
    if (namesTarget(target, shownHost)) continue;
    return `The link text shows ${shown} but it goes to ${target}.`;
  }
  return "";
}
