import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DEFAULT_RESUME_STYLE, parseResume, RESUME_LAYOUTS, resumeLayout, TEMPLATE_INFO, withTemplate } from "@careeros/contract";
import { loadPrintFonts } from "../src/print/fonts.js";
import { resumeDocx, resumeHtml } from "../src/print/resume-print.js";

// Fictional data only (Alex Example). Email by concatenation so the privacy scan stays meaningful.
const EMAIL = "alex" + "@" + "example.com";
const MD = [
  "# Alex Example", "", `AI Engineer · Sampletown NSW 2000 · ${EMAIL}`, "",
  "## Summary", "", "AI engineer who builds retrieval pipelines (fictional).", "",
  "## Experience", "", "### AI Engineer, Example Labs", "*2024 to now · Sampletown*", "", "- Built a retrieval pipeline.", "- Added an evaluation suite.", "",
  "## Skills", "", "- **Cloud:** AWS, Docker", "- **AI:** Retrieval, evaluation", "",
  "## Languages", "", "- English: Native", "",
  "## Education", "", "### BSc Computer Science, Example University", "*2017 to 2020*", "",
].join("\n");
const tree = () => resumeLayout(parseResume(MD));
const docXml = async (layout: (typeof RESUME_LAYOUTS)[number]) => strFromU8(unzipSync(await resumeDocx(tree(), "Alex Example - Resume", withTemplate(DEFAULT_RESUME_STYLE, layout)))["word/document.xml"]!);
/** The text of the page in reading order: tags dropped, CSS removed. */
const htmlText = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<title>[\s\S]*?<\/title>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** Word text in document order. */
const wordText = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(" ").replace(/\s+/g, " ");
const order = (text: string, words: string[]) => words.map((w) => text.indexOf(w));

describe("every template, every output", () => {
  it.each(RESUME_LAYOUTS)("%s renders the same words in the PDF page and the Word file", async (layout) => {
    const style = withTemplate(DEFAULT_RESUME_STYLE, layout);
    const html = resumeHtml(tree(), "Alex Example - Resume", style, loadPrintFonts(style.font));
    const xml = await docXml(layout);
    for (const words of ["Alex Example", "Example Labs", "Built a retrieval pipeline.", "AWS, Docker", "English", "Example University", "2024 to now", EMAIL]) {
      expect(htmlText(html)).toContain(words);
      expect(wordText(xml)).toContain(words);
    }
    // Headings stay as written in the text (capitals are styling only).
    expect(xml).toContain(">Experience<");
    // Fills print: the printer leaves backgrounds off unless the page asks.
    expect(html).toContain("print-color-adjust: exact");
    expect(html).not.toContain("monospace");
    // Nothing positioned: Chromium paints positioned boxes last, which would reorder the PDF's text.
    expect(html).not.toMatch(/position:\s*(?:absolute|relative|fixed|sticky)|opacity:|(?<!text-)transform:|float:|z-index:/);
    // Tables only for the two-column templates.
    if (TEMPLATE_INFO[layout].twoColumn) expect(xml).toMatch(/<w:tbl\b/);
    else expect(xml).not.toMatch(/<w:tbl\b|<w:drawing\b|<w:txbxContent\b/);
  });
});

describe("two-column reading order", () => {
  it.each(RESUME_LAYOUTS.filter((l) => TEMPLATE_INFO[l].twoColumn))("%s reads header, then the main column, then the side column", async (layout) => {
    const style = withTemplate(DEFAULT_RESUME_STYLE, layout);
    const html = resumeHtml(tree(), "t", style, null);
    const xml = await docXml(layout);
    const words = ["Alex Example", EMAIL, "Built a retrieval pipeline.", "Example University", "AWS, Docker", "English"];
    for (const text of [htmlText(html), wordText(xml)]) {
      const at = order(text, words);
      expect(at.every((x) => x >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
    // The side column is placed on the right by the grid, never by reordering the text.
    expect(html).toContain('<div class="cols"><div class="main">');
    expect(html).not.toMatch(/\border:/);
  });
});

describe("template details", () => {
  it("Timeline puts dates in a left column, first in the text", async () => {
    const html = resumeHtml(tree(), "t", withTemplate(DEFAULT_RESUME_STYLE, "timeline"), null);
    expect(html).toContain('<div class="line gut"><span class="dates">2024 to now</span><span class="title">AI Engineer</span></div>');
    expect(wordText(await docXml("timeline"))).toMatch(/2024 to now\s+AI Engineer/);
  });
  it("Timeline wraps a long date inside its column", () => {
    const html = resumeHtml(resumeLayout(parseResume(MD.replace("*2024 to now · Sampletown*", "*September 2021 to Present · Sampletown*"))), "t", { ...withTemplate(DEFAULT_RESUME_STYLE, "timeline"), size: "large", margins: "wide" }, null);
    expect(html).toContain(".line.gut .dates { white-space: normal;");
    expect(html).toContain('<span class="dates">September 2021 to Present</span>');
  });
  it("Engineer sets the place on the right of the organisation line", async () => {
    const html = resumeHtml(tree(), "t", withTemplate(DEFAULT_RESUME_STYLE, "engineer"), null);
    expect(html).toContain('<div class="line subline"><span class="title">Example Labs</span><span class="place">Sampletown</span></div>');
    expect(await docXml("engineer")).toMatch(/<w:tab w:val="right"/);
  });
  it("Banner draws the header on the accent with white text, in both outputs", async () => {
    const style = { ...withTemplate(DEFAULT_RESUME_STYLE, "banner"), accent: "navy" as const };
    expect(resumeHtml(tree(), "t", style, null)).toMatch(/\.head \{ background: #1f3a5f; color: #ffffff;/);
    const xml = strFromU8(unzipSync(await resumeDocx(tree(), "t", style))["word/document.xml"]!);
    expect(xml).toMatch(/w:fill="1F3A5F"/);
    expect(xml).toMatch(/w:color w:val="FFFFFF"/);
  });
  it("Skills first moves the summary and skills to the top", async () => {
    const text = wordText(await docXml("skills"));
    expect(order(text, ["Summary", "Skills", "Experience"])).toEqual([...order(text, ["Summary", "Skills", "Experience"])].sort((a, b) => a - b));
  });
  it("serif text embeds Source Serif 4 in the PDF and names it in Word", async () => {
    const style = withTemplate(DEFAULT_RESUME_STYLE, "scholar");
    const fonts = loadPrintFonts(style.font);
    expect(fonts.text?.regular.length).toBeGreaterThan(1000);
    expect(fonts.text?.italic.length).toBeGreaterThan(1000);
    const html = resumeHtml(tree(), "t", style, fonts);
    expect(html).toContain('html { font-family: "Source Serif 4", Georgia, serif;');
    expect(html).toMatch(/@font-face \{ font-family: "Source Serif 4"; font-style: normal; font-weight: 600;/);
    expect(html).toMatch(/@font-face \{ font-family: "Source Serif 4"; font-style: italic; font-weight: 400;/);
    const styles = strFromU8(unzipSync(await resumeDocx(tree(), "t", style))["word/styles.xml"]!);
    expect(styles).toContain("Source Serif 4");
    // Geist-text templates stay as they were.
    expect(loadPrintFonts("geist").text).toBeUndefined();
    expect(resumeHtml(tree(), "t", DEFAULT_RESUME_STYLE, null)).toContain('html { font-family: "Geist", sans-serif;');
  });
});
