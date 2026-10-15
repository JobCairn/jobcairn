/**
 * Job ad HTML (from an applicant system's public data) as plain text: headings and list items on their own lines,
 * paragraphs separated by a blank line, entities decoded, everything else dropped. Scripts, styles and comments
 * never contribute text. The result is only ever shown and saved as the job's ad, never run or rendered as HTML.
 */
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', bull: "•", middot: "·", trade: "™", copy: "©", reg: "®", euro: "€", pound: "£", dollar: "$",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  let s = html.slice(0, 2_000_000);
  // Greenhouse sends its content HTML-escaped once (&lt;p&gt;): unescape that layer first.
  if (!/<[a-z]/i.test(s) && /&lt;[a-z]/i.test(s)) s = decodeEntities(s);
  s = s.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|ul|ol|h[1-6]|table|tr|blockquote)\s*>/gi, "\n\n")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/(td|th)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s).replace(/ /g, " ");
  return s.split("\n").map((l) => l.replace(/[ \t\f\v]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
