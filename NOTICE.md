# Notices

The plugin's `proprietary` license (`plugin/.claude-plugin/plugin.json`) covers JobCairn's own
code and text only. Vendored HyperFrames files stay Apache-2.0 and the Caveat, Montserrat, JetBrains Mono,
Instrument Serif, Source Serif 4, Geist and Geist Mono fonts stay SIL OFL 1.1; see `licenses/` and the table below.

JobCairn includes material adapted from these open-source projects.

| Source | License | What we adapted |
|--------|---------|-----------------|
| HyperFrames (github.com/heygen-com/hyperframes), v0.8.140 | Apache-2.0 | Video authoring guidance and vendored composition blocks for the JobCairn video skills (sub-project 5). Detail below. |
| Montserrat font (Julieta Ulanovsky and the Montserrat Project Authors, via `@fontsource-variable/montserrat` 5.3.0) | SIL OFL 1.1 | `plugin/templates/video/assets/fonts/montserrat-latin{,-ext}-wght-normal.woff2`, the video theme's main font, copied into each composition so the video check and render never fetch it from Google Fonts. Licence text at `licenses/OFL-Montserrat.txt` and next to the files. |
| JetBrains Mono font (JetBrains, via `@fontsource-variable/jetbrains-mono` 5.3.0) | SIL OFL 1.1 | `plugin/templates/video/assets/fonts/jetbrains-mono-latin{,-ext}-wght-normal.woff2`, the video theme's label and code font, shipped the same way. Licence text at `licenses/OFL-JetBrainsMono.txt` and next to the files. |
| Caveat font (Google Fonts, shipped inside HyperFrames) | SIL OFL 1.1 | `plugin/templates/video/components/assets/fonts/Caveat-700-latin.woff2`, used only by the hand-drawn mark blocks. License text at `licenses/OFL-Caveat.txt`. |
| Instrument Serif font (via `@fontsource/instrument-serif` 5.3.0) | SIL OFL 1.1 | Bundled in the app for headlines and big numbers. Licence text at `licenses/OFL-InstrumentSerif.txt`. |
| Source Serif 4 font (Adobe, via `@fontsource/source-serif-4` 5.3.0) | SIL OFL 1.1 | Bundled in the app for resume body text (Resume Studio's Scholar and Executive templates) and embedded in their PDF exports. Licence text at `licenses/OFL-SourceSerif4.txt`. |
| Geist font (Vercel, via `@fontsource/geist` 5.3.0) | SIL OFL 1.1 | Bundled in the app for interface text. Licence text at `licenses/OFL-Geist.txt`. |
| Geist Mono font (Vercel, via `@fontsource/geist-mono` 5.3.0) | SIL OFL 1.1 | Bundled in the app for labels and figures. Licence text at `licenses/OFL-GeistMono.txt`. |
| Lucide icons 1.53.0 (lucide.dev, via `lucide-react`) | ISC | `packages/video/packs/icons.json` and `architecture.json`: 140 icons' SVG nodes copied unmodified by `packages/video/scripts/build-packs.mjs`, drawn inside video scenes (icon grids, diagrams, timelines). Licence text at `licenses/ISC-Lucide.txt`. |
| Simple Icons 16.34.0 (simpleicons.org, npm `simple-icons`) | CC0-1.0 (MIT or Apache-2.0 for the few icons that carry their own licence) | `packages/video/packs/logos.json`: 77 technology logos' SVG paths, copied once at dev time by `build-packs.mjs`, never fetched at runtime. Icons with a share-alike or non-commercial licence are left out. Brand names and logos belong to their owners; shown only to name a technology. Licence text at `licenses/CC0-SimpleIcons.txt`. |
| agentatelier audio plugin 0.1.1 (`atelier-mix` skill and its `library/` notes) | Apache-2.0 | Ideas only, rewritten in our own code and words in `packages/video/src/sound.ts`: effects kept under the voice by level, only the music ducked by a sidechain keyed from the voice (threshold, ratio, attack, release), a speech carve around 2.5 kHz, two-pass EBU R128 loudness, and crediting every sound. No files copied. Licence text at `licenses/Apache-2.0-agentatelier.txt`. |
| electron-updater 6.8.10 (npm, github.com/electron-userland/electron-builder) | MIT | Bundled unmodified into the desktop app's main process for in-app updates, with its dependencies: MIT or ISC (builder-util-runtime, debug, fs-extra, js-yaml, lazy-val, lodash, semver, tiny-typed-emitter and theirs), and sax 1.6.1 under BlueOak-1.0.0 (permissive). |
| docx 9.9.0 (npm, github.com/dolanmiu/docx) | MIT | Bundled unmodified into the desktop app's main process to write Word exports. Its dependency jszip is dual-licensed MIT or GPL-3.0; JobCairn uses it under MIT. |
| mdast-util-from-markdown 2.1.0 (npm, github.com/syntax-tree/mdast-util-from-markdown) | MIT | Bundled unmodified into the desktop app's main process to parse Markdown for exports. |

career skill: original JobCairn work. `plugin/skills/career/` started from the founder's
personal career-coaching skill and was rewritten to be generic for any candidate: no names,
emails, phone numbers, employers, client names, or founder-specific paths remain, and its
config defaults now point at the JobCairn workspace layout (`me/history/`,
`companies/<slug>/jobs/<id>/`, `settings/profile.json`) instead of the founder's own
`resume-docs/` layout. Its rules (no fabrication, confidentiality, critique pass) are
unchanged.

Models used at runtime (not redistributed): Supertonic 3 (Supertone, OpenRAIL-M; full text with Attachment A in `licenses/OpenRAIL-M-Supertonic3.txt`).

Video sounds: every sound effect and the optional music bed are generated by ffmpeg from fixed recipes in
`packages/video/src/sound.ts` (seeded noise and sine tones). They are JobCairn's own work, dedicated CC0.

Vendored into every rendered composition: GSAP 3.14.2 (`gsap` on npm), under the GSAP Standard
"No Charge" License, text at `licenses/GSAP-Standard-License.txt`. JobCairn copies
`gsap/dist/gsap.min.js` into each video's `comp/vendor/` folder so rendering never needs the network.

## HyperFrames: file map

Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0. A copy of the
license ships at `plugin/templates/video/components/LICENSE-hyperframes.txt`. The HyperFrames
repository has no NOTICE file, so no further notice text is carried. Paths on the right are
relative to the HyperFrames repository root. "Adapted" means rewritten and shortened in our own
words; "vendored" means copied.

### Skills (adapted)

| JobCairn file | Adapts these HyperFrames files |
|---------------|--------------------------------|
| `plugin/skills/video-explainer/SKILL.md` | `skills/faceless-explainer/SKILL.md`, `skills/hyperframes/SKILL.md`, `skills/hyperframes-cli/SKILL.md`, `skills/hyperframes-core/SKILL.md` |
| `plugin/skills/video-explainer/references/brief-and-script.md` | `skills/faceless-explainer/references/story-design.md`, `skills/hyperframes-creative/references/story-spine.md`, `skills/hyperframes-creative/references/narration.md`, `skills/hyperframes/references/script-format.md` |
| `plugin/skills/video-explainer/references/scene-spec.md` | `skills/faceless-explainer/references/visual-design.md`, `skills/hyperframes-animation/transitions/overview.md`, `.claude/skills/motion-doctrine/SKILL.md`, and the registry items listed under Templates |
| `plugin/skills/video-explainer/references/scene-patterns.md` | `skills/faceless-explainer/references/visual-design.md`, `skills/faceless-explainer/references/motion-language.md`, `skills/hyperframes-creative/references/motion-principles.md` |
| `plugin/skills/video-explainer/references/motion-rules.md` | `.claude/skills/motion-doctrine/SKILL.md`, `skills/faceless-explainer/references/motion-language.md`, `skills/faceless-explainer/references/visual-design.md`, `skills/hyperframes-creative/references/typography.md`, `skills/hyperframes-creative/references/video-composition.md`, `skills/hyperframes-creative/references/motion-principles.md`, `skills/hyperframes-creative/references/house-style.md`, `skills/hyperframes-core/references/determinism-rules.md`, `skills/hyperframes-core/references/data-attributes.md`, `skills/hyperframes-animation/adapters/gsap-easing-and-stagger.md` |
| `plugin/skills/video-explainer/references/render-and-check.md` | `skills/hyperframes-cli/SKILL.md`, `skills/hyperframes-cli/references/preview-render.md`, `skills/hyperframes-cli/references/init-and-scaffold.md`, `skills/hyperframes-cli/references/upgrade-info-misc.md`, `skills/hyperframes-core/SKILL.md`; facts checked in `packages/cli/src/commands/{init,transcribe,telemetry,snapshot}.ts`, `packages/lint/src/rules/{gsap,fonts}.ts`, `packages/producer/src/services/renderOrchestrator.ts` |
| `plugin/skills/video-slides/SKILL.md` | `skills/slideshow/SKILL.md` (slide writing rules, MP4 limitation) |
| `plugin/skills/video-captions/SKILL.md` | `skills/embedded-captions/SKILL.md` (rail caption model, refusal checks), `skills/media-use/audio/references/captions/authoring.md`, `skills/media-use/audio/references/captions/motion.md`, `skills/media-use/audio/references/captions/transcript-handling.md` |
| `plugin/skills/voice/SKILL.md` | `skills/hyperframes-creative/references/narration.md` (pacing, numbers). The Supertonic usage is from the Supertonic SDK, not HyperFrames. |
| `plugin/skills/voice/scripts/narrate.py` | None. Original JobCairn code. |

### Templates (adapted)

| JobCairn file | Adapts these HyperFrames files |
|---------------|--------------------------------|
| `plugin/templates/video/theme.css` | `skills/hyperframes-creative/references/house-style.md`, `typography.md`, `video-composition.md` (sizes, contrast, safe areas); palette values are our own |
| `plugin/templates/video/kit.js` | `skills/media-use/audio/references/captions/authoring.md` (grouping, one group at a time, hard kill), `skills/faceless-explainer/references/motion-language.md` (power3 settle, VO-paced reveals), `registry/components/count-up/count-up.html` (baked count frames instead of update callbacks) |
| `plugin/templates/video/explainer.html` | `packages/cli/src/templates/blank/index.html`, `skills/hyperframes-core/references/minimal-composition.md`, `skills/hyperframes-core/references/composition-patterns.md`, `skills/hyperframes-animation/transitions/overview.md` |
| `plugin/templates/video/interview-qa.html` | same as `explainer.html` |
| `plugin/templates/video/slides.html` | same as `explainer.html`, plus `skills/slideshow/SKILL.md` (slide writing rules) |
| `plugin/templates/video/caption-over-video.html` | `skills/hyperframes-core/references/variables-and-media.md`, `skills/media-use/audio/references/captions/authoring.md` |

### Templates (vendored, unmodified apart from an added header)

Each file below starts with a header naming its source, the copyright and the license, and
stating that only the header was added.

| JobCairn file in `plugin/templates/video/components/` | HyperFrames source |
|-------------------------------------------------------|--------------------|
| `code-morph.html` | `registry/blocks/code-morph/code-morph.html` |
| `code-diff.html` | `registry/blocks/code-diff/code-diff.html` |
| `code-typing.html` | `registry/blocks/code-typing/code-typing.html` |
| `code-highlight.html` | `registry/blocks/code-highlight/code-highlight.html` |
| `flowchart.html` | `registry/blocks/flowchart/flowchart.html` |
| `flowchart-vertical.html` | `registry/blocks/flowchart-vertical/flowchart-vertical.html` |
| `data-chart.html` | `registry/blocks/data-chart/data-chart.html` |
| `mk-specs-list.html` | `registry/blocks/mk-specs-list/mk-specs-list.html` |
| `hw-title.html` | `registry/blocks/hw-title/hw-title.html` |
| `caption-highlight.html` | `registry/components/caption-highlight/caption-highlight.html` |
| `caption-pill-karaoke.html` | `registry/components/caption-pill-karaoke/caption-pill-karaoke.html` |
| `count-up.html` | `registry/components/count-up/count-up.html` |
| `comparison-split.html` | `registry/components/comparison-split/comparison-split.html` |
| `inline-highlight.html` | `registry/components/inline-highlight/inline-highlight.html` |
| `hw-underline.html` | `registry/components/hw-underline/hw-underline.html` |
| `hw-arrow.html` | `registry/components/hw-arrow/hw-arrow.html` |
| `hw-callout-circle.html` | `registry/components/hw-callout-circle/hw-callout-circle.html` |
| `fade-through.html` | `registry/components/fade-through/fade-through.html` |
| `assets/fonts/Caveat-700-latin.woff2` | `registry/components/hw-underline/assets/fonts/Caveat-700-latin.woff2` (Caveat, SIL OFL 1.1; license text at `licenses/OFL-Caveat.txt`) |
| `LICENSE-hyperframes.txt` | `LICENSE` |

Not copied: HeyGen sign-in, API keys, avatars, cloud, Lambda and Cloud Run rendering,
`media-use` network providers, `talking-head-recut`, `product-launch-video`, `pr-to-video`,
frame presets, the interactive slideshow player and the matting pipeline.
