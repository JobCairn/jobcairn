---
name: video-explainer
description: Make a short narrated explainer video that runs and renders on the candidate's laptop. Use for a JD-gap lesson (teach a skill or topic a job ad asks for), an interview-prep explainer, or an interview question drill. Triggers include "make a video/lesson/explainer on X", "teach me X as a video", "video drill for this interview question". Not for slide recaps (video-slides) or captioning an existing recording (video-captions).
---

> Adapted from HyperFrames (Apache-2.0). Credits in NOTICE.md.

# Video explainer

You write a script and a JSON scene spec. The expander turns the spec into a HyperFrames
composition with a fixed JobCairn theme. You make no layout, font or colour choices.

**Where files go** (one folder per video, inside the candidate workspace):
- Topic lesson: `learning/<topic-slug>/`
- Interview drill or explainer: `companies/<slug>/jobs/<id>/interview/<video-slug>/`

Folder contents: `script.txt`, `narration.wav`, `narration.timing.json`, `transcript.json`,
`spec.json`, the composition (`index.html`, `theme.css`, `kit.js`, `compositions/`),
`renders/draft.mp4`, `renders/final.mp4`.

`hf` below means `HYPERFRAMES_NO_TELEMETRY=1 hyperframes`, the pinned 0.8.140 that setup installs
(`npm install -g hyperframes@0.8.140`). Without setup, use `HYPERFRAMES_NO_TELEMETRY=1 npx -y hyperframes@0.8.140`.

## Pipeline

0. **Preflight**, before any writing: ffmpeg, ffprobe, Chrome, `hf --version` (0.8.140) and the
   voice venv with its model. If one is missing, stop and point to setup. Never download the
   voice model mid-run. (In the app, the tools check does this.) `references/render-and-check.md` § Preflight.
1. **Brief.** One line: "This video teaches <who> <one idea> so they can <outcome>."
   Use the length asked for (Quick about 1 min, Standard 2 to 3 min, In-depth 5 to 8 min, or a
   custom length up to 10 min). Read `references/brief-and-script.md` § Longer videos.
2. **Script** to `script.txt`. One paragraph per scene, 2.3 to 2.6 words per second.
   Count the words before you lock scene lengths.
3. **Narrate** with the user's chosen voice (see the `voice` skill):
   `$HOME/.careeros/venv/bin/python ${CLAUDE_PLUGIN_ROOT}/skills/voice/scripts/narrate.py --workspace <ws> --type guide --text-file script.txt --out narration.wav`
   Use `--type interview` for drills. If it prints a fallback warning, tell the user.
4. **Transcribe locally:** `hf transcribe narration.wav --model base.en --language en` (or
   `small.en` if that is the model already installed; never download a second one). Skip this
   step when captions are `none`: use `narration.timing.json` instead.
   Read `transcript.json`. Fix misheard technical terms to match the script. Keep timings.
   After a fix, run `hf transcribe transcript.json` once to re-sync.
5. **Spec** to `spec.json`. Schema and catalog in `references/scene-spec.md`; copy its "Exact
   shapes" block (a source is `{ "file": ... }`, never `path`; a bullet-build or recap-card item is
   `{ "text", "cue" }`, never a plain string). Write `"version": 3`: at most 12 words on screen a scene
   (§ Word cap), and pick a visual scene before a text list. Keep on-screen
   words within 3.5 per scene second, and one primary item per scene (§ Roles and reading load).
6. **Expand** the spec into the folder (expander contract in `references/scene-spec.md`).
   In the JobCairn app the expander runs for you. In Claude Code without the app, build by hand: `references/scene-patterns.md` § Manual build.
7. **Check:** `hf lint`, then `hf check`, then `hf snapshot --at <mid-point of each scene>`.
   Judge the contact sheet in a fresh context: a subagent that gets only the PNGs and the spec,
   never the HTML. At most 3 check-and-fix passes, then stop and label the open issues.
   **Checkpoint:** once the first scene checks clean, show its snapshot to the user before
   building the rest. A wrong look is cheap to fix here.
8. **Draft render:** `hf render --quality draft --output renders/draft.mp4`. Show the user.
9. **Final render** only after the user says it is good:
   `hf render --output renders/final.mp4`. Verify with ffprobe, then run the final QA:
   4 to 6 stills across the video and a caption sync check on about 10 words.
10. **Report** to the user, status line first: `PASSED` or `DELIVERED WITH N OPEN ISSUES`.
   Details for steps 7 to 10: `references/render-and-check.md`.

## Spec in brief

```json
{
  "version": 3,
  "title": "How a token bucket rate limiter works",
  "voice_type": "guide",
  "audio": "narration.wav",
  "words": "transcript.json",
  "captions": "rail",
  "scenes": [
    { "type": "title", "cue": "Ever wondered", "kicker": "JD gap · Backend", "title": "Why APIs say slow down" },
    { "type": "diagram", "kind": "pipeline", "cue": "Picture a bucket", "headline": "Tokens in, requests out",
      "nodes": [{ "id": "a", "label": "Refill", "icon": "refresh-cw", "cue": "refills" }, { "id": "b", "label": "Bucket", "icon": "archive", "cue": "holds" }],
      "edges": [{ "from": "a", "to": "b" }] },
    { "type": "kinetic", "cue": "So remember", "lines": [{ "text": "Rate is refill speed.", "cue": "refill" }], "emphasis": "refill" }
  ]
}
```

`cue` is a short phrase copied word for word from the script. The scene (or item) starts when
the voice says it. Transitions are automatic.

## Component catalog

| type | Use it for | Built from |
|------|-----------|-----------|
| `title` | Opening question or claim | JobCairn title card (+ `hw-title` sweep) |
| `bullet-build` | 2 to 4 parallel points, one per cue | `mk-specs-list`, theme |
| `code-typing` | Short code typed in as you introduce it | `code-typing` |
| `code-highlight` | Walk through lines of code, one note per cue | `code-highlight` |
| `code-morph` | Before code turning into after code | `code-morph` |
| `code-diff` | Lines removed and added, with a reason | `code-diff` |
| `flowchart` | Process or architecture, nodes grow on cue | `flowchart`, `flowchart-vertical` |
| `sequence` | Messages between actors (client, API, DB) | `flowchart` primitives |
| `comparison` | Option A vs B, or the job asks vs your evidence | `comparison-split` |
| `stat` | One number with its source, counted up | `count-up` |
| `quiz` | Interview question, think timer, model answer | `interview-qa` template |
| `recap-card` | Three takeaways and a closing line | theme |
| `caption-rail` | Captions (top-level `captions` field) | kit captions, `caption-pill-karaoke` |

**Visual scenes (version 3), the house style.** Show, don't write: the voice carries the detail and the
screen shows a picture and at most 12 words. Prefer these to a text list (fields in `references/scene-spec.md`
§ Visual scenes; pictures in `references/asset-packs.md`):

| type | Use it for |
|------|-----------|
| `icon-grid` | Skills, requirements or ideas, each with an icon or a technology logo |
| `logo-row` | A tech stack or tools by name: their logos show |
| `diagram` | `architecture` (services, queues, stores, with group boxes), `userflow` (screens, decision diamonds), `pipeline` (steps passing data), `mesh` (peers that all talk, like P2P) |
| `match` | The role's asks against your evidence: match, partial or gap chips |
| `checklist` | A to-do, or yes / partly / no, ticked as the voice says it |
| `timeline` | Stages, dates, a hiring process |
| `chart` | Numbers from a source: bars, or a ring for part of a whole |
| `quote` | One short line copied exactly from a source, attributed |
| `company-card` | Who the company is (its logo comes from the workspace when there is one) |
| `map-pin` | Where the job is, on a stylised map |
| `kinetic` | One punchy line, said and shown big, word by word |
| `matrix` | Options against criteria, yes / partial / no cells |

Pick by the content: architecture talk gets an `architecture` diagram, a user's path gets a `userflow`,
"P2P and NAT traversal" gets a `mesh`, a list of tools gets a `logo-row`. A text `bullet-build` is the last resort.

Marks (`underline`, `circle`, `arrow`, `highlight`) can sit on any scene: `hw-*`, `inline-highlight`.
Optional `manim` scene for maths animation: see the note at the end of `references/scene-spec.md`.

## Rules

1. **Spec, not HTML.** Write `spec.json`. Hand-write HTML only in the manual fallback, and then
   only by filling the templates in `${CLAUDE_PLUGIN_ROOT}/templates/video/`.
2. **The voice leads.** Every scene and every revealed item has a cue. Nothing appears before
   the voice names it. At most 5 revealed items per scene (6 in an icon grid or logo row). Scenes run 4 to 15 seconds.
   At most 12 words on screen a scene; the narration says the rest.
3. **The user's voice.** Always use the voice from their settings. Never change it without asking.
4. **Local only.** Allowed `hf` commands: `transcribe`, `lint`, `check`, `snapshot`, `render`.
   Never `init`, `cloud`, `lambda`, `cloudrun`, `auth`, `publish`, `tts`, `skills`, `add`,
   `catalog`, `feedback`. No HeyGen, no avatars, no network media. Pictures come from the bundled packs and the
   workspace only; sounds are made by the app.
5. **True and plain.** Technical content must be correct. Facts about the candidate come from
   their own files only (`me/history`, `settings/profile.json`). If those files hold a "do not claim"
   or "cautions" list, nothing on it appears in the video. Short sentences, no em-dashes, no hype.
6. **Honest status.** Never present a video with open issues as passed.
7. **The user's edits win.** A hand edit to `script.txt` or `spec.json` survives every later
   step (narrate, captions, build, render). Only rewriting that file itself (a new script or a
   revise) may replace it, and then say so in your report.
8. **When the JobCairn app asked.** If the request says JobCairn narrates and renders, write only the
   files it names (`script.txt`, `spec.json`, `sources.md` and any extras) in the folder it names, then
   stop. Don't narrate, transcribe, lint or render, and don't report progress: the app does those and
   shows its own progress. It checks your files the same way `hf lint` and the scene-spec rules do.
   The app also runs the checks, the fresh-context look at the stills and the final QA, so skip steps
   3 to 10. If the request says sponsorship doesn't apply, leave visa sponsorship and work rights out
   of every file. Before you finish, read your `spec.json` back once against the exact shapes and each
   type's limits in scene-spec.md: there is no checker tool in this run, so that read-back is the check.

Chapters (`chapter: true`) will become editable sections: a change to one chapter re-plans and
re-renders only its scenes. That is planned, not built. Today, an edit re-renders the whole video.

## When something breaks

Lint codes, render flags and fixes: `references/render-and-check.md`.
Motion and design rules (for hand edits only): `references/motion-rules.md`.
