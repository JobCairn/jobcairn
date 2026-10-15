import type { Fixture } from "../mock/fixture-types";
/** A fictional structured score and write-up for the preview and tests (Alex Example, Acme Corp, Example Labs). */
export const DEMO_SCORE = {
  fit: 72, interview_odds: 64, tier: "Good Fit", recommendation: "Apply with a tailored resume that leads with your retrieval work.",
  summary: "Strong match on Python and LLM apps. Streaming data and production Kubernetes are the gaps.",
  must_haves: [
    { text: "3+ years of Python in production", status: "met", evidence: "Your resume shows four years of Python services at Example Labs." },
    { text: "Built LLM or RAG features end to end", status: "met", evidence: "Your profile describes a retrieval pipeline you designed and shipped, with evaluation and monitoring, used by internal support teams every day." },
    { text: "Kubernetes in production", status: "partial", evidence: "Your profile lists Kubernetes basics only." },
    { text: "Kafka or another event streaming platform", status: "not_met", evidence: "Nothing in your resume or profile." },
  ],
  nice_to_haves: [{ text: "TypeScript", status: "met", evidence: "Your resume lists TypeScript at Example Labs." }],
  changes: ["A small Kafka project you can talk through", "One resume bullet on running services on Kubernetes", "A number for the retrieval pipeline's usage or speed"],
} as const;

export const DEMO_SCORE_MD = [
  "# Score: AI Engineer at Acme Corp",
  "",
  "**Fit:** 72/100 · **Interview odds:** 64/100 · **Good Fit**",
  "",
  "## Must-haves",
  "",
  "| # | Must-have | Status | Evidence |",
  "|---|---|---|---|",
  "| 1 | 3+ years of Python | Met | Your resume |",
  "| 2 | LLM or RAG features | Met | Your profile |",
  "| 3 | Kubernetes in production | Partial | Your profile lists basics |",
  "| 4 | Kafka | Not met | Nothing yet |",
  "",
  "## What would change this",
  "",
  "- [ ] A small Kafka project",
  "- [x] Retrieval work on the resume",
  "",
].join("\n");

/**
 * Preview only (`?score`): Acme Corp's AI Engineer job scored with a structured score, Example Labs' job with only an
 * older write-up ("Fit score 52 / 100"), and the rest unscored, so the card, the legacy view and the empty state show.
 */
export function withScoreDemo(f: Fixture): Fixture {
  const at = "2026-10-09T23:10:00.000Z";
  const acme = f.jobs.find((j) => j.job.company_slug === "acme-corp");
  if (acme) {
    const base = `companies/acme-corp/jobs/${acme.job.id}`;
    f.texts[`${base}/score.json`] = JSON.stringify({ ...DEMO_SCORE, scored_at: at });
    f.texts[`${base}/score.md`] = DEMO_SCORE_MD;
    acme.job.scores.fit = { value: DEMO_SCORE.fit, must_haves: DEMO_SCORE.must_haves.map((m) => ({ ...m, met: m.status === "met" })), nice_to_haves: [] };
    acme.job.scores.career = { match: DEMO_SCORE.fit, odds: DEMO_SCORE.interview_odds, tier: DEMO_SCORE.tier, scored_at: at };
  }
  const labs = f.jobs.find((j) => j.job.company_slug === "example-labs");
  if (labs) {
    f.texts[`companies/example-labs/jobs/${labs.job.id}/score.md`] = [
      "# Job evaluation (Workflow 2, job evaluation)", "", "**Fit score: 52 / 100** (Match A) · Interview odds (B): 40/100", "",
      "| # | Must-have | Status | Evidence |", "|---|---|---|---|",
      "| 1 | Python | Met | me/resumes/alex-example.pdf |", "| 2 | Kafka | Not met | Not in me/history/profile.md |", "",
    ].join("\n");
    labs.job.scores.fit = { value: null, must_haves: [], nice_to_haves: [] };
    labs.job.scores.career = { match: null, odds: null, tier: "", scored_at: "" };
  }
  return f;
}
