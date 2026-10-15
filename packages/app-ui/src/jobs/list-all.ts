import type { CareerosBridge, JobQuery } from "@careeros/contract";

/** The most rows one jobs.list call may return (the contract's limit). */
export const LIST_CHUNK = 500;

/**
 * Every job that matches, fetched in chunks. The list pages on screen, so it needs all the matches: one call stops
 * at its limit, and "1–50 of 1000" must not quietly mean "of the first 200".
 */
export async function listAllJobs(b: CareerosBridge, query: JobQuery): ReturnType<CareerosBridge["jobs"]["list"]> {
  const first = await b.jobs.list({ ...query, limit: LIST_CHUNK, offset: 0 });
  const rows = [...first.rows];
  while (rows.length < first.total) {
    const next = await b.jobs.list({ ...query, limit: LIST_CHUNK, offset: rows.length });
    if (!next.rows.length) break;
    rows.push(...next.rows);
  }
  return { ...first, rows };
}
