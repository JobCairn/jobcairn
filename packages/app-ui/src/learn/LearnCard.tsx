import { Button, Icon, Icons, Pill, Text, type PillTone } from "@careeros/brand";
import type { LearnEntry, LearnProgress, LearnType } from "@careeros/contract";
import { displayName } from "../components/displayName";
import { fmtDate } from "../format";

export const TYPE_TEXT: Record<LearnType, string> = { guide: "Guide", video: "Video", interview: "Interview prep" };
export const PROGRESS_TEXT: Record<LearnProgress, string> = { not_started: "Not started", in_progress: "In progress", done: "Done" };
const PROGRESS_TONE: Record<LearnProgress, PillTone> = { not_started: "neutral", in_progress: "accent", done: "success" };
const TYPE_ICON = { guide: Icons.guide, video: Icons.video, interview: Icons.interview } as const;

/** Where an item came from, in words: "For AI Engineer at Acme Corp". */
export const sourceText = (e: LearnEntry) => (e.source ? `For ${displayName(e.source.title)} at ${displayName(e.source.company_name)}` : "");

export function LearnCard({ entry, onOpen }: { entry: LearnEntry; onOpen: (e: LearnEntry) => void }) {
  const title = displayName(entry.title);
  return (
    <article className="learn-card" data-type={entry.type} data-progress={entry.progress}>
      <div className="learn-card__top">
        <span className="learn-card__type t-label"><Icon icon={TYPE_ICON[entry.type]} size="sm" />{TYPE_TEXT[entry.type]}</span>
        <Pill tone={PROGRESS_TONE[entry.progress]}>{PROGRESS_TEXT[entry.progress]}</Pill>
      </div>
      <h3 className="learn-card__title">
        <button type="button" className="learn-card__open" onClick={() => onOpen(entry)} title={title}>{title}</button>
      </h3>
      <p className="learn-card__meta t-body-sm t-muted">
        {[sourceText(entry), entry.at ? `Added ${fmtDate(entry.at)}` : ""].filter(Boolean).join(" · ") || "In your learning folder"}
      </p>
    </article>
  );
}
