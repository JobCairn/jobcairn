import { layout, listJobs, readJson, readSearches, type SearchEntry } from "@careeros/core";
import { boardCounts, boardHealth, boardKey, type BoardHealthWarning, type ClaudeRunView, type HealthJob } from "@careeros/contract";

/**
 * Board health after a Find jobs run (contract board-health.ts), main side: gathers the run's searches from the search
 * log, the jobs it saved, the boards Chrome stopped, and earlier runs' per-board results, then asks the pure check.
 * Best effort: anything unreadable is left out, so a bad file can only mean fewer warnings, never a false one.
 */

const inWindow = (at: string, from: string, to: string) => at >= from && at <= to;

/** Searches logged between a run's start and end. */
function searchesIn(entries: readonly SearchEntry[], run: Pick<ClaudeRunView, "started_at" | "ended_at">, now: string) {
  const to = run.ended_at || now;
  return entries.filter((e) => typeof e.at === "string" && inWindow(e.at, run.started_at, to))
    .map((e) => ({ site: e.site, results: typeof e.results === "string" ? e.results : String(e.results ?? ""), notes: e.notes ?? "" }));
}

/** Jobs saved during the run: job ids start with the UTC day they were found, so only those days' folders are read. */
function jobsIn(root: string, run: Pick<ClaudeRunView, "started_at" | "ended_at">, now: string): HealthJob[] {
  const to = run.ended_at || now;
  const days = new Set([run.started_at.slice(0, 10), to.slice(0, 10)]);
  const names = new Map<string, string>();
  const nameOf = (slug: string) => {
    if (!names.has(slug)) {
      let n = "";
      try { const c = readJson(layout(root).companyFile(slug)) as { name?: unknown }; n = typeof c.name === "string" ? c.name : ""; } catch { /* unnamed */ }
      names.set(slug, n);
    }
    return names.get(slug)!;
  };
  const out: HealthJob[] = [];
  for (const j of listJobs(root)) {
    if (![...days].some((d) => j.id.startsWith(d))) continue;
    try {
      const r = readJson(j.file) as { found_at?: unknown; source_site?: unknown; title?: unknown };
      if (typeof r.found_at !== "string" || !inWindow(r.found_at, run.started_at, to)) continue;
      out.push({ site: typeof r.source_site === "string" ? r.source_site : "", title: typeof r.title === "string" ? r.title : "", company: nameOf(j.company_slug) });
    } catch { /* unreadable jobs are reported by validate */ }
  }
  return out;
}

/**
 * This run's per-board results and its health warnings. `runs`: the run records (newest first, listRuns); earlier
 * Find jobs runs are compared by their stored board_counts, or for older records by the searches logged in their time.
 */
export function runBoardHealth(root: string, run: ClaudeRunView, runs: readonly ClaudeRunView[], now: Date): { counts: Record<string, number>; warnings: BoardHealthWarning[] } {
  const nowIso = now.toISOString();
  let entries: SearchEntry[] = [];
  try { entries = readSearches(root).entries; } catch { entries = []; }
  const searches = searchesIn(entries, run, nowIso);
  const counts = boardCounts(searches);
  const past = runs
    .filter((r) => r.id !== run.id && r.action === "find_jobs" && r.status === "succeeded" && r.started_at < run.started_at && r.ended_at)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .map((r) => r.board_counts ?? boardCounts(searchesIn(entries, r, nowIso)));
  const stopped = (run.browser_diag ?? []).filter((d) => d.diag.outcome !== "ok").map((d) => boardKey(d.board));
  let jobs: HealthJob[] = [];
  try { jobs = jobsIn(root, run, nowIso); } catch { jobs = []; }
  return { counts, warnings: boardHealth({ searches, jobs, stopped, past }) };
}
