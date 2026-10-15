import { describe, expect, it } from "vitest";
import { inlineRuns, lineView } from "../src/resume/line-view";

describe("resume diff lines as the reader sees them", () => {
  it("drops markdown markers: headings, bullets, bold and italics", () => {
    expect(lineView("## Summary")).toEqual({ kind: "h2", runs: [{ text: "Summary" }] });
    expect(lineView("# Alex Example").kind).toBe("h1");
    expect(lineView("### AI Engineer, Example Labs").kind).toBe("h3");
    expect(lineView("- Built a **retrieval** pipeline")).toEqual({ kind: "bullet", runs: [{ text: "Built a " }, { text: "retrieval", bold: true }, { text: " pipeline" }] });
    expect(lineView("*2024 to now · Sampletown*")).toEqual({ kind: "para", runs: [{ text: "2024 to now · Sampletown", italic: true }] });
    expect(lineView("   ")).toEqual({ kind: "blank", runs: [] });
  });
  it("keeps plain text, stray asterisks and code as text", () => {
    expect(inlineRuns("5 * 3 = 15")).toEqual([{ text: "5 * 3 = 15" }]);
    expect(inlineRuns("uses `pgvector` daily")).toEqual([{ text: "uses " }, { text: "pgvector" }, { text: " daily" }]);
    expect(inlineRuns("<b>not html</b>")).toEqual([{ text: "<b>not html</b>" }]);
  });
});
