import { describe, expect, it } from "vitest";
import { afterRun, afterSkip, cleanSchedule, SCHEDULE_HISTORY, withEvent, isDue, nextRun, postedDaysSince, scheduleWords, type SearchSchedule } from "../src/schedule.js";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m); // October 2026; the 12th is a Monday
const base = (o: Partial<SearchSchedule>): SearchSchedule => ({ ...cleanSchedule({}), ...o });

describe("repeat this search", () => {
  it("reads any shape, off when unsure", () => {
    expect(cleanSchedule(null).mode).toBe("off");
    expect(cleanSchedule({ mode: "weekly", every_hours: 0, at: "25:00", days: [9], times: -1 }))
      .toMatchObject({ mode: "off", every_hours: 24, at: "08:00", days: [], times: null });
    expect(cleanSchedule({ mode: "hours", every_hours: 6, times: 3 })).toMatchObject({ mode: "hours", every_hours: 6, times: 3 });
  });

  it("off never runs", () => {
    expect(nextRun(base({ mode: "off" }), at(12, 9))).toBeNull();
    expect(isDue(base({ mode: "off" }), at(12, 9))).toBe(false);
  });

  it("every N hours, N times or until stopped", () => {
    const s = base({ mode: "hours", every_hours: 6, times: 2, since: at(12, 8).toISOString() });
    expect(nextRun(s, at(12, 9))).toEqual(at(12, 14));
    expect(isDue(s, at(12, 13, 59))).toBe(false);
    expect(isDue(s, at(12, 14))).toBe(true);
    const once = afterRun(s, at(12, 14));
    expect(nextRun(once, at(12, 14))).toEqual(at(12, 20));
    expect(nextRun(afterRun(once, at(12, 20)), at(12, 21))).toBeNull();
    expect(nextRun(base({ mode: "hours", every_hours: 6, runs: 50, since: at(12, 8).toISOString() }), at(12, 9))).toEqual(at(12, 14));
  });

  it("daily at a time on chosen weekdays", () => {
    const s = base({ mode: "daily", at: "08:30", days: [1, 3], since: at(12, 9).toISOString() }); // Monday 9:00, after the slot
    expect(nextRun(s, at(12, 9))).toEqual(at(14, 8, 30)); // Wednesday
    expect(isDue(s, at(14, 8, 29))).toBe(false);
    expect(isDue(s, at(14, 8, 30))).toBe(true);
    expect(nextRun(afterRun(s, at(14, 8, 31)), at(14, 8, 31))).toEqual(at(19, 8, 30)); // next Monday
  });

  it("catches up once after sleep, then counts from that run", () => {
    const s = base({ mode: "hours", every_hours: 1, since: at(12, 8).toISOString() });
    // Asleep from 8:00 until 15:00: due once now, and the next is an hour after this run, not the missed ones.
    expect(isDue(s, at(12, 15))).toBe(true);
    const ran = afterRun(s, at(12, 15));
    expect(isDue(ran, at(12, 15, 1))).toBe(false);
    expect(nextRun(ran, at(12, 15, 1))).toEqual(at(12, 16));
  });

  it("asks for ads posted since the last run, at least a day", () => {
    expect(postedDaysSince(at(12, 8).toISOString(), at(12, 14))).toBe(1);
    expect(postedDaysSince(at(10, 8).toISOString(), at(12, 9))).toBe(3);
    expect(postedDaysSince("", at(12, 9))).toBe(7);
    expect(postedDaysSince(at(1, 8).toISOString(), at(30, 9))).toBe(30);
  });

  it("says it in plain words", () => {
    expect(scheduleWords(base({ mode: "hours", every_hours: 6, times: 3 }))).toBe("Every 6 hours, 3 times");
    expect(scheduleWords(base({ mode: "hours", every_hours: 1 }))).toBe("Every hour until stopped");
    expect(scheduleWords(base({ mode: "daily", at: "08:00", days: [1, 2, 3, 4, 5] }))).toBe("At 08:00 on weekdays");
    expect(scheduleWords(base({ mode: "daily", at: "07:15", days: [0, 6] }))).toBe("At 07:15 on Sun, Sat");
    expect(scheduleWords(base({ mode: "off" }))).toBe("Off");
  });

  it("keeps a short history; a skip uses the slot but isn't counted and doesn't move the posted window", () => {
    const s = base({ mode: "hours", every_hours: 1, times: 2, since: at(12, 8).toISOString() });
    const ran = afterRun(s, at(12, 9));
    expect(ran).toMatchObject({ runs: 1, searched_at: at(12, 9).toISOString() });
    const skipped = afterSkip(ran, at(12, 10), "Skipped: Chrome wasn't allowed");
    expect(skipped).toMatchObject({ runs: 1, searched_at: at(12, 9).toISOString(), last_run_at: at(12, 10).toISOString() });
    expect(skipped.history[0]).toEqual({ at: at(12, 10).toISOString(), text: "Skipped: Chrome wasn't allowed" });
    expect(nextRun(skipped, at(12, 10))).toEqual(at(12, 11));
    let h = skipped;
    for (let i = 0; i < 15; i++) h = withEvent(h, at(13, i), `run ${i}`);
    expect(h.history).toHaveLength(SCHEDULE_HISTORY);
    expect(h.history[0]!.text).toBe("run 14");
    expect(cleanSchedule(JSON.parse(JSON.stringify(h)))).toEqual(h);
    // Saved before searched_at existed: the last start counts as the last search.
    expect(cleanSchedule({ mode: "hours", last_run_at: at(12, 9).toISOString() }).searched_at).toBe(at(12, 9).toISOString());
    expect(cleanSchedule({ mode: "hours", history: [{ at: "nope", text: "x" }, 5] }).history).toEqual([]);
  });
});
