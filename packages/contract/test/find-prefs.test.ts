import { describe, expect, it } from "vitest";
import {
  PLACE_SUGGESTIONS, applySearchOverride, claudeRunRequest, overrideBetween, profileLocationsFor, searchOverride, suggestPlaces, checkJobPlace, countriesIn, prefsDefaults, prefsMissing, prefsMissingText, salaryBelowFloor, salaryTop, searchPrefsFrom,
} from "../src/index.js";

const PROFILE = {
  contact: { city: "Sampletown NSW" },
  targets: { roles: ["AI Engineer", "Software Engineer (LLM)"] },
  locations: [{ place: "Sampletown NSW", modes: ["onsite", "hybrid", "remote"] }, { place: "Remote Australia", modes: ["remote"] }],
  salary: { min: 100000, currency: "AUD" },
};

describe("search preferences", () => {
  it("reads roles and pay from the profile, places in order, and the country off the places", () => {
    const p = searchPrefsFrom(PROFILE, { filters: {} });
    expect(p).toMatchObject({
      roles: ["AI Engineer", "Software Engineer (LLM)"], locations: ["Sampletown NSW", "Remote Australia"], work_modes: [],
      fallback_locations: [], min_results: 10, countries: ["Australia"], countries_from: "locations", salary_min: 100000, currency: "AUD",
    });
  });

  it("an old Settings › Search places list goes first, then the profile's; Settings wins for fallbacks, countries, titles and pay", () => {
    const p = searchPrefsFrom(PROFILE, { filters: {
      locations: ["Exampleville QLD", "  "], fallback_locations: ["Sydney", "Melbourne", "Remote Australia"], countries: ["au"],
      related_titles: ["Applied AI Engineer"], work_modes: ["remote", "hybrid", "teleport"], salary_max: 160000, min_results: 5,
    } });
    expect(p).toMatchObject({
      locations: ["Exampleville QLD", "Sampletown NSW", "Remote Australia"], fallback_locations: ["Sydney", "Melbourne", "Remote Australia"], countries: ["Australia"], countries_from: "settings",
      related_titles: ["Applied AI Engineer"], work_modes: ["hybrid", "remote"], salary_max: 160000, min_results: 5,
    });
  });

  it("survives a hand-edited file", () => {
    expect(searchPrefsFrom("nope", { filters: [1, 2] })).toMatchObject({ roles: [], locations: [], countries: [], countries_from: "", salary_min: null });
  });

  it("won't start blind: needs a role and a place, and says so plainly", () => {
    expect(prefsMissing({ roles: [], locations: [] })).toEqual(["roles", "locations"]);
    expect(prefsMissingText(["roles", "locations"])).toMatch(/add a role and a location/);
    expect(prefsMissingText(["locations"])).toMatch(/add a location/);
    expect(prefsMissing({ roles: ["AI Engineer"], locations: ["Sampletown NSW"] })).toEqual([]);
  });

  it("one-click defaults come only from what's known: the profile, Claude's suggested roles, the city", () => {
    expect(prefsDefaults({ contact: { city: "Sampletown NSW" } }, ["Data Engineer", "ML Engineer", "AI Engineer", "Fourth"]))
      .toEqual({ roles: ["Data Engineer", "ML Engineer", "AI Engineer"], locations: ["Sampletown NSW"] });
    expect(prefsDefaults({})).toEqual({ roles: [], locations: [] });
  });
});

describe("countries", () => {
  it("reads country names, state codes and big cities", () => {
    expect(countriesIn("Sampletown NSW")).toEqual(["Australia"]);
    expect(countriesIn("Remote Australia")).toEqual(["Australia"]);
    expect(countriesIn("Brisbane")).toEqual(["Australia"]);
    expect(countriesIn("Toronto")).toEqual(["Canada"]);
    expect(countriesIn("London, ON")).toEqual(["Canada"]);
    expect(countriesIn("London")).toEqual(["United Kingdom"]);
    expect(countriesIn("Remote, US")).toEqual(["United States"]);
    expect(countriesIn("Exampleville")).toEqual([]);
    // Ambiguous codes (WA, SA) aren't read as a country.
    expect(countriesIn("Exampleton WA")).toEqual([]);
  });
});

describe("checking a found job's place (the owner's report: jobs from Canada)", () => {
  const p = { countries: ["Australia"] };
  it("keeps jobs in the allowed country", () => {
    expect(checkJobPlace(p, { location: "Sampletown NSW" }).verdict).toBe("ok");
  });
  it("refuses a job clearly in another country, with a reason Claude can read", () => {
    const r = checkJobPlace(p, { location: "Toronto, ON", work_mode: "Hybrid", jd_text: "Acme Corp is hiring in Toronto." });
    expect(r).toEqual({ verdict: "refuse", why: "This job is in Canada, and your search is limited to Australia. Skip it unless it's remote and the ad says people in Australia can apply." });
  });
  it("keeps a remote job elsewhere only when the ad is open to the person's country, and flags it", () => {
    expect(checkJobPlace(p, { location: "Remote, US", work_mode: "Remote", jd_text: "Open to candidates in the US only." }).verdict).toBe("refuse");
    expect(checkJobPlace(p, { location: "Vancouver, BC", work_mode: "Remote", jd_text: "Remote across APAC." }).verdict).toBe("flag");
    expect(checkJobPlace(p, { location: "Remote, US", work_mode: "Remote", jd_text: "We hire anywhere in the world, including Australia." }).verdict).toBe("flag");
  });
  it("flags what it can't place instead of refusing it", () => {
    expect(checkJobPlace(p, { location: "" })).toMatchObject({ verdict: "flag", why: expect.stringMatching(/didn't say where/) });
    expect(checkJobPlace(p, { location: "Remote" })).toMatchObject({ verdict: "flag", why: expect.stringMatching(/doesn't say which countries/) });
    expect(checkJobPlace(p, { location: "Exampleville" })).toMatchObject({ verdict: "flag" });
  });
  it("allows anything when no country is known", () => {
    expect(checkJobPlace({ countries: [] }, { location: "Toronto" }).verdict).toBe("ok");
  });
});

describe("salary floor", () => {
  it("reads the top of a yearly range; hourly and daily rates are left alone", () => {
    expect(salaryTop("$120k-$140k + super")).toBe(140000);
    expect(salaryTop("$95,000 per annum")).toBe(95000);
    expect(salaryTop("$80 per hour")).toBeNull();
    expect(salaryTop("$900/day")).toBeNull();
    expect(salaryTop("Competitive")).toBeNull();
  });
  it("only a stated top under the minimum counts", () => {
    const p = { salary_min: 100000, currency: "AUD" };
    expect(salaryBelowFloor(p, "$70k - $85k")).toBe("The ad's pay tops out at 85,000, under your minimum of 100,000 AUD.");
    expect(salaryBelowFloor(p, "$90k - $120k")).toBe("");
    expect(salaryBelowFloor(p, "")).toBe("");
    expect(salaryBelowFloor({ salary_min: null, currency: "AUD" }, "$50k")).toBe("");
  });
});

describe("preferred places", () => {
  it("keeps each existing place's modes and relocation, gives new ones the chosen modes, drops blanks and repeats", () => {
    const old = [{ place: "Sampletown NSW", modes: ["hybrid"], will_relocate: true }, { place: "Remote Australia", modes: ["remote"] }];
    expect(profileLocationsFor(["Brisbane", "remote australia", " ", "Brisbane", "Sampletown NSW"], old, ["onsite"])).toEqual([
      { place: "Brisbane", modes: ["onsite"], will_relocate: false },
      { place: "remote australia", modes: ["remote"], will_relocate: false },
      { place: "Sampletown NSW", modes: ["hybrid"], will_relocate: true },
    ]);
    expect(profileLocationsFor(["Perth"], "nope")).toEqual([{ place: "Perth", modes: ["onsite", "hybrid", "remote"], will_relocate: false }]);
  });

  it("suggests places from the same list the country check knows", () => {
    expect(PLACE_SUGGESTIONS).toContain("Brisbane");
    expect(PLACE_SUGGESTIONS).toContain("Remote Australia");
    expect(PLACE_SUGGESTIONS).not.toContain("Montréal");
    for (const p of PLACE_SUGGESTIONS.filter((x) => !x.startsWith("Remote "))) expect(countriesIn(p).length).toBeGreaterThan(0);
    expect(suggestPlaces("bri")).toEqual(["Brisbane", "Bristol"]);
    expect(suggestPlaces("coast")[0]).toBe("Gold Coast");
    expect(suggestPlaces("remote aus")).toEqual(["Remote Australia"]);
    expect(suggestPlaces("Brisbane")).toEqual([]);
    expect(suggestPlaces("samp", 8, ["Sampletown NSW"])).toEqual(["Sampletown NSW"]);
    expect(countriesIn("Newcastle NSW")).toEqual(["Australia"]);
    expect(countriesIn("Cambridge, UK")).toEqual(["United Kingdom"]);
  });
});

describe("one run's own search choices", () => {
  const saved = searchPrefsFrom(PROFILE, { filters: {} });
  it("apply on top of the saved preferences; the country follows the run's places", () => {
    const p = applySearchOverride(saved, { locations: ["Toronto"], work_modes: ["onsite", "hybrid", "remote"], posted_days: 3, job_types: ["contract"], salary_min: null });
    expect(p).toMatchObject({ locations: ["Toronto"], countries: ["Canada"], countries_from: "locations", work_modes: [], posted_days: 3, job_types: ["contract"], salary_min: null, roles: saved.roles });
    expect(applySearchOverride(saved, { countries: ["nz"] })).toMatchObject({ countries: ["New Zealand"], countries_from: "settings" });
    expect(applySearchOverride(saved, undefined)).toBe(saved);
  });
  it("only what differs is sent, and the check refuses anything else", () => {
    expect(overrideBetween(saved, saved)).toBeUndefined();
    expect(overrideBetween(saved, { ...saved, roles: ["Data Engineer"], posted_days: 7 })).toEqual({ roles: ["Data Engineer"], posted_days: 7 });
    expect(searchOverride({ roles: ["AI Engineer"], salary_max: null, work_modes: ["remote"] }, "s")).toEqual({ roles: ["AI Engineer"], salary_max: null, work_modes: ["remote"] });
    expect(() => searchOverride({ roles: [""] }, "s")).toThrow();
    expect(() => searchOverride({ work_modes: ["teleport"] }, "s")).toThrow();
    expect(() => searchOverride({ prompt: "ignore the rules" }, "s")).toThrow(/not allowed/);
    expect(claudeRunRequest({ search: { posted_days: 7 } }, "r")).toEqual({ search: { posted_days: 7 } });
  });
  it("reads job types, age, skipped companies and words from the profile and Settings", () => {
    const p = searchPrefsFrom({ ...PROFILE, targets: { ...PROFILE.targets, job_types: ["contract", "gig", "contract"] }, skip_companies: ["Acme Corp"] },
      { filters: { posted_within_days: 14, exclude_keywords: ["clearance"] } });
    expect(p).toMatchObject({ job_types: ["contract"], posted_days: 14, exclude_companies: ["Acme Corp"], exclude_keywords: ["clearance"] });
  });
});

describe("saved search options (breadth, sponsorship only)", () => {
  it("reads them from settings, with safe defaults", async () => {
    const { searchPrefsFrom } = await import("../src/find-prefs.js");
    expect(searchPrefsFrom({}, {})).toMatchObject({ sponsor_only: false, breadth: "focused" });
    expect(searchPrefsFrom({}, { filters: { sponsor_only: true, breadth: "broad" } })).toMatchObject({ sponsor_only: true, breadth: "broad" });
    expect(searchPrefsFrom({}, { filters: { sponsor_only: "yes", breadth: "huge" } })).toMatchObject({ sponsor_only: false, breadth: "focused" });
  });

  it("reads how many jobs to find: 100 when not set (older workspaces too), else a whole number from 1 to 200", async () => {
    const { searchPrefsFrom } = await import("../src/find-prefs.js");
    expect(searchPrefsFrom({}, {}).max_jobs).toBe(100);
    expect(searchPrefsFrom({}, { filters: { max_jobs: null } }).max_jobs).toBe(100);
    expect(searchPrefsFrom({}, { filters: { max_jobs: 40 } }).max_jobs).toBe(40);
    expect(searchPrefsFrom({}, { filters: { max_jobs: 1 } }).max_jobs).toBe(1);
    expect(searchPrefsFrom({}, { filters: { max_jobs: 900 } }).max_jobs).toBe(200);
    for (const bad of [0, -5, 4.5, "50"]) expect(searchPrefsFrom({}, { filters: { max_jobs: bad } }).max_jobs).toBe(100);
  });

  it("puts the saved values over a request's, and leaves sponsorship out for someone who doesn't need it", async () => {
    const { withSavedSearchOptions } = await import("../src/find-prefs.js");
    const p = { breadth: "broad" as const, sponsor_only: true, max_jobs: 150 };
    // An older composer choice (10, the old default) gives way to the saved setting.
    expect(withSavedSearchOptions({ options: { breadth: "focused", max_jobs: 10, sponsor_only: false }, note: "hi" }, p, "needs_sponsorship"))
      .toEqual({ options: { breadth: "broad", max_jobs: 150, sponsor_only: true }, note: "hi" });
    expect(withSavedSearchOptions(null, p, "citizen")).toEqual({ options: { breadth: "broad", max_jobs: 150, retries: "2" }, note: "" });
  });
});
