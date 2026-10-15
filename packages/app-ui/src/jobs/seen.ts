import type { JobRow } from "@careeros/contract";

/**
 * "12 new": jobs found since you last looked at Jobs. What you've seen is the newest `found_at` on screen when you
 * left, kept per workspace, so it never depends on this computer's clock matching the files.
 */
export const seenKey = (workspace: string) => `careeros.jobs.seen:${workspace}`;

export function newestFound(rows: readonly Pick<JobRow, "found_at">[]): string {
  return rows.reduce((m, r) => (r.found_at > m ? r.found_at : m), "");
}

/** Rows found after `seenUpTo`. Nothing is "new" on the very first visit (no baseline yet). */
export function newRows<T extends Pick<JobRow, "found_at">>(rows: readonly T[], seenUpTo: string | null): T[] {
  if (!seenUpTo) return [];
  return rows.filter((r) => r.found_at > seenUpTo);
}

export function readSeen(workspace: string): string | null {
  try { return localStorage.getItem(seenKey(workspace)); } catch { return null; }
}

/** Moves the baseline forward only (a filtered list can't move it back). */
export function writeSeen(workspace: string, upTo: string): void {
  if (!upTo) return;
  try {
    const cur = localStorage.getItem(seenKey(workspace)) ?? "";
    if (upTo > cur) localStorage.setItem(seenKey(workspace), upTo);
  } catch { /* storage off: the chip just doesn't show */ }
}
