# Closing dates and board health

Ideas 2 and 9 from the ai-job-search comparison (MIT licensed upstream: ideas only, written fresh here).

## Goal

1. When an ad says when applications close, keep that date on the job and use it: show how long is left, and treat
   a job past its closing date as closed. Never guess a closing date.
2. After each Find jobs run, notice when a board quietly stops working (it returns nothing where it used to find
   jobs, or what it returns looks like junk) and say so in plain words.

## 1. Closing date

### Data

- The job record gains an optional `closes_on` (local date, `YYYY-MM-DD`). No default: records without it stay valid,
  so no migration or schema version bump is needed (the same pattern as `posted_approx`). The job form shows it as
  "Applications close".
- `JobRow` carries `closes_on` too (optional, older bridges leave it out).

### Reading the date (contract `closing-date.ts`, pure)

- The JD reader (`parseJd`, `promoteHeadings`, `splitUrls`, `splitQuote`, `splitDate`) moves from
  `app-ui/src/reading/jd.ts` to contract `jd-text.ts`; the app-ui file re-exports it.
- `closingDateFromAd(text, found)` looks for, in order: a "Closes" / "Closing date" fact line in the saved JD header,
  then the ad's own words ("Applications close 31 October 2026", "Closing date: 31/10/2026", "Apply by Friday 7 Nov",
  "Applications due by 2026-11-07", "Deadline: 7 Nov 2026").
- `parseClosingDate(value, found)` reads ISO dates, `d/m/yyyy` (Australian order; `m/d` only when the day can't be a
  month), `31 October 2026`, `31st Oct`, `October 31, 2026`. A date without a year takes the year it was found in,
  or the next year when that would put it more than 60 days before the day it was found. Anything else: null.
- `newJob` (core) stores `closes_on` from the caller's value when given, else from the ad text. Unreadable: left out.
  A duplicate found again fills `closes_on` when the saved job has none.
- Claude passes `closes` to `job_new` (and `careeros job new --closes`) exactly as the ad shows it, and leaves it out
  when the ad shows none. The find-jobs prompt and the career skill's browsing reference say so.

### Showing it (contract `closing-date.ts` `closingState`)

- Only for open jobs (Found, Saved, Applying). Days are counted in local dates.
- "Closes today", "Closes tomorrow", "Closes in N days" (N up to 60; further out shows "Closes 12 Dec"). Seven days
  or fewer: the warm accent tone, otherwise neutral. The day after the closing date: "Closed".
- Shown in the Jobs list (under the company, beside the other badges) and the job page header. The tooltip names the
  date.
- A closed job gets a `closed` ghost flag. It is never deleted or moved.

### Hide likely stale (behaviour change)

- The toggle now hides open jobs that are **closed** or **reposted**.
- "Posted over 30 days ago" (the "Possibly stale" pill) is still shown but **no longer hides** the job. Before this
  change it did. An ad 45 days old with a closing date next week is clearly still open. The switch is
  `hiddenAsStale` in `contract/src/ghost.ts`, if this needs reversing.

## 2. Board health

### Data

- Per board, this run: the search-log entries (`knowledge/job-searches.jsonl` via `search_add`) logged between the
  run's start and end, and the jobs saved in that time from that board (`source_site`).
- Per board, the past: the same search-log entries windowed by earlier Find jobs run records (`.careeros/runs`), and
  each finished run's own `board_counts` (stored from now on). Only runs where the board logged a numeric result
  count. `results: ""` (Claude didn't say) is no data, never zero.

### Checks (contract `board-health.ts`, pure)

- **Returned nothing:** every logged search on the board this run returned a numeric 0, and at least two past runs
  found some (median of the last five past runs at 3 or more). Message: "SEEK returned nothing this time, it usually
  finds about 20. Its pages may have changed." Suggestion: "Open SEEK in Chrome and search there yourself. If it
  shows jobs, run Find jobs again; if it still finds nothing, untick SEEK in Settings › Search for now."
- **Looks wrong:** at least 3 jobs saved from the board this run and half or more have junk titles (HTML tags, HTML
  entities such as `&amp;`, longer than 150 characters, or no letters) or a blank or placeholder company ("Unknown",
  "N/A", "Confidential" is fine). Message: "Most of what SEEK returned this time looked wrong (6 of 8 titles had
  web-page code in them). Its pages may have changed." Suggestion: check those jobs before relying on them.
- A board stopped by the Chrome helper (security check, lost tab, wrong profile, or any outcome other than ok) gets
  no health warning: the run already says why, and a block is never evidence the board is broken. Notes that mention
  a CAPTCHA, security check, rate limit (429) or sign-in also count as blocked.
- Healthy boards: nothing shown.

### Showing it

- The run record gains optional `board_health` (warnings) and `board_counts` (per-board results this run). Computed
  when a successful Find jobs run ends, after the Chrome helper's per-board report is in.
- The run card shows each warning as a caution line with its suggestion, under the summary.

## Out of scope

- A Home "Closing soon" card, Next-up entries and auto-filing closed ads under Skipped.
- Sorting closing-soon jobs first.
- A sentinel probe that re-runs a search to confirm a broken board.
- Turning a board off automatically.
