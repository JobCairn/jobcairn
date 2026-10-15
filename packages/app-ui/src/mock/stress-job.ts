import type { Fixture, FixtureJob } from "./fixture-types";

/**
 * A fictional job that stresses the layout: a very long title, and a JD saved the way the job-hunt
 * agents save them (H1 title, "Key: value" metadata bullets with raw URLs, a `---` rule, a
 * plain-text "Key Responsibilities" line and long paragraphs). The dev preview adds it to the mock
 * so screenshots and visual checks see the hard case. Tests opt in with `withStressJob`.
 */
export const STRESS_SLUG = "example-labs";
export const STRESS_ID = "2025-12-22-machine-learning-engineer-ml-platform";
export const STRESS_TITLE =
  "Machine Learning Engineer - ML Platform, Applied Generative AI and Retrieval Infrastructure (Senior, Hybrid)";

export const STRESS_JD = `# ${STRESS_TITLE} — Example Labs
- Source: LinkedIn https://www.linkedin.com/jobs/view/0000000001/
- Fetched: 2026-01-12
- Location / mode: Sampletown NSW / Hybrid (3 days in office)
- Salary: $150,000 - $170,000 + super
- Posted: ~2025-12-22 (3 weeks ago)
- Work rights: Sponsorship available — "We can sponsor a 482 visa for the right candidate."
- Apply via: https://careers.example.com/jobs/ml-platform-engineer
---
Example Labs builds retrieval and evaluation tooling for teams that ship language-model features to real customers. We are a small group of engineers who care about measured quality, careful rollouts and clear writing, and we work closely with product and support so that what we build solves problems people actually have rather than problems that look interesting on a whiteboard.

Key Responsibilities

Design, build and run the platform that our product teams use to train, evaluate and deploy retrieval-augmented generation features, from ingestion and chunking through embedding, indexing, ranking and response generation, with observability at every step so regressions are caught before customers notice them.

Own the offline and online evaluation harness: golden datasets, judge prompts, latency and cost budgets, and the dashboards that tell us whether a change made things better or worse.

Work with product engineers to turn prototypes into dependable services with sensible fallbacks, rate limits and caching.

About You

You have shipped machine learning or LLM-backed systems to production and supported them afterwards. You write clear Python or TypeScript, you are comfortable with cloud infrastructure and containers, and you can explain trade-offs to people who are not engineers.

- Strong Python or TypeScript
- Experience with vector search and ranking
- Familiarity with evaluation methods for generative models
- Nice to have: Kubernetes basics, streaming data pipelines
`;

export function stressJob(): FixtureJob {
  return {
    job: {
      schema: 1, id: STRESS_ID, company_slug: STRESS_SLUG, client: null, title: STRESS_TITLE,
      source: "browser", source_site: "LinkedIn", url: "https://www.linkedin.com/jobs/view/0000000001/",
      apply_via: "https://careers.example.com/jobs/ml-platform-engineer", posted: "2025-12-22",
      found_at: "2026-01-12T09:00:00.000Z", location: "Sampletown NSW", work_mode: "Hybrid", job_type: "Full time",
      salary: { text: "$150,000 - $170,000 + super", min: 150000, max: 170000, currency: "AUD", period: "year" },
      timeline: [
        { at: "2026-01-12T09:00:00.000Z", event: "Found", note: "LinkedIn" },
        { at: "2026-01-13T02:30:00.000Z", event: "Scored", note: "Fit 78" },
      ],
      work_rights: { label: "sponsorship_offered", quotes: ["We can sponsor a 482 visa for the right candidate."], decided_by: "rules" },
      scores: {
        fit: { value: 78, must_haves: [], nice_to_haves: [] },
        sponsor: { value: 95, tier: "High", reasons: ["ad says sponsorship is available"] },
        career: { match: null, odds: null, tier: "", scored_at: "" },
      },
      status: "Saved",
      files: [{ path: "jd.md", label: "Job description", at: "2026-01-12T09:00:00.000Z" }],
      custom: {},
    } as FixtureJob["job"],
    company: { name: "Example Labs", slug: STRESS_SLUG, website: "https://example.com", sponsor_status: "unknown" },
    description: STRESS_JD,
    interview: [],
  };
}

/** Adds the stress job (and its JD text) to a fixture. */
export function withStressJob(f: Fixture): Fixture {
  const j = stressJob();
  f.jobs.push(j);
  f.texts[`companies/${STRESS_SLUG}/jobs/${STRESS_ID}/jd.md`] = STRESS_JD;
  return f;
}
