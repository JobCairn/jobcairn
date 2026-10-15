# Document Export (Workflow 6)

Convert a markdown resume into a polished, **ATS-safe** PDF or Word file. Don't
assume any single tool is installed — detect what's available and pick the best
path, preferring routes that need no install.

## Pre-flight

1. Confirm: source `.md` path, target format, output path.
2. Confirm the markdown is clean canonical output — no meta text (`Status`,
   `DONE`, `draft`, TODOs), single-column, standard headings. A beautiful PDF a
   parser can't read is worse than plain text. See `ats-formatting-standards.md`.

## Tool-detection ladder (run these checks, pick the first that fits)

```bash
command -v pandoc                     # best for DOCX + PDF if present
ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  || command -v google-chrome || command -v chromium   # HTML->PDF, no install
command -v python3 && python3 -c "import weasyprint" 2>/dev/null   # HTML/CSS->PDF
command -v python3 && python3 -c "import docx" 2>/dev/null         # true .docx
command -v wkhtmltopdf; command -v pdflatex; command -v typst      # other engines
```

Then choose:

### A. PDF with zero install — HTML → headless Chrome (preferred default)

Best fidelity and full design control, and it works out of the box wherever
Chrome/Chromium exists (common on macOS). Chrome **cannot** emit `.docx`, so use
this for PDF only.

1. Convert the resume markdown into a single self-contained HTML file using the
   template below (inline the CSS; no external assets — keeps it portable and ATS
   text stays real text, not images).
2. Print to PDF:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # or `google-chrome` / `chromium`
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="resume.pdf" "file:///abs/path/to/resume.html"
```

(Older Chrome builds ignore `--no-pdf-header-footer`; that only affects the
browser's own header/footer, not the resume content.)

### B. pandoc (if installed) — cleanest DOCX, easy PDF

```bash
# PDF (needs a pdf engine: wkhtmltopdf, weasyprint, or a LaTeX install)
pandoc resume.md -o resume.pdf --pdf-engine=wkhtmltopdf --css=resume-style.css \
  -V margin-top=0.5in -V margin-bottom=0.5in -V margin-left=0.5in -V margin-right=0.5in
# Word
pandoc resume.md -o resume.docx            # add --reference-doc=template.docx for house style
```

Install (macOS): `brew install pandoc` and, for PDF, `brew install --cask wkhtmltopdf`.

### C. Official Anthropic document skills — richest Word/PDF/Slides

Anthropic ships dedicated `docx`, `pdf`, and `pptx` skills (python-docx / pdf
libraries under the hood) — the best route for true Word documents with real
styling, templates, and tracked structure. They're not installed in every
environment; if the user wants polished `.docx`, offer to install them
(`npx`-based, from Anthropic's public skills repo) and then invoke the `docx`
skill with the resume content. Prefer these over hand-rolling python-docx.

### D. Python libraries (if the user prefers / already has them)

```bash
python3 -c "import weasyprint" && python3 - <<'PY'   # HTML/CSS -> PDF, great CSS support
import weasyprint; weasyprint.HTML("resume.html").write_pdf("resume.pdf")
PY
# .docx via python-docx (pip install python-docx) when pandoc/official skill absent
```

### E. Reactive Resume + JSON Resume schema (best for polished templates)

[Reactive Resume](https://github.com/amruthpillai/reactive-resume) (MIT,
self-hostable via Docker) is a resume builder with 15+ templates, live preview,
and **PDF / DOCX / JSON export**. It imports the **JSON Resume** schema
(`https://jsonresume.org/schema`), which makes it a clean interchange target: the
skill can emit the resume as JSON Resume, and the user renders/exports a polished,
template-styled document in the app. It's a web UI (self-host or hosted), not a
library, so integration is via the JSON round-trip, not a CLI call.

Use this route when the user wants **designed templates** rather than the plain
ATS layout, or already uses Reactive Resume. Workflow: build the markdown/JSON as
usual → convert to a JSON Resume object → import into Reactive Resume → export.
Keep an ATS-plain version too, since heavily-templated resumes can trip weaker
parsers.

### Deciding quickly

- **PDF, nothing installed →** A (Chrome).
- **Employer requires Word `.docx` →** C (official `docx` skill) or B (pandoc) or
  python-docx. Never Chrome.
- **pandoc already there →** B for both formats.
- **Wants designed templates / already uses Reactive Resume →** E (JSON Resume
  round-trip); still keep an ATS-plain version.

Always **verify** the output exists and report path + size.

## ATS-safe HTML resume template

Single column, standard fonts, real text, print-tuned. Fill the `<!-- ... -->`
regions from the markdown; keep it one file with inline CSS.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Resume</title>
<style>
  @page { size: Letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  body {
    font-family: "Helvetica Neue", Arial, "Segoe UI", sans-serif;
    font-size: 10.5pt; line-height: 1.35; color: #1a1a1a; margin: 0;
  }
  header { margin-bottom: 6pt; }
  h1 { font-size: 20pt; margin: 0 0 2pt; letter-spacing: .3px; }
  .headline { font-size: 11pt; font-weight: 600; color: #333; margin: 0 0 4pt; }
  .contact { font-size: 9.5pt; color: #444; }
  .contact a { color: #444; text-decoration: none; }
  h2 {
    font-size: 11pt; text-transform: uppercase; letter-spacing: .6px;
    border-bottom: 1px solid #999; padding-bottom: 2pt; margin: 12pt 0 6pt;
  }
  .role { display: flex; justify-content: space-between; gap: 12pt; margin-top: 6pt; }
  .role .who { font-weight: 700; }
  .role .when { color: #555; white-space: nowrap; font-size: 9.5pt; }
  ul { margin: 3pt 0 0; padding-left: 16pt; }
  li { margin: 1.5pt 0; }
  .summary { margin: 2pt 0; }
  .competencies { margin: 2pt 0; }
  @media print { a { color: inherit; } }
</style>
</head>
<body>
  <header>
    <h1><!-- Full Name --></h1>
    <p class="headline"><!-- Target Job Title / headline --></p>
    <p class="contact"><!-- email · phone · city · linkedin · portfolio --></p>
  </header>

  <h2>Summary</h2>
  <p class="summary"><!-- 2–3 line executive summary --></p>

  <h2>Core Competencies</h2>
  <p class="competencies"><!-- comma-separated, keyword-aligned to the JD --></p>

  <h2>Experience</h2>
  <!-- repeat per role, reverse-chronological -->
  <div class="role">
    <span class="who"><!-- Title, Company --></span>
    <span class="when"><!-- Mon YYYY – Mon YYYY --></span>
  </div>
  <ul>
    <li><!-- Action + Scope + Method + Outcome, quantified --></li>
  </ul>

  <h2>Education</h2>
  <div class="role">
    <span class="who"><!-- Degree, Institution --></span>
    <span class="when"><!-- YYYY --></span>
  </div>
</body>
</html>
```

Keep everything as real text (never render sections as images), avoid multi-column
CSS, and keep contact info in the body — not in a running page header — so ATS
parsers capture it.
