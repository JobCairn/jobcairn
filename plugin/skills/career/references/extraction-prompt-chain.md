# Extraction Prompt Chain (Workflow 4a)

The chain turns raw conversation archives into structured, evidenced master docs.
The prompt templates live under `{{PROMPTS_ROOT}}/`; this file describes what each
does and the protocol that keeps the process trustworthy.

## The one hard rule

**One run = one (or a few) conversation files in context.** Loading the whole
archive at once wrecks context quality and produces shallow, generic bullets.
Process incrementally and record progress so you can resume.

## The prompts

| # | Prompt | Extracts into master docs |
|---|--------|---------------------------|
| 01 | employers | Companies, roles held, dates |
| 02 | timeline | Chronological role/project timeline |
| 03 | skills | Technical + domain skills demonstrated |
| 04 | achievements | Quantified accomplishments and outcomes |
| 05 | portfolio | Shippable/public work, links, artifacts |
| 06 | AI work | AI/ML-specific contributions |
| 07 | roles | Role descriptions and responsibilities |
| 08 | story | Narrative arc / positioning material |
| 09 | descriptions | Bullet-ready content for the master bullet list |
| 10 | cross-check | Reconciles the above; finds gaps/conflicts |

Prompts 01–09 write into `{{DOCS_ROOT}}`. Prompt 10 appends discrepancies to
`{{INDEX_ROOT}}/gaps-and-conflicts.md`.

## Protocol per run

1. Read `{{INDEX_ROOT}}/processed_conversations.md` to see which
   `(prompt, conversation_id)` pairs are already done.
2. Pick the ungprocessed file(s) and prompt(s) relevant to the user's goal.
3. Run the prompt(s) with only those file(s) in context.
4. Write additions **only** under `{{DOCS_ROOT}}` (and the index files). For each
   addition, cite the `conversation_id` and the angle it came from.
5. Update `processed_conversations.md`: mark those `(prompt, conversation_id)`
   pairs done.
6. If you ran prompt 10, append any gaps/conflicts to
   `gaps-and-conflicts.md`.

## Confidentiality (applies to every extraction)

Extract *what the user did and the skills they showed* — not employer IP. Never
copy proprietary code/strategy verbatim; never surface internal codenames, client
names, credentials, internal URLs, or unpublished work. Abstract when in doubt:
"Led go-to-market for an enterprise launch," not the real project/client names.

## No fabrication

If the archive doesn't support a claim, it doesn't go in the docs. Missing
evidence is logged as a gap, never invented to fill a section.
