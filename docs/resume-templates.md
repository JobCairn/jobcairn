# Resume templates

How the resume templates in Resume Studio are built, what we learned from other products, and why they
look the way they do. Research done 2026-10-11 from public pages only (no sign-ups, no logins). We took
structure and lessons only. No competitor's design, names, copy or assets were copied.

## What ships

17 templates. Single column is the default. Two templates have a right-hand column and are marked
"ATS caution" in the gallery.

| Template | Group | Columns | What makes it different |
|----------|-------|---------|--------------------------|
| Classic | Professional | 1 | Centred name, capitals with a thin rule |
| Plain | Professional | 1 | Black and white, plain bold headings, larger text. For government jobs and older systems |
| Skills first | Professional | 1 | Summary, then skills (labels in their own column), then experience. For a career change |
| Modern | Modern | 1 | Name in the accent colour, plain headings |
| Minimal | Modern | 1 | Quiet capitals, dates after the title, dashes |
| Headline | Modern | 1 | Heavy accent bar over a large name, headline in the accent |
| Banner | Modern | 1 | Name and contact details on a solid accent band, white text |
| Open | Modern | 1 | Light large name, muted small headings, extra white space |
| Split | Modern | 2 | A ruled right-hand column for skills, certifications and languages |
| Swiss | Creative | 1 | Black and white grid: heavy rule over each heading, content set in from the left |
| Timeline | Creative | 1 | Dates in a left column, in the accent colour |
| Sidebar | Creative | 2 | A tinted right-hand column for short sections |
| Compact | Compact | 1 | Tight spacing, narrow margins |
| Technical | Compact | 1 | Headings on a light band, square bullets |
| Engineer | Compact | 1 | Dense and centred. Organisation on the left, place on the right of the second line |
| Executive | Academic | 1 | Serif name and headings, Source Serif 4 text, roomy spacing |
| Scholar | Academic | 1 | Serif headings centred over a rule, Source Serif 4 text, roomy spacing |

## How it works (one layout tree, three outputs)

- A template is a preset (font pairing, spacing, margins, heading style, dates, bullets) plus a "look"
  in `packages/contract/src/resume-style.ts` (`LOOK`): header style (plain, band, bar, rule), name size
  and weight, colours by role, content indent, left dates column, skill grid, section order, and the
  right-hand column. `resumeTheme(style)` turns it into numbers.
- `resumeLayout` (the content) and `arrangeLayout` (where each section goes) in
  `packages/contract/src/resume-layout.ts` are shared by the live preview (`app-ui/src/resume/Preview.tsx`),
  the PDF page (`services/src/print/resume-print.ts` `resumeHtml`) and the Word file (`resumeDocx`).
  Sections move by type (skills, languages, interests, certifications, awards go to the side column),
  never by heading text.
- Every look is built from things both outputs can draw: borders, fills, indents, tab stops, colour,
  size and capitals. No icons, skill bars, charts or text in images.
- Word has no Geist or Instrument Serif, so the Word file uses Arial and Georgia. Serif text names Source Serif 4
  in Word; where it is not installed, Word shows a substitute font.

### Rules that keep the PDF text in order

- Reading order is header, then the main column, then the side column, in every output. The side column
  is placed with CSS grid columns, never with `order`, because Chromium paints (and so writes the PDF
  text) in document order.
- Nothing on the page is positioned. Chromium paints positioned boxes after everything else, which put
  every bullet at the end of the PDF text, away from its job. This was a bug in the old bullets (all
  templates); bullets are now plain inline boxes.
- The printer prints with backgrounds off. Fills (the Banner band, Technical heading bands, the Sidebar
  tint) use `print-color-adjust: exact`, which Chromium honours even then. Before this, Technical's
  heading band showed in the preview but not in the PDF.
- In Word, a two-column template is one borderless table row with two cells, main first. The row may
  break across pages. One-column templates have no tables. Word section columns are not used: they flow
  text from one column into the next, so a long main column would spill into the side column.

### Fit to pages

Fit steps through spacing, then margins, then text size. Template spacing (band padding, column gap,
side padding, section gaps) scales with the spacing setting, so it shrinks too. Checked in the app on the
three-page sample for every template: each fits on two pages; one page says it still needs two and
suggests hiding a section.

### Switching templates

Picking a template applies its own fonts, headings, spacing, dates and bullets. The accent colour, page
size, text size and hidden sections stay. "Reset to <template> defaults" appears once you change the type
or layout controls. We chose this over per-template memory because it is predictable, needs no extra
saved state, and matches what people expect from a template ("show me this look"). Plain and Swiss are
black and white: the colour swatches are disabled there, with a note.

## Research

### Galleries

| Source | What we noted |
|--------|---------------|
| Enhancv, https://enhancv.com/resume-templates/ | Filter chips including an "ATS" filter, style groups (Traditional, Modern, Simple, Creative, Minimalist), single and double column, timeline layouts |
| Resume.io, https://resume.io/resume-templates | Tabs: All, ATS, Simple, Professional, Two-column. Some two-column templates sold as ATS |
| Novoresume, https://novoresume.com/resume-templates | Categories (Professional, Modern, Traditional, Creative, Minimalist, One-page, Two-page). Claims all templates are ATS-friendly, no per-template mark |
| Kickresume, https://www.kickresume.com/en/resume-templates/ | Five groups (ATS-Friendly, Professional, Simple, Creative, Free); one dominant colour per template |
| FlowCV, https://flowcv.com/resume-templates | Groups include Compact; names describe structure ("sidebar left") |
| Canva, https://www.canva.com/resumes/templates/ | Free-form designs. Its own FAQ warns against text boxes, tables and images for ATS |
| Reactive Resume (MIT), https://docs.rxresu.me/guides/choosing-a-template | Filters One column / Two columns / ATS-safe. Thumbnails drawn from the user's own resume. Hover or Tab shows a full preview. Every two-column template is marked not ATS-safe |
| VisualCV, https://support.visualcv.com/article/40-how-do-i-change-the-design | Content survives a template switch |

Zety and Teal did not load (timeout and 403), so we have no first-hand notes on them.

Lessons we used: one honest ATS flag per template (not a blanket claim), thumbnails from the person's
own content, hover and keyboard preview, style groups as a filter, and a Compact group for dense layouts.

### Open source we learned from

- Reactive Resume (MIT), https://github.com/reactive-resume/reactive-resume: main column plus sidebar
  model; one-column templates print sidebar sections after the main ones; its fit-to-page steps density,
  then margins, then text size (the same order as ours).
- Jake's Resume (MIT, from sb2nov), https://github.com/jakegut/resume: large bold name, one centred contact
  line, small-capital headings over a full rule, dense spacing, entry rows with the organisation on the
  left and place and dates on the right. Our Engineer template follows this structure.
- RenderCV (MIT), https://docs.rendercv.com/user_guide/yaml_input_structure/design/: themes are presets
  of one parameter set (fonts, sizes, title styles, a 4.15 cm dates column, partial or full rules,
  centred titles). Default: 10 pt body, 0.7 in margins, accent on name and headings only. Our templates
  work the same way. moderncv's left dates column informed Timeline; harvard's centred titles informed
  Scholar.
- JSON Resume themes, https://jsonresume.org/themes: includes "Government Standard", "Academic CV" and
  sidebar themes; the common ones (even, elegant, flat, stackoverflow) are MIT.

### ATS guidance

- Jobscan, https://www.jobscan.co/blog/resume-tables-columns-ats/: two-column resumes are "generally, no"
  for ATS because columns can run together; decorative dividers rarely break parsing; skills as text.
- Jobscan, https://www.jobscan.co/blog/ats-formatting-mistakes/: keep contact details in the body (not a
  page header); standard headings; no skill bars; consistent date formats.
- Indeed, https://www.indeed.com/career-advice/resumes-cover-letters/ats-resume-template: 10 to 12 pt,
  standard headings; columns, text boxes and images disrupt the linear flow.
- MIT CAPD, https://capd.mit.edu/resources/resume-checklist/: 10 to 12 pt, margins 0.5 to 1 in, bold and
  italics for headings and positions, no underlining.
- US federal (OPM guidance, via https://jobs.irs.gov/sites/default/files/2025-12/guidance-for-applicants-on-2-page-resume%20(1).pdf):
  two-page limit, MM/YYYY dates and hours per week for each job. Plain is the template for this; the
  content rules are the writer's job.

### Typography

- Line spacing 120 to 145 percent, line length 45 to 90 characters, and resumes fail most often by being
  too dense: https://practicaltypography.com/line-spacing.html, https://practicaltypography.com/line-length.html,
  https://practicaltypography.com/resumes.html.
- What we applied: body 10 to 11 pt (smaller only through Fit), line height 1.3 to 1.45, name 1.5 to 2.9
  times the body size, metadata about 5 percent smaller, accent only on the name, headings, rules and
  dates, and at most one fill per page area.

## Decisions and open questions

- **Text serif: Source Serif 4 (OFL), added 2026-10-11.** Scholar and Executive use the "serif-text" pairing:
  Instrument Serif for the name and headings, Source Serif 4 for body text. It comes from the pinned
  `@fontsource/source-serif-4` package, is in the packaging font list, and the preview sets it through the brand
  class `.t-text-serif`. Older Scholar and Executive files keep "serif" (Geist text) until the person picks the
  pairing or resets the template.
- **Two-column templates are right-hand only.** A left sidebar would need a right-to-left table in Word
  to keep the main column first in the text. That is a hack, so we didn't.
- Contact details always stay in the header, never in the side column.
