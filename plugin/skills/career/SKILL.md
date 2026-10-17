---
name: career
description: >-
  Career management and ATS resume tailoring toolkit. Covers resume review and
  scoring (formatting, design, content, ATS-parseability), tailoring a resume to
  a specific job description, evaluating/scoring job postings for fit and
  interview odds with an apply/not-apply recommendation, building and refining
  scoring rubrics, extracting career content from exported conversation
  archives into master docs, and auditing the resume pipeline for traceability.
  Use this whenever the user wants to review/score/tailor/audit a resume, decide
  whether to apply to a role, evaluate or rank a job posting, work on resume
  rubrics, pull achievements out of past conversations, or check whether their
  resume pipeline can be trusted — even if they don't say the word "resume" (e.g.
  "should I apply to this?", "score this job", "is my experience section strong?",
  "pull more from my convos", "can I trust this chain?").
---

# Career

Resume coaching, job evaluation, rubric work, content extraction, and pipeline
quality assurance, built on a set of **master docs** that are the single source
of truth for the user's history. Never invent experience, metrics, titles, or
dates; every claim must trace back to those docs. See
`references/concepts-master-and-confidentiality.md` for the master-vs-tailored
model and the full confidentiality mandate — read it before Workflow 4.

## Configuration

These paths are project-specific. Ask the user (or infer from the workspace) if
they aren't set. Sensible defaults for the JobCairn workspace layout are shown
(`<slug>` is a company slug, `<id>` a job identifier such as a role slug or date).

| Variable | Description | Default |
|----------|-------------|---------|
| `{{DOCS_ROOT}}` | Resume master docs (source of truth) | `me/history/` |
| `{{PROMPTS_ROOT}}` | Extraction/tailoring prompt templates | `me/prompts/` |
| `{{INDEX_ROOT}}` | Processing index files | `me/history/index/` |
| `{{CONVERSATIONS_DIR}}` | Exported conversation archives | `me/conversations/` |
| `{{JOBS_DIR}}` | Per-application job folders | `companies/<slug>/jobs/` |
| `{{PROFILE}}` | The user's profile (read only for Claude) | `settings/profile.json` |
| `{{CONFIRMED_FACTS}}` | Facts the user confirmed (evidence, like the master docs) | `me/history/confirmed-facts.md` |

If master docs don't exist yet, say so plainly and offer to start with
**Workflow 4 (content extraction)** or to work from a resume the user pastes in —
just flag that traceability can't be verified without master docs.

**Suggested file names** within those roots:

| Purpose | Path |
|---------|------|
| Master docs (source of truth) | `{{DOCS_ROOT}}/00-master-timeline.md` … `08-*.md` |
| Universal job rubric | `{{DOCS_ROOT}}/10-universal-job-rubric-and-apply-recommendation.md` |
| Ranked jobs | `{{DOCS_ROOT}}/11-ranked-jobs-with-apply-recommendations.md` |
| Resume quality rubric (0–100) | `{{DOCS_ROOT}}/09-resume-quality-rubric.md` |
| Master bullet list | `{{DOCS_ROOT}}/07-master-bullet-list.md` |
| Tailored resume prompt | `{{PROMPTS_ROOT}}/prompt-11-master-tailored-resume.md` |
| Extraction prompts | `{{PROMPTS_ROOT}}/prompt-01-employers.md` … `prompt-10-cross-check.md` |
| Processed list | `{{INDEX_ROOT}}/processed_conversations.md` |
| Gaps/conflicts | `{{INDEX_ROOT}}/gaps-and-conflicts.md` |
| Per-application job folders | `{{JOBS_DIR}}/[id]/posting.md`, `resume.md` |
| Learned profile | `{{PROFILE}}` |
| Confirmed facts | `{{CONFIRMED_FACTS}}` |
| Second-pass review of a tailored application | `{{JOBS_DIR}}/[id]/application/review.json` |

## Routing — pick the workflow, then read its reference file

| The user says something like… | Workflow | Read |
|-------------------------------|----------|------|
| "Review my resume", "check formatting/design/content", "review against this job" | 1. Resume Review | `references/workflow-resume-review.md` |
| "Score this job", "should I apply?", "evaluate this posting", "rank these roles" | 2. Job Evaluation | `references/workflow-job-evaluation.md` |
| "Help with rubric development", "evaluate this resume adaptation" | 3. Rubric & Adaptation | `references/workflow-rubric-and-adaptation.md` |
| "Pull achievements from my convos / git / LinkedIn", "gather evidence", "add this new role to my resume" | 4. Content Extraction & Evidence | `references/workflow-content-extraction.md` |
| "Audit the resume chain", "can I trust this pipeline?" | 5. Pipeline Audit | `references/workflow-pipeline-audit.md` |
| "Export my resume to PDF/Word", "convert this markdown resume" | 6. Export | `references/workflow-export.md` |
| After any tailored resume or cover letter; "double-check this draft", "is this defensible?" | Second-pass review | `references/workflow-second-pass-review.md` |
| "Write my LinkedIn profile / About / headline", "draft a cover letter", "prep STAR stories for this interview" | 7. LinkedIn & Adjacent | `references/workflow-linkedin-and-adjacent.md` |
| "Find jobs", "search the boards", "check my sign-in" (every job search run; the Chrome steps apply when it browses Chrome) | 8. Job Search | `references/job-search-browsing.md` |

When the ask is ambiguous, ask one short clarifying question rather than guessing
the workflow — the workflows have different outputs and it's cheap to confirm.
Only load the one reference file for the workflow in play; don't preload the rest.

## Quality Rules (apply everywhere, every workflow)

- **No fabrication** — every claim traces to a master doc or a cited conversation.
- **Honour the do-not-claim list** — if the master docs (`me/history/` in a CareerOS
  workspace) hold a "do not claim" or "cautions" list, nothing on it appears in any
  output, even as a hint (people management, a title, a scope or a skill level).
- **Confidentiality** — describe the user's accomplishments and skills, never the
  employer's IP, codenames, client names, or confidential/unpublished work. Full
  mandate: `references/concepts-master-and-confidentiality.md`.
- **Score before you write** — evaluate fit/quality before tailoring (Workflows 1, 2).
- **Write like a person, not an AI** — short plain sentences, no em-dashes, no
  filler; always run the mandatory critique-and-rewrite pass
  (`references/writing-style-and-verbs.md`) before presenting candidate-facing prose.
- **Learn from corrections** — when the user corrects a fact (business model,
  scope, responsibility), fix it everywhere *and* persist it so the same mistake
  doesn't recur (see the next rule for how).
- **Confirmed facts persist, in the same turn** — when the user confirms a fact
  that isn't in the master docs (answers a question, says a stretch bullet is
  true, gives a metric), record it immediately with
  `careeros fact add "<fact>" --from "<where>"`, which appends to
  `{{CONFIRMED_FACTS}}`. A fact left only in chat or a draft is stripped as made
  up by the next grounding check. You can't edit `me/` or `settings/` yourself; if
  you can't run the command, give the user the exact line to add. In an app run,
  list facts from the user's note in `review.json` instead (the user saves them).
- **Second pass after tailoring** — after writing a tailored resume or cover
  letter, always run `references/workflow-second-pass-review.md` (grounding and
  the interview test) and write its `review.json`.
- **One conversation at a time** (Workflow 4) — don't load entire archives.
- **Update the index** (Workflow 4) — mark conversations processed after each run.
- **Traceability** — every bullet maps to evidence.

## Reference files

- `references/concepts-master-and-confidentiality.md` — master-vs-tailored model
  and the confidentiality mandate. Read first for Workflow 4, and whenever in doubt.
- `references/workflow-resume-review.md` — Workflow 1 steps and output format.
- `references/workflow-job-evaluation.md` — Workflow 2 steps, both rubrics' use,
  recommendation tiers, resume-revision and ranking output.
- `references/workflow-rubric-and-adaptation.md` — Workflow 3 steps.
- `references/workflow-content-extraction.md` — Workflow 4 steps (4a prompt chain,
  4b other evidence sources, 4c interview-by-SAR).
- `references/workflow-pipeline-audit.md` — Workflow 5 steps.
- `references/workflow-export.md` — Workflow 6 steps; full tool-detection ladder,
  commands, and HTML/CSS template in `references/document-export.md`.
- `references/workflow-linkedin-and-adjacent.md` — Workflow 7 steps; format specs
  and character limits in `references/linkedin-and-adjacent.md`.
- `references/workflow-second-pass-review.md` — the required review after
  tailoring: grounding, the interview test, `review.json`, confirmed facts.
- `references/ats-formatting-standards.md` — what keeps a resume machine-parseable.
- `references/resume-quality-rubric.md` — default 0–100 resume quality rubric.
- `references/job-scoring-rubric.md` — default job-fit and interview-odds rubrics.
- `references/extraction-prompt-chain.md` — the 10-prompt extraction chain.
- `references/job-search-browsing.md` — Workflow 8: what to search and keep in a
  find-jobs run, the Do and Don't rules for browsing job boards with
  `./.careeros/bin/jobcairn-chrome`, and the search steps.
- `references/writing-style-and-verbs.md` — SAR framing, anti-AI-slop writing
  standard, mandatory critique-and-rewrite pass, strong verbs, level-matching,
  strict accuracy rules. Read whenever drafting or rewriting candidate-facing prose.
