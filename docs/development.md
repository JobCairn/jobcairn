# JobCairn

A local-first job-hunt assistant. It runs on the candidate's own laptop (macOS, Windows or
Linux), with Claude doing the thinking. It finds jobs, checks work rights and visa
sponsorship, scores fit, tailors resumes and cover letters, tracks applications and email,
and makes interview-prep and learning videos. All data stays on the laptop.

> Status: early build. The Claude Code plugin and the core data library (sub-project 1) are in.
> The app UI and installer come next. Not ready for candidates yet.

## How it works

- **Files are the truth.** Each candidate has a workspace folder (`~/JobCairn`) of plain JSON
  and Markdown files: profile, companies, jobs, documents, searches, settings. A SQLite index
  is generated from those files for fast lists and dashboards, and can be rebuilt any time.
- **Records are extensible.** JSON Schemas define every record. Unknown fields are kept, every
  record has a `custom` object, and the UI builds its forms from the schemas. Numbered
  migrations upgrade old workspaces, with a backup first.
- **Claude does the reasoning, through our own plugin.** JobCairn ships one small Claude Code
  plugin with focused skills. We don't install third-party skill bundles, to keep token use low.
  Candidates connect Claude one of three ways: the Claude desktop app with our plugin (default),
  an in-app chat with their own Anthropic API key, or an opt-in "Use my Claude Code login
  (experimental)" setting.
- **One-click setup.** Every dependency is a component file with a check and an install step.
  `./setup.sh` installs everything; `./setup.sh doctor` checks it.
- **Local and key-free.** No cloud rendering, no third-party keys by default. Optional services
  (cloud voices, job APIs) are off until the candidate adds their own key.

## Roadmap

| # | Sub-project | Status |
|---|-------------|--------|
| 1 | Workspace and data: schemas, `careeros` CLI, index, validator, migrations, legacy import, privacy guard | Done |
| 2 | Claude Code plugin: career, video and voice skills | First version merged |
| 3a | Desktop app: brand system, analytics home, jobs, job detail, apply hand-off, inbox, learn, sponsors, searches, settings, privacy, approvals | Done (merged to develop) |
| 3a+ | Claude action buttons and resume export (PDF, Word) | Done |
| 3b | Mail: Gmail app-password setup, sync, mail timeline, safe viewer, send after approval | In progress |
| 3c | Claude chat and voice: in-app chat, API-key mode, voice picker | Planned (plan written) |
| 4 | One-click installer and doctor | In progress: the app installs Claude Code, Node.js, Python, ffmpeg and the video tools itself, after a yes |
| 5 | Videos: seven video types made in the app, script review, local narration and render, captions | Done |
| 6 | Website and terms | Planned |

## Repo layout

```
.claude-plugin/        marketplace entry so Claude Code can install the plugin
plugin/                the JobCairn Claude Code plugin
  skills/              career, video-explainer, video-slides, video-captions, voice
  templates/video/     HTML video templates and vendored HyperFrames components
packages/core/         TypeScript core library and `careeros` CLI
samples/               a fictional sample workspace (Alex Example)
scripts/privacy/       privacy scanner used by git hooks and CI
scripts/setup/         one-click setup runner (install / doctor)
setup/components/      one JSON file per dependency: check + install
docs/
  specs/               approved designs
  superpowers/plans/   implementation plans
  dependencies.md      every tool, model and copied skill we use, with licenses
licenses/              third-party license texts
NOTICE.md              credits for copied and adapted work
```

## Install the plugin (development)

```bash
claude plugin marketplace add ./      # from the repo root
claude plugin install careeros@careeros
```

## Development

Requires Node.js 22.13+, Python 3.11+, ffmpeg and Google Chrome. See `docs/dependencies.md`.

```bash
npm install          # also turns on the repo's git hooks
npm test
npm run typecheck
npm run careeros -- --help
./setup.sh doctor    # read-only check of every component
npm start -w @careeros/app-electron   # build and run the desktop app
```

The first `npm start` (or any first Electron run) downloads Electron itself, about 100 MB, into `node_modules/electron/dist`.
Dev mode (`npm run dev -w @careeros/app-ui`, then `npm run dev -w @careeros/app-electron`) runs without the app's CSP, because Vite's dev preamble is an inline script; `npm start` serves the strict CSP.

## Branches

- `develop` is the default working branch. Feature branches merge into it.
- `main` is production. It moves only when develop is stable.
- Remove the worktree and delete the branch after every merge.

## Privacy rules

This repo must never contain a real person's data: no names, emails, phones, addresses,
employers, ID numbers, resumes or documents.

- Samples and tests use only fictional values: Alex Example, Acme Corp, Example Labs,
  Acme Recruiting, `alex@example.com`, `0491 570 006`, 1 Example Street, Sampletown NSW 2000.
- Tests build email and phone strings by concatenation so the scanner stays meaningful.
- A privacy scanner runs on every commit and push, and in CI. A personal denylist lives
  outside the repo in `~/.config/careeros/denylist.txt` and is never committed.
- Never bypass the hooks with `--no-verify`.

## Docs

- Design: [docs/specs/2026-10-08-workspace-design.md](docs/specs/2026-10-08-workspace-design.md)
- Plan: [docs/superpowers/plans/2026-10-08-workspace-core.md](docs/superpowers/plans/2026-10-08-workspace-core.md)
- Dependencies and licenses: [docs/dependencies.md](docs/dependencies.md)
- Credits: [NOTICE.md](NOTICE.md)

## License

Proprietary. JobCairn code and text only. Third-party parts keep their own licenses; see
`NOTICE.md` and `licenses/`.
