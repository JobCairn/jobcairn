import { layout, readRecord, updateRecord } from "@careeros/core";
import { afterRun, afterSkip, cleanSchedule, isActiveRun, isDue, nextRun, postedDaysSince, withEvent, type ClaudeRunView, type ScheduleView, type SearchSchedule } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { engineFor, ScheduledSkip, type RunOptions } from "./claude/engine.js";
import { jobRows } from "./read.js";

/**
 * "Repeat this search" (Find jobs): while the app is open, a check every minute starts the saved search when its
 * schedule is due. Each scheduled search asks only for ads posted since the last one (at least a day), newest first,
 * never starts while another Find jobs search is running (or waiting to retry), and catches up at most once after
 * the computer slept or the app was closed (schedule.ts nextRun). When it ends, a notification says what it found.
 * The schedule lives in the workspace's search settings (`schedule`), written through the record store.
 *
 * With Search in my Chrome on, a scheduled search never searches the web instead: when Chrome has to be connected
 * again, a notification says "Click Allow in Chrome to start" and the search waits up to 10 minutes for it. Not
 * allowed in time: the search is skipped ("Skipped: Chrome wasn't allowed" in the history) and the next slot tries
 * again; a skip doesn't count as one of its N times.
 */

export const ALLOW_TITLE = "Scheduled job search is ready";
export const ALLOW_BODY = "Click Allow in Chrome to start.";

export const TICK_MS = 60_000;

export interface ScheduleEngine {
  run(id: "find_jobs", target: { kind: "workspace" }, req: { search: { posted_days: number; sort: "recent" } }, o: RunOptions): Promise<ClaudeRunView>;
  get(id: string): ClaudeRunView | undefined;
  runs(): ClaudeRunView[];
  /** True while a Find jobs run is queued, running, or waiting to try again. */
  findJobsBusy(): boolean;
}

export interface ScheduleDeps {
  engine(): ScheduleEngine;
  notify?(title: string, body: string): void;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(t: unknown): void;
}

export function readSchedule(root: string): SearchSchedule {
  try { return cleanSchedule((readRecord("search", layout(root).search) as { schedule?: unknown }).schedule); } catch { return cleanSchedule(null); }
}

/** Saves a schedule (from Find jobs): a changed schedule starts counting again from now. */
export function saveSchedule(root: string, s: SearchSchedule, now: Date): SearchSchedule {
  // The history and when it last searched are the app's own: kept from what's stored, never taken from the caller.
  const cur = readSchedule(root);
  const next = cleanSchedule({ ...s, since: now.toISOString(), runs: 0, last_run_at: "", searched_at: cur.searched_at, history: cur.history });
  if (next.mode === "off") next.since = "";
  updateRecord("search", layout(root).search, (cur) => ({ ...cur, schedule: next }) as typeof cur);
  return next;
}

/** When the schedule next runs (ISO), or "" when off or finished. */
export function nextRunAt(root: string, now: Date): string {
  const n = nextRun(readSchedule(root), now);
  return n ? (n.getTime() < now.getTime() ? now : n).toISOString() : "";
}

/** "3 new jobs from your scheduled search", from the jobs found since the run started. */
export function summaryLine(root: string, run: ClaudeRunView): { title: string; body: string } {
  let found = 0;
  try { found = jobRows(root).filter((r) => r.found_at >= run.started_at).length; } catch { found = 0; }
  if (run.status === "succeeded") {
    return { title: found ? `${found} new ${found === 1 ? "job" : "jobs"} found` : "No new jobs this time", body: found ? "Your scheduled search added them to Jobs." : "Your scheduled search found nothing new. It runs again on schedule." };
  }
  if (run.status === "cancelled") return { title: "Scheduled search stopped", body: found ? `It added ${found} ${found === 1 ? "job" : "jobs"} before it stopped.` : "Nothing was added." };
  return { title: "Scheduled search didn't finish", body: run.error ? run.error.slice(0, 180) : "Open Find jobs to see why." };
}

export class SearchScheduler {
  private pending: { root: string; id: string } | null = null;
  private ticking = false;

  constructor(private ctx: ServiceContext, private deps: ScheduleDeps) {}

  /** Changes the saved schedule (through the record store) and tells the app. */
  /** False when it couldn't be saved (the schedule stays as it was). */
  private record(root: string, change: (cur: SearchSchedule) => SearchSchedule): boolean {
    try {
      updateRecord("search", layout(root).search, (cur) => ({ ...cur, schedule: change(cleanSchedule((cur as { schedule?: unknown }).schedule)) }) as typeof cur);
      this.ctx.emit("settings");
      return true;
    } catch { return false; }
  }

  /** Checks every minute while a workspace is open; stops when it closes. */
  start(): () => void {
    const set = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    const clear = this.deps.clearInterval ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
    return this.ctx.onOpen(() => {
      const t = set(() => { void this.tick(); }, TICK_MS);
      void this.tick();
      return () => { clear(t); };
    });
  }

  /** One check: report a finished scheduled run, then start the next one when due. Never two at once. */
  async tick(): Promise<void> {
    const root = this.ctx.root;
    if (!root || this.ticking) return;
    this.ticking = true;
    try {
      const engine = this.deps.engine();
      if (this.pending) {
        const first = this.pending.root === root ? engine.get(this.pending.id) : undefined;
        if (first && (isActiveRun(first.status) || engine.findJobsBusy())) return;
        this.pending = null;
        if (first) {
          // A retry is a new run: the summary is the newest Find jobs run since this one started, with every job found since.
          const last = engine.runs().filter((r) => r.action === "find_jobs" && r.started_at >= first.started_at).sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? first;
          const s = summaryLine(root, { ...last, started_at: first.started_at });
          this.record(root, (cur) => withEvent(cur, this.ctx.now(), s.title));
          try { this.deps.notify?.(s.title, s.body); } catch { /* best effort */ }
        }
      }
      const now = this.ctx.now();
      const s = readSchedule(root);
      if (!isDue(s, now) || engine.findJobsBusy()) return;
      const days = postedDaysSince(s.searched_at || s.since, now, 1);
      // Recorded first, so a start that fails (no role yet, Claude not set up) doesn't try again every minute.
      // When even that can't be saved, the schedule would look due again after every run: don't start at all.
      if (!this.record(root, () => afterRun(s, now))) return;
      const askAllow = () => { try { this.deps.notify?.(ALLOW_TITLE, ALLOW_BODY); } catch { /* best effort */ } };
      try {
        const v = await engine.run("find_jobs", { kind: "workspace" }, { search: { posted_days: days, sort: "recent" } }, { scheduled: { askAllow } });
        this.pending = { root, id: v.id };
      } catch (e) {
        const msg = (e as Error).message.slice(0, 180);
        if (e instanceof ScheduledSkip) {
          // The slot is used (it tries again at the next one), but not counted, and the next search still asks
          // for ads since the last real one.
          // A schedule changed meanwhile (Save starts counting again) keeps the change; only the line is added.
          this.record(root, (cur) => (cur.since === s.since && cur.mode === s.mode ? afterSkip({ ...cur, runs: s.runs, searched_at: s.searched_at }, now, msg) : withEvent(cur, now, msg)));
          try { this.deps.notify?.("Scheduled search skipped", `${msg}. It tries again at the next time.`); } catch { /* best effort */ }
        } else {
          this.record(root, (cur) => withEvent(cur, now, `Didn't start: ${msg}`));
          try { this.deps.notify?.("Scheduled search didn't start", msg); } catch { /* best effort */ }
        }
      }
    } finally { this.ticking = false; }
  }
}

function view(ctx: ServiceContext): ScheduleView {
  const root = ctx.requireRoot();
  const li = ctx.host.loginItem;
  let open: boolean | null = null;
  try { open = li ? li.get() : null; } catch { open = null; }
  return { schedule: readSchedule(root), next_run_at: nextRunAt(root, ctx.now()), open_at_login: open };
}

export const scheduleHandlers = {
  "schedule.get": (ctx: ServiceContext) => view(ctx),
  "schedule.save": (ctx: ServiceContext, s: SearchSchedule, openAtLogin?: boolean) => {
    saveSchedule(ctx.requireRoot(), s, ctx.now());
    if (openAtLogin !== undefined && ctx.host.loginItem) ctx.host.loginItem.set(openAtLogin);
    return view(ctx);
  },
} satisfies Partial<HandlerTable>;

/** Main: the scheduler for the open workspace, on the Claude engine, with the host's notifications. */
export function installSearchScheduler(ctx: ServiceContext): () => void {
  return new SearchScheduler(ctx, {
    engine: () => engineFor(ctx),
    notify: ctx.host.notify ? (t, b) => ctx.host.notify!(t, b) : undefined,
  }).start();
}
