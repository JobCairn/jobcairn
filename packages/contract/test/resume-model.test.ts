import { describe, expect, it } from "vitest";
import {
  addBullet, inlineRuns, moveBullet, moveSection, parseResume, removeBullet, sectionKey, serializeResume, setBulletText,
  stripInline, toPlainText, visibleMarkdown, type ResumeEntry, type ResumeList,
} from "../src/resume-model.js";

const ALEX = [
  "# Alex Example",
  "",
  "AI Engineer · Sampletown NSW · alex@example.com",
  "",
  "## Summary",
  "",
  "AI engineer who builds **retrieval** pipelines (fictional).",
  "",
  "## Experience",
  "",
  "### AI Engineer, Example Labs",
  "*2024 to now*",
  "",
  "- Built a retrieval pipeline for support answers.",
  "- Cut answer latency with caching.",
  "",
  "### Developer, Acme Corp",
  "*2021 to 2024*",
  "",
  "- Wrote Node.js services.",
  "",
  "## Skills",
  "",
  "- Python, TypeScript, Node.js",
  "",
  "## Education",
  "",
  "### BSc Computer Science, Example University",
  "",
].join("\n");

const ODD: Record<string, string> = {
  crlf: "# Alex Example\r\n\r\n## Summary\r\n\r\nText.\r\n",
  "no final newline": "# Alex\n\n## Skills\n- a\n- b",
  "star and plus markers": "## Experience\n\n* one\n+ two\n1. three\n2) four\n",
  "nested and continued bullets": "## X\n\n- top\n  continued line\n  - nested\n    deeper\n\n  loose para\n- next\n",
  "code fence with a fake heading": "# A\n\n## Notes\n\n```\n## not a heading\n- not a bullet\n```\n\n## Real\n",
  "html comment and rule": "<!-- keep me -->\n# A\n\n---\n\n## S\n\n<div>raw</div>\n\n***\n",
  "closing hashes and extra spaces": "#   Alex   #\n\n##  Skills  ##\n\n###   Role ###\n",
  "front matter": "---\ntitle: x\n---\n# A\n",
  "only text": "Just a paragraph.\n\nAnother.\n",
  empty: "",
  "blank lines only": "\n\n\n",
  "second h1 later": "# A\n\n## S\n\nx\n\n# B\n\ny\n",
  "tabs and trailing spaces": "## S\n\n-\tTabbed bullet  \n- \n",
  "deep headings": "## S\n\n#### Small heading\n\ntext\n",
  "setext heading": "Alex\n====\n\n## S\n",
};

describe("parseResume / serializeResume", () => {
  it("round-trips a normal resume byte for byte", () => {
    expect(serializeResume(parseResume(ALEX))).toBe(ALEX);
  });

  for (const [name, md] of Object.entries(ODD)) {
    it(`round-trips odd markdown: ${name}`, () => {
      expect(serializeResume(parseResume(md))).toBe(md);
    });
  }

  it("reads the structure", () => {
    const m = parseResume(ALEX);
    expect(m.header.name).toBe("Alex Example");
    expect(m.sections.map((s) => s.heading)).toEqual(["Summary", "Experience", "Skills", "Education"]);
    expect(m.sections.map((s) => s.kind)).toEqual(["summary", "experience", "skills", "education"]);
    const exp = m.sections[1]!;
    const roles = exp.blocks.filter((b): b is ResumeEntry => b.kind === "entry");
    expect(roles.map((r) => r.title)).toEqual(["AI Engineer, Example Labs", "Developer, Acme Corp"]);
    expect(roles[0]!.meta).toEqual(["*2024 to now*"]);
    expect(roles[0]!.bullets.map((b) => b.text)).toEqual(["Built a retrieval pipeline for support answers.", "Cut answer latency with caching."]);
  });

  it("does not split a section on a heading inside a code fence", () => {
    const m = parseResume(ODD["code fence with a fake heading"]!);
    expect(m.sections.map((s) => s.heading)).toEqual(["Notes", "Real"]);
  });

  it("joins continuation lines into the bullet text and keeps nested lines", () => {
    const m = parseResume(ODD["nested and continued bullets"]!);
    const list = m.sections[0]!.blocks[0] as ResumeList;
    expect(list.bullets.map((b) => b.text)).toEqual(["top continued line", "next"]);
    expect(list.bullets[0]!.children.join("\n")).toContain("- nested");
  });

  it("writes only the edited node in canonical form", () => {
    const m = parseResume(ALEX);
    const role = m.sections[1]!.blocks[0] as ResumeEntry;
    const out = serializeResume(setBulletText(m, role.bullets[1]!.id, "Cut answer latency by caching results."));
    expect(out).toBe(ALEX.replace("- Cut answer latency with caching.", "- Cut answer latency by caching results."));
  });

  it("keeps an edited bullet's marker and nested lines", () => {
    const md = "## S\n\n* top\n  - child\n";
    const m = parseResume(md);
    const b = (m.sections[0]!.blocks[0] as ResumeList).bullets[0]!;
    expect(serializeResume(setBulletText(m, b.id, "new"))).toBe("## S\n\n* new\n  - child\n");
  });

  it("parses what it serialises again to the same structure after edits", () => {
    for (const md of [ALEX, ...Object.values(ODD)]) {
      const m = parseResume(md);
      const again = parseResume(serializeResume(m));
      expect(serializeResume(again)).toBe(serializeResume(m));
    }
  });
});

describe("edits", () => {
  it("moves sections and bullets", () => {
    const m = parseResume(ALEX);
    const moved = moveSection(m, m.sections[2]!.id, 0);
    expect(moved.sections.map((s) => s.heading)).toEqual(["Skills", "Summary", "Experience", "Education"]);
    const role = m.sections[1]!.blocks[0] as ResumeEntry;
    const m2 = moveBullet(m, role.bullets[1]!.id, 0);
    const role2 = m2.sections[1]!.blocks[0] as ResumeEntry;
    expect(role2.bullets.map((b) => b.text)[0]).toBe("Cut answer latency with caching.");
    expect(serializeResume(m2)).toContain("- Cut answer latency with caching.\n- Built a retrieval");
    expect(m.sections[0]!.heading).toBe("Summary"); // the original is untouched
  });

  it("adds and removes bullets", () => {
    const m = parseResume(ALEX);
    const role = m.sections[1]!.blocks[0] as ResumeEntry;
    const added = addBullet(m, role.id, "Shipped an evaluation suite.");
    expect(serializeResume(added)).toContain("- Cut answer latency with caching.\n- Shipped an evaluation suite.\n");
    const removed = removeBullet(m, role.bullets[0]!.id);
    expect(serializeResume(removed)).not.toContain("Built a retrieval pipeline");
    expect(serializeResume(removed)).toContain("*2024 to now*\n\n- Cut answer latency");
  });

  it("hides sections by heading", () => {
    const m = parseResume(ALEX);
    const out = visibleMarkdown(m, [sectionKey("Skills")]);
    expect(out).not.toContain("## Skills");
    expect(out).toContain("## Education");
  });
});

describe("inline text", () => {
  it("strips Markdown marks and keeps https links as text", () => {
    expect(stripInline("Built **fast** _search_ with `rg` and [docs](https://example.com) or [x](javascript:alert(1))")).toBe(
      "Built fast search with rg and docs (https://example.com) or x",
    );
    expect(stripInline("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("splits bold and italic runs", () => {
    expect(inlineRuns("a **b** *c*")).toEqual([{ text: "a " }, { text: "b", bold: true }, { text: " " }, { text: "c", italic: true }]);
  });
});

describe("toPlainText", () => {
  it("is ATS-safe: no glyph bullets, no Markdown marks, hidden sections left out", () => {
    const md = ALEX.replace("- Wrote Node.js services.", "• Wrote **Node.js** services.");
    const txt = toPlainText(parseResume(md), [sectionKey("Education")]);
    expect(txt).not.toMatch(/[•●▪◦‣*#`]/);
    expect(txt).toContain("ALEX EXAMPLE");
    expect(txt).toContain("EXPERIENCE");
    expect(txt).toContain("- Built a retrieval pipeline for support answers.");
    expect(txt).toContain("- Wrote Node.js services.");
    expect(txt).not.toContain("EDUCATION");
    expect(txt.endsWith("\n")).toBe(true);
  });
});
