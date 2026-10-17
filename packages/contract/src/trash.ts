import { resumeItemRef, type ResumeItemRef } from "./resume.js";
import { ArgError, bool, fileName, obj, oneOf, relPath, slug, str, type V } from "./validate.js";
import { videoFolder } from "./video.js";

/**
 * Delete in the app: the item moves to the workspace's trash (.backup/trash), never away for good. Undo puts it back,
 * Settings › Workspace › Recently deleted lists it for 30 days, then it is removed when the app opens.
 * Every target is named by slugs and checked folder names, never by a path the renderer chose.
 */
export type TrashTarget =
  | { kind: "job"; company_slug: string; id: string }
  | { kind: "company"; company_slug: string }
  | { kind: "resume"; ref: ResumeItemRef }
  /** A Learn topic: its folder name under learning/. */
  | { kind: "topic"; topic: string }
  /** A video folder (VideoListItem.folder). */
  | { kind: "video"; folder: string }
  /** A research topic: its folder name under research/ (with its report, exports and videos). */
  | { kind: "research"; topic: string }
  /** One of a job's own files (JobFile.path, inside the job folder), such as application/cover-letter.md. */
  | { kind: "job_file"; company_slug: string; id: string; path: string };
export type TrashTargetKind = TrashTarget["kind"];
export const TRASH_TARGET_KINDS = ["job", "company", "resume", "topic", "video", "job_file", "research"] as const satisfies readonly TrashTargetKind[];

/** What a confirm dialog says before anything moves. `blocked`: why it can't be deleted right now (a run is working on it). */
export interface TrashCheck {
  /** The item's name: "Adpen", "AI Engineer at Adpen". */
  title: string;
  /** What goes with it, to follow "and" ("its 2 jobs"), or "". */
  also: string;
  /** One more plain sentence for the dialog ("Its 3 emails stay in Mail, under To sort."), or "". */
  note: string;
  blocked: string | null;
}

/** One entry in Recently deleted. */
export interface TrashItem {
  id: string;
  kind: TrashTargetKind;
  title: string;
  /** What went with it ("its 2 jobs"), or "". */
  also: string;
  deleted_at: string;
  /** When it goes for good. */
  purge_at: string;
}

/** An entry's id: the folder name the services made (checked again there before any use). */
export const trashId = str({ min: 20, max: 140, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z-]{1,20}-[a-z0-9-]{1,80}$/ });

const shapes: Record<TrashTargetKind, V<unknown>> = {
  job: obj({ kind: oneOf(["job"] as const), company_slug: slug, id: slug }),
  company: obj({ kind: oneOf(["company"] as const), company_slug: slug }),
  resume: obj({ kind: oneOf(["resume"] as const), ref: resumeItemRef }),
  topic: obj({ kind: oneOf(["topic"] as const), topic: fileName }),
  video: obj({ kind: oneOf(["video"] as const), folder: videoFolder }),
  job_file: obj({ kind: oneOf(["job_file"] as const), company_slug: slug, id: slug, path: relPath }),
  research: obj({ kind: oneOf(["research"] as const), topic: slug }),
};

export const trashTarget: V<TrashTarget> = (v, at) => {
  const kind = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined;
  if (typeof kind === "string" && Object.hasOwn(shapes, kind)) return shapes[kind as TrashTargetKind](v, at) as TrashTarget;
  throw new ArgError(`${at}.kind must be one of: ${TRASH_TARGET_KINDS.join(", ")}`);
};

/** "Delete forever" only with this set: the UI asks first. */
export const trashConfirm = bool;
