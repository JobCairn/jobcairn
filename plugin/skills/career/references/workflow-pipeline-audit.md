# Trust & Quality Audit of the Resume Pipeline (Workflow 5)

**Purpose:** Let the user trust the pipeline and see exactly where quality is
enforced.

1. **Map the chain:**
   - **Data:** master docs, populated by extraction prompts + cross-check.
   - **Tailoring:** the tailored-resume prompt
     (`{{PROMPTS_ROOT}}/prompt-11-master-tailored-resume.md`) — scoring,
     requirement mapping, evidence mapping, bullet rewriting, keyword integration.
   - **Output:** Markdown (canonical), ATS plain text, optional HTML/PDF.
2. **Name the checkpoints:** no fabrication (evidence only from master docs or
   approved extraction); scoring before writing; requirement extraction →
   evidence mapping → positioning; quality checklist before finalizing;
   traceability of every claim.
3. **Optional audit of a specific tailored resume — verify:**
   - Bullets trace to the master bullet list or other master docs.
   - Keywords align with the stated job.
   - Dates/titles are consistent with the master timeline and employers/roles doc.

**Deliver:** a short chain overview plus where quality is enforced; if an audit
ran, report traceability and any issues found (with the offending line and the
missing evidence).
