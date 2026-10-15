import { describe, expect, it } from "vitest";
import {
  arrangeLayout, columnWidths, DEFAULT_RESUME_STYLE, fitSteps, fitToPages, isAtsSafe, isTemplateDefault, LAYOUT_HELP, LAYOUT_TEXT, parseResume, parseResumeStyle,
  RESUME_ACCENTS, RESUME_LAYOUTS, resumeLayout, resumeTheme, TEMPLATE_GROUPS, TEMPLATE_INFO, TEMPLATE_PRESETS, withTemplate, type ResumeStyle,
} from "../src/index.js";

// Fictional data only (Alex Example).
const MD = [
  "# Alex Example", "", "AI Engineer · Sampletown NSW 2000", "",
  "## Experience", "", "### AI Engineer, Example Labs", "*2024 to now · Sampletown*", "", "- Built a retrieval pipeline.", "",
  "## Skills", "", "- **Cloud:** AWS, Docker", "",
  "## Summary", "", "AI engineer (fictional).", "",
  "## Languages", "", "- English: Native", "",
  "## Education", "", "### BSc, Example University", "*2017 to 2020*", "",
].join("\n");
const doc = () => resumeLayout(parseResume(MD));

/** A rough page count from the theme's numbers: enough to tell tighter from looser. */
const estimatePages = (lines: number) => (s: ResumeStyle) => {
  const t = resumeTheme(s);
  const lineH = t.basePt * t.lineHeight;
  const contentH = t.page.heightMm / 25.4 * 72 - 2 * t.page.marginIn * 72;
  const width = columnWidths(s).main;
  const perLine = width / (t.basePt * 0.5);
  return Math.max(1, Math.ceil((lines * (80 / perLine) * lineH + 20 * t.sectionGapPt) / contentH));
};

describe("resume templates", () => {
  it("has at least 14 templates, each with a name, help, preset, group and look", () => {
    expect(RESUME_LAYOUTS.length).toBeGreaterThanOrEqual(14);
    for (const l of RESUME_LAYOUTS) {
      expect(LAYOUT_TEXT[l]).toBeTruthy();
      expect(LAYOUT_HELP[l].length).toBeGreaterThan(10);
      expect(TEMPLATE_PRESETS[l]).toBeTruthy();
      expect(TEMPLATE_GROUPS).toContain(TEMPLATE_INFO[l].group);
    }
    // Every group has at least two templates, and names are unique.
    for (const g of TEMPLATE_GROUPS) expect(RESUME_LAYOUTS.filter((l) => TEMPLATE_INFO[l].group === g).length).toBeGreaterThanOrEqual(2);
    expect(new Set(Object.values(LAYOUT_TEXT)).size).toBe(RESUME_LAYOUTS.length);
    // Single column is the default; two-column ones are few and marked.
    expect(isAtsSafe(DEFAULT_RESUME_STYLE.layout)).toBe(true);
    expect(RESUME_LAYOUTS.filter((l) => !isAtsSafe(l))).toEqual(["sidebar", "split"]);
  });

  it("gives every template its own look", () => {
    const sig = (l: (typeof RESUME_LAYOUTS)[number]) => JSON.stringify({ ...resumeTheme(withTemplate(DEFAULT_RESUME_STYLE, l)), page: null });
    expect(new Set(RESUME_LAYOUTS.map(sig)).size).toBe(RESUME_LAYOUTS.length);
  });

  it("round-trips every template's style through its JSON file", () => {
    for (const l of RESUME_LAYOUTS) {
      const s = { ...withTemplate(DEFAULT_RESUME_STYLE, l), accent: "teal" as const, hidden: ["awards"] };
      expect(parseResumeStyle(JSON.parse(JSON.stringify(s)))).toEqual(s);
      expect(isTemplateDefault(s)).toBe(true);
    }
    // An older file with only a layout gets that template's preset; an unknown layout falls back to classic.
    expect(parseResumeStyle({ layout: "timeline" })).toMatchObject({ layout: "timeline", dates: "gutter" });
    expect(parseResumeStyle({ layout: "nope" }).layout).toBe("classic");
  });

  it("switching template keeps the accent, page, text size and hidden sections, and resets the rest", () => {
    const mine: ResumeStyle = { ...DEFAULT_RESUME_STYLE, accent: "wine", page: "letter", size: "small", hidden: ["awards"], density: "tight", dates: "inline" };
    const s = withTemplate(mine, "scholar");
    expect(s).toMatchObject({ layout: "scholar", accent: "wine", page: "letter", size: "small", hidden: ["awards"], ...TEMPLATE_PRESETS.scholar });
    expect(isTemplateDefault({ ...s, dates: "inline" })).toBe(false);
  });

  it("black-and-white templates ignore the accent", () => {
    for (const l of RESUME_LAYOUTS) {
      const t = resumeTheme({ ...withTemplate(DEFAULT_RESUME_STYLE, l), accent: "plum" });
      expect(t.accent).toBe(TEMPLATE_INFO[l].mono ? RESUME_ACCENTS.ink : RESUME_ACCENTS.plum);
    }
  });

  it("fit to pages gets tighter for every template, two-column ones included", () => {
    for (const l of RESUME_LAYOUTS) {
      const s = withTemplate(DEFAULT_RESUME_STYLE, l);
      const steps = fitSteps(s);
      expect(steps.length).toBeGreaterThan(0);
      const last = resumeTheme(steps.at(-1)!);
      const first = resumeTheme(s);
      // Nothing the template draws grows as Fit tightens.
      for (const k of ["basePt", "sectionGapPt", "entryGapPt", "itemGapPt", "bandPadPt", "colGapPt", "sidePadPt", "namePt"] as const) expect(last[k]).toBeLessThanOrEqual(first[k]);
      expect(last.page.marginIn).toBeLessThanOrEqual(first.page.marginIn);
      const pages = estimatePages(150);
      const fit = fitToPages(s, 2, pages);
      expect(fit.pages).toBeLessThanOrEqual(pages(s));
      expect(fit.style.layout).toBe(l);
    }
  });

  it("arranges sections by type: skills first, and short sections in the side column", () => {
    const names = (ss: { heading: string }[]) => ss.map((s) => s.heading);
    expect(names(arrangeLayout(doc(), DEFAULT_RESUME_STYLE).main)).toEqual(["Experience", "Skills", "Summary", "Languages", "Education"]);
    expect(names(arrangeLayout(doc(), withTemplate(DEFAULT_RESUME_STYLE, "skills")).main)).toEqual(["Summary", "Skills", "Experience", "Languages", "Education"]);
    const two = arrangeLayout(doc(), withTemplate(DEFAULT_RESUME_STYLE, "sidebar"));
    expect(names(two.main)).toEqual(["Experience", "Summary", "Education"]);
    expect(names(two.side)).toEqual(["Skills", "Languages"]);
    // Nothing short to move: one column.
    const noSide = resumeLayout(parseResume("# Alex Example\n\n## Experience\n\n### AI Engineer, Example Labs\n\n- Built things.\n"));
    expect(arrangeLayout(noSide, withTemplate(DEFAULT_RESUME_STYLE, "split")).side).toEqual([]);
    const w = columnWidths(withTemplate(DEFAULT_RESUME_STYLE, "split"));
    expect(w.side).toBeGreaterThan(100);
    expect(w.main).toBeGreaterThan(w.side);
  });

  it("splits an entry's second line into organisation and place", () => {
    const e = doc().sections[0]!.items[0]!;
    expect(e).toMatchObject({ t: "entry", title: "AI Engineer", sub: "Example Labs · Sampletown", subLead: "Example Labs", place: "Sampletown" });
  });

  it("sets Scholar and Executive text in Source Serif 4, and keeps older serif files on Geist text", () => {
    for (const l of ["scholar", "executive"] as const) {
      const t = resumeTheme(withTemplate(DEFAULT_RESUME_STYLE, l));
      expect(t).toMatchObject({ bodyFont: "text-serif", headingFont: "serif", nameFont: "serif" });
    }
    expect(resumeTheme(parseResumeStyle({ layout: "scholar", font: "serif" })).bodyFont).toBe("sans");
    expect(parseResumeStyle(JSON.parse(JSON.stringify({ ...DEFAULT_RESUME_STYLE, font: "serif-text" }))).font).toBe("serif-text");
    expect(resumeTheme(DEFAULT_RESUME_STYLE).bodyFont).toBe("sans");
  });
});
