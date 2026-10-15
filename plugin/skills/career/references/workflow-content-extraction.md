# Content Extraction & Evidence Gathering (Workflow 4)

**Purpose:** Enrich the master docs and master bullet list with real, evidenced
accomplishments — from conversation archives *and* from other sources of proof of
work. Apply the confidentiality mandate in
`references/concepts-master-and-confidentiality.md` to everything you extract.

## 4a. From conversation archives (the prompt chain)

The governing constraint: **one run = one (or a few) conversation files in
context.** Never load the whole archive at once — it blows context and produces
shallow, generic extractions. See `references/extraction-prompt-chain.md` for the
full chain and rules.

1. **Check what's done.** Read `{{INDEX_ROOT}}/processed_conversations.md` — which
   prompts have run against which `conversation_id`s.
2. **Find the gaps** relevant to the user's goal (employers, timeline, skills,
   achievements, portfolio, AI work, roles, story, descriptions, cross-check).
3. **Run the chain** on the selected file(s): prompts 1–9 extract into master
   docs; prompt 10 cross-checks and appends to `{{INDEX_ROOT}}/gaps-and-conflicts.md`.
4. **Record it.** Update the processed list for the prompt(s) used. Only write
   under `{{DOCS_ROOT}}` and the index files. Cite `conversation_id` and angle for
   every addition.

## 4b. From other evidence sources

When the user points at real proof of work, mine it for accomplishments rather
than relying on memory. Ask which sources are available, then for each:

| Source | What to pull |
|--------|--------------|
| Git repositories | Commits by author + date range, tech stack from configs, architecture patterns, project scope/contribution volume |
| Documents / files | Reports, proposals, decks the user authored — outcomes and themes |
| Webpages / published work | Articles, portfolio, press, patents, OSS — reach and recognition |
| Calendar | Recurring meetings led, project kickoffs/completions, cross-functional work |
| Project tools (Jira/Asana) | Completed initiatives, team contributions |
| LinkedIn | Role history, recommendations, endorsements |
| Performance reviews | Documented achievements, feedback, promotions |

Present findings grouped by theme or time period: source + date range, accomplishments
found, suggested bullet points, and questions to confirm with the user.

## 4c. Adding a new role/project by interview

When there's no artifact to scan, interview the user in **SAR** form —
Situation, Action, Result — and write it up with the bullet quality bar:
1. What was the situation or challenge?
2. What actions did *you* take (vs. the team)?
3. What was the result/impact — can you quantify it?
4. What skills did it demonstrate?
Then draft bullets (Action + Scope + Method + Outcome), confirm scope ownership,
and add to the master. See `references/writing-style-and-verbs.md` for phrasing.

**Deliver:** a short summary of what was processed/added, from which sources, and
any conflicts or follow-ups.
