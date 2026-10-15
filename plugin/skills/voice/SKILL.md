---
name: voice
description: Turn a JobCairn video script into narration with the user's chosen voice, on-device (Supertonic 3, fallback macOS say). Use whenever a video-explainer, video-slides or interview drill needs narration.wav and timings, when the user wants to hear the preset voices, or when narration sounds wrong and needs a redo.
---

> Narration engine: Supertonic 3 (OpenRAIL-M model, see docs/dependencies.md). Timing and
> pacing guidance adapted from HyperFrames (Apache-2.0). Credits in NOTICE.md.

# Voice

**Always use the user's chosen voice. Never change it without asking.** The user picks it in
the app's video settings. The script reads it; you do not pass `--voice` unless the user asked
for a one-off change in this conversation. **Default voice (owner decision): F4** (female),
used only when the user hasn't chosen one yet (fresh workspace, no `voice` in settings and no
`--voice` passed) — the script falls back to it instead of blocking. `M3` is the recommended
male voice to offer if the user wants an alternative. Once a voice is chosen, that choice
always wins over the default.

## Settings it reads

`<workspace>/settings/integrations.json`, key `voice`:

```json
{ "engine": "supertonic", "voice": "F2", "lang": "en", "expressions": true,
  "per_type": { "guide": "", "interview": "M1", "slides": "" } }
```

`per_type[<type>]` wins when set; empty means use `voice`, then the default `F4` if `voice` is
also empty. Presets: F1 to F5, M1 to M5; default `F4`, recommended alternative `M3`.
`engine` is `supertonic`, `macos_say` or `elevenlabs` (optional, not run by this script: ask
the user to switch, do not switch for them).

## Make narration

```bash
$HOME/.careeros/venv/bin/python ${CLAUDE_PLUGIN_ROOT}/skills/voice/scripts/narrate.py \
  --workspace <ws> --type guide|interview|slides \
  --text-file script.txt --out narration.wav
```

Writes `narration.wav` (44.1 kHz mono, loudness -16 LUFS) and `narration.timing.json`:
`paragraphs` (start/end per paragraph), `scenes` (default plan: one scene per paragraph,
0.6s seam overlap), `total`, and `words_estimated` (rough, for when transcription is not possible).
Prints one JSON line: `{"ok":true,"engine":...,"voice":...,"fell_back":...}`.

Optional: `--voice M2 --lang en` (one-off overrides), `--engine macos_say`,
`--no-expressions`, `--lead 0.5 --gap 0.45 --tail 1.0 --transition 0.6`.

**If `fell_back` is true** (Supertonic could not load, so macOS `say` was used), tell the user
the voice is different for this video and ask whether to keep it or fix Supertonic first.

## Script format

- Paragraphs separated by a blank line. One paragraph per scene or slide.
- `# notes` lines are skipped.
- A paragraph that is only `[pause 8]` makes 8 seconds of silence (drill think time).
- Expression tags `<laugh>`, `<breath>`, `<sigh>`: use them sparingly, where a person would.
  A breath before a turn in the argument. A small laugh after a light line. A sigh on a pain
  everyone knows. At most one per 30 seconds, never inside a drill question, never two in a row.
  If settings have `"expressions": false` the script strips them. `say` always strips them.

## Writing for the ear

- About 2.5 words per second. Short sentences. Contractions.
- Say numbers as words a person would say ("about two hundred milliseconds").
- Spell out acronyms people mishear ("J W T"). Keep code identifiers on screen, not in the voice.
- Read the paragraph in your head. If you run out of breath, split it.

## Voice previews for the settings screen

```bash
$HOME/.careeros/venv/bin/python ${CLAUDE_PLUGIN_ROOT}/skills/voice/scripts/narrate.py \
  --preview --out-dir <ws>/settings/voice-previews --lang en
```

Writes `F1.wav` to `M5.wav` (same sentence) and `voices.json`, generating `F4.wav` (default)
and `M3.wav` (recommended male voice) first, then the rest. Needs Supertonic. That takes a few
minutes and keeps the CPU busy, so prefer one voice at a time at a low priority:
`--voices F4 --nice 10`. The app makes a sample only when its Preview button is pressed.

The app's read aloud uses `--serve`: one warm process that keeps the model loaded and reads JSON
jobs on stdin (see the script's docstring). Don't start one yourself.

## Redo

If a word is mispronounced, respell it in the script ("Kubernetes" to "koo-ber-net-eez" only
for that line), re-run narrate, then re-transcribe and set the caption word in
`transcript.json` back to the real spelling. Never edit the WAV by hand.

## Exit codes

0 ok · 2 bad input or settings (missing text file, bad JSON) · 3 engine unavailable ·
4 synthesis or ffmpeg failed (show the message).
