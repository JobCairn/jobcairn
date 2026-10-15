# CareerOS app (sub-project 3a): app shell and workspace screens

- Status: draft for review
- Date: 2026-10-08
- Builds on: `docs/specs/2026-10-08-workspace-design.md` (sub-project 1, merged) and `@careeros/core`
- Later parts: 3b mail, 3c Claude chat and voice (separate specs)

## 1. Goal

A desktop app a non-technical candidate double-clicks to run their whole job hunt without a
terminal: see everything, apply, and learn. It runs on macOS, Windows and Linux. All data stays
on the laptop.

Success: a candidate creates or imports a workspace, fills in their profile (any work-rights
type), browses and filters jobs with sponsorship ads pinned, opens a job and sees its
description, score, files and timeline, prepares an application and hands it off, files
documents by dragging them in, reads their learning guides and videos, and controls privacy,
all from screens.

## 2. Decisions (owner, 2026-10-08)

| Topic | Decision |
|-------|----------|
| Split | 3a shell and workspace screens, then 3b mail, then 3c Claude chat and voice |
| Apply | Prepare, approve, hand off. The app never submits a form. It opens the employer's page with files ready, or (3b) sends an email application after approval. The candidate marks it applied. |
| Shell | Electron desktop app, React + TypeScript renderer, built with Vite |
| Not used | portless (local CA, root service, no web port to name), Tauri (two runtimes), local web server (attack surface) |
| Native SDK | Spiked 2026-10-08: all six tests passed on macOS, but the shell would be Zig code, we would still ship Node (no size win), and Windows/Linux are untested. Not adopted for 3a. The renderer talks only to a typed `rpc()` bridge, so the shell can be swapped later without touching screens. |
| Brand | One central brand system (`packages/brand`): design tokens in W3C DTCG JSON, built with Style Dictionary into CSS variables and TypeScript. Screens never use raw colours, fonts or sizes. |

## 3. Architecture

```
packages/app/
  src/main/          Electron main process (Node): owns the workspace, calls @careeros/core
    services/        workspace, jobs, inbox, privacy, approvals, secrets, files, learn
    ipc.ts           typed IPC handlers; every argument validated before use
    watcher.ts       file watcher -> incremental index refresh -> push "changed" events
  src/preload/       contextBridge exposes one typed `careeros` API to the renderer
  src/renderer/      React UI (no Node, no fs)
    screens/         Home, Jobs, Job, Apply, Inbox, Learn, Sponsors, Searches, Settings,
                     Privacy, Approvals, Onboarding
    components/      shared UI (tables, filters, cards, forms built from x-ui fields)
  test/              unit, component, and Electron end-to-end tests
```

- The renderer never touches the file system. It asks the main process through a small typed
  IPC API (for example `jobs.list(filters)`, `jobs.get(slug,id)`, `inbox.file(name,target)`).
  The main process calls `@careeros/core`, which already enforces path safety.
- One workspace open at a time. The app remembers its path in Electron's `userData`, never
  inside the workspace.
- Reads use the SQLite index for lists and counts. A file watcher refreshes the index when
  files change (from the app, Claude, or the candidate), so the UI is always current. This
  closes the deferred "index refresh after writes" item from sub-project 1.

### Electron hardening (all required)

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`,
strict Content-Security-Policy (no remote scripts, styles, fonts or images; fonts bundled),
single-instance lock, no `remote` module, navigation and new windows blocked inside the app.
External links open in the system browser only for `https:` URLs, after showing the real
address. Workspace files are shown through a custom `careeros-file:` protocol that serves
only files inside the open workspace (real-path checked) and never from locked folders unless
an allow-once grant is active. No telemetry.

## 4. Screens

| Screen | What it does |
|--------|--------------|
| Onboarding | Create a new workspace or open one; optional import of a legacy folder with a dry-run preview first; profile basics; work-rights type and visa fields; target roles and locations. |
| Home | Analytics first: pipeline counts by status, weekly activity (found, applied, replies), sponsorship mix, days left on visa (if set), and a "next up" list (best eligible jobs to prepare, interviews, pending approvals, inbox items). |
| Jobs | Table with search and filters (status, eligibility, work-rights label, location and mode, salary, source, fit and sponsor score, date). Sponsorship-offered ads are pinned and highlighted. Ads the candidate is not eligible for are hidden by default with a "show" toggle. Saved views. |
| Job | Tabs: description, score, files, timeline, gaps. Status change, notes, attach files. "Prepare application" button. Gap skills link to Learn. Mail tab arrives in 3b. |
| Apply | Four steps: prepare (tailored resume and cover letter, answers), review and approve (side-by-side preview, every claim linked to the candidate's history), hand off (open the apply page and reveal the files, or 3b email), confirm (mark applied, timeline event). In 3a, "prepare" opens Claude (desktop app) with the job and instructions ready; generated files land in the job folder and appear here. |
| Inbox | Drop zone. Each file gets a suggested destination (rules: file name, type and simple text match against jobs and document kinds). The candidate confirms or changes it, then the app files it with `fileInboxItem`. Claude-based classification arrives in 3c. |
| Learn | Lists `learning/` topics built from job gaps: guides (Markdown rendered safely), videos (played from the workspace), interview prep per job. Generating new videos is sub-project 5. |
| Sponsors | The sponsor cache with status, evidence links and scores. |
| Searches | The search log with site filter and times; "ran recently" badges. |
| Settings | Forms generated from the schemas' `x-ui` fields (profile, search, integrations), so new fields appear without UI code. Covers every candidate type. Connections (Gmail, Claude mode, voice) show "coming in 3b/3c". |
| Privacy | Lock switches for `me/identity` and `me/employment` (on by default). Changing a switch regenerates the workspace `.claude/settings.json`. Lists active allow-once grants with "revoke". |
| Approvals | Queue of actions waiting for the candidate: apply hand-offs, status changes proposed by Claude, and (3b) emails to send. Each card shows exactly what will happen, with Approve and Decline. |

## 5. Privacy, allow-once and approvals

- **Lock state** lives in `workspace.json` (`privacy.locked: ["me/identity","me/employment"]`,
  new field with a migration). The app regenerates `.claude/settings.json` from it. Deny rules
  cover Read and Edit, plus Bash patterns that read those folders (`cat`, `head`, `less`,
  `cp`, `open` and similar) and the CLI's `--jd-file` pointing into them. The CLI itself also
  refuses `--jd-file` paths inside locked folders.
- **Allow once:** when Claude or the CLI needs a locked fact, it writes an access request to
  `.careeros/requests/<id>.json` (who, which folder or field, why). The app shows a card. On
  Allow, the app unlocks only that folder for 15 minutes (configurable), regenerates the
  settings, records the grant in the activity log, and re-locks automatically. Deny records
  the refusal.
- **Approvals** work the same way: proposals are written to `.careeros/approvals/<id>.json`
  (new record kind with a schema). Only the app executes an approved action.

## 6. Secrets

A `SecretStore` service in the main process uses Electron `safeStorage` (macOS Keychain,
Windows DPAPI, Linux Secret Service). Encrypted values are stored in the app's `userData`
folder, never in the workspace. The renderer can only ask "is it set?", set, replace, or
delete. It never receives a secret. On Linux without a secret service, the app warns and
refuses to save rather than storing plaintext. 3b (Gmail app password) and 3c (API key) use it.

## 7. Look and feel (owner: "premium")

Direction chosen 2026-10-08: calm modern structure with editorial character.

- Themes: **Graphite** (dark, default) and **Paper** (light), switchable, following the OS setting
  on first run. Graphite: near-black background, soft panels, warm amber accent, green for
  sponsorship and success. Paper: warm off-white, terracotta accent.
- Type: **Instrument Serif** for headlines and big numbers, **Geist** for interface text,
  **Geist Mono** for labels and figures. All three are SIL OFL and bundled (no font CDN); add
  them to `docs/dependencies.md`, `NOTICE.md` and `licenses/`.
- Layout: left rail with counts, a command bar (Cmd/Ctrl+K: search jobs, run actions, ask
  Claude in 3c), cards with thin borders and gentle depth, small sparklines on the KPIs, a
  highlighted "Waiting for you" card for approvals, and a connection footer (Claude, mail).
- Motion: short, quiet entrance and state transitions (respect "reduce motion").
- Quality bar: keyboard navigable, labelled controls, WCAG AA contrast in both themes, crisp
  at 100-200% scaling, consistent 4/8 px spacing. A design-token file (colours, type, radius,
  spacing) drives every screen.
- Reference mockups: `.superpowers/brainstorm/.../premium-home-v3.html` and `brand.html` (local, not committed).

### Brand system (single source of truth)

- `packages/brand/tokens/`: W3C Design Tokens (DTCG) JSON in three layers. Primitives (colour
  ramps, font families, type scale, 4 px spacing, radius, shadow, motion), semantic tokens per
  theme (bg, surface, border, text, text-muted, accent, success, danger, info, focus), and
  component tokens (button, pill, badge, card, KPI, nav item, input).
- Style Dictionary v4 builds `tokens.css` (custom properties under `[data-theme=graphite|paper]`)
  and typed `tokens.ts`.
- Shared components consume tokens only: Button (primary, accent, secondary, ghost, danger;
  sm and md; disabled and loading; icon slot), Pill, Badge, Card, KpiCard, NavItem, Icon,
  Input, Kbd, Avatar. Type is used through roles (display, h1, h2, body, label, numeric),
  never raw font names.
- Alignment rules: icons come from one line set (Lucide, ISC licence) in a fixed 18 px box;
  numbers use tabular lining figures; KPI values and sparklines share a baseline; long titles
  truncate with an ellipsis and a tooltip.
- Fonts are bundled through @fontsource packages (OFL). Logo mark, wordmark and app-icon source
  live in `packages/brand/assets`.
- Enforcement: a test fails CI if renderer code contains hex colours, `rgb(` or `font-family`
  outside `packages/brand`. A brand guide page renders every token and component in both
  themes, with a Playwright visual snapshot.

## 8. Core changes needed (in `@careeros/core`)

1. Schema: `workspace.privacy.locked`; new kinds `approval` and `access_request`; migration 1
   adds the defaults to existing workspaces.
2. `claudeSettings(locked)` takes the lock list and adds the Bash deny patterns.
3. CLI: refuse `--jd-file` inside locked folders.
4. Incremental index refresh API (`refreshIndex(root, changedPaths)`), used by the watcher.
5. `fieldsFor` handles arrays of objects and arrays of enums (deferred from sub-project 1).
6. Permission calls are safe on Windows (chmod is a no-op there; ACLs come in sub-project 4).
7. Inbox suggestion rules: `suggestInboxTarget(root, name)`.

## 9. Testing

- Unit tests for main-process services and IPC argument validation (vitest).
- Component tests for screens with React Testing Library, using the fictional sample
  workspace.
- End-to-end smoke tests with Playwright for Electron on CI (Linux under xvfb, and macOS):
  onboarding on a temp workspace, filter jobs, open a job, file an inbox item, toggle a lock.
- Security tests: the renderer cannot reach Node; `careeros-file:` refuses paths outside the
  workspace and inside locked folders; external links require https; IPC rejects bad input.

## 10. Out of scope for 3a

Mail setup, sync, timeline and viewer (3b). In-app Claude chat, "Use my Claude Code login
(experimental)", API-key chat, voice picker (3c). Generating videos (5). Installers, code
signing, auto-update, Windows ACLs and Windows CI (4). Builds in 3a are unsigned development
builds.

## 11. Risks

- Electron app size (about 100 MB): accepted for a desktop app installed once.
- File watching on large workspaces: debounce and refresh only changed folders.
- Bash deny patterns can never be complete; locked folders also get OS permissions (POSIX) and
  ACLs (sub-project 4). Allow-once is time-boxed and logged.
