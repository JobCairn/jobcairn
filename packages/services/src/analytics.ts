// Gathers what the Home dashboard's analytics need from a workspace: every timeline event with its
// job, the search log and the two goal settings. The numbers themselves are computed by the pure
// functions in @careeros/contract (analytics.ts), which the mock bridge shares.
// Locked folders (me/identity, me/employment) are never read here.
import { buildIndex, layout, openIndex, readRecord, readSearches } from "@careeros/core";
import { isCalendarDate, type HomeGoals, type JobEvent, type SearchLogEntry } from "@careeros/contract";

function eventsFromIndex(root: string): JobEvent[] {
  const sql = "SELECT company_slug, job_id, at, event FROM events";
  const run = () => {
    const db = openIndex(root);
    try { return db.prepare(sql).all() as unknown as JobEvent[]; } finally { db.close(); }
  };
  try { return run(); } catch { buildIndex(root); return run(); }
}

/** The search deadline and weekly goal, or blanks when the settings file is missing or unreadable, or when the deadline is not a real date. */
export function homeGoals(root: string): HomeGoals {
  try {
    const s = readRecord("search", layout(root).search);
    return { search_deadline: typeof s.search_deadline === "string" && isCalendarDate(s.search_deadline) ? s.search_deadline : "", weekly_goal: typeof s.weekly_goal === "number" ? s.weekly_goal : null };
  } catch { return { search_deadline: "", weekly_goal: null }; }
}

export function searchLog(root: string): SearchLogEntry[] {
  try { return readSearches(root).entries.map((e) => ({ at: e.at, site: e.site, results: e.results, kept: e.kept })); } catch { return []; }
}

/** Everything homeAnalytics() needs beyond the job rows. */
export function analyticsInputs(root: string): { events: JobEvent[]; searches: SearchLogEntry[]; goals: HomeGoals } {
  return { events: eventsFromIndex(root), searches: searchLog(root), goals: homeGoals(root) };
}
