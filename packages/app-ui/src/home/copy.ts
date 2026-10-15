// Plain-English text for the Home dashboard. Pure functions, so tests can check the wording.
import { WR_LABEL_TEXT, type FunnelView, type HomeAnalytics, type RankedJob, type SponsorshipFocus, type WorkRightsLabel } from "@careeros/contract";
import { plural } from "../format";

/** "today", "yesterday", "3 days ago", "5 weeks ago". TODO(lane-B): move to format.ts. */
export function daysAgoText(n: number | null): string {
  if (n === null) return "";
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 21) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  return `${Math.round(n / 30)} months ago`;
}

/** "about 3 days" for a median stay; "same day" under a day. */
export function stayText(d: number | null): string {
  if (d === null) return "";
  if (d < 1) return "under a day";
  const n = Math.round(d);
  return `about ${plural(n, "day")}`;
}

export const pct = (x: number | null) => (x === null ? "" : `${Math.round(x * 100)}%`);
export const money = (n: number) => `$${n.toLocaleString("en-AU")}`;

/** The coaching line shown instead of a big zero. */
export function coachText(stage: FunnelView["stages"][number]["stage"], f: FunnelView): string {
  const lastAppliedDays = f.lastAppliedDays;
  const at = (s: string) => f.stages.find((x) => x.stage === s)!;
  switch (stage) {
    case "found": return "No roles yet. Run a search, or use Add job to paste a link.";
    case "shortlisted": return "Nothing shortlisted yet. Save the roles worth a closer look.";
    case "applying": return at("shortlisted").now ? `Nothing in progress. ${plural(at("shortlisted").now, "shortlisted role")} ready to prepare.` : "Nothing in progress. Prepare a shortlisted role.";
    case "applied": return at("applying").now ? `Nothing sent yet. ${plural(at("applying").now, "application")} being prepared.` : "Nothing sent yet.";
    case "interview":
      if (!f.awaitingReply) return "Interviews show up here once you apply.";
      return `No replies yet. ${plural(f.awaitingReply, "application")} out${lastAppliedDays === null ? "" : `, latest sent ${daysAgoText(lastAppliedDays)}`}.`;
    case "offer": return at("interview").now ? `No offers yet. ${plural(at("interview").now, "interview")} under way.` : "Offers show up here after interviews.";
  }
}

const LABEL_REASON: Record<WorkRightsLabel, string> = {
  sponsorship_offered: "Ad says sponsorship", visa_ok: "Open to visa holders", silent: "Ad silent on visas",
  citizen_pr_only: WR_LABEL_TEXT.citizen_pr_only, clearance: WR_LABEL_TEXT.clearance,
};

/**
 * The work-rights part of a reason line, for this candidate. Sponsorship wording shows only when sponsorship
 * matters to them; with a temporary visa it is plain info, and "silent" says nothing worth reading.
 */
function rightsReason(label: WorkRightsLabel, focus: SponsorshipFocus): string | null {
  if (focus === "primary") return LABEL_REASON[label];
  if (label === "citizen_pr_only" || label === "clearance") return LABEL_REASON[label];
  if (focus === "secondary" && label !== "silent") return label === "sponsorship_offered" ? "Ad mentions sponsorship" : LABEL_REASON[label];
  return null;
}

/** One reason line for a Next up row. */
export function reasonText(j: RankedJob, focus: SponsorshipFocus = "primary"): string {
  const parts: string[] = [];
  const rights = rightsReason(j.wr_label, focus);
  if (rights) parts.push(rights);
  if (j.action === "follow_up" && j.waitingDays !== null) parts.unshift(`Applied ${daysAgoText(j.waitingDays)}, no reply yet`);
  parts.push(j.fit === null ? "not scored yet" : `fit ${j.fit}`);
  if (j.sponsor !== null && focus !== "off") parts.push(`sponsor ${j.sponsor}`);
  if (j.salary) parts.push(j.salary);
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ageText(j: { ageDays: number | null; ageFrom: "posted" | "found" }): string {
  return j.ageDays === null ? "" : `${j.ageFrom === "posted" ? "Posted" : "Found"} ${daysAgoText(j.ageDays)}`;
}

/** The Today sentence. */
export function todaySentence(a: HomeAnalytics, total: number): string {
  const t = a.today;
  const parts: string[] = [];
  if (t.readySponsored) parts.push(`${plural(t.readySponsored, "role says it sponsors", "roles say they sponsor")} and ${t.readySponsored === 1 ? "is" : "are"} ready to apply`);
  if (t.interviews) parts.push(`${plural(t.interviews, "interview")} to prepare for`);
  if (t.followUpsDue) parts.push(`${plural(t.followUpsDue, "follow-up")} due`);
  if (t.deadlineDays !== null) {
    parts.push(t.deadlineDays > 0 ? `${plural(t.deadlineDays, "day")} until your search deadline` : t.deadlineDays === 0 ? "your search deadline is today" : `your search deadline passed ${plural(-t.deadlineDays, "day")} ago`);
  }
  if (!parts.length) {
    if (!total) return "Start by adding roles: run a search, or use Add job to paste a link.";
    if (a.map.unscored.length) return `Nothing urgent. ${plural(a.map.unscored.length, "role")} still need${a.map.unscored.length === 1 ? "s" : ""} a score.`;
    return "Nothing urgent. Prepare your best match.";
  }
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}
