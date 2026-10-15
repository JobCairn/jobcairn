# Resume Studio (Lane D)

Status: built on `feat/resume-studio`, 2026-10-10.

## Goal

A resume Claude tailored for a job (`application/resume.md`) can be edited, styled, rewritten with AI help,
versioned and downloaded, without leaving plain Markdown. The file stays readable by the career skill and the
plugin.

## Pieces

- **Section model** (`contract/src/resume-model.ts`, pure). Parses Markdown into a header (`# Name` plus the
  lines under it), `##` sections, `###` entries (roles, projects, degrees) with meta lines and bullets, and text
  blocks. Every node keeps the source lines it came from and emits them unchanged unless it was edited, so an
  untouched file round-trips byte for byte (CRLF, odd markers, code fences and HTML comments included). Edited
  nodes are written in a canonical form.
- **Style** (`contract/src/resume-style.ts`). `application/.studio/<name>.style.json` (a dot folder, never listed as an application file or handed off): layout (classic, modern,
  compact, minimal), font (Geist, Instrument Serif headings, Geist Mono headings; all bundled OFL), accent (a
  fixed palette of print-safe colours, never free CSS), density, A4 or Letter, and hidden sections.
  `resumeTheme(style)` turns it into numbers that the HTML print CSS, the DOCX writer and the live preview all
  read, so the three agree. Hidden sections are removed before export.
- **Services** (`services/src/resume.ts`). `resume.load / save / version / restore / suggestion / download /
  copy`. All IO checks the job folder (`writableProblem`, plain folders, no links, no second names, no locked
  folders), caps sizes (512 KB Markdown, 64 KB style) and writes atomically. Save takes the digest the editor
  loaded and refuses if the file changed underneath (Claude wrote it meanwhile).
- **Versions.** `application/.versions/<name>/<stamp>-<kind>.md`. Kinds: original (first edit), manual (a save
  when the newest version is 10+ minutes old), ai (Claude's rewrite accepted), restore, replaced (Claude's
  version kept aside by "Keep my edits"). At most 100 kept. The renderer gets ids and dates, never paths.
- **AI rewrite (round 2).** Lane G's catalogue action `rewrite_resume`, run through Lane H's engine:
  `useClaudeRun("rewrite_resume", job).start({options, note})` plus `<ClaudeRunPanel>`. Per bullet, per section or
  the whole resume (resume.md only). The renderer sends positions in the saved file (`s<n>`, `b<n>`); the main
  process (`studioRequest`, engine start) maps them to G's ids (heading slug, `<section>-<n from 1>`), so no
  resume text comes from the renderer. Claude writes the whole resume with the rewrite in place to
  `application/.studio/resume.suggested.md`. The engine's write checks refuse every dot folder except exactly
  that file for that action (`studioOutputs`). The prompt adds "Don't add anything about visas, sponsorship or
  work rights" unless the profile says `needs_sponsorship` and the note asks for it.
- **Suggestion.** Studio shows the suggested resume as a line diff (text only) with Accept (it becomes the
  resume, versioned), Keep my edits (Claude's version saved under Versions first, then removed) and Reject
  (removed). It is never an application file and never "ready to send".
- **Downloads.** PDF and Word through the existing print path (`renderHtml` / `renderDocx`, now style-aware,
  same CSP and isolated parse), plus Markdown and ATS-safe plain text (ASCII hyphens, no glyph bullets, no
  Markdown marks). The main process shows the save dialog and writes the file; the renderer never names a path.
  Copy to clipboard for Markdown and text.
- **UI.** Route `#/resume/<slug>/<id>/<file>`. Editor left, live page preview right (page count, warning above
  2 pages), tabs for Style, AI suggestions, Versions and Download. Drag or Move up/down to reorder sections and
  bullets, show/hide sections, add/remove bullets, undo/redo (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z), autosave after
  1.5 s idle. Entry points: "Edit resume" on Apply's Review step and on the Job screen's Files tab.

## Not in scope

Cover-letter-specific editing (the studio opens any `application/*.md`, but the section tools are resume
shaped), more fonts (needs a new pinned dependency), two-column layouts (not ATS-safe).

## Fix round 1 (2026-10-10)
- Studio state lives in `application/.studio/` (style, Claude's suggestions) and `application/.versions/`. Apply,
  the Job Files tab and the hand-off skip dot folders and any stray `*.style.json` / `*-suggestions.json`.
  Suggestions are never "ready to send" until accepted into the resume.
- The rewrite request has Lane H's shape: `{action: "rewrite_resume", options: {scope: "resume" | "section" |
  "bullet", section_id?, bullet_id?}, note}`. Ids are positions in the saved file (`header` or `s<n>`, `b<n>`),
  resolved by the main process, so no resume text travels from the renderer. The prompt never adds visas or
  sponsorship unless the profile needs sponsorship and the note asks for it.
