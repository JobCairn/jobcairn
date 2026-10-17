# Research any topic, as a report and a video

## Goal

People ask job-search questions that aren't about one company or one skill: "Express Entry in Canada for software
engineers", "Skilled visa 482 vs 186", "Salary bands for ML engineers in Sydney". Let them ask Claude to research any
topic on the web, read the answer as a clear, good-looking report in the app, export it, and turn it into a video.

## Behaviour

**Research screen** (sidebar, Prepare group, after Learn). The list shows each topic as a card: its title, the "as of"
date, Quick or Thorough, and a **Needs refresh** pill once the report is more than 30 days old. **New research** opens
a dialog:

- **Topic** (required, up to 80 characters, the same plain characters as a Learn topic).
- **Questions to answer** (optional, up to 1000 characters): goes to Claude as the person's note, fenced and checked
  like every other note (`noteProblems`, `requestSection`, `noteRule`).
- **Depth**: Quick (default, a one-page brief from the best sources) or Thorough (more sources, more depth).
- Example chips fill the topic with an idea.

**Research** starts the run. The topic folder `research/<slug>/` gets `topic.json` (title, questions, depth, created
date) first, written by the app. A second topic with the same slug gets `-2`, `-3`. While Claude works, the card and
the report page show the run chip with Stop.

**Report page.** Built by the app from `report.json` with our own components and brand tokens, so it follows light and
dark themes:

- header: title, "As of" date, depth, Needs refresh when stale, and a one-line note when Claude flagged that the rules
  change often;
- summary card, then key-figure tiles (label, value, short detail, footnote numbers);
- sections (heading, paragraphs, bullets);
- a numbered step timeline (title, detail, typical time);
- comparison tables (columns and rows, with a caption);
- simple bar charts (horizontal CSS bars with values and the unit, scaled to the largest value);
- "What we couldn't confirm" callout;
- sources as a numbered list (title, publisher, the date read, Official badge), and every fact's `[n]` links to it.
  Links open in the system browser through the bridge.
- the footer says it's general information, not legal, migration or financial advice.

Actions: **Refresh** (runs again with the saved questions and depth; replaces report.md and report.json), **Make
video**, **Export HTML**, **Save PDF** (when the app has the printer), and **Delete** in the More menu (to Recently
deleted, with Undo, like other items).

If `report.json` is missing or fails the schema, the page shows `report.md` with the Markdown reader and a short note
("This report is shown as plain text: its data file had problems."). With neither file, it says Claude hasn't written
it yet, with **Research** to start.

## Data

`research/<slug>/`:

- `topic.json` (app): `{ "title", "questions", "depth": "quick"|"thorough", "created_at" }`.
- `report.md` (Claude): the report with sources (URL and date read), the "as of" date, plain facts and a "What we
  couldn't confirm" section.
- `report.json` (Claude), schema 1, validated by `parseResearchReport` (contract/research.ts):
  `title`, `as_of` (YYYY-MM-DD), `summary`, optional `changes_often` and `confidence`, `key_facts[]`
  (`label`, `value`, `detail?`, `sources[]`), `sections[]` (`heading`, `paragraphs[]`, `bullets[]`, `sources[]`),
  `steps[]` (`title`, `detail`, `duration?`, `sources[]`), `tables[]` (`title`, `columns[]`, `rows[][]`, `note?`),
  `charts[]` (`title`, `unit`, `bars[]` of `label` and a finite `value`, `note?`), `uncertain[]`, `sources[]`
  (`id` 1..n, `title`, `url` https only, `publisher?`, `accessed` YYYY-MM-DD, `official`). Every string and list has a
  length cap; a footnote must name a listed source.
- `report.html` (app, Export HTML): one self-contained file: inline styles only, no scripts, a CSP meta tag that allows
  nothing but inline styles, every value escaped, https links only, light and dark through `prefers-color-scheme`.
- `report.pdf` (app, Save PDF): the same HTML through the existing printer.
- `videos/<n>/`: research briefing videos.

Action `research_topic` (target `{ kind: "research", topic, label }`, surface `research`): a web run (no workspace
reads), writes exactly `report.md` and `report.json`. Main puts the topic, today's date and the person's city in front
of the request. Option `depth` (quick/thorough). Bridge: `research.list`, `research.create`, `research.get`,
`research.exportHtml`, `research.exportPdf`. Trash target `{ kind: "research", topic }`. Changes under `research/` refresh
the `learn` area.

Video type `research-briefing` (video-slides, subject `research`, entry point `research`, output
`research/{topic}/videos/{n}/`), source resolver `research.report` (report.md and report.json, untrusted: they came
from web pages): scenes from the summary, key figures, steps and sources.

Career skill: `references/topic-research.md` sets the method: official sources first (government and regulator
sites), cite every fact, date-stamp, say "as of", no legal or financial advice wording, flag rules that change often.

## Defaults chosen

- Stale after 30 days (`RESEARCH_STALE_DAYS`); Refresh keeps the questions and depth.
- Research lives in its own top-level folder, not Learn: it isn't a study guide, and it may be about visas or pay.
- Charts are horizontal bars only (no axes to mislead), at most 12 bars each.
- The HTML export uses the light theme in print and follows the reader's system theme on screen.
- The report never renders Claude-written HTML: Markdown goes through the app's Markdown reader (no raw HTML), JSON
  through React text.

## Edge cases

- Topic text with characters outside the plain set is cleaned (`topicLabel`); an empty result is refused.
- A topic folder that's a link or not a plain folder is refused (the usual folder checks).
- A report.json larger than 512 KB, or with a footnote to a missing source, falls back to report.md.
- Delete is blocked while Claude or a video is working on the topic.

## Out of scope

Sharing reports, scheduled refreshes, charts other than bars, editing a report in the app.
