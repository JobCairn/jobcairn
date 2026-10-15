---
name: video-captions
description: Add readable captions to JobCairn videos or to the candidate's own recording, all on the laptop. Use for "add captions/subtitles", "caption my mock interview recording", "export an SRT/VTT", or when fixing caption timing, wording or style in a JobCairn explainer, drill or slide video. Not for writing or narrating a new video (video-explainer, video-slides).
---

> Adapted from HyperFrames (Apache-2.0). Credits in NOTICE.md.

# Video captions

Captions are a quiet rail in the lower band: verbatim words, 3 to 5 per group, one group on
screen at a time, the spoken word lit in the accent colour. They serve reading, not decoration.

`hf` = `HYPERFRAMES_NO_TELEMETRY=1 npx -y hyperframes@0.8.140`. All steps run locally.

## Job 1: captions in a JobCairn video

They are on by default (`"captions": "rail"` in `spec.json`). The rail is built by
`kit.js` from the `TRANSCRIPT` line in `index.html`.

1. Transcribe the narration: `hf transcribe narration.wav --model base.en --language en`.
   Use `small.en` instead only if that is the model already on this computer. Never download a
   second model. The script is already known, so the small base.en model is enough to time it.
   With `"captions": "none"` skip this step: the words are timed from `narration.timing.json`.
2. **Check the words** (always): open `transcript.json`, compare with `script.txt`.
   Fix misheard terms ("cube control" to "kubectl"), keep `start`/`end` as they are.
3. Re-sync into the page: `hf transcribe transcript.json`.
4. `hf check`, then `hf snapshot --at <a few times mid-sentence>` and read the frames.
5. **Sync check** on the rendered video: pick about 10 words spread through `transcript.json`,
   pull the frame at each word's midpoint, and confirm the lit word is that word (or a
   neighbour within ±120 ms). The app's final render pulls these frames into `qa/` for you.
   Details: `${CLAUDE_PLUGIN_ROOT}/skills/video-explainer/references/render-and-check.md` § Final QA.

Styles: `rail` (default, dark pill, active word amber), `pill` (`caption-pill-karaoke`),
`highlight` (`caption-highlight`), `none`. Change only if the user asks.

## Job 2: burn captions onto the candidate's recording

For a mock interview answer or a practice pitch the user recorded. Save in the same folder
as the recording's job, e.g. `companies/<slug>/jobs/<id>/interview/practice-<n>/`.

1. Copy `${CLAUDE_PLUGIN_ROOT}/templates/video/caption-over-video.html` as `index.html`, plus
   `theme.css` and `kit.js`. Copy the recording in as `input.mp4`.
2. `ffprobe -v error -show_entries stream=width,height:format=duration -of compact input.mp4`.
   Fill `{{W}}`, `{{H}}`, `{{DUR}}`. Portrait: `CAPTION_TOP = 1240`, `maxChars: 26`.
3. `hf transcribe input.mp4 --model small.en --language en` (fills `TRANSCRIPT`). A recording has no
   script to align to, so it needs the larger small.en model: ask before it downloads (about 470 MB).
4. Check the words as in Job 1. Do not "clean up" what the user said: captions are verbatim,
   minus filler (um, uh) which the kit drops.
5. `hf check`, `hf render --quality draft --output renders/captioned-draft.mp4`, show the
   user, then the final render. Run the sync check from Job 1 on it.

Refuse and say why if: the audio is mostly silence or music (Whisper invents words there),
the recording already has burned-in subtitles, or more than one person speaks over each other.

## Job 3: a subtitle file

`hf transcribe transcript.json --to srt --output captions.srt` (or `--to vtt`).
Use for uploading with the video, or for the candidate to read along.

## Transcript quality check

Bad words make bad captions. Retry once with `--model medium.en` if you see:
- many `♪` or `�` tokens, or nonsense words;
- the wrong language (`small.en` translates non-English speech: for other languages drop the
  `.en` model and pass `--language <code>`);
- words shorter than 0.05s in long runs.
If `medium.en` is still bad, tell the user the audio is too noisy for local captions.

## Style rules (already in the kit; keep them in any hand edit)

- Bottom band, y 880 to 1040 on 1920x1080. Nothing else important lives there.
- 44px Montserrat 700, off-white on a dark 78% pill. Max 42 characters (26 portrait).
- Break groups at sentence ends, at commas after 3+ words, and at pauses over 0.35s.
- Each group enters in 0.16s and leaves in 0.12s, then is hard-hidden. Never two at once.
- Active word turns amber for its spoken duration. No bounce, no scale pop, no emoji.
- `overflow: visible` on the caption container; never shrink text below 36px.

## Rules

- Local only: `transcribe`, `lint`, `check`, `snapshot`, `render`. No cloud captioning.
- Never change the user's footage (no grading, crops or cuts) unless they ask.
- Recordings and transcripts are private. Keep them in the workspace.
