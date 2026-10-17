# Resume checks: ATS check of the export, second-pass review, confirmed facts

Ideas 1, 4 and 5 from the ai-job-search review (MIT, ideas only, rewritten in our style).

## Goal

1. Check the files an applicant tracking system actually reads (the exported PDF and Word resume), not the Markdown.
2. Make Claude review its own tailored resume and cover letter before it finishes, and show what it changed and why.
3. Stop real facts the person confirms from being stripped later as "made up": confirmed facts go into the master
   history straight away.

## 1. ATS check of the exported resume

**Where:** `docs.check(slug, id)` (read only, on demand; export itself is unchanged). It reads
`application/export/resume.pdf` (or `resume.docx` when there is no PDF) with the export folder's checks (plain,
single-named file, size cap), pulls the text out in the same worker, deadline and heap cap as Fill from my resume
(`resume-fill-worker.mjs`, which now also returns the PDF's page count), and runs the pure checker
`atsCheck()` in `contract/src/ats-check.ts`.

**Checks** (each is pass or warn, with one plain line):

| Check | Pass when | Warn when |
|---|---|---|
| Text reads cleanly | No replacement characters, `(cid:` markers, private-use or control characters, ligature glyphs (ﬁ, ﬂ), or letter-spaced words | Any of those, named |
| Sensible length | 150 to 1,500 words, and at least 100 words a page | Too little (maybe images or a scan) or too much |
| Email as text | The profile's email (any case) is in the text; with no profile email, any email address is | Missing |
| Phone as text | The profile's phone (last 9 digits, so +61 and 0 both match) is in the text; with no profile phone, any phone number is | Missing |
| Date ranges | Every year joined to a dash uses an ASCII hyphen | A year joined to an en dash, em dash or other Unicode dash (some ATS imports drop those dates). A dash at the start of a line is a bullet, not a range |
| Page count | PDF of 1 or 2 pages | More than 2. Word files have no fixed pages, so this row is left out for them |
| Section headings | Experience, Education and Skills headings each appear on their own line (same matching as the Resume Studio's `sectionType`) | One is missing, named |

When the file can't be read the result is one warn row ("Couldn't read the exported file"). The check reports the
file it read and the time, and whether `resume.md` changed after the export.

**UI:** one `AtsChecklist` component, a compact pass/warn list, shown in the Export card (Apply screen) under the
exported files, and in the Resume Studio's side panel for a job's resume. Before anything is exported it says
"Export your resume to see how an applicant tracking system reads it."

**Skill:** `ats-formatting-standards.md` uses `Jan 2022 - Present` (ASCII hyphen) and says to use ASCII hyphens in
date ranges. The tailor and rewrite prompts say so too.

## 2. Second-pass review (self-review inside tailor_application)

App runs are one headless `claude -p` with no subagent tool, so the second pass is a mandatory self-review step
inside `tailor_application`, not a separate agent or action. After writing the resume, the letter and
`claims.json`, Claude re-reads them as a strict reviewer, applies its own exact edits, and writes
`application/review.json` (an extra, so applications tailored before this still count as done):

```json
{
  "edits": [{ "file": "resume.md", "old": "exact old text", "new": "exact new text", "reason": "grounding", "why": "one line" }],
  "stretch": [{ "file": "resume.md", "text": "the exact bullet", "why": "why it is a stretch", "soften": "a safer wording, or \"\" to drop" }],
  "facts": [{ "fact": "a new fact you stated in your note", "source": "your note" }],
  "notes": "two or three plain sentences"
}
```

- `reason` is one of `keyword`, `company`, `reframing`, `style`, `grounding`. Grounding: every claim must trace to
  `me/history`, `me/resumes` or `settings/profile.json`; anything that doesn't is removed or softened.
- The interview test: for each bullet, "could you defend this in an interview without backtracking?" Bullets that
  pass only with a stretch are listed in `stretch`, never silently kept.
- The method lives in a new reference, `references/workflow-second-pass-review.md`, routed from SKILL.md.

**UI:** a **Review** card next to Claims on the Apply screen's Review step: the edits Claude made (old, new, reason),
its notes, and each stretch bullet with three buttons:

- **It's true**: you confirm the claim. It is saved as a confirmed fact (section 3) and the item is marked kept.
- **Soften**: the bullet is replaced with Claude's safer wording in the resume or letter (a new version in the Resume
  Studio's history, so it can be undone).
- **Drop**: the bullet's line is removed the same way.

`review.json` is read leniently (`parseReview`): bad items are skipped, an unreadable file reads as no review.

## 3. Confirmed facts persist

Claude can never write to `me/` or `settings/` (`NEVER_WRITE`), and app runs are headless, so Claude can't write a
confirmed fact into the master itself. And the job ad is untrusted text: if Claude could add facts to the master on
its own, an ad could plant fake achievements there. So only the person adds facts, by a click or by the CLI:

- **Store:** `me/history/confirmed-facts.md`, one bullet per fact with the date and where it was confirmed
  (`addConfirmedFact` in `core`). It sits in `me/history`, which every claim check already reads as evidence. Exact
  repeats aren't added twice.
- **In the app:** **It's true** on a stretch bullet, and **Save** on each fact in `review.json`'s `facts` (facts the
  person stated in their note), write there at once. Nothing Claude writes is imported without that click.
- **In a Claude Code chat:** the skill tells Claude to run `careeros fact add "<fact>" --from "<where>"` in the same
  turn the person confirms a fact (the CLI writes from its own process). If it can't run commands, it tells the person
  the exact line to add and lists the fact in `review.json` `facts` when it is writing one.
- **Skill rules:** SKILL.md's "Learn from corrections" points at this file instead of `settings/profile.json` (which
  Claude can't write), and the tailor prompt says facts from the note go into `facts`.
- **Facts the person states in the request count as evidence.** The shared no-fabrication rule now reads "...trace to
  a file in me/history or me/resumes, or to a fact I state myself in this request", and the review's grounding step
  says the same, so the second pass doesn't strip a fact from the note, or an ad term ticked as true in the keyword
  check. Those are listed in `facts` (source "your note" or "ticked in the keyword check") for the person to save.
- Stretch text and soft wording are read without a leading bullet marker, so Soften keeps the draft's marker, and a
  saved fact is plain text (no list marker, bold or italic marks: `plainFact`).

## Out of scope

- Keyword coverage on the extracted text (keyword-gap still reads the Markdown).
- Checking the cover letter's export.
- Layout checks (orphans, footer collisions).
- A fresh-context reviewer agent (would need the Agent tool in runs).
