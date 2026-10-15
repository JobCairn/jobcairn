import type { PillTone } from "@careeros/brand";
import { sponsorshipFocus, WR_STATUSES, type SponsorshipFocus, type WorkRightsLabel, type WorkRightsStatus } from "@careeros/contract";
import { useLoad } from "./bridge-context";
import { wrTone } from "./format";

/** The candidate's work-rights status from settings/profile.json (`work_rights.status`). */
export function statusOf(values: Record<string, unknown> | undefined): WorkRightsStatus {
  const wr = values?.work_rights;
  const s = wr && typeof wr === "object" ? (wr as Record<string, unknown>).status : undefined;
  return (WR_STATUSES as readonly unknown[]).includes(s) ? (s as WorkRightsStatus) : "unknown";
}

/**
 * The candidate's work-rights status and how much sponsorship matters to them. Follows Settings
 * live (a profile save emits "settings"). `null` until the profile has loaded, so sponsorship UI
 * never flashes for someone who doesn't need it.
 */
export function useCandidate(): { status: WorkRightsStatus; focus: SponsorshipFocus } | null {
  const { data } = useLoad((b) => b.settings.get("profile"), [], ["settings"]);
  if (!data) return null;
  const status = statusOf(data.values);
  return { status, focus: sponsorshipFocus(status) };
}

/**
 * How a job's work-rights label shows for this candidate: a pill tone, or null to hide it.
 * - primary: the usual tones (sponsorship offered is good news, citizens/PR only is a blocker).
 * - secondary: sponsorship is plain info, so it shows neutral; blockers keep their tone.
 * - off: sponsorship wording is hidden. "Citizens/PR only" is neutral (it doesn't bar them);
 *   a clearance requirement can still bar a citizen, so it keeps its tone.
 */
export function rightsTone(label: WorkRightsLabel, focus: SponsorshipFocus): PillTone | null {
  if (focus === "primary") return wrTone(label);
  if (label === "sponsorship_offered" || label === "visa_ok" || label === "silent") return focus === "off" ? null : "neutral";
  if (label === "citizen_pr_only" && focus === "off") return "neutral";
  return wrTone(label);
}
