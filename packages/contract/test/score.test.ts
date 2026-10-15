import { describe, expect, it } from "vitest";
import {
  SCORE_TIERS, parseLegacyScore, plainPaths, scoreFromRecord, scoreRecordArgs, scoreResultFrom,
} from "../src/score.js";

const GOOD = {
  fit: 72, interview_odds: 64, tier: "Good Fit", recommendation: "Apply with a tailored resume.",
  must_haves: [
    { text: "3+ years Python", status: "met", evidence: "Your resume shows four years of Python at Acme Corp." },
    { text: "Kubernetes", status: "partial", evidence: "Your profile lists Kubernetes basics only." },
    { text: "Kafka", status: "not_met", evidence: "Nothing in your resume or profile." },
  ],
  changes: ["A Kafka side project", "A Kubernetes certificate"],
  summary: "Strong Python match for Example Labs; streaming is the gap.",
};

describe("score tiers", () => {
  it("are the career skill's five tiers, in order", () => {
    expect(SCORE_TIERS).toEqual(["Definite No Go", "Nah", "Meh", "Good Fit", "Freaking Apply Now"]);
  });
});

describe("scoreRecordArgs", () => {
  it("accepts a full result and defaults the optional lists", () => {
    const v = scoreRecordArgs(GOOD, "score_record");
    expect(v.fit).toBe(72);
    expect(v.nice_to_haves).toEqual([]);
    expect(v.must_haves[1]!.status).toBe("partial");
  });
  it("refuses out-of-range numbers, unknown tiers, unknown statuses and extra keys", () => {
    expect(() => scoreRecordArgs({ ...GOOD, fit: 101 }, "a")).toThrow(/whole number from 0 to 100/);
    expect(() => scoreRecordArgs({ ...GOOD, fit: 50.5 }, "a")).toThrow(/whole number/);
    expect(() => scoreRecordArgs({ ...GOOD, interview_odds: -1 }, "a")).toThrow(/interview_odds/);
    expect(() => scoreRecordArgs({ ...GOOD, tier: "Great" }, "a")).toThrow(/tier must be one of/);
    expect(() => scoreRecordArgs({ ...GOOD, must_haves: [{ text: "X", status: "yes", evidence: "" }] }, "a")).toThrow(/status must be one of/);
    expect(() => scoreRecordArgs({ ...GOOD, path: "me/history/profile.md" }, "a")).toThrow(/path is not allowed/);
    expect(() => scoreRecordArgs({ ...GOOD, must_haves: Array(41).fill(GOOD.must_haves[0]) }, "a")).toThrow(/at most 40/);
  });
});

describe("plainPaths", () => {
  it("names workspace files in plain words", () => {
    expect(plainPaths("See me/resumes/alex-example.pdf and me/history/profile.md.")).toBe("See your resume and your profile.");
    expect(plainPaths("The ad (jd.md) asks for Go.")).toBe("The ad (the job ad) asks for Go.");
    expect(plainPaths("From companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md")).toBe("From the job ad");
    expect(plainPaths("In application/resume.md and application/cover-letter.md")).toBe("In your tailored resume and your cover letter");
    expect(plainPaths("me/history/projects/rag.md")).toBe("your career history");
    expect(plainPaths("knowledge/job-searches/2026-01-12.md")).toBe("your notes");
  });
  it("leaves ordinary text, URLs and code words alone", () => {
    const s = "Built a RAG app with Node.js and package.json scripts; see https://example.com/me/docs.md";
    expect(plainPaths(s)).toBe(s);
    expect(plainPaths("Python 3.12, me / my team")).toBe("Python 3.12, me / my team");
    expect(plainPaths("Send it as application/json, or contact me/us.")).toBe("Send it as application/json, or contact me/us.");
    expect(plainPaths("Read me/history and me/resumes first.")).toBe("Read your career history and your resume first.");
  });
  it("drops internal workflow and rubric labels", () => {
    expect(plainPaths("Job evaluation (Workflow 2, job evaluation)")).toBe("Job evaluation");
    expect(plainPaths("Rubric A: 52/100")).toBe("Fit: 52/100");
    expect(plainPaths("Rubric B — Interview Odds")).toBe("Interview odds");
  });
});

describe("parseLegacyScore", () => {
  it("reads a fit score from an older write-up", () => {
    expect(parseLegacyScore("# Score\n\n**Fit score: 52 / 100**\n")).toEqual({ fit: 52 });
    expect(parseLegacyScore("Fit score 52/100")).toEqual({ fit: 52 });
    expect(parseLegacyScore("## Fit score\n\n78 / 100")).toEqual({ fit: 78 });
    expect(parseLegacyScore("Rubric A — Ideal Job Match: 61/100\nRubric B — Interview Odds: 40/100")).toEqual({ fit: 61, interview_odds: 40 });
    expect(parseLegacyScore("Interview odds: 35 / 100\nFit: 70/100")).toEqual({ fit: 70, interview_odds: 35 });
  });
  it("finds the tier when one is named", () => {
    expect(parseLegacyScore("Fit score: 88/100\nRecommendation: **Freaking Apply Now**")).toEqual({ fit: 88, tier: "Freaking Apply Now" });
  });
  it("leaves it unset when there is no clear number", () => {
    expect(parseLegacyScore("# Score\n\nFit 72. Gaps: Kubernetes.")).toBeNull();
    expect(parseLegacyScore("Fit score: 140/100")).toBeNull();
    expect(parseLegacyScore("")).toBeNull();
  });
});

describe("scoreResultFrom / scoreFromRecord", () => {
  it("turns a saved score.json into a result, cleaning paths", () => {
    const r = scoreResultFrom({ ...GOOD, must_haves: [{ text: "Python", status: "met", evidence: "me/resumes/a.pdf" }], scored_at: "2026-01-14T09:00:00.000Z" });
    expect(r).toMatchObject({ fit: 72, tier: "Good Fit", source: "structured", scored_at: "2026-01-14T09:00:00.000Z" });
    expect(r!.must_haves[0]!.evidence).toBe("your resume");
    expect(scoreResultFrom({ fit: "high" })).toBeNull();
  });
  it("builds a result from the job record's scores when only those exist", () => {
    const r = scoreFromRecord({ fit: { value: 70, must_haves: [{ skill: "Kafka", met: false }], nice_to_haves: [] }, career: { match: 70, odds: 50, tier: "Meh", scored_at: "2026-01-13T00:00:00.000Z" } });
    expect(r).toMatchObject({ fit: 70, interview_odds: 50, tier: "Meh", source: "record" });
    expect(r!.must_haves).toEqual([{ text: "Kafka", status: "not_met", evidence: "" }]);
    expect(scoreFromRecord({ fit: { value: null, must_haves: [], nice_to_haves: [] }, career: { match: null, odds: null, tier: "", scored_at: "" } })).toBeNull();
  });
});
