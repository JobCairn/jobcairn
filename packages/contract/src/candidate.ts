import type { WorkRightsStatus } from "./constants.js";

/**
 * How much visa sponsorship matters to this candidate, from their work-rights status.
 * - primary: they need sponsorship. Show sponsor scores, pin ads that offer it, rank by it.
 * - secondary: temporary visa with work rights. Show sponsorship as background info only.
 * - off: citizens, permanent residents, and anyone who prefers not to say. Hide it entirely.
 * Eligibility (which ads are filtered out) is a separate rule: see isEligible.
 */
export type SponsorshipFocus = "primary" | "secondary" | "off";

export function sponsorshipFocus(status: WorkRightsStatus): SponsorshipFocus {
  switch (status) {
    case "needs_sponsorship": return "primary";
    case "full_visa": case "limited_visa": return "secondary";
    default: return "off";
  }
}

/** Show sponsor columns, scores, the Sponsors screen and sponsorship cards. */
export const showSponsorship = (status: WorkRightsStatus): boolean => sponsorshipFocus(status) !== "off";

/** Pin sponsorship-offered ads, rank and sort by sponsor score, and use the 482 salary bands. */
export const prioritiseSponsorship = (status: WorkRightsStatus): boolean => sponsorshipFocus(status) === "primary";

/** The work-rights line for a job-search prompt, written for this candidate. */
export function jobSearchRightsRule(status: WorkRightsStatus): string {
  switch (status) {
    case "citizen": case "pr":
      return "I have full, unrestricted work rights, so don't filter ads on work-rights wording.";
    case "needs_sponsorship":
      return "Read each whole ad for work-rights wording. Skip ads that need citizenship, permanent residency or a security clearance I don't have. Put ads that offer visa sponsorship first in the report. When the wording is unclear or the ad says nothing, keep the ad and note it, unless I chose to see just the ads that offer sponsorship.";
    case "full_visa":
      return "I have full work rights on a temporary visa. Read each whole ad for work-rights wording and skip ads that need citizenship, permanent residency or a security clearance. Note any sponsorship offer, but don't rank by it. When the wording is unclear or the ad says nothing, keep the ad and note it.";
    case "limited_visa":
      return "My visa limits my work rights. Read each whole ad for work-rights wording and skip ads that need citizenship, permanent residency or a security clearance. Note hours, contract type and any sponsorship offer. When the wording is unclear or the ad says nothing, keep the ad and note it.";
    default:
      return "Don't filter ads on work-rights wording.";
  }
}
