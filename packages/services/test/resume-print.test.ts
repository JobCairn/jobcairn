import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DEFAULT_RESUME_STYLE, parseResume, resumeLayout, withTemplate } from "@careeros/contract";
import { loadPrintFonts } from "../src/print/fonts.js";
import { countNodes, MAX_RESUME_NODES, resumeDocx, resumeHtml, ResumeTooLarge } from "../src/print/resume-print.js";

const EMAIL = "alex" + "@" + "example.com";
const MD = [
  "# Alex <Example>", "", `AI Engineer · Sampletown NSW 2000 · ${EMAIL}`, "",
  "## Experience", "", "### AI Engineer, Example Labs", "*2024 to now · Sampletown*", "",
  "- Built a retrieval pipeline with **Python** & <b>evals</b>.", "- Second bullet.", "",
  "## Skills", "", "- **Cloud:** AWS, Docker", "",
].join("\n");
const tree = () => resumeLayout(parseResume(MD));

describe("resume PDF page", () => {
  it("puts dates on the entry line, keeps the head with its first bullet, and escapes text", () => {
    const html = resumeHtml(tree(), "Alex Example - Resume", DEFAULT_RESUME_STYLE, null);
    expect(html).toContain('<div class="entry"><div class="keep"><div class="line"><span class="title">AI Engineer</span><span class="dates">2024 to now</span></div><p class="sub">Example Labs · Sampletown</p><ul><li>Built a retrieval pipeline with <strong>Python</strong> &amp; evals.</li></ul></div><ul class="more"><li>Second bullet.</li></ul></div>');
    expect(html).toContain('<h1 class="name">Alex </h1>');
    expect(html).not.toMatch(/<Example>|<b>/);
    expect(html).toContain("<p class=\"group\"><strong>Cloud:</strong> AWS, Docker</p>");
    expect(html).toContain(".keep { break-inside: avoid; }");
    expect(html).not.toContain("monospace");
  });

  it("follows the template: serif fonts embedded, inline dates", () => {
    const s = withTemplate(DEFAULT_RESUME_STYLE, "minimal");
    expect(resumeHtml(tree(), "t", s, null)).toContain('<body class="inline">');
    const ex = resumeHtml(tree(), "t", withTemplate(DEFAULT_RESUME_STYLE, "executive"), loadPrintFonts("serif"));
    expect(ex).toContain('font-family: "Instrument Serif"');
  });

  it("refuses a resume with too many nodes", () => {
    const big = parseResume(`# A\n\n## Experience\n\n${Array.from({ length: MAX_RESUME_NODES + 5 }, (_x, i) => `- b${i}`).join("\n")}\n`);
    expect(countNodes(resumeLayout(big))).toBeGreaterThan(MAX_RESUME_NODES);
    expect(() => resumeHtml(resumeLayout(big), "t", DEFAULT_RESUME_STYLE, null)).toThrow(ResumeTooLarge);
  });
});

describe("resume Word file", () => {
  it("has the dates on a right tab stop and no tables", async () => {
    const files = unzipSync(await resumeDocx(tree(), "Alex Example - Resume", DEFAULT_RESUME_STYLE));
    const xml = strFromU8(files["word/document.xml"]!);
    expect(xml).toMatch(/<w:tab w:val="right"/);
    expect(xml).toContain("2024 to now");
    expect(xml).toContain("Example Labs · Sampletown");
    expect(xml).not.toMatch(/<w:tbl\b|<w:drawing\b/);
  });
});
