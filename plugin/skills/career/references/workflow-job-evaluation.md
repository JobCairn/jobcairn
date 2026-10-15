# Job Evaluation — Score, Recommendation, Resume Revisions (Workflow 2)

**Purpose:** Score a job (browser-found or user-supplied) for fit and interview
likelihood, give a clear apply/not-apply call, and — for strong fits only —
produce specific, copy-pasteable resume revisions.

1. **Load** the job description (and any company context) plus the master docs
   needed to map evidence.
   - If the user gives a **job URL**, fetch it with the Claude-in-Chrome tools
     (open a new tab, read the page). If the page can't be parsed, ask them to
     paste the description. Save the parsed posting to
     `{{JOBS_DIR}}/[id]/posting.md`, extracting title/level,
     company, responsibilities, must-haves, nice-to-haves, keywords, and team
     context.
   - Use the universal rubric at
     `{{DOCS_ROOT}}/10-universal-job-rubric-and-apply-recommendation.md` if
     present, otherwise `references/job-scoring-rubric.md`.
2. **Score** with both:
   - **Rubric A — Ideal Job Match (0–100):** how well the role fits what the user
     wants and can evidence.
   - **Rubric B — Interview Odds (0–100):** realistic likelihood of getting an
     interview given documented experience.
   Use only documented evidence from master docs. Don't inflate to be
   encouraging — an honest low score saves the user a wasted application.
3. **Recommend** exactly one tier (map scores + any deal-breakers):
   `Definite No Go` · `Nah` · `Meh` · `Good Fit` · `Freaking Apply Now`
4. **Why:** 2–4 sentences citing *both* scores and 1–2 concrete factors that
   drove the tier (including any deal-breaker).
5. **Resume revisions — only if `Good Fit` or `Freaking Apply Now`:**
   - Summary edits
   - Core competencies adjustments
   - Experience bullets, grouped by role
   - Keywords to integrate (from the JD; avoid stuffing — see standards)
   - Cover letter / application notes

   Every item must be specific, actionable, and traceable to master docs.
   **Match the emphasis to the role's level** (executive / director / IC) — see
   the level-matching guidance in `references/writing-style-and-verbs.md`.
6. **Full tailored resume (on request, strong fits):** generate a complete 1–2
   page tailored resume — reorder to lead with the most relevant experience,
   mirror the posting's language where authentic, integrate keywords without
   stuffing, keep all roles and true dates. Then run the **mandatory
   critique-and-rewrite pass** and apply the writing standard (Flesch > 90, no
   em-dashes, one idea per sentence) from `references/writing-style-and-verbs.md`
   *before* showing it. Save to `{{JOBS_DIR}}/[id]/resume.md`.

**Deliver in this order:** Scores → Recommendation tier → Why → [if strong fit]
Resume revisions (and full tailored resume if requested).

For **ranking multiple jobs**, score each the same way and append/update
`{{DOCS_ROOT}}/11-ranked-jobs-with-apply-recommendations.md`, sorted by tier then
Interview Odds.

## In a JobCairn run (Score this job)

The person reads the result in the JobCairn app, not in this conversation. Write for them:

- **Plain words only.** Never show file paths, folder names or internal labels. Name evidence as
  "your resume", "your profile", "your career history" or "the job ad". Don't write "Workflow 2",
  "Rubric A", "Match A" or "(B)": call the scores **Fit** and **Interview odds**.
- **No tables.** Use short headings and bullet lists, so the write-up reads well at any width.
- **Must-haves:** one bullet each, marked met, partly met or not met, with one line of evidence.
- **What would change this:** a short list of things that would move the score (a project, a
  certificate, a clearer bullet on the resume). Only suggest what is true or doable.
- **Finish with the `score_record` tool, once.** Give the same result as the write-up: `fit` and
  `interview_odds` (whole numbers 0 to 100), `tier` (exactly one of the tiers above),
  `recommendation`, `must_haves` (each with `text`, `status` met / partial / not_met, and plain
  `evidence`), `nice_to_haves`, `changes` and a short `summary`. It saves the score on the job and
  marks it scored. If it refuses the input, fix what it names and call it again.
