import { strFromU8, unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";
import { core } from "@careeros/brand/tokens";
import { renderDocx } from "../src/print/docx.js";
import { loadPrintFonts } from "../src/print/fonts.js";
import { PRINT_CSP, renderHtml } from "../src/print/html.js";
import { ExportUnavailable, parseIsolated, ParseTooComplex, TooManyBlocks } from "../src/print/isolate.js";
import { MAX_EXPORT_BLOCKS, MAX_EXPORT_RUNS, parseMarkdown, reduceTree, TooComplex, type PrintDoc } from "../src/print/markdown.js";
import { EMAIL, RESUME } from "./print-fixtures.js";

const SHORT = "# Alex Example\n\n## Experience\n\n- Built retrieval pipelines with **Python**\n  - nested\n\n1. First\n\n---\n\nThanks <b>x</b> & \"q\"\n";
const SHORT_HTML = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:">`,
  "<title>Alex Example - Resume</title>",
  "<style>",
  "@page { size: A4; }",
  `html { font-family: ${core["font-family-sans"]}; font-size: 10.5pt; line-height: 1.4; color: black; background: white; }`,
  "body { margin: 0; }",
  "h1 { font-size: 18pt; font-weight: 600; margin: 0 0 4pt; }",
  "h2 { font-size: 12pt; font-weight: 600; margin: 12pt 0 4pt; padding-bottom: 2pt; border-bottom: 0.75pt solid black; }",
  "h3 { font-size: 10.5pt; font-weight: 600; margin: 8pt 0 2pt; }",
  "h1, h2, h3 { break-after: avoid; }",
  "p { margin: 0 0 4pt; orphans: 2; widows: 2; }",
  ".item { margin-bottom: 2pt; padding-left: 10pt; text-indent: -10pt; }",
  ".lvl-1 { margin-left: 12pt; } .lvl-2 { margin-left: 24pt; } .lvl-3 { margin-left: 36pt; } .lvl-4 { margin-left: 48pt; }",
  "hr { border: 0; border-top: 0.75pt solid black; margin: 8pt 0; }",
  "strong { font-weight: 600; }",
  "</style>",
  "</head>",
  "<body>",
  "<h1>Alex Example</h1>",
  "<h2>Experience</h2>",
  '<p class="item lvl-0">• Built retrieval pipelines with <strong>Python</strong></p>',
  '<p class="item lvl-1">• nested</p>',
  '<p class="item lvl-0">1. First</p>',
  "<hr>",
  "<p>Thanks x &amp; &quot;q&quot;</p>",
  "</body>",
  "</html>",
  "",
].join("\n");

describe("markdown to a print document", () => {
  it("keeps headings, bullets and text, and drops raw HTML and images", () => {
    const doc = parseMarkdown(RESUME, "Alex Example - Resume");
    expect(doc.blocks).toEqual([
      { kind: "heading", level: 1, runs: [{ text: "Alex Example" }] },
      { kind: "paragraph", runs: [{ text: `Sampletown NSW · ${EMAIL}` }] },
      { kind: "heading", level: 2, runs: [{ text: "Experience" }] },
      { kind: "heading", level: 3, runs: [{ text: "AI Engineer, Example Labs" }] },
      { kind: "bullet", level: 0, marker: "•", runs: [{ text: "Built retrieval pipelines with " }, { text: "Python", bold: true }, { text: " and " }, { text: "TypeScript", italic: true }] },
      { kind: "bullet", level: 1, marker: "•", runs: [{ text: "Cut answer time in half (fictional)" }] },
      { kind: "bullet", level: 0, marker: "1.", runs: [{ text: "First" }] },
      { kind: "bullet", level: 0, marker: "2.", runs: [{ text: "Second" }] },
      { kind: "paragraph", runs: [{ text: "See my portfolio (https://portfolio.example.com) and notes." }] },
      { kind: "rule" },
      { kind: "heading", level: 3, runs: [{ text: "Deep heading" }] },
    ]);
    expect(doc.dropped).toBe(4);
  });
});

describe("print HTML", () => {
  it("matches the snapshot: one column, sober print style, escaped text", () => {
    expect(renderHtml(parseMarkdown(SHORT, "Alex Example - Resume"), null)).toBe(SHORT_HTML);
  });

  it("keeps every word as real text, in reading order", () => {
    const html = renderHtml(parseMarkdown(RESUME, "Alex Example - Resume"), null);
    const text = html.replace(/<head>[\s\S]*<\/head>/, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    expect(text).toBe(
      `Alex Example Sampletown NSW · ${EMAIL} Experience AI Engineer, Example Labs • Built retrieval pipelines with Python and TypeScript • Cut answer time in half (fictional) 1. First 2. Second See my portfolio (https://portfolio.example.com) and notes. Deep heading`,
    );
  });

  it("has no remote references, scripts, images or links", () => {
    const html = renderHtml(parseMarkdown(RESUME, "Alex Example - Resume"), loadPrintFonts());
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`);
    expect(html).not.toMatch(/<(img|script|link|iframe|object|embed|svg|a)\b/i);
    expect(html).not.toMatch(/\b(src|href)\s*=/i);
    expect(html).not.toMatch(/tracker\.example\.com|cdn\.example\.com|logo\.png/);
    expect(html.match(/url\([^)]*\)/g)?.every((u) => u.startsWith("url(data:font/woff2;base64,"))).toBe(true);
  });

  it("embeds the bundled Geist regular and semibold fonts", () => {
    const fonts = loadPrintFonts();
    for (const b64 of [fonts.regular, fonts.semibold]) expect(Buffer.from(b64, "base64").subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(renderHtml(parseMarkdown(SHORT, "t"), fonts).match(/@font-face \{ font-family: "Geist"/g)).toHaveLength(2);
  });
});

describe("DOCX", () => {
  it("has real headings, bullets and paragraphs, and no tables, images or text boxes", async () => {
    const files = unzipSync(await renderDocx(parseMarkdown(RESUME, "Alex Example - Resume")));
    const xml = strFromU8(files["word/document.xml"]!);
    expect(xml.match(/<w:pStyle w:val="[^"]+"\/>/g)).toEqual([
      '<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="Heading2"/>', '<w:pStyle w:val="Heading3"/>',
      '<w:pStyle w:val="ListParagraph"/>', '<w:pStyle w:val="ListParagraph"/>', '<w:pStyle w:val="Heading3"/>',
    ]);
    expect(xml).not.toMatch(/<w:tbl\b|<w:drawing\b|<w:pict\b|<w:txbxContent\b/);
    const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("|");
    expect(text).toBe(`Alex Example|Sampletown NSW · ${EMAIL}|Experience|AI Engineer, Example Labs|Built retrieval pipelines with |Python| and |TypeScript|Cut answer time in half (fictional)|1. |First|2. |Second|See my portfolio (https://portfolio.example.com) and notes.|Deep heading`);
    expect(strFromU8(files["docProps/core.xml"]!)).toContain("<dc:title>Alex Example - Resume</dc:title>");
  });
});

// Markdown written to attack the print page: every one of these must come out as inert text or not at all.
const HOSTILE = [
  "# Alex <script>alert(1)</script> Example", "",
  "<script>fetch('https://evil.example.com')</script>", "",
  "</style><script>alert(2)</script>", "",
  "<img src=x onerror=\"alert(3)\">", "",
  "<div onclick=\"alert(4)\">raw block</div>", "",
  "<iframe src=\"https://evil.example.com\"></iframe>", "",
  "Inline <a href=\"https://evil.example.com\" onmouseover=\"alert(5)\">tag</a> and <svg onload=alert(6)> here.", "",
  "[click](javascript:alert(7)) [file](file:///etc/hosts) [data](data:text/html,<script>alert(8)</script>)", "",
  "<https://auto.example.com> and &lt;script&gt;alert(9)&lt;/script&gt; and </style>", "",
  "- <b onmouseover=alert(10)>bold</b> item with `<script>` code", "",
  "```html", "<script>alert(11)</script>", "```", "",
  "![x](https://cdn.example.com/x.png \"t\")", "",
].join("\n");

describe("hostile Markdown", () => {
  const html = renderHtml(parseMarkdown(HOSTILE, "Alex <Example> - Resume"), loadPrintFonts());
  const body = html.slice(html.indexOf("<body>"));

  it("prints no active markup: no scripts, handlers, frames, links or remote addresses", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<(img|iframe|object|embed|svg|a|link|div|b|base|meta http-equiv="refresh")\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // no event-handler attributes
    expect(html).not.toMatch(/\b(src|href|action|formaction)\s*=/i);
    expect(html).not.toMatch(/javascript:|file:|data:text/i);
    // The only URLs in markup are the embedded fonts; remote addresses survive only as escaped text.
    expect(html.match(/url\([^)]*\)/g)?.every((u) => u.startsWith("url(data:font/woff2;base64,"))).toBe(true);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(body).not.toMatch(/evil\.example\.com|cdn\.example\.com/);
  });

  it("keeps the words as escaped text", () => {
    expect(html).toContain("<title>Alex &lt;Example&gt; - Resume</title>");
    expect(body).toContain("https://auto.example.com and &lt;script&gt;alert(9)&lt;/script&gt; and</p>"); // the raw </style> is dropped
    expect(body).toContain("&lt;script&gt;alert(11)&lt;/script&gt;");
    expect(body).toContain("https://auto.example.com");
    expect(body).toContain("click file data");
    // Parsed as a page, the body holds only our own elements and no attributes but class.
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelectorAll("script, img, iframe, a, svg, object, embed, link").length).toBe(0);
    for (const el of doc.body.querySelectorAll("*")) expect(el.getAttributeNames().filter((a) => a !== "class")).toEqual([]);
    const ours = new Set(["h1", "h2", "h3", "p", "strong", "em", "hr"]);
    expect([...doc.body.querySelectorAll("*")].map((e) => e.tagName.toLowerCase()).filter((t) => !ours.has(t))).toEqual([]);
  });
});

describe("DOCX text safety", () => {
  it("writes XML specials, CDATA ends and WordprocessingML tags as text, and drops characters XML can't hold", async () => {
    const md = [
      "# A & B <w:t>x</w:t> ]]> \"q\" 'a'", "",
      "<w:p><w:r><w:t>injected</w:t></w:r></w:p>", "",
      "Text with ]]> and <![CDATA[ x ]]> and &amp; and \u0001ctrl\u000bvt and a lone \ud800 surrogate.",
    ].join("\n");
    const doc = parseMarkdown(md, "Alex & <Example> ]]>");
    const files = unzipSync(await renderDocx(doc));
    const xml = strFromU8(files["word/document.xml"]!);
    const parsed = new JSDOM("").window.DOMParser;
    for (const name of ["word/document.xml", "docProps/core.xml"]) {
      const d = new parsed().parseFromString(strFromU8(files[name]!), "application/xml");
      expect(d.getElementsByTagName("parsererror").length).toBe(0);
    }
    const xmlDoc = new parsed().parseFromString(xml, "application/xml");
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const paras = [...xmlDoc.getElementsByTagNameNS(W, "p")].map((p) => [...p.getElementsByTagNameNS(W, "t")].map((t) => t.textContent).join(""));
    expect(paras.filter(Boolean)).toEqual(doc.blocks.map((b) => (b.kind === "rule" ? "" : b.runs.map((r) => r.text).join(""))).filter(Boolean));
    // "w:t" isn't an HTML tag name, so CommonMark keeps it as text; it must reach Word as text, not markup.
    expect(paras[0]).toBe("A & B <w:t>x</w:t> ]]> \"q\" 'a'");
    expect(paras[1]).toBe("<w:p><w:r><w:t>injected</w:t></w:r></w:p>");
    expect(xml).toContain("&lt;w:t&gt;injected&lt;/w:t&gt;");
    expect(paras.join("|")).toContain("Text with ]]> and and & and ctrlvt and a lone surrogate.");
    expect(xml).not.toMatch(/[\u0001\u000b]/);
  });
});

// Each test starts a worker thread; on a loaded machine that alone can take seconds.
describe("parsing off the main thread", { timeout: 60_000 }, () => {
  it("gives the same document as parsing in place", async () => {
    expect(await parseIsolated(RESUME, "Alex Example - Resume")).toEqual(parseMarkdown(RESUME, "Alex Example - Resume"));
  });

  it("gives up on input the parser is slow with, and on very deep nesting", async () => {
    await expect(parseIsolated("- - - - x\n".repeat(20_000), "t", { timeoutMs: 300 })).rejects.toBeInstanceOf(ParseTooComplex);
    await expect(parseIsolated(`${">".repeat(500)} x`, "t")).rejects.toBeInstanceOf(ParseTooComplex);
  });

  it("keeps the main thread free on a large flat inline input (parse and reduce both run in the worker)", async () => {
    // Before the fix this stalled the main thread for minutes: every merge re-scanned the whole run for double spaces.
    const n = Math.floor((512 * 1024) / 6);
    const md = "ab<x> ".repeat(n);
    let last = Date.now();
    let worst = 0;
    const tick = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 20);
    // A long deadline, so the parse finishes and whatever runs after it is measured too.
    const result = await parseIsolated(md, "t", { timeoutMs: 60_000 }).then((d) => d, (e: unknown) => e);
    clearInterval(tick);
    expect(result).not.toBeInstanceOf(Error);
    expect((result as PrintDoc).blocks).toEqual([{ kind: "paragraph", runs: [{ text: Array(n).fill("ab").join(" ") }] }]);
    expect(worst).toBeLessThan(3000); // minutes before the fix; generous for a loaded machine
  }, 120_000);

  it("allows up to MAX_EXPORT_RUNS inline runs and refuses one more, inside the worker", async () => {
    expect(MAX_EXPORT_RUNS).toBe(5000);
    const at = Array.from({ length: 2500 }, () => "a **b**").join(" ");
    const doc = await parseIsolated(at, "t");
    expect(doc.blocks[0]!.kind === "paragraph" && doc.blocks[0]!.runs.length).toBe(5000);
    await expect(parseIsolated(`${at} a`, "t")).rejects.toBeInstanceOf(ParseTooComplex);
    expect(() => parseMarkdown(`${at} a`, "t")).toThrow(TooComplex);
  });

  it("refuses too many blocks inside the worker", async () => {
    await expect(parseIsolated("- x\n".repeat(MAX_EXPORT_BLOCKS + 1), "t")).rejects.toBeInstanceOf(TooManyBlocks);
    expect((await parseIsolated("- x\n".repeat(MAX_EXPORT_BLOCKS), "t")).blocks).toHaveLength(MAX_EXPORT_BLOCKS);
  });

  it("reports a broken worker as unavailable, not as a complex document", async () => {
    const missing = new URL("./no-such-worker.mjs", import.meta.url);
    await expect(parseIsolated(RESUME, "t", { workerUrl: missing })).rejects.toBeInstanceOf(ExportUnavailable);
    const broken = new URL("data:text/javascript,throw new Error('boom')");
    await expect(parseIsolated(RESUME, "t", { workerUrl: broken })).rejects.toBeInstanceOf(ExportUnavailable);
  });
});

describe("linear inline handling", { timeout: 60_000 }, () => {
  it("merges thousands of pieces and long link labels without quadratic work", () => {
    const n = 100_000;
    const tree = fromMarkdown("ab<x>  ".repeat(n)); // the parse itself runs in the worker; this measures the reduction
    let t = Date.now();
    const doc = reduceTree(tree, "t");
    t = Date.now() - t;
    expect(doc.blocks[0]!.kind === "paragraph" && doc.blocks[0]!.runs[0]!.text).toBe(Array(n).fill("ab").join(" "));
    expect(t).toBeLessThan(3000); // was 40 s before the fix; generous for a loaded machine
    const label = "word ".repeat(20_000).trim();
    const linked = parseMarkdown(`[${label}](https://portfolio.example.com) and [https://portfolio.example.com](https://portfolio.example.com)`, "t");
    expect(linked.blocks[0]!.kind === "paragraph" && linked.blocks[0]!.runs[0]!.text).toBe(`${label} (https://portfolio.example.com) and https://portfolio.example.com`);
  });
});
