// What the Jobs table's Fit, Sponsor, Status and Work rights cells say, as plain data (no React), so the
// wording and tones are tested once and reused by every list that shows these values.
import type { IconKey } from "@careeros/brand";
import { sponsorTierOf, WR_LABEL_TEXT, type JobStatus, type SponsorshipFocus, type WorkRightsLabel } from "@careeros/contract";
import { rightsTone } from "../../candidate";

/** Cell tones. "muted" is quiet secondary text; "neutral" is normal text. */
export type CellTone = "success" | "accent" | "info" | "warning" | "danger" | "neutral" | "muted";

// ---- Fit ------------------------------------------------------------------------------------------

export type FitBand = "top" | "high" | "mid" | "low";
export interface FitView { value: number; band: FitBand; label: string }

const FIT_WORDS: Record<FitBand, string> = { top: "strong match", high: "good match", mid: "partial match", low: "weak match" };

/**
 * The fit as a band. The scoring rubric calls a match "strong" from about 85 and "good" from about 70
 * (plugin/skills/career/references/job-scoring-rubric.md). The rubric's tier names also need the interview
 * odds, which a list row doesn't have, so the cell never prints them.
 */
export function fitView(fit: number | null): FitView | null {
  if (fit === null || !Number.isFinite(fit)) return null;
  const value = Math.max(0, Math.min(100, Math.round(fit)));
  const band: FitBand = value >= 85 ? "top" : value >= 70 ? "high" : value >= 50 ? "mid" : "low";
  return { value, band, label: `${value} of 100, ${FIT_WORDS[band]}` };
}

// ---- Sponsor --------------------------------------------------------------------------------------

export interface SponsorView {
  kind: "explicit" | "tier" | "blocked" | "unknown";
  word: string; tone: CellTone; icon: IconKey | null; value: number | null;
  /** The tooltip: what the word means and where the number comes from. */
  title: string;
}

const OPEN_FOR_EVIDENCE = "Open the job for the evidence.";
const outOf = (n: number | null) => (n === null ? "" : ` Likelihood ${n} of 100.`);

/**
 * The sponsor likelihood as a tier word plus the number. An ad that offers sponsorship is the loudest state;
 * an ad that rules it out (or a sanctioned employer, the only way to score 0) reads as a blocker.
 * The tier words are the Companies screen's (sponsorTierOf), so both screens agree.
 */
export function sponsorView(score: number | null, label: WorkRightsLabel): SponsorView {
  const value = score === null || !Number.isFinite(score) ? null : Math.max(0, Math.min(100, Math.round(score)));
  if (label === "sponsorship_offered") {
    return { kind: "explicit", word: "Confirmed", tone: "success", icon: "sponsorYes", value, title: `The ad says sponsorship is available.${outOf(value)}` };
  }
  if (label === "citizen_pr_only" || label === "clearance") {
    const why = label === "clearance" ? "The ad needs a security clearance." : "The ad needs citizenship, PR or full work rights.";
    return { kind: "blocked", word: "Ruled out", tone: "danger", icon: "sponsorNo", value, title: `${why}${outOf(value)}` };
  }
  if (value === null) return { kind: "unknown", word: "Unknown", tone: "neutral", icon: null, value, title: "No sponsor score was saved with this job (jobs found before scores were added at import, or added by hand). The company's page on Companies has its score." };
  if (value === 0) return { kind: "blocked", word: "Avoid", tone: "danger", icon: "sponsorNo", value, title: `This employer is on the sanctioned-sponsors register.${outOf(value)}` };
  const word = sponsorTierOf(value);
  // Traffic light: green for likely, amber for maybe, red for unlikely. Blockers above are red with a crossed shield.
  const tone: CellTone = value >= 65 ? "success" : value >= 45 ? "warning" : "danger";
  return { kind: "tier", word, tone, icon: null, value, title: `${word} chance this employer sponsors.${outOf(value)} ${OPEN_FOR_EVIDENCE}` };
}

// ---- Status ---------------------------------------------------------------------------------------

export interface StatusView { word: string; tone: CellTone; icon: IconKey; strong?: boolean }

/** Every stage has its own icon and word. Colour follows the pipeline: quiet to start, green for good news, red for a no. */
const STATUS_VIEW: Record<JobStatus, StatusView> = {
  Found: { word: "Found", tone: "muted", icon: "found" },
  Saved: { word: "Saved", tone: "neutral", icon: "saved" },
  Applying: { word: "Applying", tone: "accent", icon: "applying" },
  Applied: { word: "Applied", tone: "info", icon: "send" },
  Interview: { word: "Interview", tone: "success", icon: "interview" },
  Offer: { word: "Offer", tone: "success", icon: "offer", strong: true },
  Rejected: { word: "Rejected", tone: "danger", icon: "rejected" },
  "No response": { word: "No response", tone: "muted", icon: "noResponse" },
  Withdrawn: { word: "Withdrawn", tone: "muted", icon: "withdrawn" },
  Skipped: { word: "Skipped", tone: "muted", icon: "skipped" },
};
export const statusView = (s: JobStatus): StatusView => STATUS_VIEW[s] ?? { word: s, tone: "neutral", icon: "found" };

// ---- Work rights ----------------------------------------------------------------------------------

export interface RightsView { short: string; full: string; tone: CellTone; icon: IconKey; filled: boolean }

const RIGHTS_SHORT: Record<WorkRightsLabel, { short: string; icon: IconKey }> = {
  sponsorship_offered: { short: "Sponsors", icon: "sponsorYes" },
  visa_ok: { short: "Visa OK", icon: "visaOk" },
  silent: { short: "Silent", icon: "silent" },
  citizen_pr_only: { short: "PR only", icon: "sponsorNo" },
  clearance: { short: "Clearance", icon: "locked" },
};

/**
 * The ad's work-rights wording as an icon and a short word, or null to hide it (rightsTone decides, per
 * candidate). Only "Sponsorship offered" for someone who needs sponsorship gets a filled, coloured tag.
 */
export function rightsView(label: WorkRightsLabel, focus: SponsorshipFocus): RightsView | null {
  const tone = rightsTone(label, focus);
  if (!tone) return null;
  const { short, icon } = RIGHTS_SHORT[label];
  const filled = label === "sponsorship_offered" && tone === "success";
  return { short, full: WR_LABEL_TEXT[label], tone, icon, filled };
}
