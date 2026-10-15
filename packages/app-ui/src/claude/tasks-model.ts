import type { ClaudeRunView, VideoRunView } from "@careeros/contract";
import type { Route } from "../router";
import { chipVerb, doneText, resultLink, runLabel } from "./activity-model";
import { videoStatus } from "../video/stage";

/**
 * Everything the Activity panel and the sidebar line follow, as one list: Claude runs and video jobs (a video's
 * script writer is part of its video job, so it isn't listed twice). Pure, so it's tested without a bridge.
 */
export type TaskStatus = "queued" | "running" | "review" | "done" | "failed" | "stopped";
export interface TaskEntry {
  /** "claude:<run id>" or "video:<run id>". */
  id: string;
  kind: "claude" | "video";
  /** "Score this job", "Video". */
  label: string;
  /** What it's doing, for the sidebar: "Scoring", "Making a video". */
  verb: string;
  status: TaskStatus;
  started_at: string;
  ended_at: string;
  open: { label: string; to: Route | null };
  /** What a finished task made, for toasts: "Score ready", "Video ready". */
  done: string;
  /** A video's stage in words, for its Activity row: "Script ready for your review", "Making video…". */
  stage?: string;
  /** The setup test run: no toast, notification or History line. */
  quiet?: boolean;
}

export const HISTORY_CAP = 50;
/** Tasks shorter than this never raise an OS notification. */
export const NOTIFY_AFTER_MS = 30_000;

const CLAUDE_STATUS: Record<ClaudeRunView["status"], TaskStatus> = { queued: "queued", running: "running", succeeded: "done", failed: "failed", cancelled: "stopped" };
const VIDEO_STATUS: Record<VideoRunView["status"], TaskStatus> = { queued: "queued", running: "running", review: "review", preview: "done", done: "done", failed: "failed", cancelled: "stopped" };

export function claudeTask(run: ClaudeRunView): TaskEntry {
  return {
    id: `claude:${run.id}`, kind: "claude", label: runLabel(run), verb: chipVerb(run.action), status: CLAUDE_STATUS[run.status],
    started_at: run.started_at, ended_at: run.ended_at, open: resultLink(run), done: doneText(run), ...(run.action === "test" ? { quiet: true } : {}),
  };
}

/**
 * A video job. Making a video has two parts, and the words keep them apart: Claude writes a script, which waits for
 * your review ("Script ready: review it to make the video"); only after you approve is the video made.
 */
export function videoTask(v: VideoRunView, typeLabel?: string): TaskEntry {
  const status = VIDEO_STATUS[v.status];
  const stage = videoStatus(v.status === "queued" || v.status === "running" ? (v.phase === "write" ? "writing" : "rendering") : v.status, v.error).text;
  return {
    id: `video:${v.runId}`, kind: "video", label: typeLabel ? `Video: ${typeLabel}` : "Video", verb: v.phase === "write" ? "Writing a video script" : "Making a video",
    status, started_at: v.started_at, ended_at: "", stage,
    open: { label: status === "review" ? "Review script" : status === "done" ? "Watch" : "Open", to: { screen: "video", folder: v.folder } },
    done: v.status === "review" ? "Script ready: review it to make the video" : v.status === "preview" ? "Draft video ready"
      : v.status === "failed" ? videoStatus("failed", v.error).text : v.status === "cancelled" ? "Stopped" : "Video ready",
  };
}

export const isActiveTask = (t: Pick<TaskEntry, "status">) => t.status === "queued" || t.status === "running";

/** Claude runs (minus video script writers, shown as their video job) and video jobs, newest first. */
export function allTasks(runs: readonly ClaudeRunView[], videos: readonly VideoRunView[], typeLabel: (id: string) => string | undefined = () => undefined): TaskEntry[] {
  const list = [
    ...runs.filter((r) => r.action !== "video_script").map(claudeTask),
    ...videos.map((v) => videoTask(v, typeLabel(v.type))),
  ];
  return list.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/** The sidebar's Claude line while work is going: names the one task, or counts several. */
export function sidebarLine(active: readonly TaskEntry[]): string {
  if (!active.length) return "";
  if (active.length === 1) return `Claude · ${active[0]!.verb}`;
  return `Claude · ${active.length} running`;
}

/** A finished task as kept in History: what it was, how it ended, when, and where its result is. */
export interface HistoryEntry { id: string; kind: TaskEntry["kind"]; label: string; status: TaskStatus; started_at: string; ended_at: string; open: TaskEntry["open"] }

export function toHistory(t: TaskEntry, now: string): HistoryEntry {
  return { id: t.id, kind: t.kind, label: t.label, status: t.status, started_at: t.started_at, ended_at: t.ended_at || now, open: t.open };
}

/** Adds newly finished tasks to History: one entry per task (the latest wins), newest first, at most HISTORY_CAP. */
export function mergeHistory(prev: readonly HistoryEntry[], add: readonly HistoryEntry[], cap = HISTORY_CAP): HistoryEntry[] {
  const by = new Map<string, HistoryEntry>();
  for (const e of [...prev, ...add]) by.set(e.id, e);
  return [...by.values()].sort((a, b) => b.ended_at.localeCompare(a.ended_at)).slice(0, cap);
}

/** Reads stored History safely: anything malformed is dropped. */
export function parseHistory(raw: string | null): HistoryEntry[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is HistoryEntry => !!e && typeof e === "object" && typeof (e as HistoryEntry).id === "string"
      && typeof (e as HistoryEntry).label === "string" && typeof (e as HistoryEntry).ended_at === "string").slice(0, HISTORY_CAP);
  } catch { return []; }
}

/** Tasks that were active at the last look and have ended (or reached review) since. */
export function endedSince(before: ReadonlyMap<string, TaskStatus>, tasks: readonly TaskEntry[]): TaskEntry[] {
  return tasks.filter((t) => { const was = before.get(t.id); return was !== undefined && isActiveTask({ status: was }) && !isActiveTask(t); });
}

/** An OS notification only for a task that took a while, while you're in another app, when you've left them on. */
export function shouldNotify(t: TaskEntry, o: { focused: boolean; enabled: boolean; now: number }): boolean {
  if (!o.enabled || o.focused || isActiveTask(t)) return false;
  const started = Date.parse(t.started_at);
  return Number.isFinite(started) && o.now - started >= NOTIFY_AFTER_MS;
}

/** The notification's words: "Score ready" / "Claude didn't finish: Score this job". */
export function notifyText(t: TaskEntry, done: string): { title: string; body: string } {
  if (t.status === "done") return { title: done, body: t.label };
  if (t.status === "review") return { title: done, body: t.label };
  if (t.status === "failed") return { title: "Claude didn't finish", body: t.label };
  return { title: "Stopped", body: t.label };
}

