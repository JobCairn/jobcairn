import type { WorkRightsLabel, WorkRightsStatus } from "./types.js";

/** Whether a candidate with this work-rights status can apply to a job with this ad label. */
export function isEligible(status: WorkRightsStatus, label: WorkRightsLabel): boolean {
  if (status === "citizen" || status === "pr" || status === "unknown") return true;
  return label !== "citizen_pr_only" && label !== "clearance";
}

/** Sort key: ads that offer sponsorship always come first. */
export function pinRank(label: WorkRightsLabel): number {
  return label === "sponsorship_offered" ? 0 : 1;
}
