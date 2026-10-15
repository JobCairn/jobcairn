import { describe, expect, it } from "vitest";
import type { ClaudeRunView } from "@careeros/contract";
import { ALLOW_BODY, ALLOW_TITLE, nextRunAt, readSchedule, saveSchedule, SearchScheduler, type ScheduleEngine } from "../src/search-schedule.js";
import { ScheduledSkip, type RunOptions } from "../src/claude/engine.js";
import { FIXED, minutes, openSample } from "./helpers.js";

function fakeEngine() {
  const views = new Map<string, ClaudeRunView>();
  const started: { posted_days: number; sort: string }[] = [];
  const opts: RunOptions[] = [];
  let busy = false;
  let n = 0;
  let skip = false;
  const engine: ScheduleEngine & { finish(id: string, status: ClaudeRunView["status"]): void; setBusy(b: boolean): void; notAllowed(b: boolean): void } = {
    async run(_id, _t, req, o) {
      opts.push(o);
      if (skip) { o.scheduled?.askAllow?.(); throw new ScheduledSkip("Skipped: Chrome wasn't allowed"); }
      const v = { id: `r${++n}`, action: "find_jobs", status: "running", started_at: new Date(FIXED.getTime() + n * 60_000).toISOString(), error: "" } as unknown as ClaudeRunView;
      views.set(v.id, v);
      started.push(req.search);
      busy = true;
      return v;
    },
    get: (id) => views.get(id),
    runs: () => [...views.values()],
    findJobsBusy: () => busy,
    finish(id, status) { views.get(id)!.status = status; busy = false; },
    setBusy(b) { busy = b; },
    notAllowed(b) { skip = b; },
  };
  return { engine, started, opts };
}

describe("repeat this search", () => {
  it("is off until set; saving starts counting from now", () => {
    const { root } = openSample();
    expect(readSchedule(root).mode).toBe("off");
    expect(nextRunAt(root, FIXED)).toBe("");
    const s = saveSchedule(root, { ...readSchedule(root), mode: "hours", every_hours: 2, times: 2 }, FIXED);
    expect(s).toMatchObject({ mode: "hours", since: FIXED.toISOString(), runs: 0 });
    expect(readSchedule(root)).toEqual(s);
    expect(nextRunAt(root, FIXED)).toBe(minutes(120).toISOString());
  });

  it("a schedule saved again starts counting from now, even when the screen sends an old last run back", async () => {
    const { root } = openSample();
    const old = minutes(-60 * 72).toISOString();
    saveSchedule(root, { ...readSchedule(root), mode: "hours", every_hours: 6, times: 3, last_run_at: old, runs: 2 }, FIXED);
    expect(readSchedule(root)).toMatchObject({ last_run_at: "", runs: 0 });
    expect(nextRunAt(root, FIXED)).toBe(minutes(360).toISOString());
  });

  it("doesn't start a search when the schedule can't be saved, so it can't run again and again", async () => {
    const { ctx, root, setNow } = openSample();
    const { engine, started } = fakeEngine();
    const sch = new SearchScheduler(ctx, { engine: () => engine });
    saveSchedule(root, { ...readSchedule(root), mode: "hours", every_hours: 1, times: null }, FIXED);
    setNow(minutes(60));
    (sch as unknown as { record: () => boolean }).record = () => false;
    await sch.tick();
    await sch.tick();
    expect(started).toEqual([]);
  });

  it("starts the search when due, for ads since the last run, newest first; never two at once; notifies when done", async () => {
    const { ctx, root, setNow } = openSample();
    const { engine, started } = fakeEngine();
    const notes: string[] = [];
    const sch = new SearchScheduler(ctx, { engine: () => engine, notify: (t) => notes.push(t) });
    saveSchedule(root, { ...readSchedule(root), mode: "hours", every_hours: 1, times: null }, FIXED);
    await sch.tick();
    expect(started).toEqual([]);
    setNow(minutes(60));
    await sch.tick();
    expect(started).toEqual([{ posted_days: 1, sort: "recent" }]);
    expect(readSchedule(root)).toMatchObject({ runs: 1, last_run_at: minutes(60).toISOString() });
    // Still running an hour later: nothing new starts.
    setNow(minutes(125));
    await sch.tick();
    expect(started).toHaveLength(1);
    engine.finish("r1", "succeeded");
    // It ended past the next run's time: the next one starts at once (no overlap, no pile-up).
    await sch.tick();
    expect(notes).toEqual(["No new jobs this time"]);
    expect(started).toHaveLength(2);
    engine.finish("r2", "failed");
    await sch.tick();
    expect(notes[1]).toBe("Scheduled search didn't finish");
    // Missed several hours (asleep): one catch-up run now, asking for the days since the last run, then an hour from it.
    setNow(minutes(60 * 30));
    await sch.tick();
    expect(started).toHaveLength(3);
    expect(started[2]).toEqual({ posted_days: 2, sort: "recent" });
    engine.finish("r3", "succeeded");
    await sch.tick();
    setNow(minutes(60 * 30 + 30));
    await sch.tick();
    expect(started).toHaveLength(3);
  });

  it("waits while another Find jobs search runs, and stops after N times", async () => {
    const { ctx, root, setNow } = openSample();
    const { engine, started } = fakeEngine();
    const sch = new SearchScheduler(ctx, { engine: () => engine });
    saveSchedule(root, { ...readSchedule(root), mode: "hours", every_hours: 1, times: 1 }, FIXED);
    engine.setBusy(true);
    setNow(minutes(61));
    await sch.tick();
    expect(started).toEqual([]);
    engine.setBusy(false);
    await sch.tick();
    expect(started).toHaveLength(1);
    engine.finish("r1", "succeeded");
    await sch.tick();
    setNow(minutes(600));
    await sch.tick();
    expect(started).toHaveLength(1);
    expect(nextRunAt(root, minutes(600))).toBe("");
  });

  it("runs as a scheduled search; not allowed in Chrome in time: skipped, not counted, and tried again at the next slot", async () => {
    const { ctx, root, setNow } = openSample();
    const { engine, started, opts } = fakeEngine();
    const notes: string[] = [];
    const sch = new SearchScheduler(ctx, { engine: () => engine, notify: (t, b) => notes.push(`${t}: ${b}`) });
    saveSchedule(root, { ...readSchedule(root), mode: "hours", every_hours: 1, times: 2 }, FIXED);
    engine.notAllowed(true);
    setNow(minutes(60));
    await sch.tick();
    expect(opts).toHaveLength(1);
    expect(opts[0]!.scheduled).toBeDefined();
    expect(notes[0]).toBe(`${ALLOW_TITLE}: ${ALLOW_BODY}`);
    expect(notes[1]).toMatch(/^Scheduled search skipped: Skipped: Chrome wasn't allowed\. It tries again/);
    expect(started).toEqual([]);
    const s = readSchedule(root);
    expect(s).toMatchObject({ runs: 0, searched_at: "", last_run_at: minutes(60).toISOString() });
    expect(s.history).toEqual([{ at: minutes(60).toISOString(), text: "Skipped: Chrome wasn't allowed" }]);
    // Not again until the next slot, and then it asks for ads since the schedule began (two hours), not since the skip.
    setNow(minutes(90));
    await sch.tick();
    expect(opts).toHaveLength(1);
    engine.notAllowed(false);
    setNow(minutes(120));
    await sch.tick();
    expect(started).toEqual([{ posted_days: 1, sort: "recent" }]);
    expect(readSchedule(root)).toMatchObject({ runs: 1, searched_at: minutes(120).toISOString() });
    engine.finish("r1", "succeeded");
    await sch.tick();
    expect(readSchedule(root).history.map((e) => e.text)).toEqual(["No new jobs this time", "Skipped: Chrome wasn't allowed"]);
  });
});
