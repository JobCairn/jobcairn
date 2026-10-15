import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  daysUntil, homeAnalytics, isCalendarDate, seenCount, jobAge, median, parseSalary, postedDate, reachedStage, rowSalary, salaryShort, SALARY_THRESHOLDS,
  SUPER_RATE, type JobEvent, type JobRow,
} from "../src/index.js";

const NOW = new Date("2026-01-15T10:00:00.000Z"); // a Thursday
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(p: Partial<JobRow> & { id: string }): JobRow {
  return {
    company_slug: "acme-corp", company_name: "Acme Corp", client: null, title: `Role ${p.id}`, location: "Sampletown NSW", work_mode: "hybrid",
    salary_text: "", salary_min: null, salary_max: null, wr_label: "silent", fit: null, sponsor: null, status: "Found", source: "ats",
    source_site: "Greenhouse", posted: "", found_at: daysAgo(2), eligible: true, pinned: false, last_activity: daysAgo(2), ...p,
  };
}
const ev = (id: string, ago: number, event: string, slug = "acme-corp"): JobEvent => ({ company_slug: slug, job_id: id, at: daysAgo(ago), event });
const run = (rows: JobRow[], events: JobEvent[] = [], extra: Partial<Parameters<typeof homeAnalytics>[0]> = {}) =>
  homeAnalytics({ rows, events, searches: [], goals: {}, now: NOW, status: "needs_sponsorship", ...extra });

describe("salary parsing", () => {
  it.each([
    ["$140k-$160k + super", 140_000, 160_000, "year"],
    ["$120,000 – $135,000 base", 120_000, 135_000, "year"],
    ["$140-160k", 140_000, 160_000, "year"],
    ["150k+", 150_000, null, "year"],
    ["Up to $180k", null, 180_000, "year"],
    ["$80 - $95 per hour", 80, 95, "hour"],
    ["$900/day", 900, null, "day"],
    ["130000", 130_000, null, "year"],
  ])("reads %s", (text, min, max, period) => {
    expect(parseSalary(text)).toMatchObject({ min, max, period });
  });
  it("ignores text with no pay in it", () => {
    for (const t of ["", "Competitive", "Great culture, 5+ years Python", "12% super", "Start in 2026"]) expect(parseSalary(t)).toBeNull();
  });
  it("notices a package that includes super", () => {
    expect(parseSalary("$160k package incl. super")?.includesSuper).toBe(true);
    expect(parseSalary("$140k + super")?.includesSuper).toBe(false);
  });
  it("shares a k suffix across a range", () => {
    expect(parseSalary("140-160k")).toMatchObject({ min: 140_000, max: 160_000, period: "year" });
    expect(parseSalary("AUD 140-160k")).toMatchObject({ min: 140_000, max: 160_000 });
    expect(parseSalary("140 to 160k + super")).toMatchObject({ min: 140_000, max: 160_000 });
  });
  it("reads /h as hourly", () => {
    expect(parseSalary("$40/h")).toMatchObject({ min: 40, period: "hour" });
    expect(parseSalary("$80/hr")).toMatchObject({ min: 80, period: "hour" });
  });
  it("treats implausible yearly figures as not stated", () => {
    for (const t of ["$95 - $110", "$800", "$1.2m", "$5,000,000"]) expect(parseSalary(t)).toBeNull();
    expect(parseSalary("$0.15m")).toMatchObject({ min: 150_000 });
    expect(rowSalary({ salary_min: 95, salary_max: 110, salary_text: "" })).toBeNull();
  });
  it("keeps the common forms working", () => {
    expect(parseSalary("$150k+")).toMatchObject({ min: 150_000, max: null, period: "year" });
    expect(parseSalary("150,000–170,000")).toMatchObject({ min: 150_000, max: 170_000 });
    expect(parseSalary("AUD 120K")).toMatchObject({ min: 120_000 });
    expect(parseSalary("competitive")).toBeNull();
    expect(parseSalary("$150k + super")).toMatchObject({ min: 150_000, includesSuper: false });
    expect(parseSalary("$750 per day")).toMatchObject({ min: 750, period: "day" });
    expect(parseSalary("$79,499")).toMatchObject({ min: 79_499 });
    expect(parseSalary("$146,717")).toMatchObject({ min: 146_717 });
  });
  it("prefers stored numbers, then text", () => {
    expect(rowSalary({ salary_min: 100_000, salary_max: null, salary_text: "" })).toMatchObject({ min: 100_000, period: "year" });
    expect(rowSalary({ salary_min: null, salary_max: null, salary_text: "$150k" })).toMatchObject({ min: 150_000 });
    expect(rowSalary({ salary_min: null, salary_max: null, salary_text: "" })).toBeNull();
  });
  it("writes a short salary", () => {
    expect(salaryShort(parseSalary("$140k-$160k"))).toBe("$140k–$160k");
    expect(salaryShort(parseSalary("150k+"))).toBe("$150k+");
    expect(salaryShort(parseSalary("up to $180,000"))).toBe("up to $180k");
    expect(salaryShort(parseSalary("$90 per hour"))).toBe("$90/hr");
    expect(salaryShort(null)).toBe("");
  });
});

describe("dates and helpers", () => {
  it("reads a posted date only from a leading calendar date", () => {
    expect(postedDate("2026-01-10")).toBe("2026-01-10");
    expect(postedDate("~2025-12-22 (3 weeks ago)")).toBe("2025-12-22");
    expect(postedDate("3 weeks ago")).toBeNull();
    expect(postedDate("")).toBeNull();
  });
  it("ages a job from its posted date, else from when it was found", () => {
    expect(jobAge({ posted: "2026-01-05", found_at: daysAgo(1) }, NOW)).toEqual({ days: 10, from: "posted" });
    expect(jobAge({ posted: "", found_at: daysAgo(4) }, NOW)).toEqual({ days: 4, from: "found" });
    expect(jobAge({ posted: "", found_at: "" }, NOW)).toEqual({ days: null, from: "found" });
  });
  it("counts days to a deadline", () => {
    expect(daysUntil("2026-02-24", NOW)).toBe(40);
    expect(daysUntil("2026-02-30", NOW)).toBeNull();
    expect(daysUntil("", NOW)).toBeNull();
    expect(daysUntil("next month", NOW)).toBeNull();
  });
  it("accepts only real calendar dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    for (const d of ["2026-13-45", "2026-02-30", "2026-02-29", "2026-00-10", "2026-1-5", "", "soon"]) expect(isCalendarDate(d)).toBe(false);
  });
  it("takes medians", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
  it("works out the furthest stage, counting a rejection as applied", () => {
    expect(reachedStage("Found", [])).toBe(0);
    expect(reachedStage("Rejected", [{ stage: 0 }])).toBe(3);
    expect(reachedStage("Rejected", [{ stage: 0 }, { stage: 4 }])).toBe(4);
    expect(reachedStage("Skipped", [{ stage: 1 }])).toBe(1);
  });
});

describe("homeAnalytics", () => {
  it("handles an empty workspace", () => {
    const a = run([]);
    expect(a.funnel.stages.map((s) => s.reached)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(a.funnel.stages.every((s) => s.conversion === null && s.medianDays === null)).toBe(true);
    expect(a.funnel.showTrends).toBe(false);
    expect(a.nextUp).toEqual([]);
    expect(a.map).toEqual({ points: [], unscored: [] });
    expect(a.weekly).toHaveLength(12);
    expect(a.weekly.every((w) => w.found === 0 && w.applied === 0)).toBe(true);
    expect(a.mix).toEqual([]);
    expect(a.sources).toEqual([]);
    expect(a.salary.shortlisted).toBe(0);
    expect(a.today).toEqual({ readySponsored: 0, followUpsDue: 0, interviews: 0, searchDeadline: null, deadlineDays: null });
  });

  it("builds the funnel with conversion and median days from timeline events", () => {
    const rows = [
      row({ id: "a", status: "Applied" }), row({ id: "b", status: "Saved" }), row({ id: "c", status: "Found" }), row({ id: "d", status: "Interview" }),
    ];
    const events = [
      ev("a", 20, "Found"), ev("a", 18, "Status: Saved"), ev("a", 14, "Status: Applying"), ev("a", 12, "Status: Applied"),
      ev("b", 10, "Found"), ev("b", 6, "Status: Saved"),
      ev("c", 3, "Found"),
      ev("d", 30, "Found"), ev("d", 26, "Status: Applied"), ev("d", 16, "Status: Interview"),
    ];
    const f = run(rows, events).funnel;
    expect(f.stages.map((s) => s.reached)).toEqual([4, 3, 2, 2, 1, 0]);
    expect(f.stages.map((s) => s.now)).toEqual([1, 1, 0, 1, 1, 0]);
    expect(f.stages[1]!.conversion).toBeCloseTo(0.75);
    expect(f.stages[0]!.medianDays).toBe(4); // a: 2, b: 4, d: 4
    expect(f.stages[3]!.medianDays).toBe(10); // d: Applied -> Interview
    expect(f.stages[5]!.conversion).toBe(0);
    expect(f.historyDays).toBe(30);
    expect(f.showTrends).toBe(true);
    expect(f.stages[0]!.thisWeek).toBe(1);
    expect(f.stages[0]!.lastWeek).toBe(1);
    expect(f.awaitingReply).toBe(1);
    expect(f.lastAppliedAt).toBe(daysAgo(12));
    expect(f.lastAppliedDays).toBe(12);
  });

  it("collapses repeated entries into the same stage before timing it", () => {
    const at = (d: string) => `${d}T09:00:00.000Z`;
    const now = new Date("2026-09-25T09:00:00.000Z");
    const rows = [row({ id: "a", status: "Applied", found_at: at("2026-09-08") })];
    const events: JobEvent[] = [
      { company_slug: "acme-corp", job_id: "a", at: at("2026-09-08"), event: "Found" },
      { company_slug: "acme-corp", job_id: "a", at: at("2026-09-10"), event: "Status: Saved" },
      { company_slug: "acme-corp", job_id: "a", at: at("2026-09-15"), event: "Status: Saved" },
      { company_slug: "acme-corp", job_id: "a", at: at("2026-09-20"), event: "Status: Applied" },
    ];
    const f = run(rows, events, { now }).funnel;
    expect(f.stages[1]!.medianDays).toBe(10);
    expect(f.stages[1]!.lastWeek + f.stages[1]!.thisWeek).toBe(0); // the repeat on 09-15 is not a new entry
    expect(run(rows, [...events, { company_slug: "acme-corp", job_id: "a", at: at("2026-09-19"), event: "Status: Saved" }], { now: new Date("2026-09-21T09:00:00.000Z") }).funnel.stages[1]!.thisWeek).toBe(0);
  });

  it("uses found_at when a job has no events, and hides trends on short history", () => {
    const f = run([row({ id: "a", found_at: daysAgo(5) })]).funnel;
    expect(f.stages[0]!.reached).toBe(1);
    expect(f.historyDays).toBe(5);
    expect(f.showTrends).toBe(false);
  });

  it("ranks next up: interview, sponsorship ads, follow-ups, then fit", () => {
    const rows = [
      row({ id: "low", fit: 40, sponsor: 50 }),
      row({ id: "high", fit: 90, sponsor: 20 }),
      row({ id: "spons", wr_label: "sponsorship_offered", fit: 60, sponsor: 95, salary_text: "$150k+" }),
      row({ id: "unscored", wr_label: "sponsorship_offered" }),
      row({ id: "int", status: "Interview", fit: 70 }),
      row({ id: "fu", status: "Applied" }),
      row({ id: "fresh-applied", status: "Applied" }),
      row({ id: "blocked", wr_label: "citizen_pr_only", eligible: false, fit: 99 }),
      row({ id: "gone", status: "Rejected", fit: 99 }),
    ];
    const events = [ev("fu", 9, "Status: Applied"), ev("fresh-applied", 2, "Status: Applied")];
    const a = run(rows, events);
    expect(a.nextUp.map((j) => j.id)).toEqual(["int", "spons", "unscored", "fu", "high", "low"]);
    expect(a.nextUp.map((j) => j.action)).toEqual(["practise", "prepare", "score", "follow_up", "prepare", "prepare"]);
    expect(a.nextUp[1]!.salary).toBe("$150k+");
    expect(a.nextUp[3]!.waitingDays).toBe(9);
    expect(a.nextUpTotal).toBe(6);
    expect(a.today).toMatchObject({ readySponsored: 2, followUpsDue: 1, interviews: 1 });
  });

  describe("candidate types", () => {
    const mixed = () => [
      row({ id: "spons", wr_label: "sponsorship_offered", fit: 60, sponsor: 95 }),
      row({ id: "high", fit: 90, sponsor: 20 }),
      row({ id: "fit-only", fit: 70 }),
    ];
    it("needs_sponsorship: ads that say they sponsor rank first and count on Today", () => {
      const a = run(mixed(), [], { status: "needs_sponsorship" });
      expect(a.sponsorship).toBe("primary");
      expect(a.nextUp.map((j) => j.id)).toEqual(["spons", "high", "fit-only"]);
      expect(a.today.readySponsored).toBe(1);
      expect(a.map.unscored.map((j) => j.id)).toEqual(["fit-only"]);
    });
    it("full_visa: no sponsorship tier or count, fit decides", () => {
      const a = run(mixed(), [], { status: "full_visa" });
      expect(a.sponsorship).toBe("secondary");
      expect(a.nextUp.map((j) => j.id)).toEqual(["high", "fit-only", "spons"]);
      expect(a.today.readySponsored).toBe(0);
    });
    it("citizen: no sponsorship tier or count, and a fit score is all a role needs to count as scored", () => {
      const a = run(mixed(), [], { status: "citizen" });
      expect(a.sponsorship).toBe("off");
      expect(a.nextUp.map((j) => j.id)).toEqual(["high", "fit-only", "spons"]);
      expect(a.today.readySponsored).toBe(0);
      expect(a.map.unscored).toEqual([]);
    });
    it("treats a missing status as unknown (no sponsorship)", () => {
      const a = homeAnalytics({ rows: mixed(), events: [], searches: [], goals: {}, now: NOW });
      expect(a.sponsorship).toBe("off");
    });
  });

  it("has no separate visa-friendly tier: a silent job with a better fit ranks first", () => {
    const a = run([row({ id: "visa", wr_label: "visa_ok", fit: 40 }), row({ id: "silent", fit: 90 })]);
    expect(a.nextUp.map((j) => j.id)).toEqual(["silent", "visa"]);
  });

  it("caps next up at 8 rows but reports the total", () => {
    const a = run(Array.from({ length: 11 }, (_, i) => row({ id: `j${i}`, fit: i })));
    expect(a.nextUp).toHaveLength(8);
    expect(a.nextUpTotal).toBe(11);
  });

  it("only suggests a follow-up between 7 and 30 days after applying", () => {
    const rows = [row({ id: "six", status: "Applied" }), row({ id: "ten", status: "Applied" }), row({ id: "forty", status: "Applied" })];
    const a = run(rows, [ev("six", 6, "Status: Applied"), ev("ten", 10, "Status: Applied"), ev("forty", 40, "Status: Applied")]);
    expect(a.nextUp.map((j) => j.id)).toEqual(["ten"]);
    expect(a.today.followUpsDue).toBe(1);
    expect(a.funnel.awaitingReply).toBe(3);
  });

  it("does not count a follow-up when a reply came after applying", () => {
    const a = run([row({ id: "a", status: "Applied" })], [ev("a", 10, "Status: Applied"), ev("a", 3, "Email received")]);
    expect(a.today.followUpsDue).toBe(0);
    expect(a.funnel.awaitingReply).toBe(0);
  });

  it("puts scored roles on the map and the rest in the not-scored strip", () => {
    const a = run([
      row({ id: "s", fit: 80, sponsor: 70, wr_label: "visa_ok" }),
      row({ id: "nofit", sponsor: 70 }),
      row({ id: "nosponsor", fit: 60 }),
      row({ id: "applied", status: "Applied", fit: 50, sponsor: 50 }),
      row({ id: "skip", status: "Skipped", fit: 90, sponsor: 90 }),
      row({ id: "blocked", eligible: false, fit: 90, sponsor: 90 }),
    ]);
    expect(a.map.points.map((p) => [p.id, p.applied])).toEqual([["s", false], ["applied", true]]);
    expect(a.map.unscored.map((j) => j.id).sort()).toEqual(["nofit", "nosponsor"]);
  });

  it("buckets 12 weeks of found and applied, and passes the weekly goal through", () => {
    const rows = [row({ id: "a", status: "Applied", found_at: daysAgo(3) }), row({ id: "old", found_at: daysAgo(200) })];
    const a = run(rows, [ev("a", 3, "Found"), ev("a", 1, "Status: Applied"), ev("old", 200, "Found")], { goals: { weekly_goal: 5 } });
    expect(a.weekly.at(-1)).toMatchObject({ week: "2026-01-12", found: 1, applied: 1 });
    expect(a.weekly[0]!.week).toBe("2025-10-27");
    expect(a.weekly.reduce((s, w) => s + w.found, 0)).toBe(1);
    expect(a.weeklyGoal).toBe(5);
    expect(run([], [], { goals: { weekly_goal: 0 } }).weeklyGoal).toBeNull();
  });

  it("counts the sponsorship mix over every job", () => {
    const a = run([row({ id: "a", wr_label: "sponsorship_offered" }), row({ id: "b" }), row({ id: "c" }), row({ id: "d", wr_label: "citizen_pr_only", eligible: false })]);
    expect(a.mix).toEqual([{ label: "sponsorship_offered", count: 1 }, { label: "silent", count: 2 }, { label: "citizen_pr_only", count: 1 }]);
  });

  it("finds roles going stale, oldest first", () => {
    const a = run([
      row({ id: "old", posted: "2025-12-01" }), row({ id: "older", posted: "~2025-11-20 (8 weeks ago)" }),
      row({ id: "found-long-ago", found_at: daysAgo(30) }), row({ id: "fresh", posted: "2026-01-10" }),
      row({ id: "applied", status: "Applied", posted: "2025-11-01" }),
    ]);
    expect(a.stale.map((s) => [s.id, s.ageDays, s.ageFrom])).toEqual([["older", 56, "posted"], ["old", 45, "posted"], ["found-long-ago", 30, "found"]]);
  });

  it("joins the search log with job sources", () => {
    const a = run(
      [row({ id: "a", source_site: "SEEK", status: "Applied" }), row({ id: "b", source_site: "seek" }), row({ id: "c", source_site: "Pasted link" })],
      [ev("a", 2, "Status: Applied")],
      { searches: [{ at: daysAgo(3), site: "SEEK", results: "40", kept: "2" }, { at: daysAgo(1), site: "SEEK", results: "~12", kept: "0" }, { at: daysAgo(1), site: "LinkedIn", results: "", kept: "" }] },
    );
    expect(a.sources).toEqual([
      { site: "SEEK", seen: 52, searches: 2, kept: 2, applied: 1 },
      { site: "Pasted link", seen: null, searches: 0, kept: 1, applied: 0 },
      { site: "LinkedIn", seen: null, searches: 1, kept: 0, applied: 0 },
    ]);
  });

  it("sorts shortlisted salaries into 482 bands and lists the unstated ones", () => {
    const { core, specialist } = SALARY_THRESHOLDS;
    const a = run([
      row({ id: "spec", status: "Saved", salary_min: specialist, salary_max: specialist + 10_000 }),
      row({ id: "core", status: "Applying", salary_text: `$${core / 1000 + 1}k - $${core / 1000 + 20}k` }),
      row({ id: "below", status: "Applied", salary_text: "$60,000" }),
      row({ id: "hourly", status: "Saved", salary_text: "$90 per hour" }),
      row({ id: "none", status: "Interview" }),
      row({ id: "not-shortlisted", status: "Found", salary_text: "$200k" }),
      row({ id: "rejected", status: "Rejected", salary_text: "$200k" }),
    ]);
    expect(a.salary.shortlisted).toBe(5);
    expect(a.salary.specialist.jobs.map((j) => j.id)).toEqual(["spec"]);
    expect(a.salary.core.jobs.map((j) => j.id)).toEqual(["core"]);
    expect(a.salary.below.count).toBe(1);
    expect(a.salary.notStated.jobs.map((j) => j.id)).toEqual(["hourly", "none"]);
  });

  it("bands a package that includes super on its base pay, with a reason", () => {
    expect(SUPER_RATE).toBe(0.12);
    const a = run([
      row({ id: "pkg", status: "Saved", salary_text: "$160k package incl. super" }), // base about $142.9k
      row({ id: "at-spec", status: "Saved", salary_text: "$146,717" }),
      row({ id: "at-core", status: "Saved", salary_text: "$79,499 + super" }),
      row({ id: "range", status: "Saved", salary_text: "150,000–170,000" }),
    ]);
    expect(a.salary.core.jobs.map((j) => j.id)).toEqual(["pkg", "at-core"]);
    expect(a.salary.core.jobs[0]!.note).toMatch(/includes super.*\$143k/i);
    expect(a.salary.specialist.jobs.map((j) => j.id)).toEqual(["at-spec", "range"]);
    expect(a.salary.specialist.jobs[0]!.note).toBeUndefined();
  });

  it("never bands an 'up to' salary, and treats odd figures as not stated", () => {
    const a = run([
      row({ id: "upto", status: "Saved", salary_text: "Up to $200k" }),
      row({ id: "stored-upto", status: "Saved", salary_max: 190_000 }),
      row({ id: "tiny", status: "Saved", salary_text: "$800" }),
      row({ id: "huge", status: "Saved", salary_text: "$1.2m" }),
      row({ id: "hourly", status: "Saved", salary_text: "$40/h" }),
      row({ id: "bare", status: "Saved", salary_text: "$95 - $110" }),
      row({ id: "plus", status: "Saved", salary_text: "$150k+" }),
      row({ id: "hr", status: "Saved", salary_text: "$80/hr" }),
      row({ id: "day", status: "Saved", salary_text: "$900/day" }),
      row({ id: "comp", status: "Saved", salary_text: "competitive" }),
    ]);
    expect(a.salary.specialist.jobs.map((j) => j.id)).toEqual(["plus"]);
    expect(a.salary.notStated.jobs.map((j) => j.id)).toEqual(["upto", "stored-upto", "tiny", "huge", "hourly", "bare", "hr", "day", "comp"]);
    expect(a.salary.notStated.jobs[0]!.note).toMatch(/upper limit/i);
  });

  it("counts down to the search deadline only when it is a real date", () => {
    expect(run([], [], { goals: { search_deadline: "2026-02-24" } }).today).toMatchObject({ searchDeadline: "2026-02-24", deadlineDays: 40 });
    expect(run([], [], { goals: { search_deadline: "soon" } }).today.searchDeadline).toBeNull();
    expect(run([], [], { goals: { search_deadline: "2026-02-30" } }).today.searchDeadline).toBeNull();
    expect(run([], [], { goals: { search_deadline: "2026-13-45" } }).today.searchDeadline).toBeNull();
  });

  it("skips events with unreadable dates", () => {
    const a = run([row({ id: "a", found_at: "" })], [ev("a", 0, "Found"), { company_slug: "acme-corp", job_id: "a", at: "garbage", event: "Status: Saved" }]);
    expect(a.funnel.stages[0]!.reached).toBe(1);
    expect(a.funnel.stages[1]!.reached).toBe(0);
  });
});

describe("local calendar dates (Brisbane, before 10:00)", () => {
  const prev = process.env.TZ;
  beforeAll(() => { process.env.TZ = "Australia/Brisbane"; });
  afterAll(() => { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; });
  // 08:00 Monday 12 Jan in Brisbane is still Sunday 11 Jan in UTC.
  const now = new Date("2026-01-11T22:00:00.000Z");

  it("counts deadline days from the local date", () => {
    expect(now.getDate()).toBe(12); // the TZ switch took effect
    expect(daysUntil("2026-01-12", now)).toBe(0);
    expect(daysUntil("2026-01-13", now)).toBe(1);
    expect(daysUntil("2026-01-11", now)).toBe(-1);
  });

  it("starts weeks on the local Monday and buckets events by local date", () => {
    const rows = [row({ id: "a", status: "Applied", found_at: "2026-01-11T21:00:00.000Z" })]; // 07:00 Mon local
    const a = homeAnalytics({ rows, events: [{ company_slug: "acme-corp", job_id: "a", at: "2026-01-11T21:30:00.000Z", event: "Status: Applied" }], searches: [], goals: {}, now });
    expect(a.weekly.at(-1)).toMatchObject({ week: "2026-01-12", found: 1, applied: 1 });
    expect(a.weekly[0]!.week).toBe("2025-10-27");
  });
});

describe("seenCount", () => {
  it("counts what was read, not every digit run together", () => {
    expect(seenCount("81 (cards 51-81)")).toBe(31);
    expect(seenCount("2,000+ (25 read)")).toBe(25);
    expect(seenCount("87 (25 cards p1 read)")).toBe(25);
    expect(seenCount("2,000+")).toBe(2000);
    expect(seenCount("48")).toBe(48);
    expect(seenCount("~12")).toBe(12);
    expect(seenCount(12)).toBe(12);
    expect(seenCount("")).toBeNull();
    expect(seenCount("unknown")).toBeNull();
  });
});
