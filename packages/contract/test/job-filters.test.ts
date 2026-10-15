import { describe, expect, it } from "vitest";
import {
  applyJobQuery, jobFacets, jobRowFromRecord, jobTypeOf, postedAtOfRow, sanitizeJobQuery, siteOfRow, sponsorTierOfRow, workModesOf,
  type JobRecord, type JobRow,
} from "../src/index.js";
import { jobQuery } from "../src/methods.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");
function job(over: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    company_slug: "acme-corp", client: null, title: "AI Engineer", source: "ats", source_site: "Greenhouse", url: "", apply_via: "", posted: "",
    found_at: "2026-01-14T09:00:00.000Z", location: "Sampletown NSW", work_mode: "Hybrid", job_type: "Full time",
    salary: { min: null, max: null, currency: "", period: "", text: "" },
    work_rights: { label: "silent", quotes: [], decided_by: "none" },
    scores: { fit: { value: null, must_haves: [], nice_to_haves: [] }, sponsor: { value: null, tier: "", reasons: [] }, career: { match: null, odds: null, tier: "", scored_at: "" } },
    status: "Found", timeline: [], files: [], ...over,
  };
}
const sponsor = (value: number | null) => ({ fit: { value: null, must_haves: [], nice_to_haves: [] }, sponsor: { value, tier: "", reasons: [] }, career: { match: null, odds: null, tier: "", scored_at: "" } });
const fit = (value: number) => ({ ...sponsor(null), fit: { value, must_haves: [], nice_to_haves: [] } });
const rows: JobRow[] = [
  job({ id: "a", work_rights: { label: "sponsorship_offered", quotes: [], decided_by: "scan" }, source_site: "SEEK", work_mode: "Remote", salary: { min: 140000, max: 160000, currency: "AUD", period: "year", text: "" } }),
  job({ id: "b", scores: sponsor(70), source_site: "LinkedIn", location: "Remote Australia", work_mode: "Hybrid or remote", found_at: "2026-01-05T09:00:00.000Z", job_type: "Contract" }),
  job({ id: "c", scores: sponsor(50), work_mode: "On-site", posted: "2026-01-15", found_at: "2026-01-01T00:00:00.000Z", salary: { min: 70000, max: 90000, currency: "AUD", period: "year", text: "" } }),
  job({ id: "d", scores: { ...fit(88), sponsor: { value: 20, tier: "", reasons: [] } }, source: "pasted", source_site: "Pasted link", work_mode: "", job_type: "" , status: "Saved" }),
  job({ id: "e", work_rights: { label: "citizen_pr_only", quotes: [], decided_by: "scan" }, scores: sponsor(80) }),
].map((j) => jobRowFromRecord(j, "Acme Corp", j.work_rights.label !== "citizen_pr_only"));
const ids = (q: Parameters<typeof applyJobQuery>[1]) => applyJobQuery(rows, q, false, NOW).rows.map((r) => r.id).sort();

describe("how a row reads for each quick filter", () => {
  it("sponsorship tiers follow the table's traffic light", () => {
    expect(rows.map(sponsorTierOfRow)).toEqual(["confirmed", "likely", "possible", "low", "low"]);
    expect(sponsorTierOfRow({ sponsor: null, wr_label: "silent" })).toBe("unknown");
  });
  it("work modes, job types, boards and the posting date are read from the ad's words", () => {
    expect(workModesOf("Hybrid or remote")).toEqual(["remote", "hybrid"]);
    expect(workModesOf("On-site")).toEqual(["onsite"]);
    expect(workModesOf("")).toEqual([]);
    expect(["Full-time", "Permanent", "6 month contract", "Part time", "Casual", "Graduate program", "", "Other"].map(jobTypeOf))
      .toEqual(["full_time", "full_time", "contract", "part_time", "casual", "internship", "", ""]);
    expect(rows.map(siteOfRow)).toEqual(["SEEK", "LinkedIn", "Greenhouse", "Pasted by you", "Greenhouse"]);
    expect(siteOfRow({ source: "browser", source_site: "" })).toBe("Not recorded");
    expect(postedAtOfRow(rows[2]!)).toBe("2026-01-15");
    expect(postedAtOfRow(rows[0]!)).toBe("2026-01-14T09:00:00.000Z");
  });
});

describe("quick filters", () => {
  it("filter by sponsorship tier, work mode, job type, board and posting date", () => {
    expect(ids({ sponsorTiers: ["confirmed", "likely"] })).toEqual(["a", "b"]);
    expect(ids({ modes: ["remote"] })).toEqual(["a", "b"]);
    expect(ids({ modes: ["onsite"] })).toEqual(["c"]);
    expect(ids({ modes: ["on-site"] })).toEqual(["c"]); // an old saved view's free text still works
    expect(ids({ jobTypes: ["contract"] })).toEqual(["b"]);
    expect(ids({ jobTypes: [""] })).toEqual(["d"]);
    expect(ids({ sites: ["seek", "Pasted by you"] })).toEqual(["a", "d"]);
    // Only the ad's own date counts, never the day it was found; jobs with no date stay unless excluded.
    expect(ids({ postedDays: 1, postedUndated: false })).toEqual(["c"]);
    expect(ids({ postedDays: 1 })).toEqual(["a", "b", "c", "d"]);
    expect(ids({ postedDays: 30, postedUndated: false })).toEqual(["c"]);
    expect(ids({ salaryMin: 100000, statuses: ["Found"] })).toEqual(["a", "b"]);
  });

  it("counts each choice with every other filter applied but its own", () => {
    const f = applyJobQuery(rows, { sponsorTiers: ["likely"], modes: ["remote"] }, false, NOW).facets!;
    // Sponsorship counts ignore the sponsorship filter but keep Remote: a and b are remote.
    expect(f.sponsor).toMatchObject({ confirmed: 1, likely: 1, possible: 0, low: 0 });
    // Work-mode counts ignore Remote but keep Likely: only b is likely, and it's hybrid and remote.
    expect(f.modes).toEqual({ remote: 1, hybrid: 1, onsite: 0 });
    expect(f.statuses.Found).toBe(1);
    expect(f.sites).toEqual([{ name: "LinkedIn", count: 1 }]);
    const all = jobFacets(rows.filter((r) => r.eligible), {}, NOW);
    expect(all.sites.map((s) => s.name)).toEqual(["LinkedIn", "SEEK", "Greenhouse", "Pasted by you"]);
    expect(all.postedDays).toEqual({ 1: 4, 3: 4, 7: 4, 14: 4, 30: 4 });
    expect(all.postedUnknown).toBe(3);
    expect(all.fitMin).toEqual({ 50: 1, 70: 1, 85: 1 });
    expect(all.salaryMin["100000"]).toBe(3); // unknown pay stays in
    expect(all.locations[0]).toEqual({ name: "Sampletown NSW", count: 3 });
    expect(all.jobTypes).toMatchObject({ full_time: 2, contract: 1, "": 1 });
  });

  it("text search narrows the counts too, and hidden ads only count when shown", () => {
    expect(applyJobQuery(rows, { text: "remote australia" }, false, NOW).facets!.sponsor.likely).toBe(1);
    expect(applyJobQuery(rows, {}, false, NOW).facets!.sponsor.low).toBe(1);
    expect(applyJobQuery(rows, { showIneligible: true }, false, NOW).facets!.sponsor.low).toBe(2);
  });

  it("sanitizes the new fields and the IPC check accepts them", () => {
    const q = { sponsorTiers: ["likely", "nope"], jobTypes: ["contract", "", "gig"], sites: ["SEEK", 3, ""], postedDays: 7 };
    expect(sanitizeJobQuery(q)).toEqual({ sponsorTiers: ["likely"], jobTypes: ["contract", ""], sites: ["SEEK"], postedDays: 7 });
    expect(sanitizeJobQuery({ postedDays: 0.5, sponsorTiers: "likely" })).toEqual({});
    const ok = { sponsorTiers: ["likely"], jobTypes: ["contract", ""], sites: ["SEEK"], postedDays: 7 };
    expect(jobQuery(ok, "q")).toEqual(ok);
    expect(() => jobQuery({ postedDays: 0 }, "q")).toThrow();
    expect(() => jobQuery({ sponsorTiers: ["maybe"] }, "q")).toThrow();
  });
});
