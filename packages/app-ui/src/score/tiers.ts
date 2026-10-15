import type { PillTone } from "@careeros/brand";
import type { MustHaveStatus, ScoreItem, ScoreResult, ScoreTier } from "@careeros/contract";

/** Tier colours: red for no-go, amber for weak, neutral for middling, green for good, the accent for "apply now". */
export const TIER_TONE: Record<ScoreTier, PillTone> = {
  "Definite No Go": "danger", Nah: "warning", Meh: "neutral", "Good Fit": "success", "Freaking Apply Now": "accent",
};

/** One must-have status: its mark, words and colour. The words are always shown, so colour is never the only signal. */
export const STATUS: Record<MustHaveStatus, { mark: string; label: string; tone: "success" | "warning" | "danger" }> = {
  met: { mark: "✓", label: "Met", tone: "success" },
  partial: { mark: "◐", label: "Partial", tone: "warning" },
  not_met: { mark: "✗", label: "Not met", tone: "danger" },
};

/** The skills to study: must-haves not met first, then partial ones, else the job's gap list. At most 12. */
export function gapsOf(score: ScoreResult | null | undefined, fallback: string[]): string[] {
  const items: ScoreItem[] = score?.must_haves ?? [];
  const pick = (s: MustHaveStatus) => items.filter((m) => m.status === s).map((m) => m.text);
  const out = [...pick("not_met"), ...pick("partial")];
  return (out.length ? out : fallback).filter((x, i, a) => a.indexOf(x) === i).slice(0, 12);
}

/** "3 of 5 met" for a checklist heading. */
export function metLine(items: ScoreItem[]): string {
  const met = items.filter((m) => m.status === "met").length;
  return `${met} of ${items.length} met`;
}
