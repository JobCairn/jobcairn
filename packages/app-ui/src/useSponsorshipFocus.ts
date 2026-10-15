import { prioritiseSponsorship, sponsorshipFocus, showSponsorship, type SponsorshipFocus, type WorkRightsStatus } from "@careeros/contract";
import { useLoad } from "./bridge-context";
import { workRightsStatusOf } from "./format";

export interface SponsorshipFocusInfo {
  status: WorkRightsStatus;
  focus: SponsorshipFocus;
  /** Show sponsor columns, scores, the sponsorship parts of Companies and sponsorship cards. */
  showSponsorship: boolean;
  /** Pin sponsorship-offered ads, rank/sort by sponsor score, and use the 482 salary bands. */
  prioritiseSponsorship: boolean;
  loading: boolean;
}

/**
 * The candidate's sponsorship focus (see candidate.ts), read from the profile's work_rights.status
 * through the generic settings.get("profile"). While it's loading (or on a workspace with no
 * profile yet) it reads as "unknown" -> "off", the safe, no-sponsorship-shown default, so a
 * screen never flashes sponsorship content before the real status arrives.
 */
export function useSponsorshipFocus(): SponsorshipFocusInfo {
  const { data, loading } = useLoad((b) => b.settings.get("profile"), [], ["settings"]);
  const status = workRightsStatusOf(data?.values);
  return {
    status, focus: sponsorshipFocus(status), showSponsorship: showSponsorship(status),
    prioritiseSponsorship: prioritiseSponsorship(status), loading,
  };
}
