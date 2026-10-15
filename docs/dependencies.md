# JobCairn dependencies

Single list of every external tool, model and code source JobCairn uses. The installer
(sub-project 4) installs and health-checks everything marked **Required**. When a new tool is
adopted, add it here in the same change.

## Rules

0. **One-click setup.** Every dependency is one file in `setup/components/<id>.json`
   (id, name, order, required, why, docs, per-OS `check` + `install`) plus a row in this file
   that mentions its id in backticks. `./setup.sh` (or double-click `Setup JobCairn.command`)
   installs what is missing and skips the rest; `./setup.sh doctor` only checks. A test fails if a
   component is missing from this file. The downloaded app installs the same components itself (no
   Terminal): the Setup cards offer `claude-code`, `node`, `python` and `ffmpeg`, and the Videos tools card
   offers its own, each after a native confirm that shows the exact command, one at a time. The runner and
   components ship in the app as `Resources/careeros-setup`. The app never asks for or handles a password:
   if Homebrew is missing it shows Homebrew's one-line installer to copy into Terminal, and when an install
   fails it says why in plain words (permission, network or proxy, too slow, disk full: services
   `install-error.ts`) and shows the exact commands to run in Terminal instead, with the sudo and no-password
   fixes for permission problems. Homebrew runs with `HOMEBREW_NO_AUTO_UPDATE`, `HOMEBREW_NO_ENV_HINTS`,
   `HOMEBREW_NO_INSTALL_CLEANUP` and `HOMEBREW_NO_ANALYTICS` set (setup.sh, run.mjs and the app). Component ids: `node`, `claude-code`, `chrome`, `ffmpeg`,
   `python`, `supertonic`, `hyperframes`, `whisper`, `agent-browser`, `workspace`.
1. **Local and key-free.** Phase 1 runs on the candidate's laptop. The only account needed is the
   candidate's own Claude plan. Anything needing a third-party key or cloud account is
   **Optional** and off by default.
2. **Our own skills, not skill bundles.** JobCairn ships one plugin with a small set of focused
   skills. We do not install third-party skill or plugin bundles into candidates' Claude Code,
   because every loaded skill costs tokens in every session. When an open-source skill has
   useful guidance, we copy only the parts we need, rewrite them into our skill, and credit the
   source in `NOTICE.md` (license permitting: check before copying).
3. **Command-line tools are fine as dependencies.** Engines such as a renderer or a TTS model are
   installed as pinned CLIs or packages and called by our skills and scripts.
4. **No cloud paths.** Never use HeyGen sign-in, HeyGen API keys, avatar generation, or cloud /
   Lambda / Cloud Run rendering.
5. **npm packages are pinned exactly** and installed by `npm ci` (covered by the `node` component).
   They need no `setup/components/` file, but every one gets a row in "App packages" below with its
   licence.

## System

| Tool | Version | Status | Install (macOS) | Used for |
|------|---------|--------|-----------------|----------|
| Claude Code | latest | Required | Anthropic's native installer, `curl -fsSL https://claude.ai/install.sh \| bash` (into `~/.local/bin`, no password; checked against code.claude.com/docs/en/setup on 2026-10-12); candidate signs in with their Claude plan | the AI worker for every skill |
| Node.js | 22+ (development: 22.13+) | Required | `brew install node` | UI app, careeros-core CLI, HyperFrames renderer, the browser helper's npm install |
| Google Chrome | current | Required | chrome.com | agent-browser sessions, headless video render |
| ffmpeg / ffprobe | 6+ | Required | `brew install ffmpeg` | video assembly, audio normalise, probing |
| Python | 3.11 to 3.14 | Required | `brew install python@3.12` (it installs `python3.12`, not `python3`; the app and the components look for `python3.14` … `python3.11` too) | Supertonic voice, email helper scripts. Upper bound: onnxruntime 1.31.0 has macOS wheels for cp311-cp314 only (PyPI, 2026-10-11), so Homebrew's default `python` (3.15) can't run the voice yet |
| osascript | built into macOS | Built in (nothing to install) | none | asks Google Chrome over Apple Events to open its remote-control page (Search in my Chrome step 3); macOS asks the person once (NSAppleEventsUsageDescription). Falls back to Chrome's own binary when refused |
| Xcode Command Line Tools | current | Release builds only (not for users) | `xcode-select --install` | `codesign`, `spctl`, `xcrun notarytool` / `stapler` for signing, notarising and `npm run release:verify` (see `docs/packaging.md`) |

How the app finds these tools: an app opened from Finder gets a PATH that starts with `/usr/bin`, where macOS
keeps Python 3.9. `packages/services/src/toolchain.ts` puts `/opt/homebrew/bin`, `/opt/homebrew/sbin` and
`/usr/local/bin` (those that exist) first and picks the first `node` and `python3` that are new enough, not just
the first found; npm comes from the picked node's folder. `/usr/bin/python3` is never run to read its version
(without the developer tools it opens an install dialog).

## Engines (called by JobCairn skills and scripts)

| Engine | Version | Status | License | Install | Used for |
|--------|---------|--------|---------|---------|----------|
| HyperFrames CLI (`hyperframes` on npm) | pinned, currently 0.8.140 | Required | Apache-2.0 | `npm install -g hyperframes@0.8.140` (setup component `hyperframes`; the app never runs `npx`) | Render HTML compositions to MP4 locally (`render` only, never `cloud`/`lambda`/`cloudrun`) |
| Supertonic 3 (`supertonic` on PyPI, model `Supertone/supertonic-3`) | pinned, currently 1.3.1 | Required | OpenRAIL-M (model) | `pip install supertonic==1.3.1` in a JobCairn venv (never `--upgrade`); the model downloads once from Hugging Face during setup or from Settings > Voice, then runs offline via ONNX Runtime. Videos run narration with `--no-download` and `HF_HUB_OFFLINE=1` | Narration for learning and interview videos. 31 languages, 10 preset voices (F1-F5, M1-M5), expression tags (`<laugh>`, `<breath>`, `<sigh>`) for natural, engaging delivery |
| Whisper captions model (`ggml-small.en.bin`, used by `hyperframes transcribe`) | small.en | Required for videos | MIT (whisper.cpp model) | Setup component `whisper`: one explicit download into `~/.cache/hyperframes/whisper/models/`. Videos check it is there and never fetch it mid-run | Times captions to the narration |
| macOS `say` | built in | Fallback | n/a | none | Voice when Supertonic is unavailable |
| Manim CE | pinned when adopted | Optional (off) | MIT | not installed by default | Only for true math/graph animation scenes, rendered to a transparent clip and placed in a HyperFrames video |
| agent-browser CLI ("browser helper" in the UI) | pinned, currently 0.38.2 (min 0.38.0) | Required for Search in my Chrome | Apache-2.0 (npm registry, 2026-10-10) | Settings > Connections > Search in my Chrome > "Install browser helper" (about 118 MB: registry `dist.unpackedSize` 117,855,861 bytes, no dependencies; "Remove helper" deletes the folder): `npm install --prefix <app data>/chrome-search/browser-helper agent-browser@0.38.2` (array args, no shell, clean env, one at a time; a permission failure, usually a root-owned `~/.npm`, retries once with a cache in that folder); setup script: `npm install -g agent-browser@0.38.2` (same pin; if npm's global folder isn't writable it prints the sudo and no-password fixes, then installs into `~/.npm-global`, where the app also looks) | Search in my Chrome (lane S): find-jobs runs read the candidate's ticked job boards in their own Chrome through one named session (`careeros`), our own empty `--config`, typed MCP browser tools only |

Supertonic license duty: OpenRAIL-M allows commercial use, but its use-based restrictions
(Attachment A of the model license) must be included in JobCairn's own terms of use (still open: sub-project 6,
website and terms). The full license text is in `licenses/OpenRAIL-M-Supertonic3.txt` (from the model's Hugging Face
repo, revision 3cadd1e, fetched 2026-10-12), and `licenses/` ships in the app as `Resources/licenses`.

## Video package (npm, exact pins)

| Package | Version | Licence | Used for |
|---------|---------|---------|----------|
| Montserrat and JetBrains Mono fonts (files, not npm deps) | Fontsource variable 5.3.0 builds, latin and latin-ext subsets | SIL OFL 1.1 (`licenses/OFL-Montserrat.txt`, `licenses/OFL-JetBrainsMono.txt`) | the video theme's fonts, shipped in `plugin/templates/video/assets/fonts/` and copied into each composition with inline `@font-face` rules, so `hyperframes check` and `render` never download them from Google Fonts (they did on first use before) |
| gsap | 3.14.2 | GSAP Standard "No Charge" License (`licenses/GSAP-Standard-License.txt`) | motion inside rendered videos; copied into each composition as `vendor/gsap/dist/gsap.min.js` (sub-project 5) |
| Asset packs (data files, not npm deps) | lucide 1.53.0, Simple Icons 16.34.0 | ISC; CC0-1.0 (MIT / Apache-2.0 per icon where set) | `packages/video/packs/{icons,logos,architecture}.json`: icons, technology logos and architecture node kinds for the visual scenes, built once by `packages/video/scripts/build-packs.mjs` (Simple Icons is unpacked from its npm tarball at dev time, never installed or fetched at runtime) |
| Diagram layout | own code (`packages/video/src/layout.ts`) | proprietary (JobCairn) | layered and ring layouts for diagram scenes; no layout engine was in node_modules and diagrams have at most 8 nodes, so no dependency was added |
| Sound effects and music bed | made by ffmpeg from recipes (`packages/video/src/sound.ts`) | CC0 (our own) | quiet effects on scene changes and reveals, an optional bed ducked under the voice, loudness set to -16 LUFS in two passes; ffmpeg is already a required tool |

## Video approach (decided 2026-10-08, see research notes in the video skills)

- The JobCairn app runs this pipeline itself (`packages/video`, sub-project 5): seven video types from
  `plugin/video-types/`, script review before narration, draft then final render, all local. It calls
  HyperFrames 0.8.140 (Apache-2.0) through `transcribe`, `lint`, `check`, `snapshot` and `render` only,
  and vendors GSAP 3.14.2 (GSAP Standard "No Charge" License) into each composition. Claude writes
  the script through the app's Claude engine (Claude Code, with Claude Desktop as the fallback); the
  weekly recap is built from the candidate's own numbers with no Claude call.
- Claude writes a short JSON scene spec (about 15-30 lines per minute); a JobCairn script expands it
  into HyperFrames HTML from a fixed set of about 12 components with one theme. Claude does not
  write raw HTML. Timing comes from the narration audio via local `hyperframes transcribe`.
- HyperFrames setup: pinned CLI, `hyperframes telemetry disable`, macOS renders with
  `HF_CAPTURE_PARALLEL_STREAM=true` and `--gpu`. Offline rendering needs the HyperFrames runtime and
  GSAP vendored (installer task). Check GSAP's license terms for commercial use.
- Not used: Remotion (company license needed at 4+ people; its skills have no license), Motion
  Canvas (no headless render CLI), Revideo (stagnant), Lottie (hard for an LLM to write).

## Free media in videos (decided 2026-10-08)

A JobCairn `media` skill with one command, modelled on HyperFrames `media-use` (Apache-2.0):
`media resolve --type image|icon|illustration|bgm|sfx --intent "..." --project <dir>` returns one line
(`resolved <id> -> <path>`); search noise stays on disk.

- Cache first: exact intent match in the project ledger, then the global cache, then a source search.
  Files are downloaded once into `learning/<topic>/media/<type>/` and play offline after that.
- Ledger `media/manifest.jsonl`, one record per asset: id, type, path, source, source_url, author,
  license, license_url, attribution_required, retrieved_date, intent. Render adds a credits card for
  every `attribution_required` asset.
- License filter in code: allow CC0, CC-BY, and named free-commercial licenses (Pixabay, unDraw);
  reject anything NC or ND.

| Source | Key | Status |
|--------|-----|--------|
| Openverse (images, audio) | none | Default |
| Wikimedia Commons | none | Default |
| Lucide / Heroicons icons (vendored npm) | none | Default, offline |
| unDraw illustrations (curated, pre-downloaded) | none | Default, offline |
| Bundled CC0 SFX and music bed (generated by ffmpeg from recipes, 2026-10-11) with credits.md | none | Default, offline |
| Pexels, Pixabay, Freesound | candidate's own key in workspace `.env` | Optional, off |
| Unsplash (API requires hotlinking), Mixkit (no API, no redistribution) | n/a | Never automated |

## Skills JobCairn writes itself (in the JobCairn plugin, sub-project 2 and 5)

| JobCairn skill | Adapted from (credit in NOTICE.md) | Notes | Status |
|----------------|------------------------------------|-------|--------|
| `career` scoring and tailoring | founder's own career skill, scrubbed and genericized | resume, cover letter, job scoring | Exists in `plugin/` |
| `video-explainer` | HyperFrames `faceless-explainer`, `hyperframes-core`, `hyperframes-cli` (Apache-2.0) | JD gap and topic explainers, local render only | Exists in `plugin/` |
| `video-slides` | HyperFrames `slideshow` (Apache-2.0) | interview-prep decks with presenter notes | Exists in `plugin/` |
| `video-captions` | HyperFrames `embedded-captions` (Apache-2.0) | burned-in captions | Exists in `plugin/` |
| `voice` | Supertonic SDK docs | narration with Supertonic 3 (pick voice per lesson, add expression tags where a human would pause, breathe or smile), fallback `say` | Exists in `plugin/` |
| `humanize` | `blader/humanizer` (MIT) | plain-English pass that never adds facts | Planned, not yet in `plugin/` |
| `media` | HyperFrames `media-use` (Apache-2.0) | resolve free, commercial-safe media with license ledger and auto-credits | Planned, not yet in `plugin/` |
| `browse-jobs` | `vercel-labs/agent-browser` skill | read-only job-site browsing rules | Planned, not yet in `plugin/` |

Not copied: anything that needs HeyGen sign-in, keys, avatars or cloud rendering
(`media-use` network providers, `talking-head-recut`, `product-launch-video`, `pr-to-video`).

## JobCairn plugin

Location: `plugin/` (the Claude Code plugin manifest is `plugin/.claude-plugin/plugin.json`;
the repo marketplace that points at it is `/.claude-plugin/marketplace.json`). It currently
bundles the `career`, `video-explainer`, `video-slides`, `video-captions` and `voice` skills
listed above.

Install for development, from this repo's root:

```bash
claude plugin marketplace add <repo path>
claude plugin install careeros@careeros
```

The installer (sub-project 4) will add a setup component that does this (plus dependency
checks from this file) for candidates automatically; until then, development installs use the
two commands above.

## App packages (npm, exact pins)

| Package | Version | Licence | Used for |
|---------|---------|---------|----------|
| style-dictionary | 4.4.0 | Apache-2.0 | builds `packages/brand` DTCG tokens into CSS variables and TypeScript (dev only) |
| react, react-dom | 19.3.0 | MIT | renderer UI (`packages/brand`, `packages/app-ui`) |
| @types/react, @types/react-dom | 19.3.0 | MIT | types (dev only) |
| jsdom | 26.1.0 | MIT | DOM for component tests (dev only) |
| @testing-library/react, /dom, /user-event, /jest-dom | 16.3.3, 10.4.2, 14.6.7, 7.0.1 | MIT | component tests (dev only) |
| @fontsource/instrument-serif, @fontsource/geist, @fontsource/geist-mono, @fontsource/source-serif-4 | 5.3.0 | OFL-1.1 | bundled app fonts (no font CDN); licences in `licenses/`, credits in `NOTICE.md`, and embedded in PDF exports by `@careeros/services` (Instrument Serif and Geist Mono only for Resume Studio heading fonts; Source Serif 4 only for the "serif-text" pairing, body text in Scholar and Executive) |
| lucide-react | 1.53.0 | ISC | the app's single line-icon set (stroke 1.6) |
| Simple Icons path data (not an npm dependency) | 16.34.0 | CC0-1.0 | service marks copied in as SVG paths: job boards (`app-ui/src/source/boards.ts`: Indeed, Glassdoor, Greenhouse, Wellfound) and connections (`brand/src/icons/marks.tsx`: Gmail, Anthropic, Claude, Google Chrome). Fetched once with `npm pack simple-icons@16.34.0`. The marks are trademarks of their owners and are shown only to identify the service (About dialog says so). LinkedIn and SEEK have no Simple Icons entry and use monograms. |
| react-markdown | 10.1.0 | MIT | app-ui: renders job descriptions and study guides; raw HTML disabled |
| vite, @vitejs/plugin-react | 7.3.7, 5.2.0 | MIT | builds `packages/app-ui` (the renderer) and the brand guide (dev only; Vite 7 because Vitest 3.2 supports up to 7) |
| tsx | ^4.19.0 | MIT | runs TypeScript scripts directly: `careeros` CLI, sample-workspace generator, `@careeros/app-ui`'s fixture builder, the marketing video maker (root dev dependency) |
| @playwright/test | 1.64.0 | Apache-2.0 | brand visual snapshots, Electron end-to-end tests, and recording the marketing and guide videos (`scripts/marketing/`; dev only) |
| electron | 44.7.0 | MIT | desktop shell, dev only; Chromium and Node licences ship inside Electron's own LICENSES.chromium.html |
| esbuild | 0.28.2 | MIT | bundles the main process and preload (dev only) |
| electron-builder | 26.15.3 | MIT | packages the desktop app: mac dmg + zip, Windows NSIS, Linux AppImage (`npm run package:mac`; dev only, see `docs/packaging.md`). Ships nothing of its own inside the app |
| electron-updater | 6.8.10 | MIT | in-app updates: the installed mac app checks GitHub Releases (`latest-mac.yml`), downloads the zip in the background and installs on restart (`app-electron/src/updates.ts`). Bundled into the main process; its dependencies (builder-util-runtime, debug, fs-extra, js-yaml, lazy-val, lodash.escaperegexp, lodash.isequal, semver, tiny-typed-emitter and theirs) are MIT or ISC, except sax 1.6.1 (BlueOak-1.0.0, permissive), which reads the GitHub release feed |
| docx | 9.9.0 | MIT | services: writes the Word export with real Heading 1-3 and list styles (no tables or images); pure JS. Its `jszip` dependency is MIT or GPL-3.0; used under MIT |
| mdast-util-from-markdown | 2.1.0 | MIT | services: parses resume and letter Markdown, in a worker thread with a time limit; only headings, paragraphs, lists and rules are kept (raw HTML and images dropped) |
| @types/mdast | 4.0.4 | MIT | types (dev only) |
| fflate | 0.8.3 | MIT | tests unzip DOCX files to check headings and paragraphs (dev only) |
| imapflow | 2.2.11 | MIT | read-only Gmail sync (`EXAMINE`, `BODY.PEEK[]`, finds Sent by `\Sent`); main process only |
| nodemailer | 10.0.14 | MIT-0 | SMTP send over implicit TLS and deterministic MIME build; same version `mailparser` pins |
| mailparser | 3.9.36 | MIT | parses stored `.eml` files for the viewer, attachments and the `.md` copy; types vendored in `packages/mail/src/vendor-types.d.ts` |
| sanitize-html | 2.18.0 | MIT | allow-list HTML cleaning before an email is shown; types vendored |

Mail packages' transitive licences are checked by `packages/mail/test/licences.test.ts`.
`@zone-eu/mailsplit` is dual-licensed "(MIT OR EUPL-1.1+)"; JobCairn uses it under MIT.

## Optional services (off by default)

| Service | Needs | Used for |
|---------|-------|----------|
| ElevenLabs | candidate's API key in workspace `.env` | cloud narration |
| Adzuna API | own app id/key in workspace `.env` | job aggregation |
| Gmail (IMAP `imap.gmail.com:993`, SMTP `smtp.gmail.com:465`, implicit TLS) | the candidate's Gmail address and an App Password, stored only in the OS secure store | job mail on each job's timeline, replies and email applications after approval (Settings > Email) |

## Under evaluation

| Tool | License | Status | Plan |
|------|---------|--------|------|
| EmbeddingGemma 2, text-only 270M (`google/embeddinggemma-2`) | Apache 2.0 (ungated); Google asks users to follow the Gemma Prohibited Use Policy | Evaluating (off) | 1-day spike after sub-project 1: run in the existing Python venv, store 256-dim vectors as blobs in the SQLite index, brute-force cosine. Uses: pre-rank job ads so Claude scores only the top N, retrieve relevant master bullets for tailoring. Baseline stays SQLite FTS5/BM25. Adopt only if it beats FTS5 on real ads and runs well on Apple Silicon. Fallbacks: bge-small-en-v1.5 (MIT), Qwen3-Embedding-0.6B (Apache 2.0). |

## Third-party marks (bundled assets, not code)

Job-board logo marks (LinkedIn, SEEK, Indeed, Greenhouse, etc.) shown next to a job's source are
not a licensed dependency - they're each company's own trademark, used only to identify where a
job ad came from. Source URL, retrieval date and licensing note per mark: `docs/third-party-marks.md`.

## Dev-only (building JobCairn, not shipped)

| Tool | Used for |
|------|----------|
| `superpowers` plugin | brainstorming, plans, TDD, reviews |
| HyperFrames source (Apache-2.0, local clone) | reference when writing JobCairn video skills |
| `claude-security` plugin (Anthropic, local scope) | full security audit of the codebase, patch files only |
| `security-guidance` plugin (Anthropic, local scope) | security warnings on edits and diff review; calls only Anthropic's API with the developer's own login |
| gitleaks (MIT) | secrets scan of working tree and full git history; config `.gitleaks.toml` |
| semgrep CLI (LGPL-2.1) | static analysis (`--metrics=off`, no login); rules downloaded, code never uploaded |
| osv-scanner (Apache-2.0) | dependency vulnerability check against the OSV database |
