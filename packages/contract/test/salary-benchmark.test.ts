import { describe, expect, it } from "vitest";
import {
  annualPay, cityOf, compareSalary, homeSummary, percentile, roleFamily, salaryBenchmarks, SUPER_RATE, type JobRow,
} from "../src/index.js";

let n = 0;
const row = (over: Partial<JobRow>): JobRow => ({
  company_slug: "acme-corp", id: `job-${++n}`, company_name: "Acme Corp", client: null, title: "Data Analyst", location: "Sydney NSW", work_mode: "",
  salary_text: "", salary_min: null, salary_max: null, wr_label: "silent", fit: null, sponsor: null, status: "Found", source: "pasted",
  source_site: "", posted: "", found_at: "2026-10-01T00:00:00.000Z", eligible: true, pinned: false, last_activity: "2026-10-01T00:00:00.000Z", ...over,
});

describe("annualPay", () => {
  it("takes the middle of a yearly range", () => {
    expect(annualPay(row({ salary_text: "$100k - $120k + super" }))).toBe(110_000);
    expect(annualPay(row({ salary_text: "$95,000" }))).toBe(95_000);
    expect(annualPay(row({ salary_text: "up to $130k" }))).toBe(130_000);
  });

  it("makes day rates (× 220) and hourly rates (× 1,760) yearly", () => {
    expect(annualPay(row({ salary_text: "$600 per day" }))).toBe(132_000);
    expect(annualPay(row({ salary_text: "$70 - $80 per hour" }))).toBe(132_000);
  });

  it("takes super out of a package", () => {
    expect(annualPay(row({ salary_text: "$112,000 package" }))).toBe(Math.round(112_000 / (1 + SUPER_RATE)));
  });

  it("uses the stored numbers when the record has them", () => {
    expect(annualPay(row({ salary_min: 90_000, salary_max: 110_000, salary_text: "Competitive" }))).toBe(100_000);
  });

  it("drops unstated and unbelievable pay, checked after converting", () => {
    expect(annualPay(row({ salary_text: "" }))).toBeNull();
    expect(annualPay(row({ salary_text: "Competitive salary" }))).toBeNull();
    expect(annualPay(row({ salary_text: "$40 per day" }))).toBeNull();
    expect(annualPay(row({ salary_text: "$900 per hour" }))).toBeNull();
  });
});

describe("role family and city", () => {
  it("drops seniority, levels and brackets from the title", () => {
    expect(roleFamily("Senior Data Analyst (Contract)")).toBe("data analyst");
    expect(roleFamily("Data Analyst II")).toBe("data analyst");
    expect(roleFamily("Lead Data Analyst - Marketing")).toBe("data analyst");
    expect(roleFamily("Sr. Software Engineer")).toBe("software engineer");
    expect(roleFamily("R&D Engineer")).toBe("r and d engineer");
    expect(roleFamily("Senior")).toBe("");
  });

  it("finds the city in a place, or Remote, or nothing", () => {
    expect(cityOf("Sydney NSW 2000")).toBe("Sydney");
    expect(cityOf("Gold Coast, QLD")).toBe("Gold Coast");
    expect(cityOf("Sampletown NSW 2000")).toBe("");
    expect(cityOf("Remote Australia")).toBe("Remote");
    expect(cityOf("", "Remote")).toBe("Remote");
    expect(cityOf("Melbourne VIC", "Remote")).toBe("Melbourne");
  });
});

describe("percentile", () => {
  it("interpolates between ranks like PERCENTILE.INC", () => {
    const s = [10, 20, 30, 40, 50];
    expect(percentile(s, 0.25)).toBe(20);
    expect(percentile(s, 0.5)).toBe(30);
    expect(percentile(s, 0.75)).toBe(40);
    expect(percentile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([7], 0.75)).toBe(7);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

const sydney = (pays: number[]) => pays.map((p) => row({ salary_min: p, salary_max: p }));

describe("salaryBenchmarks", () => {
  it("buckets by role family and city and needs five ads", () => {
    const rows = [
      ...sydney([100_000, 110_000, 120_000, 130_000, 140_000]),
      ...[90_000, 95_000, 100_000, 105_000].map((p) => row({ location: "Melbourne VIC", salary_min: p, salary_max: p })),
      row({ title: "Senior Data Analyst", salary_text: "$600 per day" }),
      row({ salary_text: "" }),
    ];
    const b = salaryBenchmarks(rows);
    expect(b).toEqual([{ family: "data analyst", label: "Data analyst", city: "Sydney", count: 6, p25: 112_500, p50: 125_000, p75: 131_500 }]);
  });

  it("is empty with nothing stated", () => {
    expect(salaryBenchmarks([row({}), row({})])).toEqual([]);
  });

  it("reaches Home through homeSummary", () => {
    const h = homeSummary({ name: "Alex Example", rows: sydney([1, 2, 3, 4, 5].map((x) => 100_000 + x * 5_000)), events: [], visaExpiry: "", approvals: [], requests: [], inbox: [], now: new Date("2026-10-15T00:00:00Z") });
    expect(h.salaryBenchmarks).toHaveLength(1);
    expect(h.salaryBenchmarks![0]).toMatchObject({ count: 5, p50: 115_000 });
  });
});

describe("compareSalary", () => {
  const others = sydney([100_000, 110_000, 120_000, 130_000, 140_000]);

  it("says where the job sits against the other ads, leaving itself out", () => {
    const job = row({ id: "mine", title: "Senior Data Analyst", salary_text: "$140k - $160k" });
    const c = compareSalary(job, [...others, job]);
    expect(c).toMatchObject({ count: 5, p25: 110_000, p50: 120_000, p75: 130_000, pay: 150_000, position: "above", city: "Sydney" });
    expect(c!.text).toBe("Above the median of 5 similar ads you've saved");
  });

  it("reads below and about the median", () => {
    expect(compareSalary(row({ id: "low", salary_text: "$90k" }), others)!.text).toBe("Below the median of 5 similar ads you've saved");
    expect(compareSalary(row({ id: "mid", salary_text: "$121k" }), others)!.position).toBe("about");
  });

  it("says nothing with fewer than five other ads, no pay or no city", () => {
    const job = row({ id: "mine", salary_text: "$120k" });
    expect(compareSalary(job, [...others.slice(0, 4), job])).toBeNull();
    expect(compareSalary(row({ id: "x" }), others)).toBeNull();
    expect(compareSalary(row({ id: "y", location: "Sampletown", salary_text: "$120k" }), others)).toBeNull();
    expect(compareSalary(row({ id: "z", title: "Platform Engineer", salary_text: "$120k" }), others)).toBeNull();
  });
});
