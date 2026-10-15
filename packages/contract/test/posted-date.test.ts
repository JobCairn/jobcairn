import { describe, expect, it } from "vitest";
import { applySearchOverride, overrideBetween, searchOverride, searchPrefsFrom } from "../src/find-prefs.js";
import { POSTED_PRESETS, postedWords } from "../src/job-filters.js";
import { daysSinceMonday } from "../src/posted-date.js";

const PROFILE = { targets: { roles: ["AI Engineer"] }, locations: [{ place: "Sampletown NSW", modes: ["remote"] }] };
const day = (d: number) => new Date(2026, 9, d, 15, 0); // the 12th of October 2026 is a Monday

describe("posted date presets", () => {
  it("offer the last 2 weeks too", () => {
    expect(POSTED_PRESETS).toEqual([1, 3, 7, 14, 30]);
    expect(postedWords(14)).toBe("Last 2 weeks");
    expect(postedWords(10)).toBe("Last 10 days");
    expect(postedWords(1)).toBe("Last 24 hours");
    expect(postedWords(null)).toBe("");
    expect(postedWords(3, true)).toBe("This week");
  });

  it("this week counts the days since Monday, today included", () => {
    expect([12, 13, 14, 15, 16, 17, 18, 19].map((d) => daysSinceMonday(day(d)))).toEqual([1, 2, 3, 4, 5, 6, 7, 1]);
  });

  it("this week is saved as a choice and worked out when read, so it doesn't go stale", () => {
    const s = { filters: { posted_this_week: true, posted_within_days: 30 } };
    expect(searchPrefsFrom(PROFILE, s, day(14))).toMatchObject({ posted_days: 3, posted_week: true });
    expect(searchPrefsFrom(PROFILE, s, day(18))).toMatchObject({ posted_days: 7, posted_week: true });
    expect(searchPrefsFrom(PROFILE, { filters: { posted_within_days: 10 } }, day(18))).toMatchObject({ posted_days: 10, posted_week: false });
  });

  it("a run may ask for this week, or a number of days, for itself", () => {
    const saved = searchPrefsFrom(PROFILE, { filters: { posted_within_days: 30 } }, day(15));
    const week = applySearchOverride(saved, searchOverride({ posted_week: true }, "search"), day(15));
    expect(week).toMatchObject({ posted_days: 4, posted_week: true });
    expect(overrideBetween(saved, week)).toEqual({ posted_week: true });
    const savedWeek = searchPrefsFrom(PROFILE, { filters: { posted_this_week: true } }, day(15));
    const ten = applySearchOverride(savedWeek, { posted_days: 10 }, day(15));
    expect(ten).toMatchObject({ posted_days: 10, posted_week: false });
    expect(overrideBetween(savedWeek, ten)).toEqual({ posted_days: 10, posted_week: false });
    expect(applySearchOverride(savedWeek, overrideBetween(savedWeek, ten), day(15))).toMatchObject({ posted_days: 10, posted_week: false });
  });
});
