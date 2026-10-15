import { describe, expect, it } from "vitest";
import { WR_STATUSES, jobSearchRightsRule, prioritiseSponsorship, showSponsorship, sponsorshipFocus } from "../src/index.js";

describe("sponsorshipFocus", () => {
  it("puts sponsorship first only for people who need it", () => {
    expect(sponsorshipFocus("needs_sponsorship")).toBe("primary");
    expect(prioritiseSponsorship("needs_sponsorship")).toBe(true);
  });
  it("keeps sponsorship as background info on a temporary visa", () => {
    for (const s of ["full_visa", "limited_visa"] as const) {
      expect(sponsorshipFocus(s)).toBe("secondary");
      expect(showSponsorship(s)).toBe(true);
      expect(prioritiseSponsorship(s)).toBe(false);
    }
  });
  it("hides sponsorship for citizens, permanent residents and prefer-not-to-say", () => {
    for (const s of ["citizen", "pr", "unknown"] as const) {
      expect(sponsorshipFocus(s)).toBe("off");
      expect(showSponsorship(s)).toBe(false);
      expect(prioritiseSponsorship(s)).toBe(false);
    }
  });
  it("covers every status", () => {
    for (const s of WR_STATUSES) expect(["primary", "secondary", "off"]).toContain(sponsorshipFocus(s));
  });
});

describe("jobSearchRightsRule", () => {
  it("never tells a citizen or PR to skip ads or chase sponsorship", () => {
    for (const s of ["citizen", "pr"] as const) {
      const r = jobSearchRightsRule(s);
      expect(r).not.toMatch(/sponsor/i);
      expect(r).not.toMatch(/skip/i);
    }
  });
  it("puts sponsorship first only when it is needed", () => {
    expect(jobSearchRightsRule("needs_sponsorship")).toMatch(/sponsorship first/i);
    expect(jobSearchRightsRule("full_visa")).not.toMatch(/sponsorship first/i);
  });
  it("skips citizen, PR and clearance-only ads for visa holders", () => {
    for (const s of ["needs_sponsorship", "full_visa", "limited_visa"] as const) expect(jobSearchRightsRule(s)).toMatch(/skip ads/i);
  });
  it("does not filter when the status is not shared", () => {
    expect(jobSearchRightsRule("unknown")).not.toMatch(/skip/i);
  });
});
