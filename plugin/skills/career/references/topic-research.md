# Workflow 9: Topic research

Research any topic for a job search (a visa or skilled migration program, pay for a role in a city, a job
market, how a hiring process works) and write two files: `report.md` for people and `report.json` for the app,
which draws the report itself. The request names the topic, today's date and the folder.

## Method

1. **Frame the question.** Restate the topic in one line, and the person's questions if the request has any.
   Note the country or city it is about. If the topic is ambiguous ("482"), say which meaning you researched.
2. **Official sources first.** Start with the body that owns the rule or the number:
   - migration and visas: the government immigration department's own pages (for example canada.ca for Express
     Entry, immi.homeaffairs.gov.au for Australian visas, gov.uk for UK visas), and official occupation lists;
   - pay and job markets: national statistics offices, labour market information sites, award or agreement
     pages, then well-known salary surveys (name the survey and its year);
   - professional recognition: the assessing body's own site.
   Use news, forums, agents' blogs and AI summaries only to find official pages, never as the source of a fact.
3. **Open and check each page.** Read the page itself; confirm it says what you cite. Note the date you read it
   and, when the page shows one, when it was last updated.
4. **Cite every fact.** Every key figure, step, table row and chart value carries the id of a source that states
   it. No source, no fact: move it to "What we couldn't confirm".
5. **Date-stamp.** The report is "as of" today's date. Give numbers with their period ("in the 2025-26 program
   year", "rounds in September 2026").
6. **Flag what changes often.** Say plainly when rules, cut-offs, caps, processing times or pay data change often,
   and where to check the current figure (`changes_often` in report.json).
7. **Mark uncertainty.** Conflicting sources, old pages, figures you could only find second-hand: list them under
   "What we couldn't confirm" and set `confidence` honestly (high, medium or low).

## Wording rules

- General information only. Never tell the person what they should do about their own visa, legal, tax or money
  situation ("you should apply for", "you qualify", "you will get"). Write what the rules say and who they apply
  to, and say where a registered migration agent, lawyer or financial adviser can help.
- Plain Australian English, short sentences, no filler. Explain each acronym once.
- Never guess a number. Never round a figure so it reads as more certain than the source.
- No personal details about the person: the request gives only a city and target roles, for relevance.
- Leave out fees and costs unless the person's questions ask for them; when they do, cite the official fee page
  and its date.

## report.json

Write the same facts as `report.md`, as one JSON object in the shape the request gives. The app checks it and
falls back to `report.md` when it fails, so:

- plain text only in every field: no Markdown, HTML, links or emoji;
- `sources` are numbered from 1, each with its https `url`, `title`, `publisher`, the `accessed` date and
  `official: true` for government or regulator pages;
- footnotes (`sources` lists on facts, sections, steps, tables and charts) use only ids from that list;
- `key_facts`: 3 to 6 tiles with a short `value` ("Up to 1,200 points", "12 months");
- `steps`: only for a real process, in order, with a typical `duration` when a source gives one;
- `tables`: comparisons ("482 vs 186"), every row as wide as `columns`;
- `charts`: only for three or more comparable numbers from one kind of source, all in one `unit`; never mix units
  or periods in one chart;
- keep every list short: the app shows at most 12 key facts, 15 steps, 6 tables and 4 charts.
