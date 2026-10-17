import { jobBoardBySite } from "./job-boards.js";

/**
 * Board health: after a Find jobs run, notice a board that has quietly stopped working. Boards change their pages
 * without warning, and a run that reads them then finds nothing, or saves junk, without any error. Two checks, from
 * what the run already holds (nothing is searched again):
 * - returned nothing: every search on the board this run showed 0 results, where past runs usually found some;
 * - looks wrong: most jobs saved from it this run have junk titles (web-page code, very long) or no real company.
 * A board that was blocked (a security check, a sign-in wall, too many requests) is never called broken: the run
 * already says why it stopped. Healthy boards get no line. Pure: main gathers the inputs (services board-health.ts).
 */

/** Past runs compared with: the most recent this many that searched the board. */
export const HEALTH_PAST_RUNS = 5;
/** "Returned nothing" needs at least this many past runs that found some... */
export const HEALTH_MIN_PAST = 2;
/** ...and their middle (median) count at least this. */
export const HEALTH_MIN_USUAL = 3;
/** "Looks wrong" needs at least this many jobs saved from the board this run... */
export const HEALTH_MIN_JOBS = 3;
/** ...and at least this share of them junk. */
export const HEALTH_JUNK_SHARE = 0.5;
/** A title longer than this is page text, not a job title. */
export const HEALTH_MAX_TITLE = 150;

/** One search_add entry: the board as Claude named it, the results it logged ("" when it didn't say) and its notes. */
export interface HealthSearch { site: string; results: string; notes?: string }
/** One job saved this run: where it came from and what was saved. */
export interface HealthJob { site: string; title: string; company: string }

export interface BoardHealthInput {
  /** This run's searches and the jobs it saved. */
  searches: HealthSearch[];
  jobs: HealthJob[];
  /** Boards (keys, see boardKey) the run stopped or couldn't open (Chrome's security check, a lost tab): never judged. */
  stopped?: string[];
  /** Earlier runs' results per board (boardCounts of each run), newest first. */
  past: Record<string, number>[];
}

export interface BoardHealthWarning {
  /** boardKey: a known board's id ("seek"), else the site name lower-cased. */
  board: string;
  /** The board's name as people know it ("SEEK"). */
  name: string;
  kind: "nothing" | "junk";
  /** One plain sentence on what happened. */
  message: string;
  /** One plain sentence on what to do. */
  suggestion: string;
}

/** A board's key: a known board's id, else its name trimmed and lower-cased. "" for no name. */
export function boardKey(site: string): string {
  return jobBoardBySite(site)?.id ?? site.trim().toLowerCase().replace(/\s+/g, " ");
}

const boardName = (site: string) => jobBoardBySite(site)?.name ?? site.trim();

/** A logged results count, or null when Claude left it out or it isn't a whole number (never read as 0). */
export function resultsCount(results: string): number | null {
  const t = (results ?? "").trim();
  return /^\d{1,6}$/.test(t) ? Number(t) : null;
}

/** Results per board for one run: the sum over its searches. Boards whose searches logged no number are left out. */
export function boardCounts(searches: readonly HealthSearch[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of searches) {
    const k = boardKey(s.site);
    const n = resultsCount(s.results);
    if (!k || n === null) continue;
    out[k] = (out[k] ?? 0) + n;
  }
  return out;
}

/** Notes that say the board blocked the search rather than finding nothing. */
const BLOCKED = /\b(captcha|security check|verify you are human|are you a robot|blocked|access denied|rate[- ]?limit(ed)?|too many requests|429|sign[- ]?in|log[- ]?in|signed out)\b/i;

/** Why a saved title or company looks like junk from a changed page, or null when it looks like a real one. */
export function junkReason(job: Pick<HealthJob, "title" | "company">): "code" | "long" | "empty" | "company" | null {
  const t = (job.title ?? "").trim();
  if (!/\p{L}/u.test(t)) return "empty";
  if (/<\/?[a-z][^>]*>|&(?:amp|lt|gt|quot|nbsp|#\d+|#x[0-9a-f]+);|\{\{|\}\}|\bundefined\b|\bnull\b|\[object Object\]/i.test(t)) return "code";
  if (t.length > HEALTH_MAX_TITLE) return "long";
  const c = (job.company ?? "").trim().toLowerCase();
  if (!/\p{L}/u.test(c) || /^(unknown|n\/?a|none|null|undefined|company|employer|-+)$/.test(c)) return "company";
  return null;
}

const JUNK_WORDS: Record<NonNullable<ReturnType<typeof junkReason>>, string> = {
  code: "had web-page code in the title", long: "had a title too long to be a job title", empty: "had no title", company: "had no company name",
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Warnings for this run's boards: a board that returned nothing when it usually finds some, or returned mostly junk. */
export function boardHealth(input: BoardHealthInput): BoardHealthWarning[] {
  const stopped = new Set(input.stopped ?? []);
  const boards = new Map<string, { name: string; searches: HealthSearch[]; jobs: HealthJob[] }>();
  const slot = (site: string) => {
    const k = boardKey(site);
    if (!k) return null;
    return boards.get(k) ?? boards.set(k, { name: boardName(site), searches: [], jobs: [] }).get(k)!;
  };
  for (const s of input.searches) slot(s.site)?.searches.push(s);
  for (const j of input.jobs) slot(j.site)?.jobs.push(j);

  const out: BoardHealthWarning[] = [];
  for (const [board, b] of boards) {
    if (stopped.has(board) || b.searches.some((s) => BLOCKED.test(s.notes ?? ""))) continue;
    const counts = b.searches.map((s) => resultsCount(s.results));
    const allZero = counts.length > 0 && counts.every((n) => n === 0);
    if (allZero && !b.jobs.length) {
      const found = input.past.map((p) => p[board]).filter((n): n is number => typeof n === "number").slice(0, HEALTH_PAST_RUNS);
      const some = found.filter((n) => n > 0);
      const usual = found.length ? median(found) : 0;
      if (some.length >= HEALTH_MIN_PAST && usual >= HEALTH_MIN_USUAL) {
        out.push({
          board, name: b.name, kind: "nothing",
          message: `${b.name} returned nothing this time, it usually finds about ${usual}. Its pages may have changed.`,
          suggestion: `Try the same search on ${b.name} yourself. If it shows jobs there, run Find jobs again; if ${b.name} keeps finding nothing, leave it out of your searches for now.`,
        });
      }
      continue;
    }
    if (b.jobs.length < HEALTH_MIN_JOBS) continue;
    const reasons = b.jobs.map(junkReason).filter((r): r is NonNullable<typeof r> => r !== null);
    if (reasons.length / b.jobs.length < HEALTH_JUNK_SHARE) continue;
    const tally = new Map<string, number>();
    for (const r of reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
    const [top, n] = [...tally.entries()].sort((x, y) => y[1] - x[1])[0]!;
    out.push({
      board, name: b.name, kind: "junk",
      message: `Most of what ${b.name} returned this time looked wrong (${n} of ${b.jobs.length} jobs ${JUNK_WORDS[top as keyof typeof JUNK_WORDS]}). Its pages may have changed.`,
      suggestion: `Check the jobs saved from ${b.name} today against the ads before relying on them, and delete any that are junk.`,
    });
  }
  return out;
}
