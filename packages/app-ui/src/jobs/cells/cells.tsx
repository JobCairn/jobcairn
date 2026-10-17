// Table cells for a job's Fit, Sponsor likelihood, Status, Work rights and Languages. Each pairs an icon or bar with a word,
// so colour is never the only signal; the full wording is the tooltip and the screen-reader text.
import type { MouseEvent } from "react";
import { cx, Icon, Icons } from "@careeros/brand";
import { SPONSOR_REASONS_SHOWN, type JobStatus, type LanguageCheck, type SponsorshipFocus, type WorkRightsLabel } from "@careeros/contract";
import { ScoreMeter } from "../../components/ScoreMeter";
import { fitView, rightsView, sponsorView, statusView } from "./meta";
import "./cells.css";

/** Fit as a number and a short bar banded by the scoring rubric. Not scored: a quiet Score button with the AI mark, always visible (quiet words only where scoring isn't offered). */
export function FitCell({ fit, onScore, name }: { fit: number | null; onScore?: () => void; /** The job, for the Score button's accessible name. */ name?: string }) {
  const v = fitView(fit);
  if (v) return <span className="cell-fit"><ScoreMeter value={v.value} band={`fit-${v.band}`} label={`Fit ${v.label}`} /></span>;
  const score = (e: MouseEvent) => { e.stopPropagation(); onScore?.(); };
  return (
    <span className="cell-fit-empty">
      {onScore
        ? <button type="button" className="cell-action" onClick={score} aria-label={name ? `Score ${name}` : "Score this job"} title="Not scored yet. Ask Claude to score it."><Icon icon={Icons.ai} size="sm" />Score</button>
        : <span className="cell-fit-empty__text">Not scored</span>}
    </span>
  );
}

/** Sponsor reasons as sentences: blank lines dropped, first letter capitalised, at most `max` (the top few by default). */
export function sponsorReasons(reasons: readonly string[] = [], max = SPONSOR_REASONS_SHOWN): string[] {
  return reasons.map((r) => String(r).trim()).filter(Boolean).slice(0, max).map((r) => `${r.charAt(0).toUpperCase()}${r.slice(1)}`);
}

/** Sponsor likelihood: a tier word (the number is in the tooltip and drives sorting). "Confirmed" (the ad says so) gets a shield and bold type; a blocker gets a crossed shield. */
export function SponsorCell({ score, label, reasons = [] }: { score: number | null; label: WorkRightsLabel; /** Evidence lines for the tooltip (the company page has them). */ reasons?: string[] }) {
  const v = sponsorView(score, label);
  const top = sponsorReasons(reasons);
  const title = [v.title, ...top.map((r) => `• ${r}`)].join("\n");
  const spoken = v.value === null ? v.word : `${v.word}, ${v.value} of 100`;
  return (
    <span className={cx("cell-sponsor", `cell-tone--${v.tone}`, v.kind === "explicit" && "cell-sponsor--explicit", v.kind === "unknown" && "cell-sponsor--unknown")} title={title} data-score={v.value ?? undefined}
      aria-description={top.length ? `Why: ${top.map((r) => r.replace(/[.\s]+$/, "")).join(". ")}.` : undefined}>
      <span className="cell-sponsor__mark" aria-hidden="true">{v.icon ? <Icon icon={Icons[v.icon]} size="sm" /> : v.kind === "tier" ? <span className="cell-dot" /> : null}</span>
      <span className="cell-sponsor__word" aria-hidden="true">{v.word}</span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

/** A job's stage: its own icon and word. Offer is the one filled tag. */
export function StatusCell({ status }: { status: JobStatus }) {
  const v = statusView(status);
  return (
    <span className={cx("cell-tag", `cell-tone--${v.tone}`, v.strong && "cell-tag--filled")} title={v.word}>
      <Icon icon={Icons[v.icon]} size="sm" className="cell-tag__icon" />
      <span className="cell-tag__word">{v.word}</span>
    </span>
  );
}

/** The ad's work-rights wording as an icon and a short word. Only "Sponsorship offered" (for someone who needs it) is filled. */
export function RightsCell({ label, focus }: { label: WorkRightsLabel; focus: SponsorshipFocus }) {
  const v = rightsView(label, focus);
  if (!v) return null;
  // Neutral wording (an ad that's silent, or sponsorship that doesn't matter to this person) stays quiet.
  const tone = v.tone === "neutral" ? "muted" : v.tone;
  return (
    <span className={cx("cell-tag", `cell-tone--${tone}`, v.filled && "cell-tag--filled")} title={v.full}>
      <Icon icon={Icons[v.icon]} size="sm" className="cell-tag__icon" />
      <span className="cell-tag__word" aria-hidden="true">{v.short}</span>
      <span className="sr-only">{v.full}</span>
    </span>
  );
}

/**
 * What the ad needs in languages against the profile: a crossed shield for a language the person hasn't listed
 * ("Needs German"), a watch-out mark for a higher level than declared. Nothing when it's fine or unknown.
 */
export function LanguageCell({ check }: { check: LanguageCheck | undefined }) {
  if (!check || check.verdict === "unknown") return null;
  const block = check.verdict === "block";
  return (
    <span className={cx("cell-tag", `cell-tone--${block ? "danger" : "warning"}`)} title={check.text}>
      <Icon icon={block ? Icons.sponsorNo : Icons.watchOut} size="sm" className="cell-tag__icon" />
      <span className="cell-tag__word" aria-hidden="true">{check.short}</span>
      <span className="sr-only">{check.text}</span>
    </span>
  );
}
