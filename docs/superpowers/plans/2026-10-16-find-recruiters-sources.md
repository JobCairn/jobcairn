# Find recruiters: sources, target count and Chrome Implementation Plan

**Goal:** Find recruiters searches web, directories and job boards (in Chrome when available) until it reaches a
target number of agencies, and each agency records where it was found.

**Architecture:** Contract: `MAX_AGENCIES`, `recruiterBudget`, the `max_agencies` option, new steps, `sources` in
`cleanAgencyInput`. Core: `sources` in the agency schema and `mergeAgency`. Services: recruiter_add takes sources and
an `--agencies` cap; the engine plans Chrome in recruiters mode and falls back to web-only; `toolArgs` gives such a run
Bash (browser command) plus WebSearch and WebFetch with board domains denied; `jobcairn-chrome` recruiters mode
answers only extracted facts.

**Tech Stack:** TypeScript, Vitest.

**Spec:** `docs/specs/2026-10-16-find-recruiters-sources.md`

## Global Constraints

- Find jobs and chrome_check behave exactly as before (args, prompts, fallback rules, Chrome caps).
- No run ever gets raw signed-in page text together with WebFetch.
- Fictional data only; emails in tests built by concatenation.
- Every record write goes through the store (core `mergeAgency`).

## Tasks

### Task 1: sources on agencies
Files: `packages/core/schemas/agency.schema.json`, `packages/core/src/types.ts`, `packages/core/src/recruiters.ts`,
`packages/contract/src/recruiters.ts`, `packages/services/src/claude/mcp/tools.ts`,
`packages/services/src/recruiters-capture.ts`, tests.
- [x] Failing tests: cleanAgencyInput keeps https sources and names boards like jobs; mergeAgency merges by url;
      recruiter_add saves sources; ad capture records the job's board.
- [x] Implement; tests pass.

### Task 2: target count and budget
Files: `packages/contract/src/find-plan.ts`, `packages/contract/src/request.ts`, `packages/contract/src/actions.ts`,
`packages/services/src/claude/{args,engine}.ts`, `packages/services/src/claude/mcp/{argv,server,tools}.ts`,
`packages/app-ui/src/composer/labels.ts`.
- [x] Failing tests: `max_agencies` validation and line; `recruiterBudget` scaling; `--agencies` cap.
- [x] Implement; tests pass.

### Task 3: Chrome in recruiters mode
Files: `packages/services/src/chrome/{service,cli,session}.ts`, `packages/services/src/claude/args.ts`, engine.
- [x] Failing tests: toolArgs hybrid plan (Bash + web, board domains denied, exact files) while find_jobs keeps its
      deny list; CLI recruiters mode refuses raw commands and returns only extracted facts; planForRun leaves Find
      jobs' state alone.
- [x] Implement; tests pass.

### Task 4: prompt and context
- [x] New steps (multi-source, per-source counts, sources on every recruiter_add); context adds advertisers from saved
      jobs and more known agencies.
- [x] `npm run typecheck`; contract and services tests pass; commit.
