import { describe, expect, it } from "vitest";
import { researchAge, researchAgeText, researchedOn, researchRule } from "../src/index.js";

const now = new Date(2026, 9, 17, 10, 0); // 17 Oct 2026, local time

describe("researchedOn: the date research.md states", () => {
  it("reads a Researched line or front matter near the top", () => {
    expect(researchedOn("# Acme Corp\n\nResearched: 2026-09-01\n\nWhat they do")).toBe("2026-09-01");
    expect(researchedOn("---\nresearched_on: 2026-09-02\n---\n# Acme")).toBe("2026-09-02");
    expect(researchedOn("# Acme\n**Researched:** 2026-09-03")).toBe("2026-09-03");
    expect(researchedOn("# Acme\n- Research date: 2026-09-04")).toBe("2026-09-04");
  });

  it("is empty when it doesn't say, or the date isn't real", () => {
    expect(researchedOn("# Acme\nThey were founded in 2001.")).toBe("");
    expect(researchedOn("Researched: 2026-02-31")).toBe("");
    expect(researchedOn(`${"line\n".repeat(50)}Researched: 2026-09-01`)).toBe("");
  });
});

describe("researchAge", () => {
  it("counts days from the stated date, stale after 30", () => {
    expect(researchAge("Researched: 2026-09-06", "", now)).toEqual({ at: "2026-09-06", days: 41, stale: true });
    expect(researchAge("Researched: 2026-09-17", "", now)).toMatchObject({ days: 30, stale: false });
    expect(researchAge("Researched: 2026-09-16", "", now)).toMatchObject({ days: 31, stale: true });
  });

  it("falls back to the file's modified time, and treats a future date as today", () => {
    const at = new Date(2026, 9, 10, 9, 0).toISOString();
    expect(researchAge("# Acme", at, now)).toEqual({ at, days: 7, stale: false });
    expect(researchAge("Researched: 2026-12-01", "", now)).toMatchObject({ days: 0, stale: false });
    expect(researchAge("# Acme", "", now)).toBeNull();
  });

  it("says the age in words", () => {
    expect(researchAgeText(0)).toBe("Researched today");
    expect(researchAgeText(1)).toBe("Researched yesterday");
    expect(researchAgeText(41)).toBe("Researched 41 days ago");
  });
});

describe("researchRule: the line for score and tailor prompts", () => {
  const file = "companies/acme-corp/research.md";
  it("lets fresh research be used as background, with its URLs", () => {
    expect(researchRule({ at: "2026-10-10", days: 7, stale: false }, file)).toBe(`${file} is 7 days old. You may use it as background; a fact from it that goes into my documents keeps its source URL.`);
  });
  it("tells Claude not to reuse stale research and to ask for a refresh", () => {
    const r = researchRule({ at: "2026-09-06", days: 41, stale: true }, file);
    expect(r).toMatch(/41 days old, older than 30 days, so it is stale/);
    expect(r).toMatch(/refresh the company research/);
  });
  it("says nothing without research", () => {
    expect(researchRule(null, file)).toBe("");
  });
});
