import { describe, expect, it } from "vitest";
import { ACTION_RULES, ACTIONS, applyStretch, ASCII_DATES_STEP, buildActionPrompt, parseReview, plainFact, REVIEW_STEPS } from "../src/index.js";

// Fictional data only (Alex Example, Acme Corp).
describe("parseReview", () => {
  it("keeps well-formed items and skips the rest", () => {
    const r = parseReview({
      edits: [
        { file: "resume.md", old: "Led a team of 12", new: "Worked in a team of 12", reason: "grounding", why: "No source says led." },
        { file: "resume.md", old: "x", new: "y", reason: "made-up" },
        { old: "", new: "y", reason: "style" },
        "junk",
      ],
      stretch: [{ file: "cover-letter.md", text: "Owned the platform", why: "Supported it", soften: "Supported the platform" }, { text: "" }, { text: "Ran on-call", state: "kept" }],
      facts: [{ fact: "Mentored 2 graduates in 2024", source: "your note" }, { fact: 3 }],
      notes: "  Two changes.  ",
    });
    expect(r).toEqual({
      edits: [{ file: "resume.md", old: "Led a team of 12", new: "Worked in a team of 12", reason: "grounding", why: "No source says led." }],
      stretch: [
        { file: "cover-letter.md", text: "Owned the platform", why: "Supported it", soften: "Supported the platform", state: "open" },
        { file: "resume.md", text: "Ran on-call", why: "", soften: "", state: "kept" },
      ],
      facts: [{ fact: "Mentored 2 graduates in 2024", source: "your note", saved: false }],
      notes: "Two changes.",
    });
  });

  it("reads anything but an object as no review", () => {
    for (const v of [null, [], "text", 3]) expect(parseReview(v)).toBeNull();
    expect(parseReview({})).toEqual({ edits: [], stretch: [], facts: [], notes: "" });
  });
});

describe("applyStretch", () => {
  const md = "## Experience\n\n- Owned the data platform for Acme Corp\n- Built pipelines\n";
  const item = { text: "Owned the data platform for Acme Corp", soften: "Supported the data platform for Acme Corp" };

  it("softens the exact text in place", () => {
    expect(applyStretch(md, item, "soften")).toBe("## Experience\n\n- Supported the data platform for Acme Corp\n- Built pipelines\n");
  });

  it("drops the whole bullet line", () => {
    expect(applyStretch(md, item, "drop")).toBe("## Experience\n\n- Built pipelines\n");
  });

  it("drops only the sentence when the line holds more", () => {
    const letter = "I like Acme Corp. Owned the data platform for Acme Corp And more.\n";
    expect(applyStretch(letter, item, "drop")).toBe("I like Acme Corp.  And more.\n");
  });

  it("keeps the bullet marker when Claude's text and soft wording came with or without one", () => {
    const r = parseReview({ stretch: [{ text: "- Owned the data platform for Acme Corp", soften: "Supported the data platform for Acme Corp" }] })!;
    expect(r.stretch[0]!.text).toBe(item.text);
    expect(applyStretch(md, r.stretch[0]!, "soften")).toContain("\n- Supported the data platform for Acme Corp\n");
    const s = parseReview({ stretch: [{ text: item.text, soften: "* Supported it" }] })!;
    expect(applyStretch(md, s.stretch[0]!, "soften")).toContain("\n- Supported it\n");
  });

  it("changes nothing when the text isn't there any more", () => {
    expect(applyStretch("- Something else\n", item, "drop")).toBeNull();
  });
});

describe("plainFact", () => {
  it("drops the list marker and bold or italic marks", () => {
    expect(plainFact("- Built pipelines with **Python** and *TypeScript*")).toBe("Built pipelines with Python and TypeScript");
    expect(plainFact("  1. Cut costs  by __20%__ ")).toBe("Cut costs by 20%");
    expect(plainFact("Rated 4*5 by users")).toBe("Rated 4*5 by users");
  });
});

describe("tailor_application prompt", () => {
  it("lets a fact I state myself count as evidence, listed for me to save", () => {
    const p = buildActionPrompt("tailor_application", { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }, { title: "AI Engineer", company: "Acme Corp" });
    expect(ACTION_RULES[3]).toContain("or to a fact I state myself in this request");
    expect(p).toContain(ACTION_RULES[3]);
    expect(p).toContain("or a fact I state myself in this request (my note, or ad terms I confirmed)");
    expect(p).toContain("ticked in the keyword check");
  });

  it("asks for the second pass, review.json and ASCII date ranges", () => {
    const t = ACTIONS.tailor_application;
    expect(t.extras).toContain("{folder}/review.json");
    expect(t.outputs).not.toContain("{folder}/review.json");
    expect(t.steps).toContain(ASCII_DATES_STEP);
    for (const s of REVIEW_STEPS) expect(t.steps).toContain(s);
    expect(REVIEW_STEPS.join(" ")).toContain("could I defend this in an interview");
    expect(ACTIONS.rewrite_resume.steps).toContain(ASCII_DATES_STEP);
  });
});
