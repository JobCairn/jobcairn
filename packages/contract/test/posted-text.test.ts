import { describe, expect, it } from "vitest";
import { jobFacets, jobPredicates } from "../src/job-filters.js";
import { applyJobQuery } from "../src/logic.js";
import { parsePosted, postedAgoText, storedPosted } from "../src/posted-text.js";
import type { JobRow } from "../src/types.js";

// Found at 3pm local on Wednesday 14 October 2026.
const FOUND = new Date(2026, 9, 14, 15, 0).toISOString();

describe("a board's posted text as a date", () => {
  it("keeps a stated date, exact", () => {
    expect(parsePosted("2026-10-12", FOUND)).toEqual({ date: "2026-10-12", approx: false });
    expect(parsePosted("Posted: 2026-10-01T09:00:00Z", FOUND)).toEqual({ date: "2026-10-01", approx: false });
  });
  it("today, just posted, hours and minutes ago are the found day", () => {
    for (const t of ["just posted", "Today", "New", "5 hours ago", "30m ago", "Posted 2h ago", "moments ago"]) expect(parsePosted(t, FOUND), t).toEqual({ date: "2026-10-14", approx: false });
    expect(parsePosted("Yesterday", FOUND)).toEqual({ date: "2026-10-13", approx: false });
  });
  it("days, weeks and months ago are approximate", () => {
    expect(parsePosted("3d ago", FOUND)).toEqual({ date: "2026-10-11", approx: true });
    expect(parsePosted("Posted 4 days ago", FOUND)).toEqual({ date: "2026-10-10", approx: true });
    expect(parsePosted("2 weeks ago", FOUND)).toEqual({ date: "2026-09-30", approx: true });
    expect(parsePosted("a month ago", FOUND)).toEqual({ date: "2026-09-14", approx: true });
    expect(parsePosted("30+ days ago", FOUND)).toEqual({ date: "2026-09-14", approx: true });
    expect(parsePosted("Active 1 week ago", FOUND)).toEqual({ date: "2026-10-07", approx: true });
  });
  it("gives up on anything else", () => {
    for (const t of ["", "sometime", "Hiring now", "Closing soon"]) expect(parsePosted(t, FOUND), t).toBeNull();
    expect(parsePosted("3d ago", "not a date")).toBeNull();
  });
  it("what to store: a date with approx, or the words as they were", () => {
    expect(storedPosted("3d ago", FOUND)).toEqual({ posted: "2026-10-11", approx: true });
    expect(storedPosted("Hiring now", FOUND)).toEqual({ posted: "Hiring now", approx: false });
    expect(storedPosted(undefined, FOUND)).toEqual({ posted: "", approx: false });
  });
});

describe("posted ago, in words", () => {
  const now = new Date(2026, 9, 14, 18, 0);
  it("says how long ago, with about when approximate", () => {
    expect(postedAgoText({ posted: "2026-10-14" }, now)).toBe("Posted today");
    expect(postedAgoText({ posted: "2026-10-13" }, now)).toBe("Posted yesterday");
    expect(postedAgoText({ posted: "2026-10-11" }, now)).toBe("Posted 3 days ago");
    expect(postedAgoText({ posted: "2026-10-11", posted_approx: true }, now)).toBe("Posted about 3 days ago");
    expect(postedAgoText({ posted: "2026-09-14", posted_approx: true }, now)).toBe("Posted about 4 weeks ago");
    expect(postedAgoText({ posted: "" }, now)).toBe("Posted date unknown");
    expect(postedAgoText({ posted: "Hiring now" }, now)).toBe("Posted date unknown");
  });
});

const row = (id: string, posted: string, found_at: string): JobRow => ({
  company_slug: "acme-corp", id, company_name: "Acme Corp", client: null, title: "AI Engineer", location: "Sampletown NSW", work_mode: "", salary_text: "",
  salary_min: null, salary_max: null, wr_label: "unknown", fit: null, sponsor: null, status: "found", source: "browser", source_site: "SEEK",
  posted, found_at, eligible: true, pinned: false, last_activity: found_at,
} as unknown as JobRow);

describe("the Posted filter uses the ad's own date only", () => {
  const now = new Date(2026, 9, 14, 18, 0);
  const rows = [row("fresh", "2026-10-13", "2026-10-14T01:00:00.000Z"), row("old", "2026-08-01", "2026-10-14T01:00:00.000Z"), row("undated", "", "2026-10-14T01:00:00.000Z")];
  it("a job with no posted date never passes on the day it was found, but is kept while undated jobs are included", () => {
    const keep = (q: Parameters<typeof jobPredicates>[0]) => rows.filter(jobPredicates(q, now).posted).map((r) => r.id);
    expect(keep({ postedDays: 7 })).toEqual(["fresh", "undated"]);
    expect(keep({ postedDays: 7, postedUndated: false })).toEqual(["fresh"]);
    expect(jobFacets(rows, { postedDays: 7 }, now)).toMatchObject({ postedUnknown: 1, postedDays: { 1: 1, 7: 2, 30: 2 } });
    expect(jobFacets(rows, { postedUndated: false }, now).postedDays).toMatchObject({ 7: 1 });
  });
  it("sorts by posted date, newest first, undated last", () => {
    const ids = applyJobQuery([rows[2]!, rows[1]!, rows[0]!], { sort: "fresh" }).rows.map((r) => r.id);
    expect(ids).toEqual(["fresh", "old", "undated"]);
  });
});
