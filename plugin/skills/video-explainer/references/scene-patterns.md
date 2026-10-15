# Scene patterns and manual build

Adapted from HyperFrames (Apache-2.0): faceless-explainer visual-design (time-coded shot
sequence, layout vocabulary), blueprints for count-up, comparison and layer reveal.

## Each scene is a short shot, paced to the voice

Think of a scene as windows cued by the narration, not a slide:

```
0.0s        seam lands; only the headline (or the first thing the voice says) is visible
cue 1       first item lands (the noun the voice just named)
cue 2..n    next items, one per cue, most of them in the back half of the scene
last cue    0.3 to 0.75s of stillness, then the key item; hold still until the seam
```

## Patterns by type

| type | Layout | Motion pattern |
|------|--------|----------------|
| `title` | Left-aligned, vertically centred. Kicker, short amber rule, hero title, subtitle. | Kicker slides in from left, rule draws, title rises; subtitle waits for its cue. |
| `bullet-build` | Claim headline top, 2 to 4 numbered rows below. | Each row enters from the left on its cue. No row before its cue. |
| `code-typing` | Code panel left 60%, one-line label right. | Types at reading pace; the label lands when typing ends. |
| `code-highlight` | Code panel 1080px wide left, note card right. | Code lands with the stage. A bar walks to the lines on each cue; the previous note lifts out, the next slides in. |
| `code-morph` | One centred code panel. | Hold the "before" long enough to read, a 0.4s stillness, then the morph on `cue_morph`. |
| `code-diff` | One panel; reason card under it. | Removed lines strike out first, added lines land, then the reason. |
| `flowchart` | Nodes in one row (lr) or column (tb), 40 to 60% of the frame. | Node 1 scales in; each edge draws 0.3s before its target node lands. Takeaway after a pause. |
| `sequence` | Actors as columns with lifelines; messages as arrows. | One arrow per cue, drawn in the message direction, label lands with it. |
| `comparison` | Two equal cards side by side (job asks vs your evidence). | Left from the left, right from the right, each on its cue. Verdict last. |
| `stat` | Claim headline, huge amber number, source line. | Number counts up on the word that says it (1.4s ease-out), source after. |
| `quiz` | Question large, timer bar under it; then 4 beat rows; then good/weak cards. | Timer drains during the silent pause. Beats land on cues; result beat after a stillness. |
| `recap-card` | Headline, three cards in a row, closing line. | Rises in (up seam). Cards on cues, closing line after a 0.4s stillness. |

Vary framing across a video: centred title, left-anchored lists, split code, full-width flow,
triptych recap. Never the same framing twice in a row.

## Manual build (until the expander ships)

Use this only when the expander is not available. Never write layout from scratch.

1. Pick the template:
   `${CLAUDE_PLUGIN_ROOT}/templates/video/explainer.html` (title, bullets, flow, code, recap),
   `interview-qa.html` (quiz), or `slides.html` (for video-slides).
2. Copy it into the video folder as `index.html`, with `theme.css` and `kit.js` beside it.
   Copy `narration.wav` there too.
3. Map spec scenes to template sections. Delete unused `<section>` blocks and their script
   blocks (each is labelled `S2`, `S3`, ...). To repeat a type, copy its section and script
   block and give every id a new scene prefix.
4. Timing: open `narration.timing.json`. For scene i set `data-start` = `scenes[i].start` and
   `data-duration` = `scenes[i].duration`. Set the root `data-duration` = `total`.
   Default scene plan is one script paragraph per scene.
5. Fill every `{{SLOT}}`. Cue slots take the same phrase you put in the spec. Fallback seconds
   stay as they are; they only apply when a cue is not found.
6. Run `hf transcribe transcript.json` so the `TRANSCRIPT` line in `index.html` is filled.
   If transcription is not possible, paste `words_estimated` from the timing JSON into the
   `TRANSCRIPT` array instead (captions will drift a little).
7. Check that no `{{` is left: `grep -n "{{" index.html` should print nothing.
8. Then `hf lint`, `hf check`, `hf snapshot` as in the main pipeline.

The templates already handle: theme, safe areas, caption rail, seams, end fade, cue lookup,
deterministic count-up and the timeline registration. Keep `kit.js` calls; do not inline GSAP
code for things the kit does.
