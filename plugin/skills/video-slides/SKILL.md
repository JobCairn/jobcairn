---
name: video-slides
description: Make a short narrated slide recap video (MP4) plus speaker notes, rendered locally. Use for a company research recap, a "role asks vs my evidence" summary, an interview-prep recap before a call, or any request for "slides", "a deck", "a slide video" or "a recap video". Not for teaching a technical topic with diagrams or code (video-explainer) or for captioning a recording (video-captions).
---

> Adapted from HyperFrames (Apache-2.0). Credits in NOTICE.md.

# Video slides

A slide recap is the video-explainer pipeline with a slide grammar: one claim per slide,
one visual per slide, steady pace, speaker notes beside it. Output is a linear MP4.

**Where files go:**
- Interview prep for a job: `companies/<slug>/jobs/<id>/interview/<recap-slug>/`
- General learning recap: `learning/<topic-slug>/`

Folder contents: `script.txt`, `notes.md`, `narration.wav`, `narration.timing.json`,
`transcript.json`, `spec.json`, the composition, `renders/draft.mp4`, `renders/final.mp4`.

`hf` = `HYPERFRAMES_NO_TELEMETRY=1 hyperframes` (pinned 0.8.140 from setup), else `HYPERFRAMES_NO_TELEMETRY=1 npx -y hyperframes@0.8.140`.

## Pipeline

Same steps as the video-explainer skill (preflight first, the 3-pass check limit, the
checkpoint, final QA and the status-first report), with these changes and a notes file:

1. **Brief:** "This recap tells <who> <one message> before <moment, e.g. the first call>."
   Use the length asked for: about 5 to 8 slides for a minute, about one more slide per 10
   seconds after that. Longer decks get more slides and, from 5 minutes, chapters
   (`"chapter": true` on each chapter's first slide). Never more words per slide.
2. **Script:** one paragraph per slide, 2 to 3 sentences. The first sentence says the slide's claim.
3. **Narrate** with `--type slides` (the user's slides voice from settings):
   `$HOME/.careeros/venv/bin/python ${CLAUDE_PLUGIN_ROOT}/skills/voice/scripts/narrate.py --workspace <ws> --type slides --text-file script.txt --out narration.wav`
4. **Transcribe:** `hf transcribe narration.wav --model base.en --language en` (or `small.en` if
   that is the model already installed). Skip it when captions are `none`.
5. **Spec** with `"voice_type": "slides"`, using only the slide types below.
6. **Expand**, or manual build from `${CLAUDE_PLUGIN_ROOT}/templates/video/slides.html`
   (see `${CLAUDE_PLUGIN_ROOT}/skills/video-explainer/references/scene-patterns.md` § Manual build).
7. **Check:** `hf lint`, `hf check`, `hf snapshot --at <each slide's middle>`, judged in a
   fresh context against the spec only.
8. **Draft render**, show the user. 9. **Final render** after approval.
10. **Notes:** write `notes.md` with one section per slide (see below).

## Slide types

| type | Slide |
|------|-------|
| `title` | Deck title as a claim, kicker, subtitle. |
| `stat` | One number with its source. Never invent a number. |
| `comparison` | "The role asks" vs "Your evidence". Gaps are named as gaps. |
| `bullet-build` | Up to 4 short points under one claim. |
| `flowchart` | A process or plan in 3 to 5 steps. |
| `recap-card` | Three takeaways and the closing line. |
| `sequence` | Who talks to whom (client, API, a person) in order. |
| `icon-grid` | The role's requirements as icons and logos ("Async Python" shows the Python logo). |
| `logo-row` | The tech stack. |
| `diagram` | How they build: architecture, user flow, pipeline or a peer mesh. |
| `match` | The role's asks against your evidence, each marked match, partial or gap. |
| `checklist` | Before-you-apply steps, or yes / partly / no. |
| `timeline` | The hiring process or a company's milestones. |
| `chart` | Numbers from the ad or research: bars, or a ring. |
| `quote` | One line copied exactly from the ad or research, attributed. |
| `company-card` | Who they are: name, location, size (the workspace logo shows when there is one). |
| `map-pin` | Where the job is. |
| `kinetic` | One line said and shown big. |
| `matrix` | Options against criteria. |

**Visual first.** A slide shows a picture and at most 12 words; the narration carries the rest. Reach for a
visual slide before a `bullet-build`: requirements become an `icon-grid`, a stack a `logo-row`, a system a
`diagram`, the asks against your evidence a `match`. Write `"version": 3`. Fields: scene-spec.md § Visual scenes;
icon, logo and node names: `${CLAUDE_PLUGIN_ROOT}/skills/video-explainer/references/asset-packs.md`.

Spec fields for each type: `${CLAUDE_PLUGIN_ROOT}/skills/video-explainer/references/scene-spec.md`.
Its "Exact shapes" block shows the JSON to copy. The three slips the app's check sees most:
- A source is `{ "file": "me/history/roles.md" }`. Use `file`, never `path`.
- A `bullet-build` or `recap-card` item is `{ "text": "...", "cue": "..." }`, never a plain string.
- A `bullet-build` has 2 to 4 items. A `recap-card` has exactly 3 items and a `closing` line.

## Slide writing rules

1. **The headline is a short claim.** "They run on Go and Kafka", not "Tech stack". Up to 8 words; a visual
   slide may leave it out when the picture says it.
2. **One idea and one visual per slide.** A second idea means a second slide.
3. **Lead with the strongest point,** on the slide and in the order of slides.
4. **Few words.** At most 12 words on screen a slide (labels under pictures, kickers and source lines aside),
   up to 9 per line. Slides are calm scenes: 4 to 8 seconds each. The headline is the slide's one primary item.
5. **Every company fact has a source** (the JD, the company site, a dated article). Put the
   source in `notes.md`. Facts about the candidate come from their own files only (`me/history`,
   `settings/profile.json`). If those files hold a "do not claim" or "cautions" list, nothing on it
   appears in any slide, script line or note, even as a hint (for example people management, a title
   or a skill level the list rules out). When unsure, leave the claim out.
6. **Reveals follow the voice.** Each item lands on its cue. Slides change with a left push;
   the last slide rises.

## notes.md shape

```markdown
# <Deck title>: speaker notes

## Slide 1 · <headline>
- Say: <one line to open with, in the candidate's words>
- If asked: <a likely follow-up and a short answer>
- Source: <URL or file, with date>
```

Keep notes short: they are prompts for the candidate, not a script to read.

## Not in v1

HyperFrames' interactive slideshow (navigable deck with presenter mode via `present`) cannot
render to a single MP4 and is not part of JobCairn v1. Do not build one.

## Rules

- Always the user's chosen voice. Never change it without asking.
- Local commands only: `transcribe`, `lint`, `check`, `snapshot`, `render`. Pictures come from the bundled packs
  and the workspace; the app adds quiet sound effects (Settings > Videos) and writes the credits into notes.md.
- No em-dashes in slides or notes. Example names use "Alex Example".
- Render, lint and fix details: `${CLAUDE_PLUGIN_ROOT}/skills/video-explainer/references/render-and-check.md`.
- **When the JobCairn app asked.** If the request says JobCairn narrates and renders, write only the
  files it names (`script.txt`, `spec.json`, `sources.md`, `notes.md` and any extras) in the folder it
  names, then stop. Don't narrate, transcribe, lint or render, and don't report progress: the app does
  those and shows its own progress. It checks your files the same way `hf lint` and the scene-spec rules
  do. If the request says sponsorship doesn't apply, leave visa sponsorship and work rights out of every file.
  Before you finish, read your `spec.json` back once and check every scene against the exact shapes in
  scene-spec.md and the limits above. There is no checker tool in this run, so this read-back is the check.
