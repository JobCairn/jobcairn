# Marketing and guide videos

`make-video.ts` turns a shot list into a finished video of the made-up example workspace:

- It records the app-ui vite mock in example mode with a headless Chrome.
- The app's own voice reads it (Supertonic, Maya: `narrate.py --voice F4`).
- The app's music bed plays under the voice and ducks for it (`packages/video/src/sound.ts`).
- The "AI voice" mark (`watermark.ts`) sits on every frame, bottom right.
- Title and end cards carry the made-up-people line.
- Captions come as a separate `.en.vtt`.
- Output is a web-ready H.264 mp4 (faststart, AI voice tags in the metadata) plus a webp poster.

The scripts are in `docs/assets/marketing/script.md`. Shot lists are in `shots/`.

## Run

```sh
npm run build -w @careeros/core                                     # once per checkout (the video package imports it)
(cd packages/app-ui && npx vite --port 5392 --strictPort --host 127.0.0.1) &
npx tsx scripts/marketing/make-video.ts scripts/marketing/shots/find-and-score.json
```

Options:

- `--base URL`: where the vite mock runs (default `http://127.0.0.1:5392`).
- `--chrome PATH`: the Chrome binary. The default is agent-browser's Chrome for Testing. Never point it at your own Chrome profile.
- `--out DIR`: where the mp4, vtt and poster go (default `tmp/marketing/<slug>/out`).
- `--reuse`: keep beats already recorded and record only the missing ones.
- `--only 2,4`: record only these beats (by index) again.

Scratch files go to `tmp/marketing/<slug>/`, which is gitignored:

- `beats/`: frames and per-beat clips.
- `qa/`: two stills per beat, for checking.
- `plan.json`: when each beat starts.
- `narration-cache/`: unchanged lines aren't spoken again.

Delete the folder when you're done.

In a worktree whose `node_modules` links to another checkout, vite refuses to serve `@fontsource` files, and the
page falls back to system fonts. Copy that folder in (`rm node_modules/@fontsource && cp -R <main>/node_modules/@fontsource
node_modules/`). The run stops if Geist and Instrument Serif didn't load.

Needs: ffmpeg on PATH, the JobCairn Python (`~/.careeros/venv`) with the Supertonic model, and `~/.config/careeros/denylist.txt`.

## What it checks

- The visible text of every beat, and the captions, go through `scripts/privacy/rules.mjs` `checkText` with the denylist. They must also not contain "CareerOS". Any hit stops the run, and the matched entry is never printed.
- The narration must come from Supertonic. A fallback to macOS `say` stops the run.

## Shot list

```jsonc
{
  "slug": "find-and-score", "title": "…", "resolution": "720p" /* or "1080p" */,
  "layoutWidth": 1280,            // the app's width in CSS px (recorded at 1920x1080, then scaled)
  "theme": "dark", "clock": "2026-01-15T23:00:00Z", "maxMB": 5.5,
  "replace": [["CareerOS", "JobCairn"]],  // text swapped in the page before it's drawn
  "cards": { "title": { "heading": "…", "sub": "…" }, "end": { … }, "disclaimer": "An example job search. …" },
  "poster": { "beat": "fit-sponsor", "at": 2.2 },
  "beats": [
    { "id": "title", "card": "title", "voice": "…", "lead": 1.3, "tail": 1.0 },
    { "id": "search", "params": "chrome=on", "route": "#/jobs", "voice": "…",
      "pre": [ /* done before recording */ ],
      "steps": [ { "at": 0.1, "role": "button", "name": "Choose how: Find jobs" }, { "at": 4.2, "hash": "#/searches" } ] }
  ]
}
```

Each beat loads the mock fresh: `?onboarding&<params>`, then "Try example", then `route`. Use `"route": "#/welcome"` to stay on the welcome screen.

`params` are main.tsx's preview switches: `score`, `chrome=on`, `learn`, `maildemo`, `dropbox`, `resume` and so on. Note that `score`, `chrome`, `video`, `jobvideos` and `stress` can't be combined.

A beat lasts lead + its spoken line + tail (at least `min`). `"card"` with `"cardFor": 2.5` shows the card first, then the screen.

Actions, in `pre` or in `steps` (`at` = seconds into the beat):

- Click: `click` (text, `exact`), `role` + `name`, or `css`. The fake cursor moves there first.
- Navigate: `hash`.
- Hover and keys: `hover`, `press`, `type: { selector, text }`.
- Scroll: `scrollTo` (text, `offset`), `scrollSelector`, `scrollBy`.
- Zoom: `zoom` (text) or `zoomSelector`, with `scale` and `ms`. `unzoom` zooms back out.
- `pre` only: `wait` (ms) and `waitFor` (text).
