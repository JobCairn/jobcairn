# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repo.
Read this file first, then the plan for the area you are changing.

## What this is

JobCairn is a local-first job search app for macOS (Windows and Linux later). An Electron + React
desktop app keeps a candidate's whole search as plain JSON and Markdown files in one workspace
folder on their computer. Claude Code, signed in to the candidate's own Claude account, does the
reading and writing: finding jobs, scoring fit, tailoring resumes, drafting emails. Nothing is sent
without the candidate's approval.

## Repo layout

| Path | What it holds |
|---|---|
| `packages/core` | Workspace data library and `careeros` CLI: JSON Schemas, record store, index, validator, migrations |
| `packages/contract` | Shared types, the IPC bridge contract and pure logic used by both the UI and main process |
| `packages/services` | Main-process services: Claude Code engine, Chrome helper, setup/installers, search schedules, mail sync glue |
| `packages/mail` | Gmail IMAP/SMTP, matching mail to jobs, HTML sanitising, MIME build |
| `packages/video` | Script, narration, captions and render pipeline for videos |
| `packages/app-ui` | React renderer (screens, components, tours) |
| `packages/app-electron` | Electron shell, packaging, signing, in-app updates |
| `packages/brand` | Brand tokens, product name (`identity.json`), icons |
| `plugin/` | The bundled Claude Code plugin (skills and video templates) |
| `setup/components/` | One JSON file per external dependency: check + install step |
| `samples/` | A fictional example workspace (Alex Example) |
| `scripts/` | Privacy scan, setup runner, typecheck |
| `tests/` | Repo-wide checks (privacy, brand, button labels, identity) |
| `docs/specs/` | Approved designs |
| `docs/superpowers/plans/` | Implementation plans |

Package names and some internal ids still say `careeros` (the old product name). Keep them; see
`docs/rebrand.md`.

## Commands

```sh
npm ci                  # install (Node 22.13 or later)
npm run typecheck       # all packages
npm test                # vitest, whole repo
npx vitest run <path>   # one file or folder; prefer this while working
npm run scan            # privacy scan
npm run package:mac     # build the macOS app (unsigned unless signing env vars are set)
```

Run `npm run typecheck && npm test` before every commit. Never use `--no-verify`: the pre-commit and
pre-push hooks run the privacy scan.

## How work is planned and built

Every non-trivial change follows design → plan → build:

1. **Design.** Write or update a spec in `docs/specs/YYYY-MM-DD-<topic>.md`: goal, user-facing
   behaviour, data, edge cases, what's out of scope.
2. **Plan.** Write a plan in `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` in the same format as
   the existing plans:
   - a header with **Goal**, **Architecture**, **Tech Stack** and **Spec**;
   - a **Global Constraints** section;
   - numbered tasks, each with the files it touches and checkbox steps (`- [ ]`): write the
     failing test, run it and see it fail, implement, run it and see it pass, commit.
3. **Build.** Work through the plan task by task, in order. Tick each checkbox (`- [x]`) as you
   finish it, so the next agent can pick up where you stopped. Don't skip the failing-test step.

When you pick up existing work:

- Find the plan for the area (file names start with the date and topic) and its spec.
- A plan's **Global Constraints** are binding. Where a later plan disagrees with an earlier one,
  the later plan wins.
- Where the code and a plan disagree, the code is the current truth. Update the plan rather than
  undoing working code, and say so in your commit message.
- Keep changes inside the plan's scope. Note new ideas in the plan or spec instead of building them.

## Rules

- **Fictional data only.** Never commit real personal data. Samples and tests use only Alex
  Example, Acme Corp, Example Labs, Acme Recruiting, alex@example.com, 0491 570 006,
  1 Example Street, Sampletown NSW 2000. Email addresses in prose use `@example.com`,
  `@example.org` or `@example.net`.
- In tests, build email and phone strings by concatenation (`"alex" + "@" + "example.com"`) so the
  privacy scan stays meaningful.
- All record writes go through `packages/core/src/store.ts`. Never hand-roll `fs` writes of records.
- The renderer (`packages/app-ui`) never imports `electron`, `node:*`, `@careeros/core`,
  `@careeros/services` or `@careeros/mail`, and never receives a secret. It talks to the main
  process only through the bridge in `packages/contract/src/bridge.ts`.
- Brand values come from `packages/brand` tokens: no hex colours, `rgb(`, `font-family` or px font
  sizes in `packages/app-ui`. The product name comes from `packages/brand/identity.json`; don't
  spell it out in source (`tests/identity.test.ts` checks this).
- Button labels are one or two words; longer wording goes in `aria-label`
  (`tests/button-labels.test.ts` checks this).
- **Dependencies.** Pin exact versions. Add every new tool, model, package or copied skill to
  `docs/dependencies.md` (and `NOTICE.md` if code was copied). An external tool also gets a
  `setup/components/<id>.json` with a check and an install step. Never ask users to install things
  by hand. Exactly-pinned npm packages installed by `npm ci` need only the row in
  `docs/dependencies.md`'s "App packages" table.
- Nothing is ever sent, applied for or posted without the user approving it in the app.
- **Branches.** `develop` is the default branch; feature branches merge into `develop`. `main` is
  production and is merged only when stable.
- **Commits.** Use the repo's configured git identity. Don't add `Co-Authored-By`, "Generated
  with" or other tool attribution lines to commit messages or pull requests.
