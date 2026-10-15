# Find recruiters: every source, a target count, and where each agency was found

Owner, 2026-10-16: a real Find recruiters run saved only 5 agencies. "Search properly with every kind of search: web
search and fetch and my own Chrome, and find many more." Then: "put all sources as well where we find it, same like jobs."

## Goal

Find recruiters keeps searching several kinds of source until it reaches a number of agencies the person picks, and
every saved agency records each place it was found.

## Behaviour

- **Target count.** The composer has "Agencies to find" (1 to 100, default 25), like Find jobs' "Jobs to find". The
  run's limits scale with it (`recruiterBudget`): Claude's time, the recruiter_add cap (re-saves merge, so about three
  calls per agency) and, when Chrome is used, pages, steps and browsing time.
- **Sources, in order.** (a) WebSearch per target role and city ("<role> recruitment agency <city>", specialty and
  "IT recruitment" queries, government contract recruiters in the state); (b) agencies advertising the person's roles
  on SEEK, Indeed and LinkedIn job search, through the person's Chrome when Search in my Chrome is on and connected,
  else through WebSearch; (c) industry directories and panels (the RCSA member directory, state government ICT and
  labour-hire supplier panels) through WebSearch and WebFetch; (d) agencies already known (saved agencies and
  advertisers in saved job ads, from the context), deduped. Each agency is checked on its own site before it is saved.
  Claude keeps going until it reaches the target or runs out of sources, and the report counts agencies per source.
- **Chrome with web tools.** A Find jobs browser run has no WebSearch or WebFetch, because a signed-in board page (the
  person's name, recommended jobs) could be copied out to any address by an injected instruction. A Find recruiters
  run that uses Chrome keeps that risk closed in a different way: `jobcairn-chrome` runs in *recruiters mode*
  (`purpose: "recruiters"` in `.careeros/chrome-run.json`, written by the app) and never hands Claude a page's raw
  text. It answers only what the app extracts itself: on a results page, the job ads' addresses and link titles; on
  an ad, the advertiser, title and place (JSON-LD, the page title or the ad's header) and the contact links in the ad,
  plus whether the ad's wording reads like an agency's. Snapshot, click, fill, get text, back and the sign-in check are
  refused in that mode. WebFetch is also denied on the job boards' own domains (and LinkedIn always), so the boards are
  read only through Chrome. The run writes only its report file (no `Edit(./**)`), and Bash stays the browser command.
- **Fallback.** When Chrome isn't set up, on, connected or free (another search is browsing), the run uses web tools
  only, as before. Find jobs is unchanged (a scheduled Find jobs still never falls back). A recruiters plan never
  changes what the Find jobs composer says about its last search, and never uses its board chips.
- **Clean-up.** The recruiters browser plan is the same `BrowserPlan` as Find jobs': its tabs close and the helper
  stops when the run ends, and the idle check applies.
- **Sources on the record.** `recruiters/<slug>/agency.json` gets `sources`: a list of `{ name, url, found_at }`.
  `name` is the board's name as jobs show it (`LinkedIn`, `SEEK`, `Indeed`, from `JOB_BOARDS`) when the address is on
  a board, else the name Claude gives (`Web search`, `RCSA directory`, `Agency website`, `Saved job`); `url` is the
  https page; `found_at` is an ISO timestamp like a job's `found_at`. Saving an agency again merges sources by
  address. An agency captured from a saved job ad gets that job's board, address and found time.
- **Context.** Up to 150 saved agency names, plus advertisers of saved job ads that aren't saved agencies yet.

## Out of scope

- Two separate Claude runs (browse, then verify). Recruiters mode keeps one run without raw page text instead.
- LinkedIn people pages, guessed addresses, anything sent.
