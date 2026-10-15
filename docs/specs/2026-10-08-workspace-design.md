# CareerOS: Workspace and Data Design (Sub-project 1)

- Status: Approved 2026-10-08
- Date: 2026-10-08
- Owner: product founder
- Working product name: CareerOS (placeholder)

## 1. Product context

CareerOS is a local-first job-hunt assistant. It runs on the candidate's own laptop as a
localhost web app. Claude Code, on the candidate's own Claude subscription, does the AI work
(sourcing, scoring, tailoring, email, interview prep). It serves every kind of candidate:
citizens, permanent residents, visa holders, and people who need sponsorship, for any job
type and location.

Business model, phase 1: a public website with a contact form. The candidate pays once and
we do a guided one-time setup on their laptop. Phase 2 is out of scope here.

Goals, in order:
1. Solve the founder's own sponsored job hunt (the founder is user #1).
2. Serve candidates in the same situation.
3. Grow into a paid product later.

### 1.1 Sub-projects (each gets its own spec, plan and build)

| # | Sub-project | Depends on |
|---|-------------|-----------|
| 1 | Workspace and data (this spec) | none |
| 2 | Claude Code plugin: skills and scripts for sourcing, sponsor check, tailoring, PDF/DOCX export, email, interview prep, gap guides | 1 |
| 3 | Local UI app: dashboard (analytics first), jobs list, settings and filters, drag-and-drop inbox, interview prep, learning | 1, 2 |
| 4 | One-click installer and setup wizard: Claude login, Chrome profile and remote debugging, email (SMTP app password or Claude Gmail connector), health checks; whole setup in 2 to 3 minutes | 2, 3 |
| 5 | Learning videos: narrated explainers for JD gaps and interview topics, rendered locally with the HyperFrames CLI, narrated by Supertonic 3 on-device TTS (fallback macOS `say`; ElevenLabs optional) | 2 |
| 6 | Website: landing page, contact form, one-time payment | none |

### 1.2 Decisions already made

- Local-first. No hosted service in phase 1. Claude Code is the worker. Hosted use of
  consumer Claude subscriptions is not allowed, so a hosted version would need API billing.
- Job sources in the product: ATS public boards (Greenhouse, Lever, Ashby, Workable,
  SmartRecruiters), an aggregator API (Adzuna), paste-a-link, and agent-browser in the
  candidate's own Chrome profile at human pace. Stop at any bot check; never evade it.
- No server-side scraping of SEEK, LinkedIn or Indeed.
- Applying and sending email always need the candidate's approval per item. No bulk auto-apply.
- Storage: files are the source of truth, with a generated SQLite index for the UI.
- Product code and candidate data live in separate folders. Personal data never enters git.
- Every external tool, model and code source is listed in `docs/dependencies.md`. The
  installer installs what that file marks Required. CareerOS ships its own small plugin; no
  third-party skill bundles are loaded into the candidate's Claude Code (token cost). Useful
  open-source skills are copied in part, rewritten and credited in `NOTICE.md`.

## 2. Goals and non-goals of this sub-project

Goals:
- A workspace layout that any candidate can understand and any skill can query.
- Record formats (profile, job, company) shared by the UI, the skills and analytics.
- Records that are easy to extend without breaking old data.
- A shared library and CLI that read and write records safely.
- A migration of the founder's legacy folder into the new layout, without touching the original.
- Strong guarantees that personal data never reaches the product repo.

Non-goals (later sub-projects): the UI, the installer, the skills themselves, sourcing
connectors, video, the website.

## 3. Two locations, never nested

| Location | What | Git |
|----------|------|-----|
| `~/Project/careeros/` | Product repo: code, schemas, plugin, UI, sample data | Private GitHub repo. No real personal data, ever. |
| `~/CareerOS/` (candidate chooses) | Workspace: all of one candidate's data | Not a git repo by default. Optional local-only git with a strict ignore list. Never pushed unless the candidate adds a remote on purpose. |

The workspace never sits inside the product repo, and the product repo never sits inside a
workspace.

## 4. Workspace layout

```
CareerOS/
├── workspace.json                 schema version, created date, product version
├── CLAUDE.md                      generated: rules and pointers for Claude
├── .claude/settings.json          generated: deny-read rules for locked folders, CareerOS plugin only
├── settings/
│   ├── profile.json               who the candidate is and what they want
│   ├── search.json                saved filters, sources on/off, sweep schedule
│   ├── integrations.json          email method, Chrome profile, video voice choice (no secrets)
│   └── .env                       secrets only, chmod 600
├── me/                            personal, never leaves the laptop
│   ├── resumes/                   uploaded originals
│   ├── history/                   career facts: roles, skills, achievements, bullets,
│   │                              projects, do-not-claim list
│   ├── identity/      (locked)    passport, visa grant, VEVO, licence
│   ├── employment/    (locked)    contracts, payslips, reference letters
│   ├── education/                 degrees, transcripts, certificates
│   └── projects/                  portfolio and side projects
├── inbox/                         drag-and-drop landing zone
├── companies/<company-slug>/
│   ├── company.json
│   └── jobs/<YYYY-MM-DD>-<title-slug>/
│       ├── job.json
│       ├── jd.md
│       ├── score.md
│       ├── application/           exactly what was sent (resume md/pdf/docx, cover letter, answers)
│       ├── emails/
│       └── interview/             prep notes, questions, videos
├── learning/<topic-slug>/         gap topics shared across jobs: guide.md, video files
├── knowledge/
│   ├── sponsors.json              sponsor evidence (starter list shipped, user finds added)
│   └── search-log.jsonl           every search: site, query, time, results, kept
└── .index/careeros.sqlite         generated, safe to delete
```

Rules:
- Folder and file names: lowercase ASCII, hyphens, no spaces. Slugs come from one function
  in the library so every tool agrees.
- One company folder holds many jobs. When a recruiter advertises a job, the company is the
  recruiter and the end client goes in `job.json` (`client` field).
- Locked folders (`me/identity`, `me/employment`): the generated `.claude/settings.json`
  denies Claude read access. A skill that needs one fact (for example visa expiry) asks the
  candidate first. Locked files are never sent to any external service.
- Inbox flow: files dropped in `inbox/` are classified by Claude, moved by the library into
  the right `me/` folder (or attached to a job), and logged in `inbox/_filed.md`.
  Unclear files stay in `inbox/` with a question for the candidate.

## 5. Records

All records are JSON, UTF-8, two-space indent, with a `schema` integer and a `custom` object.

### 5.1 `settings/profile.json`

- `contact`: name, email, phone, city, links.
- `work_rights`: `status` (`citizen` | `pr` | `full_visa` | `limited_visa` |
  `needs_sponsorship`), `visa_subclass`, `visa_expiry`, `notes`.
- `targets`: `roles[]`, `keywords[]`, `seniority`, `job_types[]` (full_time, contract,
  part_time, casual, internship).
- `locations[]` in rank order: `{ place, modes: [onsite|hybrid|remote], will_relocate }`.
- `salary_min` with `currency` and `includes_super`.
- `industries`: `include[]`, `exclude[]`. `skip_companies[]`. `skip_big_tech` (bool).

### 5.2 `companies/<slug>/company.json`

- `name`, `slug`, `aliases[]`, `website`, `size`, `type` (employer, recruiter, consultancy,
  government), `big_tech` (bool).
- `sponsor`: `status` (verified | to_verify | checked_none | sanctioned | unknown),
  `evidence[]` of `{ date, note, url }`, `last_checked`.

### 5.3 `companies/<slug>/jobs/<id>/job.json`

- `id` (folder name), `company_slug`, `client`, `title`, `source` (ats | adzuna | browser |
  pasted), `source_site`, `url`, `apply_via`, `posted`, `found_at`.
- `location`, `work_mode`, `job_type`, `salary` `{ min, max, currency, period, text }`.
- `work_rights`: `label` (`sponsorship_offered` | `visa_ok` | `silent` | `citizen_pr_only` |
  `clearance`), `quotes[]`, `decided_by` (scan | claude | user).
- `scores`: `fit` `{ value, must_haves[], nice_to_haves[] }`, `sponsor` `{ value, tier,
  reasons[] }`, `career` `{ match, odds, tier, scored_at }`.
- `status`: Found | Saved | Applying | Applied | Interview | Offer | Rejected | Skipped.
- `timeline[]`: `{ at, event, note }`. `files[]`: `{ path, label, at }`.

`eligible_for_me` is computed at index time, not stored. A `citizen` or `pr` candidate is
eligible for every label. `needs_sponsorship` hides `citizen_pr_only` and `clearance` by
default. The UI can always show hidden jobs on request.

Ads that say sponsorship is offered are pinned first in every job list.

### 5.4 Video voice settings (`settings/integrations.json` → `voice`)

The candidate picks the narration voice in Settings: engine (Supertonic on-device, Mac voice,
or ElevenLabs with their key), preset voice (F1 to F5, M1 to M5), language, natural expressions
on/off, and an optional different voice per video type (learning guide, interview prep, slide
recap). Settings offers a Preview button that plays a short sample of each voice. Skills always
use the chosen voice and never change it without asking.

## 6. Extensibility

- Every record has a JSON Schema in `schemas/` in the product repo.
- Schemas allow unknown properties. The library preserves unknown fields on every rewrite,
  so data added by a candidate, a skill or a newer version is never dropped.
- `custom: {}` on every record is free space for anything not modelled yet. The UI shows
  custom keys as extra rows.
- New fields are additive with defaults, so older files stay valid.
- Renames or reshapes ship as numbered migrations (`migrations/NNN-name.ts`). The library
  backs up affected files to `.backup/<timestamp>/`, runs each pending migration once, and
  records the new version in `workspace.json`.
- Field definitions (label, type, options, help text) live next to the schemas. The UI
  builds the settings form, job detail panel and filters from them, so most new fields need
  no UI code.

## 7. Shared library and CLI (`careeros-core`)

Language: TypeScript, shared with the UI (sub-project 3). A thin CLI makes it callable from
Claude, shell and Python.

Operations:
- `read`, `write` (validate, then write to a temp file and rename), `list`.
- `new_job`, `add_event`, `set_status`, `attach_file`.
- `file_inbox_item` (Claude decides the target, the library moves and logs).
- `build_index`, `validate_workspace`, `migrate`, `init_workspace`.

CLI examples: `careeros init ~/CareerOS`, `careeros job new ...`, `careeros index`,
`careeros validate`, `careeros import-legacy <legacy-dir> --to ~/CareerOS --dry-run`.

Index: SQLite with tables `jobs`, `companies`, `events`, `searches`. Rebuilt from files after
any write (incremental where cheap, full rebuild on demand). The UI only reads the index and
only writes through the library. Invalid files are listed by the validator and skipped by the
index instead of crashing anything.

## 8. Migration of the legacy folder

- `import-legacy` maps the current layout:
  - `Company/<Name>/application.json` and its JD/score/resume files go to
    `companies/<slug>/jobs/<date>-<title>/`.
  - `Job-Hunt-Sponsorship/sponsors.json` goes to `knowledge/sponsors.json`.
  - `SEARCH-LOG.md` goes to `knowledge/search-log.jsonl`.
  - `resume-docs/profile.md` and master docs go to `me/history/`.
  - `Resume/`, `Visa/`, `Current-company/`, `Current Address/`, `Personal Projects/` go to
    the matching `me/` folders.
- Messy names are normalised, for example "Acme Recruiting (client Example University)"
  becomes company `acme-recruiting` with that client in `job.json`.
- `--dry-run` prints the full mapping and changes nothing. A real run copies only, never
  moves or deletes, then prints a report: counts, unmapped files, validator result.
- The legacy folder keeps working unchanged until the founder chooses to switch.

## 9. Privacy guarantees for the product repo

Rule: nothing from a real person ever goes into this repo or to GitHub. Not the founder's
name, email, phone, address, employer, visa details, salary, resume or documents, and not
any candidate's. This spec itself uses only generic or fictional examples.

Sample data (`samples/`) is fully fictional and uses reserved values that can never belong
to a real person:
- Name: "Alex Example". Employers: "Acme Corp", "Example Labs", "Acme Recruiting".
- Email: `alex@example.com` (the `example.com` domain is reserved by RFC 2606).
- Phone: Australian fictional-use range from ACMA, e.g. `0491 570 006`.
- Address: "1 Example Street, Sampletown NSW 2000".
- Documents: generated placeholder PDFs that say "SAMPLE" on every page. Never a real scan.


1. Only fictional sample data ("Alex Example") is allowed in the repo, under `samples/`.
2. A pre-commit hook blocks: `.env` files, PDF/DOCX/image files outside `samples/` and
   `public/`, real-looking emails and phone numbers outside `samples/`, and keywords such as
   passport, visa grant and TFN followed by numbers.
3. CI runs gitleaks plus the same custom rules. A failing scan blocks the merge.
4. The repo starts fresh. No history is copied from the legacy folder.
5. A personal denylist lives OUTSIDE the repo (`~/.config/careeros/denylist.txt`, never
   committed). It lists the founder's real name variants, emails, phone, street address,
   employer and ID numbers. The pre-commit hook and a local pre-push hook block any commit or
   push whose diff contains one of those strings. CI uses the generic rules only, so the
   denylist itself never leaves the laptop.
6. Before the first push to GitHub, run the full-history scan (`gitleaks detect` plus the
   denylist check across all commits). Push only when both are clean.

## 10. Testing

- Unit tests: schema validation, unknown-field preservation, atomic writes, slug rules,
  index rebuild, eligibility rules, every migration, using the `samples/` workspace.
- Migration test: a synthetic legacy tree that copies the legacy folder's structure with fake data.
  Real personal files are never used in tests.
- CI on every push and pull request: typecheck, tests, personal-data scan, validate the
  sample workspace. Main is protected; nothing merges with a failing check.

## 11. Open questions for later sub-projects

- Final product name and domain.
- Windows support (phase 1 targets macOS first, since setup uses Chrome remote debugging and
  macOS voices).
- Licence and distribution of the private package to paying candidates.
