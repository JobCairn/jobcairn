import { describe, expect, it } from "vitest";
import { BOARD_IDS, type BoardFilters } from "@careeros/contract";
import { boardParams, canonicalAddress, pageKind, searchUrl } from "../../src/chrome/boards.js";

const NONE: BoardFilters = { posted_days: null, sort: "relevance", work_modes: [], job_types: [], experience: [], easy_apply: false, radius_km: null, salary_min: null };
const ALL: BoardFilters = {
  posted_days: 7, sort: "recent", work_modes: ["onsite", "remote"], job_types: ["full_time", "contract"], experience: ["entry", "mid_senior"],
  easy_apply: true, radius_km: 25, salary_min: 120000,
};

describe("board search addresses with the board's own filters", () => {
  it("leaves the plain search alone without filters", () => {
    expect(searchUrl("linkedin", "AI Engineer", "Sampletown NSW")).toBe("https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer&location=Sampletown%20NSW");
    expect(searchUrl("seek", "AI", "Sampletown", false, NONE)).toBe("https://www.seek.com.au/jobs?keywords=AI&where=Sampletown");
  });

  it("LinkedIn: date in seconds, newest first, work modes, levels, job types, Easy Apply, distance in miles", () => {
    expect(searchUrl("linkedin", "AI Engineer", "Sampletown NSW", false, ALL)).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer&location=Sampletown%20NSW"
      + "&f_TPR=r604800&sortBy=DD&f_WT=1%2C2&f_E=2%2C4&f_JT=F%2CC%2CT&f_AL=true&distance=25",
    );
    expect(boardParams("linkedin", { ...NONE, work_modes: ["hybrid"], radius_km: 200 })).toEqual([["f_WT", "3"]]);
    expect(boardParams("linkedin", { ...NONE, posted_days: 1 })).toEqual([["f_TPR", "r86400"]]);
  });

  it("SEEK: date rounded up to its choices, newest first, work types, pay floor; with the IT category", () => {
    expect(searchUrl("seek", "LLM Engineer", "Sampletown QLD", true, ALL)).toBe(
      "https://www.seek.com.au/jobs-in-information-communication-technology?keywords=LLM%20Engineer&where=Sampletown%20QLD"
      + "&daterange=7&sortmode=ListedDate&worktype=242%2C244&salaryrange=120000-",
    );
    expect(boardParams("seek", { ...NONE, posted_days: 2 })).toEqual([["daterange", "3"]]);
    expect(boardParams("seek", { ...NONE, posted_days: 10 })).toEqual([["daterange", "14"]]);
    expect(boardParams("seek", { ...NONE, posted_days: 60 })).toEqual([]);
    // No SEEK code for internships: the work type is left out, never narrowed.
    expect(boardParams("seek", { ...NONE, job_types: ["full_time", "internship"] })).toEqual([]);
  });

  it("Indeed: days rounded up, newest first, one job type only, distance in km", () => {
    expect(searchUrl("indeed", "AI", "Sampletown", false, { ...ALL, job_types: ["part_time"] })).toBe(
      "https://au.indeed.com/jobs?q=AI&l=Sampletown&fromage=7&sort=date&jt=parttime&radius=25",
    );
    expect(boardParams("indeed", { ...NONE, job_types: ["full_time", "contract"], posted_days: 30, radius_km: 500 })).toEqual([]);
  });

  it("other boards get words and place only", () => {
    for (const id of ["glassdoor", "jora", "careerone", "workforce"] as const) expect(boardParams(id, ALL)).toEqual([]);
  });

  it("every filtered address is still an allowed search page of its board", () => {
    for (const id of BOARD_IDS) {
      for (const it of [false, true]) {
        const url = searchUrl(id, "AI Engineer", "Sampletown NSW", it, ALL);
        expect(pageKind(url, id)).toBe("search");
        expect(canonicalAddress(url, id)).not.toBeNull();
      }
    }
  });
});
