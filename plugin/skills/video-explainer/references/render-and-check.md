# Render and check

Adapted from HyperFrames (Apache-2.0): hyperframes-cli (dev loop, lint/check, preview-render,
transcribe), hyperframes-core validation. Verified against the 0.8.140 source.

## The command

`hf` = `HYPERFRAMES_NO_TELEMETRY=1 npx -y hyperframes@0.8.140`. A global `hyperframes` is fine
if `hyperframes --version` prints 0.8.140. Run every command from the video folder.

Once per machine, also run `hf telemetry disable` (the env var covers each call anyway).

## Preflight (before any creative work)

Check every tool first, so a missing one never costs a written script:

```bash
ffmpeg -version && ffprobe -version
hf --version                                   # must print 0.8.140
$HOME/.careeros/venv/bin/python -I -c "import supertonic"   # voice venv
```

Also confirm Chrome is installed and the voice model is already on disk (the `voice` skill's
setup). If anything is missing, stop, name it, and point to setup (JobCairn Settings > Tools, or
the `voice` skill). Never download the voice model mid-run. The app's tools check does the same
before it narrates.

## Allowed (local only)

| Step | Command | Notes |
|------|---------|-------|
| Words | `hf transcribe narration.wav --model base.en --language en` | Local Whisper (or Parakeet if installed). Use `small.en` instead if that is the model already installed. JobCairn setup downloads base.en once (about 140 MB); a video never downloads it. Writes `transcript.json` next to the audio and fills any `const TRANSCRIPT = [...]` in `.html` files in that folder. |
| Re-sync | `hf transcribe transcript.json` | After hand-fixing words. Re-fills `TRANSCRIPT`. |
| Lint | `hf lint` | Fast. Run after every structural edit. |
| Gate | `hf check` | Lint + runtime + layout + contrast. Must end with 0 errors. |
| Look | `hf snapshot --at 1.5,9,17` | One time per scene middle. Writes a contact sheet. Read it. |
| Draft | `hf render --quality draft --output renders/draft.mp4` | For review. |
| Final | `hf render --output renders/final.mp4` | Default quality `looks`. Only after the user approves. |

Never run: `init` (it installs HyperFrames skills into the user's Claude config and copies a
CLAUDE.md into the project), `cloud`, `lambda`, `cloudrun`, `auth`, `publish`, `tts`, `skills`,
`add`, `catalog`, `feedback`, `media-use`, `capture`. Start a project by copying the JobCairn
templates instead. If `init` is ever needed, set `HYPERFRAMES_SKIP_SKILLS=1` and delete the
copied `CLAUDE.md` and `AGENTS.md`.

## Fast renders on a Mac

- 1080p30 is the default. Do not pass `--fps 60`.
- Multi-worker renders on macOS write raw frames to disk (about 25 GB a minute) unless you set
  `HF_CAPTURE_PARALLEL_STREAM=true`. Use it for the final render:
  `HF_CAPTURE_PARALLEL_STREAM=true hf render --gpu --output renders/final.mp4`
- `--gpu` encodes with VideoToolbox. `--workers auto` is the default; each worker is a Chrome.
- If memory is tight or the render stalls: `--workers 1`.
- Read the render summary's second line: capture path, GPU mode and stage timings.

## Verify the output

```bash
test -s renders/final.mp4
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of compact renders/final.mp4
```

Duration should match the root `data-duration`. Video 1920x1080 at 30 fps, audio present.

## Judge the contact sheet (fresh context)

Whoever wrote the HTML is a lenient judge of it. Judge `hf snapshot` output against the spec and
the brief only. In the plugin flow, give a subagent the PNGs and `spec.json`, nothing else, and
ask for a defect list. Don't re-read the composition while judging. Look for:

- text cut off, overlapping or colliding (with each other or the caption band);
- contrast below WCAG AA at video scale;
- density outside 3 to 12 elements on screen;
- broken alignment, or a placeholder that looks broken;
- **dead zone:** more than 1.2 s with no motion and no new information;
- **hook:** the strongest visual is not on screen by 1.5 s;
- **pacing:** calm scenes outside 4 to 8 s, fast scenes outside 2.5 to 5 s;
- **illustrate:** the frame doesn't show what the narration says at that moment.

## Fix loop and honest status

At most 3 check-and-fix passes (`hf check` plus the judge). Then stop iterating and render
anyway. The video is labelled `PASSED` or `DELIVERED WITH N OPEN ISSUES`. Each open issue gives
the scene number, the time range, one line on what is wrong, and what you tried. Never present a
degraded video as if it passed. In the app this label lives in `video.json` as
`qa: { status: "passed" | "open_issues", open_issues: [{ scene, from_s, to_s, description, tried }] }`
(scene is 0-based). A new final render clears it, so a label always matches the video it describes.

## Final QA on the MP4

On top of the ffprobe check (size, sound, length):

1. **Stills:** 4 to 6 frames spread across the video, away from the first and last frame:
   `ffmpeg -v error -ss <t> -i renders/final.mp4 -frames:v 1 -q:v 3 -y qa/frame-<n>.jpg`.
   Look at each one for legible text and gradient banding.
2. **Caption sync:** pick about 10 words spread through `transcript.json`. Pull the frame at
   each word's midpoint (`(start + end) / 2`). The lit caption word must be that word, or a
   neighbour whose timing is within ±120 ms of that moment.

The app's final render pulls these stills itself into `qa/` with `qa/plan.json`, which says
which word each sync still should show. Judge them with the same fresh-context rule.

## Report (creator first)

In this order: the status line; the video path; a poster frame and a strip of the QA stills;
the chapter map (scene, start time, headline) so the user knows what to ask to change; the open
issues; then an appendix with the check passes, tool versions (hyperframes 0.8.140, the
Supertonic version from the voice venv) and where each fact came from. Record the tool versions
in `sources.md` too.

## Hand edits

A user's edit to `script.txt` or `spec.json` is theirs. Narrating, captioning, building and
rendering only read those files, so the edit survives every later step. Only writing that file
again (a new script, or a revise) may replace it; when that happens, say so in the report. If
you change something the user edited, ask first.

## Common lint errors and fixes

| Code | Fix |
|------|-----|
| `gsap_css_transform_conflict` | Remove the CSS `transform` on that element; set the start state in `fromTo`. |
| `gsap_animates_clip_element` | Tween the `.stage` child, not the `.clip` section. |
| `gsap_from_opacity_noop` | Use `fromTo` with `opacity: 1` in the end state. |
| `gsap_cold_seek_hidden_fromto_missing_reveal` | Add `opacity: 1` to the `fromTo` end state. |
| `gsap_non_transform_motion` | Swap width/left/top/fontSize tweens for `scaleX`/`x`/`y`/`scale`. |
| `gsap_timeline_not_registered` | Add `window.__timelines["main"] = tl` at the end of the script. |
| `gsap_fullscreen_overlay_starts_visible` | Give the full-frame overlay CSS `opacity: 0`. |
| `media_missing_id` | Give the `<audio>` an `id`. Without it the render is silent. |
| `font_family_without_font_face` | Use only theme fonts, or add `@font-face` for a shipped file. |
| `root_composition_missing_duration_source` | Set root `data-duration` to the audio length. |
| `clip_ends_past_root_duration` | Raise root `data-duration` to the last clip end. |

A lint error turns off the layout and contrast audits. `check` then shows `0 sample(s)`; that
is not a pass. Clear lint errors first. Transient findings during a seam are informational.

## Trouble

| Symptom | Likely cause |
|---------|--------------|
| Silent render | `<audio>` missing `id`, or wrong `src` path. |
| Blank scene | Timeline registered before tweens were added, or key does not match `main`. |
| Element never appears | `from()` with CSS `opacity: 0`, or a reveal time after the clip ends. |
| Captions missing | `TRANSCRIPT` still `[]`. Run `hf transcribe narration.wav` after `index.html` exists. |
| Words out of sync | Using `words_estimated`. Transcribe for real timings. |
| Text overflows | Shorten the text. Do not shrink below the type sizes in motion-rules.md. |

## Offline and licensing notes (installer TODO, do not solve here)

- Templates and blocks load GSAP 3.14.2 from the jsDelivr CDN; the compiler fetches and inlines
  it at render time, so rendering needs network. The embeddable player's runtime URL also points
  at jsDelivr (the render bundler defaults to an inline runtime). The compiler keeps a local
  `<script src="...gsap.../dist/gsap.min.js">` when that file exists in the project. Fully
  offline rendering needs a vendored GSAP and runtime: TODO for the installer (sub-project 4).
- GSAP is not Apache-2.0. Check its current license terms for commercial use before JobCairn
  ships it.
- Supertonic 3 model terms (OpenRAIL-M) are tracked in `docs/dependencies.md`.
