# Read aloud (Lane E)

Every reading view (job description, company research, Learn guides, Apply documents) can be read
aloud with the on-device Supertonic 3 voice. Text never leaves the Mac.

## Pieces

| Piece | Where | What it does |
|-------|-------|--------------|
| Text prep | `contract/src/tts.ts` | Pure: strips markdown, drops fenced code, says "link" for URLs, splits into paragraphs (long ones at sentence ends, max ~600 chars). Shared by the renderer (to know the paragraphs) and the services (to clean what is spoken). |
| Cache | `services/src/tts-cache.ts` | `<ws>/.careeros/cache/tts/<sha256>.wav`. Key = sha256 of `[text, voice, lang, expressions, engine, ENGINE_VERSION]`. LRU by mtime (touched on hit), capped at 200 MB. The folder holds its own `.gitignore` (`*`). |
| Runner | `services/src/tts-runner.ts` | Spawns the narrator with an argument array (no shell), a timeout, and kills the whole process group on cancel or timeout. `spawn` is injectable for tests. |
| Engine | `services/src/tts.ts` | Bridge handlers `tts.*`. One synthesis at a time; same key in flight is shared. Engine status, voice previews. |
| Media | `app-electron/src/tts-media.ts` + `careeros-file://tts/<name>.wav` | Only two name shapes: `<64 hex>.wav` (cache) and `preview-<F1..M5>.wav` (`settings/voice-previews/`). The services check the path, refuse links and hard links and pin dev/ino; the existing `serveMediaFile` streams it. No new channel. |
| Player | `app-ui/src/listen/*` | `PlayerProvider` (one `Audio` element, queue, highlight), `PlayerBar`, `ListenButton`, `VoiceSettings`. |

## Engine pipeline

1. `ListenButton` builds paragraphs: from the rendered DOM when the view gives a `target` element id
   (exact highlight), else from the markdown text.
2. The player asks `tts.speak(text, {voice, lang, expressions}, source, requestId)` for paragraph *i*,
   then *i+1* and *i+2* ahead, one at a time. Playback starts when paragraph 1 is ready.
3. The services hash the cleaned text; a cache hit returns at once. A miss runs
   `$HOME/.careeros/venv/bin/python plugin/skills/voice/scripts/narrate.py --text-file t.txt --out x.wav
   --voice F4 --lang en --(no-)expressions --lead 0 --gap 0 --tail 0.25`.
   No venv: system `python3` with `--engine macos_say`. Neither: "not installed".
   If narrate reports `fell_back`, the audio is cached under the `macos_say` key, never the Supertonic one.
4. Speed is `audio.playbackRate` with `preservesPitch`; changing it never re-synthesises.
5. Stop or skip cancels the in-flight request (`tts.cancel(requestId)` kills the process group).

The narrator path: `CAREEROS_PLUGIN_ROOT`, else the repo's `plugin/` found above the services module.
GUI apps on macOS lack Homebrew on `PATH`, so the runner adds `/opt/homebrew/bin` and `/usr/local/bin` for ffmpeg.
Each paragraph loads the model again (about a second). A persistent worker mode is a follow-up.

## Settings

`settings/integrations.json`:

- `voice` (unchanged): the video narration voice, used by the voice skill.
- `read_aloud: { voice, speed, lang }`: the defaults for reading aloud. New, with schema defaults
  (`F4`, `1`, `true`, `en`).

The Settings > Voice tab shows the engine status (Supertonic ready / using the macOS voice / not installed,
with a setup hint), both voice groups, a Preview button per voice (`--preview` WAVs in
`settings/voice-previews/`) and "Generate previews" when they are missing.

**Emotions.** Supertonic 3 exposes one switch: expressions on or off (breaths, light laughs, sighs), and it only
acts on those marks in a video script. Documents don't carry them, so Expressions is shown for videos only
(owner decision, 2026-10-10); `read_aloud.expressions` stays in the schema with its default. No emotion presets. An
engine like ElevenLabs could offer styles later; that would be a new engine option, not a fake preset here.

**Languages.** Not hard-coded. `tts.status` returns `languages`, read once per venv from the installed
`supertonic` package by a short python probe through the runner (it reads list attributes such as
`SUPPORTED_LANGUAGES`; it never builds the engine, so nothing downloads). If the list can't be read, or
Supertonic isn't set up, only English is offered, with a note saying why. Language codes are validated
as `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$` and shown by name through `Intl.DisplayNames`.

## Privacy

- Text goes from the renderer to the services over the existing IPC and to a local process. No network.
- `source` (the workspace file the text came from) is checked with the same lock rules as `files.readText`:
  a locked folder without a grant is refused. Audio from a lockable folder (`me/identity`, `me/employment`)
  is deleted when the workspace closes or privacy changes.
- Cache files are served only by hash name through the checked media path.

## Not done here

- The packaged app shipping the plugin: sub-project 4. Until then a packaged build shows "not installed" with the setup hint.
- A persistent narrator worker (model loaded once): parked follow-up.

- Company research has no reading view yet (Lane A's Job screen). The Listen button reads
  `companies/<slug>/research.md` directly, without paragraph highlight, until a view exists.
- Word-level highlight (needs timing per word; narrate only estimates).

## Fix round 1 (2026-10-10)
- **No network mid-run.** Every narrator child gets an allow-listed env (PATH, HOME, USER, LOGNAME, LANG, LC_*,
  TMPDIR, VIRTUAL_ENV, HF_HOME, HF_HUB_CACHE, XDG_CACHE_HOME) plus `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`,
  and narrate gets `--no-download` (narrate.py builds `TTS(auto_download=False)` then). The engine check runs
  `narrate.py --check --no-download`, which loads the model with downloads off: exit 0 ready, 5 not downloaded
  (`TtsStatus.needsDownload`). The model is fetched only by `tts.downloadVoice` (`narrate.py --download`), from the
  "Download the Supertonic voice" button in Settings > Voice; that one run may use the network and proxy settings.
- **Locked-folder audio.** Audio made from `me/identity` or `me/employment` (read with a grant) goes to
  `.careeros/tts-private/` as `careeros-file://tts/private-<sha256>.wav`, never the shared cache. The folder is wiped
  on every workspace open (so a crash leaves files only until the next open) and close, and on any privacy change.
  Serving a private file needs an entry this session made and a fresh lock check of its source file.
- **Expressions** are not part of read aloud any more: not in `TtsOptions`, the schema's `read_aloud`, the cache key
  or the narrate call (always `--no-expressions`). The video `voice.expressions` switch is unchanged.
- Previews and the download run under their own AbortController: a Stop button and workspace close end them.
