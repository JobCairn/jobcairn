import { describe, expect, it } from "vitest";
import { auStateOf, BREADTH_QUERIES, BUDGET_MAX, findBudget, isTechSearch, MAX_JOBS, planSearchWords, planWidenPlaces, searchPlan, searchPrefsFrom, searchWords } from "../src/index.js";

const prefs = (profile: unknown, search: unknown = {}) => searchPrefsFrom(profile, search);

describe("search words", () => {
  it("cuts seniority words so the shortest search goes first", () => {
    expect(searchWords("Senior AI Engineer")).toBe("AI Engineer");
    expect(searchWords("Sr. Data Engineer")).toBe("Data Engineer");
    expect(searchWords("Lead Software Engineer (LLM)")).toBe("Software Engineer LLM");
    expect(searchWords("Senior")).toBe("Senior");
  });

  it("builds roles, related titles, family titles and skills, shortest roles first, no repeats", () => {
    const p = prefs({ targets: { roles: ["Senior Software Engineer (LLM)", "Senior AI Engineer"] } }, { filters: { related_titles: ["Conversational AI Engineer"] } });
    const words = planSearchWords(p, ["LLM", "Python", "RAG", "LangChain", "Docker"]);
    expect(words.slice(0, 3)).toEqual(["AI Engineer", "Software Engineer LLM", "Conversational AI Engineer"]);
    expect(words).toEqual(expect.arrayContaining(["Machine Learning Engineer", "Generative AI Engineer", "Software Engineer AI"]));
    expect(words.filter((w) => w.toLowerCase() === "ai engineer")).toHaveLength(1);
    expect(words.length).toBeLessThanOrEqual(12);
  });

  it("adds skills when there's room, and a non-AI role gets its own family", () => {
    const words = planSearchWords(prefs({ targets: { roles: ["Data Engineer"] } }), ["Python", "dbt"]);
    expect(words).toEqual(["Data Engineer", "Data Scientist", "Analytics Engineer", "Machine Learning Engineer", "Data Analyst", "Python", "dbt"]);
  });

  it("knows which searches are IT work", () => {
    expect(isTechSearch(["Senior AI Engineer"])).toBe(true);
    expect(isTechSearch(["Python Developer"])).toBe(true);
    expect(isTechSearch(["Civil Engineer"])).toBe(false);
    expect(isTechSearch(["Registered Nurse"])).toBe(false);
    for (const r of ["Mobile Plant Operator", "Data Entry Clerk", "QA Inspector", "Automation Technician", "Systems Coordinator"]) expect(isTechSearch([r]), r).toBe(false);
    for (const r of ["Full Stack Developer", "Data Scientist", "iOS Developer", "DevOps Engineer", "Software Engineer (LLM)"]) expect(isTechSearch([r]), r).toBe(true);
  });
});

describe("widening", () => {
  it("goes from the preferred places to remote in the country, the state, then the country", () => {
    const p = prefs({ targets: { roles: ["AI Engineer"] }, locations: [{ place: "Gold Coast", modes: ["onsite", "hybrid", "remote"] }, { place: "Brisbane", modes: ["hybrid"] }] });
    expect(planWidenPlaces(p)).toEqual(["Remote Australia", "Queensland", "Australia"]);
  });

  it("puts the person's fallbacks first and skips places already preferred", () => {
    const p = prefs({ locations: [{ place: "Exampleville QLD", modes: ["remote"] }, { place: "Remote Australia", modes: ["remote"] }] }, { filters: { fallback_locations: ["Sydney"] } });
    expect(planWidenPlaces(p)).toEqual(["Sydney", "Queensland", "Australia"]);
  });

  it("doesn't widen to remote when the person doesn't take remote work", () => {
    const p = prefs({ locations: [{ place: "Brisbane", modes: ["onsite"] }] });
    expect(planWidenPlaces(p)).toEqual(["Queensland", "Australia"]);
  });

  it("stays inside the allowed countries", () => {
    const p = prefs({ locations: [{ place: "Auckland", modes: ["onsite", "hybrid", "remote"] }] });
    expect(planWidenPlaces(p)).toEqual(["Remote New Zealand", "New Zealand"]);
    expect(auStateOf("Gold Coast")).toBe("Queensland");
    expect(auStateOf("Exampleville NSW")).toBe("New South Wales");
    expect(auStateOf("Auckland")).toBeNull();
  });
});

describe("plan", () => {
  it("has enough queries for a focused search across two places, and more when broad", () => {
    expect(BREADTH_QUERIES.focused).toBeGreaterThanOrEqual(6);
    expect(BREADTH_QUERIES.broad).toBeGreaterThan(BREADTH_QUERIES.focused);
    const plan = searchPlan(prefs({ targets: { roles: ["Senior AI Engineer"] }, locations: [{ place: "Gold Coast", modes: [] }] }), ["LLM"]);
    expect(plan.tech).toBe(true);
    expect(plan.words[0]).toBe("AI Engineer");
    expect(plan.words).toContain("LLM");
  });
});

describe("how many jobs a search finds, and the run's limits for it", () => {
  it("allows 1 to 200, 100 by default", () => {
    expect(MAX_JOBS).toEqual({ min: 1, max: 200, default: 100 });
  });

  it("never gives a small search less than before, and scales up for big ones", () => {
    const small = findBudget(10);
    expect(small.pagesPerBoard).toBeGreaterThanOrEqual(25);
    expect(small.actions).toBeGreaterThanOrEqual(300);
    expect(small.browseMs).toBeGreaterThanOrEqual(15 * 60_000);
    expect(small.claudeMs).toBeGreaterThanOrEqual(20 * 60_000);
    expect(small.jobNew).toBeGreaterThanOrEqual(50);
    expect(small.searchAdd).toBeGreaterThanOrEqual(100);
    const big = findBudget(100);
    // Every kept job is an ad read on some board, plus the ads dropped and the results pages.
    expect(big.pagesPerBoard).toBeGreaterThanOrEqual(200);
    expect(big.jobNew).toBeGreaterThanOrEqual(150);
    expect(big.actions).toBeGreaterThan(small.actions);
    expect(big.browseMs).toBeGreaterThan(small.browseMs);
  });

  it("leaves Claude time to write the report after browsing stops", () => {
    for (const n of [1, 10, 100, 200]) expect(findBudget(n).claudeMs - findBudget(n).browseMs).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("stays under its hard limits at the most, and treats bad numbers as the nearest allowed", () => {
    const top = findBudget(MAX_JOBS.max);
    for (const k of Object.keys(BUDGET_MAX) as (keyof typeof BUDGET_MAX)[]) expect(top[k]).toBeLessThanOrEqual(BUDGET_MAX[k]);
    expect(findBudget(10_000)).toEqual(top);
    expect(findBudget(0)).toEqual(findBudget(1));
    expect(findBudget(Number.NaN)).toEqual(findBudget(MAX_JOBS.default));
  });
});
