// Fictional Resume Studio data for the dev preview and tests: Alex Example only, no real person or employer.

export const RESUME_JOB = { slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;

export const ALEX_RESUME = [
  "# Alex Example",
  "",
  "AI Engineer · Sampletown NSW 2000 · alex" + "@" + "example.com · 0491 570 006",
  "",
  "## Summary",
  "",
  "AI engineer who builds **retrieval** pipelines and LLM agents for support teams (fictional).",
  "",
  "## Experience",
  "",
  "### AI Engineer, Example Labs",
  "*2024 to now · Sampletown*",
  "",
  "- Built a retrieval pipeline that answers support questions from product docs.",
  "- Added an evaluation suite that checks answers against cited sources.",
  "- Cut answer latency by caching embeddings.",
  "",
  "### Software Developer, Acme Corp",
  "*2021 to 2024 · Sampletown*",
  "",
  "- Wrote Node.js services for the billing team.",
  "- Moved nightly reports to a job queue.",
  "",
  "## Projects",
  "",
  "### Docs search assistant",
  "",
  "- A small RAG demo over public docs, with citations (fictional).",
  "",
  "## Skills",
  "",
  "- Python, TypeScript, Node.js",
  "- Retrieval, embeddings, evaluation",
  "",
  "## Education",
  "",
  "### BSc Computer Science, Example University",
  "*2017 to 2020*",
  "",
].join("\n");

/**
 * A fictional rewrite_resume result: the whole resume with two lines rewritten, as Claude writes
 * application/.studio/resume.suggested.md. Text that isn't there is left alone.
 */
export function mockRewrite(md: string): string {
  return md
    .replace("AI engineer who builds **retrieval** pipelines and LLM agents for support teams (fictional).", "AI engineer who builds **retrieval** pipelines and LLM agents, with evaluation built in from day one (fictional).")
    .replace("- Built a retrieval pipeline that answers support questions from product docs.", "- Built a retrieval pipeline (RAG) that answers support questions from product docs, with sources cited.");
}

/**
 * A long general version for the preview (about three pages): several roles at one organisation, pipe-style titles,
 * education and certifications as one-line items, a long bullet, languages and an empty Awards section. Fictional.
 */
/** The long version with `jobs` earlier roles: 8 is about three pages, 3 about two. */
export const alexLongResume = (jobs: number): string => [
  "# Alex Example",
  "",
  "Senior AI Engineer | Retrieval, agents and evaluation",
  "",
  "alex" + "@" + "example.com | 0491 570 006 | linkedin.com/in/alex-example | github.com/alex-example | Sampletown, NSW, Australia",
  "",
  "## Summary",
  "",
  "AI engineer with six years building retrieval systems, agents and the evaluation around them. Most at home where product, data and infrastructure meet (fictional).",
  "",
  "## Experience",
  "",
  "### Example Labs | Jan 2021 to Present",
  "**Senior AI Engineer** · Jan 2024 to Present",
  "- Led the retrieval platform used by four product teams, from design to on-call.",
  "- Built an evaluation suite that checks every answer against its cited sources before release, and runs nightly against a fixed set of questions so regressions show up the next morning rather than in a customer ticket, which used to take a week to find.",
  "- Cut answer latency by caching embeddings and streaming partial answers.",
  "- Mentored two engineers through their first production launches.",
  "",
  "**AI Engineer** | Jan 2021 to Dec 2023",
  "",
  "- Built the first agent that drafts support replies from product docs.",
  "- Moved document ingestion to a queue, so large uploads no longer time out.",
  "- Wrote the team's guide to prompt and retrieval testing.",
  "",
  ...Array.from({ length: jobs }, (_x, i) => [
    `### Acme Corp ${["Billing", "Platform", "Data", "Labs", "Search", "Mobile", "Payments", "Growth"][i]}, Sydney | ${2020 - i} to ${2021 - i}`,
    "",
    "Software Developer",
    "",
    "- Wrote Node.js services for the billing team and kept them running.",
    "- Moved nightly reports to a job queue and cut their run time in half.",
    "- Added tracing across services so slow requests could be found in minutes.",
    "- Paired with designers on the first self-serve billing screens.",
    "",
  ]).flat(),
  "## Projects",
  "",
  "### Docs search assistant | 2023",
  "github.com/alex-example/docs-search",
  "",
  "- A small RAG demo over public docs, with citations (fictional).",
  "- Runs on a laptop with a local model, or against a hosted one.",
  "",
  "## Education",
  "",
  "- Master of Data Science | Example University | 2019 to 2021",
  "- BSc Computer Science | Example Institute | 2013 to 2016",
  "",
  "## Certifications",
  "",
  "- AWS Certified Developer | Amazon Web Services | 2024",
  "- Machine Learning Specialisation | Example Online | 2022",
  "",
  "## Skills",
  "",
  "- **Languages:** Python, TypeScript, Go, SQL",
  "- **AI:** Retrieval, embeddings, evaluation, agents, fine-tuning",
  "- **Cloud:** AWS, Docker, Terraform, Postgres",
  "",
  "## Languages",
  "",
  "- English: Native",
  "- Nepali: Fluent",
  "",
  "## Awards",
  "",
].join("\n");
export const ALEX_LONG_RESUME = alexLongResume(8);
/** About two pages. */
export const ALEX_MEDIUM_RESUME = alexLongResume(3);
