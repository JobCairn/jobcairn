import { describe, expect, it } from "vitest";
import type { ActionTarget, ClaudeRunStep, ClaudeRunView } from "@careeros/contract";
import { dedupeSteps, currentStep } from "../src/claude/steps";
import { chipVerb, finishedSince, resultLink, runRoute, runsForJob, statusSnapshot } from "../src/claude/activity-model";

const step = (label: string, state: ClaudeRunStep["state"] = "done"): ClaudeRunStep => ({ label, state, at: "2026-10-10T05:00:00.000Z" });

function run(over: Partial<ClaudeRunView> & { target: ActionTarget }): ClaudeRunView {
  return {
    id: "r1", action: "research_company", key: "k", status: "running", started_at: "2026-10-10T05:00:00.000Z", ended_at: "",
    elapsed_ms: 0, steps: [], summary: "", files: [], missing: [], stray: [], error: "", cost_usd: null, turns: null, ...over,
  };
}

describe("dedupeSteps", () => {
  it("collapses repeated labels into one line with a count, in first-seen order", () => {
    const out = dedupeSteps([
      step("Starting Claude"), step("Looking through your files"), step("Reading your experience"),
      step("Looking through your files"), step("Reading your experience"), step("Searching the web", "active"),
    ]);
    expect(out.map((s) => [s.label, s.count, s.state])).toEqual([
      ["Starting Claude", 1, "done"], ["Looking through your files", 2, "done"], ["Reading your experience", 2, "done"], ["Searching the web", 1, "active"],
    ]);
  });

  it("a repeated label takes the state of its latest occurrence", () => {
    const out = dedupeSteps([step("Reading the job ad"), step("Writing"), step("Reading the job ad", "active")]);
    expect(out[0]).toEqual({ label: "Reading the job ad", count: 2, state: "active" });
  });

  it("ignores blank labels and treats case and spacing alike", () => {
    expect(dedupeSteps([step("  "), step("Reading  files"), step("reading files")])).toEqual([{ label: "Reading  files", count: 2, state: "done" }]);
  });

  it("returns nothing for no steps", () => {
    expect(dedupeSteps([])).toEqual([]);
  });

  it("names the current step: the last one", () => {
    expect(currentStep([step("A"), step("B", "active")])).toBe("B");
    expect(currentStep([])).toBe("");
  });
});

describe("activity model", () => {
  const job: ActionTarget = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };

  it("opens a job's run on that job's Activity tab, other runs on their screen or nowhere", () => {
    expect(runRoute(run({ target: job, action: "score_job" }))).toEqual({ screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "activity" });
    expect(runRoute(run({ target: { kind: "topic", topic: "rag", label: "RAG", company_slug: "acme-corp", id: "j1" }, action: "skill_gap_video" })))
      .toEqual({ screen: "job", slug: "acme-corp", id: "j1", tab: "activity" });
    expect(runRoute(run({ target: { kind: "workspace" }, action: "find_jobs" }))).toEqual({ screen: "jobs" });
    expect(runRoute(run({ target: { kind: "topic", topic: "rag", label: "RAG" }, action: "study_topic" }))).toEqual({ screen: "learn", topic: "rag" });
    expect(runRoute(run({ target: { kind: "company", company_slug: "acme-corp" } }))).toBeNull();
  });

  it("lists a job's runs, including its company's and its skill-gap topics'", () => {
    const runs = [
      run({ id: "a", target: job }),
      run({ id: "b", target: { kind: "company", company_slug: "acme-corp" } }),
      run({ id: "c", target: { kind: "topic", topic: "rag", label: "RAG", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } }),
      run({ id: "d", target: { kind: "job", company_slug: "acme-corp", id: "other" } }),
      run({ id: "e", target: { kind: "company", company_slug: "example-labs" } }),
      run({ id: "f", target: { kind: "workspace" }, action: "find_jobs" }),
    ];
    expect(runsForJob(runs, "acme-corp", "2026-01-12-ai-engineer").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("finds runs that finished since the last look, once", () => {
    const before = statusSnapshot([run({ id: "a", target: job }), run({ id: "b", target: job, status: "queued" })]);
    const after = [run({ id: "a", target: job, status: "succeeded" }), run({ id: "b", target: job, status: "running" }), run({ id: "c", target: job, status: "failed" })];
    expect(finishedSince(before, after).map((r) => r.id)).toEqual(["a"]);
    expect(finishedSince(statusSnapshot(after), after)).toEqual([]);
  });

  it("links every finished result to its exact place", () => {
    expect(resultLink(run({ target: job, action: "score_job", status: "succeeded" }))).toEqual({ label: "Open score", to: { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "score" } });
    expect(resultLink(run({ target: job, action: "tailor_application", status: "succeeded" })).to).toEqual({ screen: "apply", slug: "acme-corp", id: "2026-01-12-ai-engineer", step: "review" });
    expect(resultLink(run({ target: { kind: "workspace" }, action: "find_jobs", status: "succeeded" }))).toEqual({ label: "Open jobs", to: { screen: "jobs" } });
    expect(resultLink(run({ target: job, action: "score_job", status: "failed" }))).toEqual({ label: "Open", to: { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "activity" } });
  });

  it("has a short verb for the inline chip", () => {
    expect(chipVerb("find_jobs")).toBe("Finding jobs");
    expect(chipVerb("research_company")).toBe("Researching");
    expect(chipVerb("score_job")).toBe("Scoring");
    expect(chipVerb("company_background_video")).toBe("Making video");
  });
});
