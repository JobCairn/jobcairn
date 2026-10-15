# CareerOS (sub-project 5): video generation

- Status: draft for review
- Date: 2026-10-08
- Builds on: `docs/specs/2026-10-08-app-shell-design.md` (3a: bridge, services, Learn screen,
  allow-once, Electron shell), `docs/specs/2026-10-08-claude-chat-voice-design.md` (3c: modes,
  runs, tools, voice engines), the plugin skills `video-explainer`, `video-slides`,
  `video-captions` and `voice`, and the templates in `plugin/templates/video/`
- Plan it extends: `docs/superpowers/plans/2026-10-08-app-shell.md` (Tasks 14, 29, 32, 34)
- Depends on: sub-project 4 (installer and doctor) for guided ffmpeg and Chrome installs

## 1. Goal

One click makes a short, narrated, captioned video from the candidate's own workspace: a
lesson on a skill gap, a walkthrough of a job ad, a company briefing, interview practice, a
"tell me about yourself" pitch, a summary of an application before it goes out, or a weekly
recap. Claude writes a small scene spec; CareerOS renders it on the laptop. Every fact in a
video traces to a workspace file. Nothing renders in the cloud.

Success:
- From the Acme Corp job, "Make video > Interview prep" produces a 3 minute practice video
  with think-time pauses, captions and the candidate's chosen voice, without a terminal.
- The candidate reads and edits the script before anything renders, and sees each stage
  (writing, checking facts, narrating, captioning, rendering) with a progress bar and Cancel.
- A company briefing that states a fact with no cited source fails the fact check and says
  which line to fix. Nothing invented reaches the render.
- A new video type is added by dropping one JSON file in the registry, with no code change.
- On a laptop without ffmpeg, the Make video button explains what is missing and offers the
  guided install.

## 2. Decisions (owner, 2026-10-08)

| Topic | Decision |
|-------|----------|
| Flow | request -> Claude (any mode) writes the script and scene spec with `video-explainer` or `video-slides` -> fact check -> candidate reviews and edits the script -> narration with the chosen voice -> local captions (`video-captions`) -> local render from the bundled HTML templates -> output saved and shown in Learn. |
| Types | Seven built-in types, each a one-click action from its screen, each with its own spec template, sources and length target (section 3.2). |
| Registry | Video types are schema-validated JSON data. New types are data, not code. |
| Facts | Every fact traces to a workspace file. Company facts cite saved research with URLs. Candidate facts come from `me/history` and `settings/profile.json`. Locked folders only through 3a allow-once. |
| Render | Local only. Default renderer: the pinned HyperFrames CLI `render` (headless Chrome plus ffmpeg), as the skills already use. Fallback renderer behind the same interface: Electron offscreen capture plus ffmpeg (see open questions). No cloud, Lambda or Cloud Run paths, ever. |
| Edit | Script and on-screen text are editable before render. Re-render after edits. Narration is reused when the script did not change. |
| Media | The `media` skill (planned in `docs/dependencies.md`): openly licensed media only (CC0, CC-BY, named free-commercial licences), attribution recorded in a ledger and shown on a credits card. Keyless sources only by default. |
| Captions | Burned-in rail by default, SRT and VTT saved beside the video. |
| ffmpeg | Checked before every run. If missing, a clear in-app message and a guided install through the doctor and installer (sub-project 4). |
| Chat | 3c chat can start any registered type (`start_video`). |

## 3. Architecture

```
packages/video/                 new, shell-neutral Node package
  src/registry.ts               load + validate video types (built-in and workspace)
  src/sources.ts                source resolvers: build a source pack per request
  src/factcheck.ts              deterministic checks of spec facts against sources
  src/expander.ts               spec.json -> HyperFrames composition (contract in scene-spec.md)
  src/pipeline.ts               stages, progress, cancel, cache by content hash
  src/render/hyperframes.ts     Renderer: `hf lint|check|snapshot|render`, pinned
  src/render/electron.ts        Renderer: offscreen capture -> ffmpeg (host-provided)
  src/captions.ts               `hf transcribe`, script alignment, SRT/VTT export
  src/tools-check.ts            ffmpeg, ffprobe, Chrome, Node, Supertonic, whisper model
plugin/video-types/*.json       the seven built-in types (shipped with the plugin)
plugin/skills/media/            the free-media skill (resolve, ledger, licence filter)
packages/core/                  schemas video-type, video-request, video-run; layout for
                                companies/<slug>/research/ and recaps/; index table `videos`
```

### 3.1 Video-type registry

Each type is one JSON file validated by `video-type.schema.json`. Built-in types live in
`plugin/video-types/`; a workspace can add its own in `settings/video-types/` (validated the
same way; a bad file is listed in Settings and skipped). Fields:

| Field | Meaning |
|-------|---------|
| `id`, `label`, `description`, `version` | Identity. |
| `entry_points[]` | Screens and buttons: `job`, `job.gaps`, `job.interview`, `company`, `apply.review`, `learn.topic`, `home`, `chat`. |
| `subject` | What it is about: `job`, `company`, `topic`, `week`. |
| `writer` | `claude` (skill writes script and spec) or `template` (the app fills a fixed script from data; no Claude call). |
| `skill` | `video-explainer` or `video-slides`. |
| `voice_type` | `guide`, `interview` or `slides` (picks the per-type voice from settings). |
| `length` | `{ min_s, target_s, max_s }`. |
| `scene_types[]` | Allowed catalog types (subset of `scene-spec.md`). |
| `sources` | Resolvers and globs, each `required` or `optional`, for example `job.jd`, `job.score`, `history`, `company.research`, `index.stats`, `application.files`. Locked folders are not allowed here. |
| `brief_template`, `rules[]` | Brief line and type-specific writing rules passed to the skill. |
| `facts` | `strict` (every claim cites a source) or `teaching` (general technical content allowed; candidate and company claims still cite). |
| `extras` | Extra files to write, for example `notes.md`, `pitch.md`. |
| `output` | Folder template, for example `companies/{slug}/jobs/{id}/videos/{type}-{n}/`. |
| `media` | `none`, `offline` (bundled only) or `free` (keyless online sources allowed). |

### 3.2 The seven built-in types

| Type | One click from | Skill | Sources (required in bold) | Length target | Output folder |
|------|----------------|-------|----------------------------|---------------|---------------|
| `skill-gap-lesson` | Job > Gaps (each gap), Learn > topic | explainer | **gap name**, `jd.md`, `score.md`, `learning/<topic>/guide.md` | 60-120 s | `learning/<topic>/videos/<n>/` |
| `jd-walkthrough` | Job | slides | **`jd.md`**, **`job.json` must-haves and nice-to-haves**, `score.md`, `me/history` | 60-90 s | `companies/<slug>/jobs/<id>/videos/jd-walkthrough-<n>/` |
| `company-briefing` | Company, Job | slides | **`companies/<slug>/research/*.md` with URLs**, `company.json` (sponsor evidence), `jd.md` | 60-90 s | `companies/<slug>/videos/briefing-<n>/` |
| `interview-prep` | Job > Interview | explainer (`quiz` scenes) | **`jd.md`**, **`me/history`**, `score.md`, research, `interview/questions.md` | 2-5 min (3 to 6 questions) | `companies/<slug>/jobs/<id>/interview/<n>/` |
| `pitch` | Job, Job > Interview | slides | **`me/history`**, **`jd.md`**, `settings/profile.json` targets | 60-90 s | `companies/<slug>/jobs/<id>/interview/pitch-<n>/` |
| `application-summary` | Apply > review | slides | **`application/*`**, **`jd.md`**, `score.md` | 45-60 s | `companies/<slug>/jobs/<id>/application/summary-video/` |
| `weekly-recap` | Home | slides, `writer: template` | **index stats** (written to `stats.json` in the folder), timelines | 45-60 s | `recaps/<YYYY>-W<ww>/` |

Type notes:
- **Skill-gap lesson** teaches the skill plainly; facts mode `teaching`. Ends with "practise
  next". Links back to every job with that gap.
- **JD walkthrough** says what the role really asks: must-haves vs nice-to-haves, how the
  candidate's evidence maps (a `comparison` scene), and gaps named as gaps.
- **Company briefing** covers what they do, products, tech stack, recent news, sponsorship
  evidence and culture. `strict` facts: each claim cites a research file and the URL inside
  it. With no research saved, the button offers "Research this company first" (3c action).
- **Interview prep** has likely questions with STAR (behavioural) or Clarify, Approach,
  Trade-off, Result (technical) outlines from the candidate's history. Practice mode inserts
  `[pause N]` think time and a "your turn" card; a "watch mode" variant has no pauses.
- **Pitch** writes a 60 to 90 second "tell me about yourself" for this job, from history
  only, and saves `pitch.md` so the candidate can practise without the video.
- **Application summary** shows what is being sent and why it fits. It may only use what is
  in the application files and the ad. Shown on the Apply review step before approval.
- **Weekly recap** is built from the index with a fixed template (found, applied, replies,
  interviews, sponsorship mix, next steps). No Claude call, so it is free and fast. Numbers
  come from `stats.json`, which is the cited source.

### 3.3 Traceability and the fact check

- Scene spec v2 (additive to `scene-spec.md`): each scene and item may carry
  `sources: [{ file, quote?, url? }]`. Claude also writes `sources.md`, a readable list.
- Before review, `factcheck.ts` runs and blocks on errors:
  1. Every cited file exists, is inside the workspace, is in the type's source list, and is
     not in a locked folder unless a grant is active.
  2. Every `stat` value appears in its cited file (number match after normalising).
  3. In `strict` types, every scene has at least one source; company facts cite a URL that
     appears in the cited research file.
  4. Candidate facts (titles, employers, dates, numbers) cite `me/history` or the profile.
  5. Quotes, when given, appear verbatim in the file.
- Results show per scene: "Scene 3: 'Acme Corp runs on Go' has no source. Add a source or
  remove the line." The skill rules (no fabrication, plain sentences, no em-dashes) also go
  into the prompt.
- Locked facts: if a type needs one (for example work rights in a pitch), Claude calls 3c's
  `request_access`; the run waits for allow-once. The fact is used, the video records "used a
  locked fact (granted <time>)" in `video.json`, and the locked file itself is never copied.

### 3.4 Pipeline

| Stage | What happens | Where |
|-------|--------------|-------|
| 1 Request | Type, subject, options (length, practice mode). Saved as `request.json`. | app |
| 2 Sources | Resolvers build a source pack (file list plus short extracts). Missing required sources stop here with a fix button. | `sources.ts` |
| 3 Write | Mode 2 or 3: a 3c run with the skill and the source pack writes `script.txt`, `spec.json`, extras, through `propose_files` into the video folder (auto-approved only for that new folder, see 5). Mode 1: hand-off prompt; the app watches the folder. `template` types skip Claude. | 3c |
| 4 Check | Schema, catalog limits, cue order, fact check. | `factcheck.ts` |
| 5 Review | Script editor: script per scene, on-screen text fields, sources per scene, estimated length. "Ask Claude to revise" with a note. Approve script. | app |
| 6 Narrate | Voice engine from 3c (narrate.py), per-type voice. Cached by hash of script plus voice. | `packages/voice` |
| 7 Captions | `hf transcribe` locally; words aligned to the script so misheard terms take the script spelling with the original timings; re-sync. SRT and VTT written. | `captions.ts` |
| 8 Media | `media resolve` for any media slots, offline first, licence filter, ledger. | media skill |
| 9 Expand | Expander contract from `scene-spec.md`: composition folder, resolved timeline printed. | `expander.ts` |
| 10 Lint | `hf lint`, `hf check`, `hf snapshot` contact sheet shown in the app. | renderer |
| 11 Draft | `hf render --quality draft`. Preview in the app. | renderer |
| 12 Final | Final render, ffprobe check (duration, streams), credits card if needed. | renderer |
| 13 Save | `video.json` record, index row, Learn listing, job timeline "Video made". | core |

- Progress: each stage reports a percentage (render frames from renderer output). The run
  view lists stages with ticks, elapsed time and the current step.
- Cancel: kills the process tree, deletes `work/` temp files, keeps the reviewed script.
- Re-render: after edits, only stages whose input hash changed run again.
- One render at a time; others queue. Disk check before render (2 GB free required).

### 3.5 Interfaces extended

| Interface | 5 change |
|-----------|----------|
| `CareerosBridge` | `video.types(screen)`, `video.tools()` (what is installed), `video.start(type, subject, options)`, `video.run(runId)`, `video.cancel(runId)`, `video.draft(folder)`, `video.saveScript(folder, edits)`, `video.approveScript(folder)`, `video.render(folder, quality)`, `video.list(filter)`, `video.delete(folder)`, `video.exportCaptions(folder, format)`. Folder refs validated like `files.readText`. |
| `Transport.onEvent` (3c) | Video runs use the same `RunEvent` stream (`kind: "stage"`). |
| `CHANGE_AREAS` | Adds `video`. Learn already listens to `learn`. |
| 3c tools | `list_video_types`, `start_video`. |
| 3a `LearnData` | Gains `videos[]` with type, subject, length, status, and `recaps[]`. |
| Services `Host` | `ShellHost.spawn` (3c) for `hf`, ffmpeg, narrate.py; `Host.offscreenCapture` (Electron renderer only); `Host.doctor.run(componentId)` (sub-project 4). |
| Electron (Task 34) | Offscreen render window in its own session partition with all network blocked except the `careeros-render:` protocol that serves the composition folder. `careeros-file:` already streams video with Range headers. |
| Core | Layout: `companies/<slug>/research/`, `companies/<slug>/videos/`, `.../jobs/<id>/videos/`, `recaps/`. Kinds: `video` (`video.json`), `video_request`. Index table `videos`. Migration adds folders lazily. |

## 4. Screens

| Screen or part | What it does |
|----------------|--------------|
| Make video button | On Job, Job > Gaps, Job > Interview, Company, Apply > review, Learn topic, Home. Shows the types registered for that screen. Disabled with a reason when a required tool or source is missing. |
| Make video dialog | Type, subject (pre-filled), length, practice or watch mode (interview), voice (shows the current choice, link to Settings > Voice). Shows the sources it will use, with locked ones marked. Start. |
| Video run | Stage list with progress, Cancel, and the current log line in plain words. |
| Script review | Scene list on the left; script and on-screen text on the right; sources per scene with fact-check results; estimated duration; "Ask Claude to revise"; Approve script. |
| Preview | Draft video player, contact sheet, "Looks good, make final", "Edit script", "Change voice". |
| Learn | Sections Topics, Jobs, Companies, Recaps. Each video with type badge, length, date, captions on or off, Re-render, Reveal, Delete. Credits and sources one click away. |
| Settings > Video | Default lengths, captions style (`rail`, `pill`, `highlight`, `none`), free online media on or off, custom video types list with validation errors, tools status (ffmpeg, Chrome, Supertonic, transcription model) with Install buttons. |
| Tools missing card | "Videos need ffmpeg to join audio and pictures. CareerOS can install it for you." Install (runs the doctor component with the candidate's OK), Learn more, Check again. |

## 5. Security and privacy

| Threat | Mitigation |
|--------|-----------|
| Script injection into the composition | Claude writes JSON only. The expander escapes every string into text nodes and attributes from a fixed template set. Custom types are data and cannot add templates or code. |
| Render reaching the network | HyperFrames runs with telemetry off and only `lint`, `check`, `snapshot`, `render`, `transcribe`. Compositions reference only local files plus the vendored GSAP. The Electron renderer blocks all network in its session. Banned `hf` commands are refused by the wrapper. |
| Invented facts | Fact check blocks the review step; strict types need cited sources; candidate review before render. |
| Locked data in videos | Locked folders are never sources; facts only through allow-once, logged in `video.json`. Videos stay in the workspace. Export or Reveal of a video that used a locked fact shows a reminder. |
| Writes by Claude | The video folder is created by the app for this run. Claude's `propose_files` into that folder only is accepted without a separate approval card, because the candidate reviews the script next and nothing else changes. Any write outside it is a normal approval. |
| Media licence problems | Licence filter in code (reject NC and ND), ledger per asset, credits card, keyless sources only by default, downloads by main with fixed hosts and size caps. |
| Untrusted input (JD text steering the video) | Source extracts are wrapped as untrusted. The worst case is a wrong local video, caught at review. |
| Resource exhaustion | One render at a time, disk check, frame and length caps from the type, lower process priority for render. |
| Malicious custom type | Schema validation, no paths outside the workspace in `output`, no locked folders in `sources`. |

## 6. Cross-platform notes

- ffmpeg: macOS via Homebrew, Windows via winget, Linux via the distro package manager, all
  driven by the sub-project 4 installer component `ffmpeg`. The app checks `ffmpeg -version`
  and `ffprobe` (6 or newer) before each run.
- Chrome: HyperFrames needs a Chrome or Chromium. The installer component `chrome` covers
  it. If missing, the Electron offscreen renderer is the fallback.
- GPU: `--gpu` and `HF_CAPTURE_PARALLEL_STREAM=true` on macOS only; software encode
  elsewhere. Render time estimates per OS shown in the dialog.
- Windows: short folder names (output templates use `<n>` not titles) to stay under
  `MAX_PATH`; process-tree kill with `taskkill /T`; `npx` resolved as `npx.cmd`.
- Transcription model files download once and are cached in the CareerOS data folder.
- Fonts used by the templates are vendored, so videos look the same on every OS.
- HyperFrames on Windows and Linux has had less testing than macOS (see risks).

## 7. Testing

- Registry: every built-in type validates; bad custom types are reported, not loaded.
- Sources: resolvers on the fictional sample workspace (Alex Example, Acme Corp, Example
  Labs); missing required source; locked folder refused.
- Fact check: fixture specs with good and bad citations, stat mismatches, missing URLs.
- Expander: golden tests (spec to HTML snapshot) for every catalog type; output passes
  `hf lint` with 0 errors; missing cue and over-limit fields fail with the scene index.
- Captions: alignment fixes a misheard term and keeps timings; SRT and VTT golden files.
- Pipeline: a fake renderer and fake voice cover progress events, cancel at each stage,
  hash cache on re-render, queueing, disk-full message.
- Weekly recap template: numbers match the index of the sample workspace.
- Real render smoke test on CI (macOS and Linux, ffmpeg installed): a 5 second two-scene spec
  renders, ffprobe confirms duration and streams. Windows joins with sub-project 4's CI.
- Components and e2e: Make video from Job, script edit and approve, tools-missing card, Learn
  lists the new video, chat `start_video` opens the dialog.
- Security: banned `hf` commands refused; the offscreen session makes no network request.

## 8. Out of scope

- Cloud rendering, HeyGen, avatars, talking heads, any keyed media source by default.
- Video editing beyond script and on-screen text (no timeline editor, no trimming).
- Recording the candidate's camera. Captioning their own recording stays in the
  `video-captions` skill (desktop mode) for now.
- Portrait and square formats (v1 is 1920x1080).
- Sharing or uploading videos anywhere.
- Manim scenes (optional engine, not installed by default).

## 9. Risks

- Render time on older laptops. Mitigation: draft quality first, length caps, queue.
- HyperFrames is pinned at a pre-1.0 version; upgrades can change output. Mitigation: pin,
  golden tests, and the Electron fallback behind the same interface.
- Local transcription mishears technical terms. Mitigation: script alignment, then the
  candidate sees captions in the draft.
- Claude may write specs that fail the fact check often. Mitigation: return the exact errors
  to Claude for one automatic revision before the candidate sees them.
- GSAP licence terms must allow our commercial use (flagged in `docs/dependencies.md`).

## 10. Open questions

1. **Electron offscreen fallback in v1?** Recommended default: build the `Renderer` interface
   now, ship HyperFrames only, and add the Electron renderer when Windows or Linux testing
   shows HyperFrames problems.
2. **Bundle ffmpeg with the app?** Recommended default: no. The installer installs it through
   the OS package manager. This avoids shipping GPL or LGPL binaries and keeps the app small.
3. **GSAP licence for commercial use.** Recommended default: confirm the current GSAP licence
   text before sub-project 5 starts; if it does not fit, swap the motion layer in the vendored
   components before release.

**Resolution (2026-10-08):** the recommended default for each open question above is adopted so the build can proceed. The owner can change any of them later.
