import { describe, expect, it } from "vitest";
import { freshFirst, isFreshPosting, jobQuery, postedTime, sanitizeJobQuery, storedPosted } from "../src/index.js";

const NOW = new Date("2026-10-15T09:00:00.000Z");
const row = (posted: string, found_at = "2026-10-01T00:00:00.000Z") => ({ posted, found_at });

describe("isFreshPosting", () => {
  it("is true only when the ad's own posted date is under 48 hours old", () => {
    expect(isFreshPosting(row("2026-10-15T08:00:00.000Z"), NOW)).toBe(true);
    expect(isFreshPosting(row("2026-10-14"), NOW)).toBe(true);
    expect(isFreshPosting(row("2026-10-13T09:00:00.001Z"), NOW)).toBe(true);
    expect(isFreshPosting(row("2026-10-13T09:00:00.000Z"), NOW)).toBe(false);
    expect(isFreshPosting(row("2026-10-01"), NOW)).toBe(false);
  });
  it("never calls a job fresh without a posted date, even one found today", () => {
    expect(isFreshPosting(row("", NOW.toISOString()), NOW)).toBe(false);
    expect(isFreshPosting(row("yesterday", NOW.toISOString()), NOW)).toBe(false);
    expect(isFreshPosting(row("2026-13-45"), NOW)).toBe(false);
    expect(postedTime(row("not a date"))).toBeNull();
  });
  it("doesn't call a date in the future fresh", () => {
    expect(isFreshPosting(row("2026-10-16T09:00:00.000Z"), NOW)).toBe(false);
  });
});

describe("Fresh first", () => {
  it("puts posted dates first, newest first, then the rest by found date", () => {
    const rows = [row("", "2026-10-10"), row("2026-10-01"), row("2026-10-14"), row("", "2026-10-12")];
    expect([...rows].sort(freshFirst)).toEqual([row("2026-10-14"), row("2026-10-01"), row("", "2026-10-12"), row("", "2026-10-10")]);
  });
  it("is a job list sort the query accepts", () => {
    expect(sanitizeJobQuery({ sort: "fresh" }).sort).toBe("fresh");
    expect(jobQuery({ sort: "fresh" }, "q")).toEqual({ sort: "fresh" });
  });
});

describe("the badge and the sort use the stored posted date", () => {
  it("a board's \"yesterday\" or \"5 hours ago\" (stored as a date when found) is fresh; \"3 weeks ago\" is not", () => {
    const found = "2026-10-15T08:00:00.000Z";
    expect(isFreshPosting(row(storedPosted("yesterday", found).posted), NOW)).toBe(true);
    expect(isFreshPosting(row(storedPosted("5 hours ago", found).posted), NOW)).toBe(true);
    expect(isFreshPosting(row(storedPosted("3 weeks ago", found).posted), NOW)).toBe(false);
  });
});
