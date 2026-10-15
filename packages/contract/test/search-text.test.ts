import { describe, expect, it } from "vitest";
import { chipsPatch, parseSearchText } from "../src/search-text.js";

const p = (text: string, places: string[] = []) => parseSearchText(text, { places, now: new Date(2026, 9, 14) });
const patch = (text: string, places: string[] = []) => chipsPatch(p(text, places).chips);

describe("Describe the jobs you want", () => {
  it("reads the owner's example into chips, keeping the rest as text", () => {
    const r = p("remote or hybrid data roles in Sydney, posted this week, no big tech, sponsorship friendly");
    expect(chipsPatch(r.chips)).toEqual({ work_modes: ["hybrid", "remote"], locations: ["Sydney"], posted_week: true, skip_big_tech: true, sponsor_only: true });
    expect(r.chips.map((c) => c.label)).toEqual(["Skip big tech", "Posted this week", "Hybrid or Remote", "Offers sponsorship", "Sydney"]);
    expect(r.free_text).toBe("data");
  });

  it("dates", () => {
    expect(patch("posted today")).toEqual({ posted_days: 1 });
    expect(patch("in the last 24 hours")).toEqual({ posted_days: 1 });
    expect(patch("last 3 days")).toEqual({ posted_days: 3 });
    expect(patch("within 10 days")).toEqual({ posted_days: 10 });
    expect(patch("past week")).toEqual({ posted_days: 7 });
    expect(patch("last 2 weeks")).toEqual({ posted_days: 14 });
    expect(patch("last fortnight")).toEqual({ posted_days: 14 });
    expect(patch("past three weeks")).toEqual({ posted_days: 21 });
    expect(patch("this month")).toEqual({ posted_days: 30 });
    expect(patch("this week")).toEqual({ posted_week: true });
  });

  it("recent, latest and new jobs mean newest first in the last 7 days, unless a date is given", () => {
    expect(patch("recent jobs")).toEqual({ sort: "recent", posted_days: 7 });
    expect(patch("latest AI roles")).toEqual({ sort: "recent", posted_days: 7 });
    expect(patch("new jobs posted today")).toEqual({ sort: "recent", posted_days: 1 });
    expect(patch("newest first")).toEqual({ sort: "recent" });
    expect(patch("sort by date")).toEqual({ sort: "recent" });
    expect(patch("best match")).toEqual({ sort: "relevance" });
  });

  it("work modes, including not", () => {
    expect(patch("fully remote")).toEqual({ work_modes: ["remote"] });
    expect(patch("on-site")).toEqual({ work_modes: ["onsite"] });
    expect(patch("hybrid, onsite")).toEqual({ work_modes: ["onsite", "hybrid"] });
    expect(patch("not remote")).toEqual({ work_modes: ["onsite", "hybrid"] });
    expect(patch("wfh")).toEqual({ work_modes: ["remote"] });
  });

  it("pay", () => {
    expect(patch("$120k+")).toEqual({ salary_min: 120000 });
    expect(patch("120k+")).toEqual({ salary_min: 120000 });
    expect(patch("over $150,000")).toEqual({ salary_min: 150000 });
    expect(patch("at least 90k")).toEqual({ salary_min: 90000 });
    expect(patch("$100k-$140k")).toEqual({ salary_min: 100000, salary_max: 140000 });
    expect(patch("100-140k")).toEqual({ salary_min: 100000, salary_max: 140000 });
    expect(patch("120k or more")).toEqual({ salary_min: 120000 });
    // A bare number isn't pay ("3 roles"), and "$120k" alone isn't read as a floor.
    expect(p("top 3 roles").chips).toEqual([]);
  });

  it("job types and levels", () => {
    expect(patch("full-time or contract")).toEqual({ job_types: ["full_time", "contract"] });
    expect(patch("part time")).toEqual({ job_types: ["part_time"] });
    expect(patch("casual")).toEqual({ job_types: ["casual"] });
    expect(patch("graduate programs")).toEqual({ job_types: ["internship"] });
    expect(patch("senior")).toEqual({ experience: ["mid_senior"] });
    expect(patch("junior or entry level")).toEqual({ experience: ["entry"] });
  });

  it("no X, not X, without X: companies by their capitals, else words", () => {
    expect(patch("no Acme Corp, no clearance")).toEqual({ exclude_companies: ["Acme Corp"], exclude_keywords: ["clearance"] });
    expect(patch("without security clearance")).toEqual({ exclude_keywords: ["security clearance"] });
    expect(patch("excluding Example Labs and no recruiters")).toEqual({ exclude_companies: ["Example Labs"], exclude_keywords: ["recruiters"] });
    expect(patch("no FAANG")).toEqual({ skip_big_tech: true });
    expect(patch("no contract")).toEqual({ exclude_keywords: ["contract"] });
  });

  it("places: the person's own first, then known cities; longest name wins", () => {
    expect(patch("jobs in Sampletown NSW", ["Sampletown NSW"])).toEqual({ locations: ["Sampletown NSW"] });
    expect(patch("north sydney or melbourne")).toEqual({ locations: ["North Sydney", "Melbourne"] });
    expect(patch("Remote Australia")).toEqual({ work_modes: ["remote"], locations: ["Australia"] });
    expect(patch("near Atlantis")).toEqual({});
    expect(p("near Atlantis").free_text).toBe("atlantis");
  });

  it("other switches", () => {
    expect(patch("easy apply within 25 km")).toEqual({ easy_apply: true, radius_km: 25 });
    expect(patch("visa sponsorship")).toEqual({ sponsor_only: true });
  });

  it("keeps what it doesn't understand, without filler", () => {
    expect(p("roles that use Python and Kubernetes").free_text).toBe("use python and kubernetes");
    expect(p("jobs in the").free_text).toBe("");
    expect(p("").chips).toEqual([]);
    expect(p("x".repeat(2000)).free_text.length).toBeLessThanOrEqual(300);
  });
});
