# Export to PDF / Word (Workflow 6)

**Purpose:** Convert a markdown resume (canonical output) into a polished,
ATS-safe PDF or Word document for submission.

Don't hard-depend on any one tool — **detect what's available and pick the best
path**, preferring routes that need no install. Full commands, the tool-detection
ladder, and an HTML + print-CSS resume template are in
`references/document-export.md`. In short:

1. **Confirm** source markdown path, target format (PDF for most applications;
   DOCX only when the employer requires Word), and output location.
2. **Choose the engine** by what's installed (read the reference for the ladder):
   - **PDF, no install:** render an ATS-safe HTML resume, then headless Chrome
     `--print-to-pdf`. Best fidelity and design control; works out of the box on
     macOS. This is the default here.
   - **PDF/DOCX, if present:** `pandoc` (clean DOCX + PDF).
   - **True Word `.docx`, richer:** the official Anthropic `docx`/`pdf`/`pptx`
     skills (installable via `npx`) or Python `python-docx` / `weasyprint`.
     Chrome cannot produce `.docx` — use one of these for Word.
3. **Verify** the file exists; report its path and size.
4. **Before exporting**, confirm the markdown is clean canonical output — no meta
   text, single-column, ATS-safe (Workflow 1 standards). A pretty PDF that a
   parser can't read defeats the purpose.
