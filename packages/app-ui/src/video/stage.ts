import type { VideoListItem, VideoRunView } from "@careeros/contract";

type Status = VideoListItem["status"];
export type StageTone = "success" | "accent" | "danger" | "warning" | "neutral";

/**
 * Where a video is up to, in the same words everywhere it shows (Videos list, a job's Interview tab, the video
 * page, Activity and the finish toast). Making a video has two parts: Claude writes a script and the person
 * reviews it; only after Approve is the video itself made. The words keep those two apart, so a finished script
 * never reads as a finished video.
 */
export const STAGE_TEXT: Record<Status, string> = {
  writing: "Writing the script…", checking: "Checking the script…", review: "Script ready for your review",
  narrating: "Making video…", rendering: "Making video…", preview: "Draft video ready", done: "Video ready",
  failed: "Didn't finish", cancelled: "Stopped",
};
export const STAGE_TONE: Record<Status, StageTone> = {
  writing: "neutral", checking: "neutral", review: "accent", narrating: "neutral", rendering: "neutral",
  preview: "accent", done: "success", failed: "danger", cancelled: "warning",
};
export function videoStage(status: Status): { text: string; tone: StageTone } {
  return { text: STAGE_TEXT[status] ?? "Video", tone: STAGE_TONE[status] ?? "neutral" };
}

/**
 * The short form of why a video stopped, for a chip: its first sentence, lower-cased to follow "Didn't finish: ",
 * without the trailing full stop and capped at `max` characters. "" when there is no reason.
 */
export function shortReason(error: string | undefined, max = 60): string {
  const first = String(error ?? "").replace(/\s+/g, " ").trim().split(/(?<=\.)\s/)[0] ?? "";
  const plain = first.replace(/\.$/, "");
  if (!plain) return "";
  const lower = /^[A-Z][a-z]/.test(plain) ? plain[0]!.toLowerCase() + plain.slice(1) : plain;
  return lower.length > max ? `${lower.slice(0, max - 1).trimEnd()}…` : lower;
}

/** A video's status words with the reason when it stopped: "Didn't finish: the video check found 1 problem". */
export function videoStatus(status: Status, error?: string): { text: string; tone: StageTone; title?: string } {
  const base = videoStage(status);
  const why = status === "failed" ? shortReason(error) : "";
  return why ? { ...base, text: `${base.text}: ${why}`, title: String(error).trim() } : base;
}

/** Minutes to make the video once the script is approved: narration and renders only (the script is done). */
export function minutesToMake(videoSeconds: number, perVideoSecond: number): number {
  const v = Number.isFinite(videoSeconds) && videoSeconds > 0 ? videoSeconds : 0;
  return Math.max(1, Math.ceil((v * perVideoSecond) / 60));
}

/** Statuses that mean a step is under way. With no live run for the folder, the record is left over: it stopped. */
const IN_PROGRESS = new Set<Status>(["writing", "checking", "narrating", "rendering"]);

/** What a row can offer: make the video from its script, make it again from scratch, try the failed step again, or just open it. */
export type VideoNext = "make" | "remake" | "retry" | "open";
export interface VideoState { kind: "done" | "draft" | "running" | "script" | "legacy" | "failed" | "stale" | "cancelled"; text: string; tone: StageTone; next: VideoNext; title?: string }

/** The step a live run is on, in lower case for "Making it: narrating". */
function runStep(run: VideoRunView): string {
  const s = run.stages.find((x) => x.status === "running") ?? run.stages.find((x) => x.status === "pending");
  if (run.status === "queued") return "waiting for another video";
  const label = s?.label ?? "";
  return label ? label[0]!.toLowerCase() + label.slice(1) : "";
}

/**
 * One reading of where a listed video is, for a job's Videos tab and the Videos screen. `runs` are the live runs
 * (video.runs()): a record that says "rendering" with no live run was left over from a run that ended without
 * saving (the app quit, or the computer slept), so it shows as stopped with Try again, never as still making.
 */
export function videoState(v: Pick<VideoListItem, "folder" | "status" | "error" | "legacy" | "final" | "draft">, runs: readonly VideoRunView[] = []): VideoState {
  if (v.legacy) return { kind: "legacy", text: "Script only, not made yet", tone: "neutral", next: "remake" };
  const live = runs.find((r) => r.folder === v.folder && (r.status === "queued" || r.status === "running"));
  if (live) {
    const step = runStep(live);
    return { kind: "running", text: step ? `Making it: ${step}` : "Making it", tone: "accent", next: "open" };
  }
  if (IN_PROGRESS.has(v.status)) {
    // A build step can be tried again; a script that stopped being written is fixed on the video's page.
    const build = v.status === "narrating" || v.status === "rendering";
    return { kind: "stale", text: "Stopped before it finished", tone: "warning", next: build ? "retry" : "open" };
  }
  switch (v.status) {
    case "done": return { kind: "done", text: "Done", tone: "success", next: "open" };
    case "preview": return { kind: "draft", text: "Draft ready", tone: "accent", next: "open" };
    case "review": return { kind: "script", text: "Script only, not made yet", tone: "neutral", next: "make" };
    case "cancelled": return { kind: "cancelled", text: "Stopped", tone: "warning", next: "open" };
    default: {
      const why = shortReason(v.error);
      return { kind: "failed", text: why ? `Didn't finish: ${why}` : "Didn't finish", tone: "danger", next: "retry", ...(v.error ? { title: String(v.error).trim() } : {}) };
    }
  }
}

/** How long making a video took, in plain words: "under a minute", "9 min", "1 h 5 min". "" when unknown. */
export function fmtMaking(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 60_000) return "under a minute";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
