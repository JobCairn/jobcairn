import type { ApprovalView, JobRow, JobStatus } from "@careeros/contract";
import { resolveBoard } from "../source/boards";

export type StageId = "prepare" | "progress" | "waiting" | "sent" | "interviews" | "closed";
export interface Stage { id: StageId; label: string; statuses: JobStatus[]; empty: string }

/**
 * The Applications stages, left to right. Each job status belongs to exactly one; "Waiting for your OK" is
 * jobs with a pending approval (they also stay in their own status's stage).
 */
export const STAGES: Stage[] = [
  { id: "prepare", label: "To prepare", statuses: ["Found", "Saved"], empty: "No saved jobs are waiting. Find jobs, then save the ones worth applying for." },
  { id: "progress", label: "In progress", statuses: ["Applying"], empty: "No application in progress. Prepare one from To prepare." },
  { id: "waiting", label: "Waiting for your OK", statuses: [], empty: "Nothing is waiting for your OK." },
  { id: "sent", label: "Sent", statuses: ["Applied"], empty: "Nothing sent yet. Applications you mark as sent show up here." },
  { id: "interviews", label: "Interviews", statuses: ["Interview", "Offer"], empty: "No interviews yet. Jobs move here when you set their status to Interview or Offer." },
  { id: "closed", label: "Closed", statuses: ["Rejected", "No response", "Withdrawn", "Skipped"], empty: "Nothing closed. Jobs that were rejected, got no response, were withdrawn or skipped land here." },
];

const keyOf = (r: { company_slug: string; id: string }) => `${r.company_slug}/${r.id}`;

/** Jobs that have a pending approval (apply hand-off, status change, email) naming them. */
export function waitingKeys(approvals: readonly ApprovalView[]): Set<string> {
  const out = new Set<string>();
  for (const a of approvals) {
    const p = a.payload as { company_slug?: unknown; id?: unknown };
    if (a.status === "pending" && typeof p.company_slug === "string" && typeof p.id === "string") out.add(`${p.company_slug}/${p.id}`);
  }
  return out;
}

export function stageRows(id: StageId, rows: readonly JobRow[], waiting: ReadonlySet<string>): JobRow[] {
  if (id === "waiting") return rows.filter((r) => waiting.has(keyOf(r)));
  const st = STAGES.find((s) => s.id === id)!.statuses;
  return rows.filter((r) => st.includes(r.status));
}

export function stageCounts(rows: readonly JobRow[], waiting: ReadonlySet<string>): Record<StageId, number> {
  return Object.fromEntries(STAGES.map((s) => [s.id, stageRows(s.id, rows, waiting).length])) as Record<StageId, number>;
}

/** The tab to open: the one picked earlier this session, else In progress when there is any, else To prepare. */
export function defaultStage(counts: Record<StageId, number>, remembered: StageId | null): StageId {
  if (remembered) return remembered;
  return counts.progress > 0 ? "progress" : "prepare";
}

export interface PrepareFilter { sort: "best" | "fit" | "newest"; fit70: boolean; source: string }

const best = (a: JobRow, b: JobRow) => Number(b.pinned) - Number(a.pinned) || (b.fit ?? -1) - (a.fit ?? -1) || b.found_at.localeCompare(a.found_at);

/** To prepare's filter bar: Fit 70+, a source board, and Best match / Fit / Newest. */
export function filterPrepare(rows: readonly JobRow[], f: PrepareFilter): JobRow[] {
  const out = rows.filter((r) => (!f.fit70 || (r.fit ?? 0) >= 70) && (!f.source || resolveBoard(r).id === f.source));
  const cmp = f.sort === "fit" ? (a: JobRow, b: JobRow) => (b.fit ?? -1) - (a.fit ?? -1) || best(a, b)
    : f.sort === "newest" ? (a: JobRow, b: JobRow) => b.found_at.localeCompare(a.found_at)
    : best;
  return out.sort(cmp);
}

const KEY = "careeros.applications.stage";
export function rememberedStage(): StageId | null {
  try { return (sessionStorage.getItem(KEY) as StageId | null) || null; } catch { return null; }
}
export function rememberStage(s: StageId): void {
  try { sessionStorage.setItem(KEY, s); } catch { /* private mode */ }
}
