# Research any topic Implementation Plan

**Goal:** A Research screen where Claude researches any topic on the web and the app shows the result as a styled,
dynamic report (from report.json), exports it as self-contained HTML or PDF, and makes a video of it.

**Architecture:** Contract: `research_topic` action with a new `research` target kind, `research.ts` (report schema
validator, topic view, staleness) and `research-html.ts` (escaped, script-free export). Services: `research.ts`
(list, create, get, export) behind a `research` bridge namespace, a trash kind, the watcher, web context. UI:
`screens/Research.tsx` and `research/` components render the report with brand tokens. Video: subject kind
`research`, resolver `research.report`, type `research-briefing`.

**Tech Stack:** TypeScript, React, Vitest.

**Spec:** `docs/specs/2026-10-17-research-any-topic.md`

## Global Constraints

- Never render Claude-written HTML or scripts. Report data is validated, then rendered as React text.
- report.json falls back to report.md (Markdown reader) when missing or invalid.
- Export HTML: no scripts, CSP meta, every value escaped, https links only.
- Example data only (Alex Example); button labels one or two words; brand tokens only in app-ui.

## Tasks

### Task 1: contract
Files: `packages/contract/src/{actions,request,research,research-html,bridge,methods,trash,index}.ts`,
`packages/contract/test/research.test.ts`.
- [x] Failing tests: schema accepts the example, rejects bad URLs, unknown footnotes, huge strings, non-finite numbers;
      staleness; HTML export escapes and has no script; action prompt (web, outputs, depth, note).
- [x] Implement; tests pass.

### Task 2: services
Files: `packages/services/src/{research,trash,watcher,handlers,claude/context}.ts`, `packages/services/test/research.test.ts`.
- [x] Failing tests: create makes the folder and topic.json (deduped slug); list and get; invalid JSON falls back;
      export writes report.html; trash moves the topic.
- [x] Implement; tests pass.

### Task 3: UI and mock
Files: `packages/app-ui/src/{router,Shell,screens/*,research/*,mock/*,nav/trail}.ts(x)`, `packages/app-ui/test/research.test.tsx`.
- [x] Failing tests: list, report renders tiles, steps, table, bars and sources; fallback to Markdown; no raw HTML.
- [x] Implement; tests pass.

### Task 4: career skill
Files: `plugin/skills/career/SKILL.md`, `plugin/skills/career/references/topic-research.md`.
- [x] Add the method reference and link it from the skill.

### Task 5: video
Files: core schemas and videos.ts, `packages/video/src/{types,registry,sources}.ts`, `plugin/video-types/research-briefing.json`,
contract video.ts, MakeVideo, video-mock, services video.ts.
- [x] Subject kind `research`, resolver `research.report`, folder pattern; tests for the folder and the source pack.

### Task 6: check
- [x] Typecheck, targeted tests, headless screenshots of the report in light and dark.
