# Job Scoring Rubric & Apply Recommendation

Default rubrics for Workflow 2. **If the project has
`{{DOCS_ROOT}}/10-universal-job-rubric-and-apply-recommendation.md`, use that
instead.** Score using only documented evidence from the master docs — an honest
score is more useful than an encouraging one.

## Rubric A — Ideal Job Match (0–100)

How well the role fits what the user wants and can evidence.

| Dimension | Weight | Full marks |
|-----------|-------:|------------|
| Role/function fit | 25 | Core responsibilities match the user's target direction and strengths. |
| Domain/industry fit | 15 | Domain matches interest and background. |
| Seniority & scope | 15 | Level and ownership match where the user is / wants to be. |
| Compensation & logistics | 15 | Pay band, location/remote, work authorization all viable. |
| Growth & trajectory | 15 | Advances the user's stated goals; good learning/upside. |
| Culture & values signals | 15 | Team, mission, and ways of working align. |

## Rubric B — Interview Odds (0–100)

Realistic likelihood of landing an interview given documented experience.

| Dimension | Weight | Full marks |
|-----------|-------:|------------|
| Required-skill coverage | 35 | Evidence for (nearly) all must-haves. |
| Years/level match | 20 | Meets stated experience requirement. |
| Keyword/title alignment | 15 | Resume can honestly carry the title + key terms. |
| Domain relevance | 15 | Directly relevant background. |
| Differentiators | 15 | Standout evidence that beats the median applicant. |

## Deal-breakers (override the score)

If any hard requirement can't be met — work authorization, mandatory
certification/clearance, non-negotiable location, an absolute years floor — the
recommendation caps at **Nah** or **Definite No Go** regardless of the numbers.
Name the deal-breaker explicitly.

### Languages

Read the ad's language needs for the role itself, not the language the ad is
written in. Only explicit wording counts: "fluent in German", "Japanese
required", "Mandarin speaking", "bilingual English and Korean". A language the
ad calls desirable, preferred or a plus doesn't. Compare each need with the
Languages list in the profile (`settings/profile.json`, `languages`: Basic,
Conversational, Professional, Native or fluent):

| The ad | The profile | Result |
|---|---|---|
| Requires a language that isn't listed | Has at least one language | **Deal-breaker.** Cap at Nah or Definite No Go and quote the ad's words. |
| Asks a higher level than listed ("fluent" against Conversational) | | **Flag, then score.** Say so, quoting both the ad and the listed level. Not a deal-breaker. |
| Same or lower level, or no level stated | | Fine. Nothing to say. |
| Any need | Lists no languages | Don't assume any language, English included. Quote the need and say to add languages to the profile. |

When unsure whether a stated bar is above the listed level, flag it rather
than pass it. The JobCairn app applies the same rule to mark ads in Jobs.

## Recommendation tiers

Map both scores (and deal-breakers) to exactly one tier:

| Tier | Rough guide |
|------|-------------|
| **Definite No Go** | Deal-breaker present, or both scores low. |
| **Nah** | Match or odds clearly weak; not worth the effort. |
| **Meh** | Middling on both; apply only if it's a stretch goal or slow week. |
| **Good Fit** | Match strong and odds solid (both ~70+). Worth a tailored application. |
| **Freaking Apply Now** | Match strong *and* odds high (both ~85+), no deal-breakers. Prioritize. |

Use judgment at the boundaries — the bands guide, they don't dictate.

## Output order

Scores (A and B) → Recommendation tier → **Why** (2–4 sentences citing both
scores + 1–2 concrete drivers) → *if Good Fit or Freaking Apply Now* → resume
revision recommendations (summary edits, competencies, bullets by role, keywords,
cover-letter notes — each specific and traceable to master docs).
