# ATS Formatting Standards

Applicant Tracking Systems parse a resume into structured fields before any human
sees it. If parsing fails, strong candidates get filtered out for mechanical
reasons. These rules keep the document machine-readable without making it ugly for
the human who reads it next.

## What keeps a resume parseable

- **Single column, linear top-to-bottom flow.** Parsers read in reading order;
  multi-column layouts interleave text from both columns and scramble the result.
- **Standard section headings** — `Experience`, `Work Experience`, `Education`,
  `Skills`, `Summary`, `Certifications`. Creative headings ("Where I've Made
  Impact") may not be recognized as section boundaries.
- **Contact info in the body**, not in the page header/footer. Many parsers drop
  header/footer content entirely.
- **The target job title in the headline.** Resumes containing the actual job
  title get dramatically more interview invitations — it's the highest-leverage
  single element. Match the posting's title where honest.
- **Reverse-chronological experience** with consistent `Company — Title — Dates`
  formatting. Keep date formats uniform (e.g. `Jan 2022 – Present`).
- **Standard fonts** (Arial, Calibri, Helvetica, Georgia, Times). Decorative or
  embedded fonts can render as unparseable glyphs.
- **Real text, not images.** Text inside graphics/logos is invisible to parsers.
- **File type:** `.docx` parses most reliably across ATS platforms; a
  text-based (not scanned/flattened) `.pdf` is usually fine. Confirm the
  posting's stated preference when there is one.

## What breaks ATS parsing

- Tables and multi-column layouts (the most common failure).
- Text boxes, sidebars, headers/footers holding real content.
- Graphics, icons, logos, charts, photos carrying information.
- Non-standard or embedded fonts; unusual bullet glyphs.
- Scanned/image PDFs, or PDFs exported with security/encryption.
- Inconsistent or invented section labels.
- **Meta text in the canonical output** — `Status: DONE`, `draft`, `v2`, review
  notes, TODOs. Strip all of it before finalizing.

## Keyword strategy (without stuffing)

- Pull keywords **directly from the job description** — favor exact-match hard
  skills and the literal job title.
- Integrate them where they're **true and evidenced** in the master docs. A
  keyword you can't back up in an interview is a liability, not an asset.
- **Don't keyword-stuff.** Over-saturation reads as gaming to the human reviewer
  who sees borderline matches, and modern ATS scoring discounts it. Natural
  placement in real bullets beats a keyword dump.
- Report **coverage and gaps** honestly: which required keywords are backed by
  evidence, which are missing, and which the user shouldn't claim.

## Bullet quality bar

Every bullet should carry **Action + Scope + Method + Outcome**, quantified where
the evidence supports it.

- Weak: "Responsible for improving the deployment process."
- Strong: "Cut deployment time 45% (Action+Outcome) across 12 microservices
  (Scope) by introducing a parallelized CI pipeline (Method)."

Quantify only with numbers that trace to master docs. A precise unquantified
outcome beats an invented metric.
