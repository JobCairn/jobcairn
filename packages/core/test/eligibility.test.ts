import { describe, expect, it } from "vitest";
import { isEligible, pinRank } from "../src/eligibility.js";
import { WR_LABELS } from "../src/types.js";

describe("isEligible", () => {
  it("shows every job to citizens, PR and unknown", () => {
    for (const s of ["citizen", "pr", "unknown"] as const) for (const l of WR_LABELS) expect(isEligible(s, l)).toBe(true);
  });
  it("hides citizen/PR-only and clearance jobs from visa holders and sponsorship seekers", () => {
    for (const s of ["full_visa", "limited_visa", "needs_sponsorship"] as const) {
      expect(isEligible(s, "citizen_pr_only")).toBe(false);
      expect(isEligible(s, "clearance")).toBe(false);
      expect(isEligible(s, "silent")).toBe(true);
      expect(isEligible(s, "visa_ok")).toBe(true);
      expect(isEligible(s, "sponsorship_offered")).toBe(true);
    }
  });
  it("pins sponsorship-offered first", () => {
    expect(pinRank("sponsorship_offered")).toBe(0);
    expect(pinRank("silent")).toBe(1);
  });
});
