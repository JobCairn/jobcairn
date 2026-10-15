import { describe, expect, it } from "vitest";
import { applySearchOverride, boardFiltersOf, cleanBoardFilters, overrideBetween, searchOverride, searchPrefsFrom } from "../src/find-prefs.js";

const PROFILE = { targets: { roles: ["AI Engineer"] }, locations: [{ place: "Sampletown NSW", modes: ["remote"] }] };

describe("search sort, experience, easy apply and distance", () => {
  it("defaults to best match, any level, no easy apply, the board's own distance", () => {
    expect(searchPrefsFrom(PROFILE, { filters: {} })).toMatchObject({ sort: "relevance", experience: [], easy_apply: false, radius_km: null });
  });
  it("reads saved values and drops bad ones", () => {
    const p = searchPrefsFrom(PROFILE, { filters: { sort: "recent", experience: ["director", "nope", "entry"], easy_apply: true, radius_km: 25 } });
    expect(p).toMatchObject({ sort: "recent", experience: ["entry", "director"], easy_apply: true, radius_km: 25 });
    expect(searchPrefsFrom(PROFILE, { filters: { sort: "x", easy_apply: "yes", radius_km: 9999 } })).toMatchObject({ sort: "relevance", easy_apply: false, radius_km: null });
  });
  it("a run may change them for itself only", () => {
    const saved = searchPrefsFrom(PROFILE, { filters: {} });
    const o = searchOverride({ sort: "recent", experience: ["entry"], easy_apply: true, radius_km: 50 }, "search");
    const run = applySearchOverride(saved, o);
    expect(run).toMatchObject({ sort: "recent", experience: ["entry"], easy_apply: true, radius_km: 50 });
    expect(overrideBetween(saved, run)).toEqual({ sort: "recent", experience: ["entry"], easy_apply: true, radius_km: 50 });
    expect(overrideBetween(saved, saved)).toBeUndefined();
    expect(() => searchOverride({ sort: "oldest" }, "search")).toThrow();
  });
});

describe("board filters", () => {
  it("are the run's preferences, cleaned again when read back from the run file", () => {
    const p = searchPrefsFrom({ ...PROFILE, salary: { min: 120000 }, targets: { roles: ["x"], job_types: ["contract"] } }, { filters: { posted_within_days: 7, sort: "recent" } });
    const f = boardFiltersOf(p);
    expect(f).toEqual({ posted_days: 7, sort: "recent", work_modes: ["remote"], job_types: ["contract"], experience: [], easy_apply: false, radius_km: null, salary_min: 120000 });
    expect(cleanBoardFilters(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(cleanBoardFilters({ posted_days: "7&x=1", sort: "DD", work_modes: ["moon"], salary_min: -5, extra: "https://evil.example" }))
      .toEqual({ posted_days: null, sort: "relevance", work_modes: [], job_types: [], experience: [], easy_apply: false, radius_km: null, salary_min: null });
    expect(cleanBoardFilters(null)).toBeNull();
  });
});
