# Scene spec (spec.json)

Adapted from HyperFrames (Apache-2.0): faceless-explainer storyboard method and the
registry blocks listed below. The spec is what Claude writes. The expander writes HTML.

## Top level

| Field | Type | Notes |
|-------|------|-------|
| `version` | `1` \| `2` \| `3` | Required. Write `3`. Version 3 turns on the word cap (§ Word cap). Versions 1 and 2 still work. |
| `title` | string | Video title, plain words. |
| `voice_type` | `guide` \| `interview` \| `slides` | Picks the per-type voice in settings. |
| `audio` | path | Usually `narration.wav`. |
| `words` | path | `transcript.json` from `hf transcribe`. Fallback: `narration.timing.json` (`words_estimated`). |
| `captions` | `rail` \| `pill` \| `highlight` \| `none` | Default `rail`. See the video-captions skill. |
| `format` | `1920x1080` | Only landscape in v1. |
| `scenes` | array | In script order. 3 to 9 scenes for a 1 to 2 minute video; about one more per 10 seconds after that, up to 60 for 10 minutes. |

There is no theme field. One theme ships: dark ink ground, warm amber accent, Montserrat for
display and body, JetBrains Mono for code and labels, 140px side margins, caption band at
y 880 to 1040. Source: `templates/video/theme.css`.

## Every scene

| Field | Notes |
|-------|-------|
| `type` | One of the catalog types below. |
| `cue` | 1 to 4 words copied exactly from the script. The scene starts as the voice says it. |
| `marks` | Optional. `[{ "type": "underline"\|"circle"\|"arrow"\|"highlight", "target": "exact on-screen text", "cue": "..." }]`. Max 2 per scene. |
| `chapter` | Optional `true`. Marks a topic change: the seam becomes a fade-through instead of a push. Videos of 5 minutes or more mark the first scene of each chapter (every 1 to 2 minutes); the player lists them. |
| `hold` | Optional seconds of stillness before the scene's last reveal (default 0.4 on recap and stat). |
| `sources` | Optional (required for job, company, pitch and application videos). `[{ "file": "workspace path", "quote"?: "exact words from that file", "url"?: "https link written in a research file" }]`. The key is `file`, never `path`. Items, nodes and quiz beats may carry their own `sources` too. |

Cue rules:
- Cues appear in the script in the same order as in the spec. Item cues sit inside their scene's paragraph.
- Pick the noun or verb that names the thing on screen ("bucket", "refills"), not filler ("so", "now").
- The expander matches cues against `words` after lowercasing and dropping punctuation. A cue
  that is not found is an error, listed with its scene index. Fix the cue, not the timing.

Field rules (version 2):
- Unknown fields are errors, so a typo never drops text silently.
- A `stat` value must appear in one of the scene's cited files, and every `stat` needs a source.
- `quote` is copied exactly. A quote from `me/identity` or `me/employment` is never allowed, even after access was granted.

## Catalog

Limits apply to every type: on-screen lines up to 9 words. Each type's own list limit below is
exact (a bullet-build has at most 4 items, a recap-card exactly 3), and a list past it is an error.

Exact shapes, to copy (the app's check refuses anything else):

```json
{ "file": "me/history/roles.md", "quote": "words copied exactly from that file" }
```

```json
{ "type": "bullet-build", "cue": "Right now", "headline": "I build agents that ship", "sources": [{ "file": "me/history/roles.md" }],
  "items": [{ "text": "Support agents", "cue": "support agents" }, { "text": "Docs retrieval", "cue": "retrieval" }] }
```

```json
{ "type": "recap-card", "cue": "So next", "headline": "Why this job", "sources": [{ "file": "me/history/roles.md" }],
  "items": [{ "text": "LLM agents", "cue": "agents" }, { "text": "Shipping team", "cue": "team" }, { "text": "Real users", "cue": "users" }],
  "closing": "Thanks for listening." }
```

Items in `bullet-build` and `recap-card` are objects with `text` and `cue`, never plain strings.
A comparison side is the one exception: its `items` are plain strings.
The reading budget below applies on top (§ Roles and reading load).

**`title`** `kicker` (2 to 4 words), `title` (a question or claim, up to 9 words), `subtitle?`,
`underline?` (one word of the title to sweep). Built from the theme title card; the sweep
comes from `hw-title`.

**`bullet-build`** `headline` (a full claim), `items[]` (2 to 4) of `{ text, cue }`,
`numbered?` (default true). Built from `mk-specs-list` with theme type.

**`code-typing`** `lang`, `code` (up to 10 lines, 60 characters each), `headline?`, `label?` (a short caption under the code), `cue_done?`.
Types in as the voice introduces it. Source: `code-typing`.

**`code-highlight`** `lang`, `code`, `headline?`, `steps[]` of `{ lines: [n, m], note, cue }` (up to 4).
A bar walks the lines and a note card swaps beside it. Source: `code-highlight`.

**`code-morph`** `lang`, `from`, `to`, `headline?`, `cue_morph`. Tokens glide from before to after.
Use for refactors and "the naive version vs the right version". Source: `code-morph`.

**`code-diff`** `lang`, `before`, `after`, `headline?`, `note`. Removed lines strike out, added lines land.
Source: `code-diff`.

**`flowchart`** `headline`, `direction` (`lr` \| `tb`), `nodes[]` of `{ id, label, sub?, cue }`
(up to 6), `edges[]` of `[from, to, label?]`. Edges link neighbouring nodes only (node 1 to 2, 2 to 3), so the chart reads as one row or column with no crossing lines. A tb flowchart has at most 4 nodes so it clears the caption band. Edges draw just before their target node lands.
Source: `flowchart`, `flowchart-vertical`.

**`sequence`** `headline`, `actors[]` (2 to 4 names), `messages[]` of
`{ from, to, label, cue }` (up to 6). A request flow, one arrow per cue. Built from
`flowchart` primitives.

**`comparison`** `headline`, `left: { label, items[] }`, `right: { label, items[] }`,
`cue_left`, `cue_right`, `verdict?`. Use for trade-offs, or "the job asks" vs "your evidence".
Source: `comparison-split`.

**`stat`** `value` (number), `prefix?`, `suffix?`, `decimals?`, `label`, `source` (required:
where the number comes from), `cue` (the word that says the number). Source: `count-up`.
Never invent a number. No source, no stat scene.

**`quiz`** `kind` (`behavioural` \| `technical` \| `system-design`), `question`,
`think_seconds` (5 to 15, must match the `[pause N]` line in the script),
`beats[]` (4) of `{ label, text, cue }`, `strong[]` (2), `weak[]` (2), `prompt`,
`cue_review` (1 to 4 words where the voice turns to what interviewers listen for; the strong and weak lists land on it).
STAR beats for behavioural; Clarify, Approach, Trade-off, Result for technical.
Source: `templates/video/interview-qa.html`.

**`recap-card`** `headline`, `items[]` (3) of `{ text, cue }`, `closing` (what to practise next).
Enters on the reserved upward seam. Source: theme.

## Visual scenes (version 3)

Show, don't write. The narration carries the detail; a visual scene shows a picture and a few words. Pick the
scene that fits the idea, not a bullet list. Every list entry has its own `cue`, so each piece lands as the voice
says it. Pictures come from the bundled packs (`references/asset-packs.md`): name an `icon` or a `logo`, or leave
both out and the app picks one from the label (a technology name shows its logo; anything unknown shows initials).
Nothing is fetched. The company logo and the job board mark are added by the app from the workspace.

| type | Use it for | Fields |
|------|------------|--------|
| `icon-grid` | skills, requirements, ideas | `headline?`, `items[]` (2 to 6) of `{ label (3 words), icon?, logo?, cue }` |
| `logo-row` | a tech stack, tools | `headline?`, `items[]` (2 to 6) of `{ name, cue }` |
| `diagram` | how something fits or flows | `kind`, `headline?`, `nodes[]` (2 to 8) of `{ id, label (3 words), kind?, group?, icon?, logo?, cue }`, `edges[]` of `{ from, to, label? }`, `groups[]?` (up to 3) of `{ id, label }` |
| `match` | the role's asks against your evidence | `headline?`, `left_label?`, `right_label?`, `rows[]` (2 to 5) of `{ ask (4 words), status, icon?, logo?, cue }` |
| `checklist` | a to-do or yes / partly / no list | `headline?`, `items[]` (2 to 5) of `{ text (4 words), state, cue }` |
| `timeline` | stages, dates, a hiring process | `headline?`, `steps[]` (2 to 5) of `{ label (3 words), when?, icon?, logo?, cue }` |
| `chart` | numbers from a source | `kind` `bar` (`bars[]` 2 to 5 of `{ label, value, cue }`) or `ring` (`value`, `of?` default 100, `label`); `suffix?`, `source`, `headline?` |
| `quote` | one exact line from a source | `text` (12 words, copied exactly), `by` (who said it) |
| `company-card` | who the company is | `name`, `location?`, `size?`, `detail?` |
| `map-pin` | where the job is | `city`, `region?`, `label?` |
| `kinetic` | one punchy line, said and shown big | `lines[]` (1 to 3) of `{ text (4 words), cue }`, `emphasis?` (a word from a line) |
| `matrix` | options against criteria | `headline?`, `cols[]` (2 to 4), `rows[]` (2 to 4) of `{ label, cells[] (yes, partial or no per column), cue }` |

Diagram kinds: `architecture` (node `kind` from the architecture pack: service, queue, database, cache,
load-balancer, gpu, storage, client, peer, api, model, vector-db, worker, router and more), `userflow` (node
`kind` screen, decision, start or end), `pipeline` (steps left to right) and `mesh` (peers in a ring; leave
`edges` empty to link every pair). Nodes appear on their cues; each edge draws once both its ends are on screen.
Match `status` is `match`, `partial` or `gap`; checklist and matrix states are `yes`, `partial` or `no`.

```json
{ "type": "icon-grid", "cue": "More must-haves", "headline": "Must-haves go deep on systems", "sources": [{ "file": "companies/acme-corp/jobs/ai-engineer/jd.md" }],
  "items": [{ "label": "Checkpointing", "icon": "hard-drive", "cue": "Checkpointing" }, { "label": "Async Python", "logo": "python", "cue": "Async Python" }, { "label": "Prometheus", "cue": "Prometheus" }] }
```

Facts: a quote's `text`, a chart's numbers, a company card's location and size and a map pin's city come from a
cited file like any other claim. A `match` row is a claim about the person, so the scene cites `me/history`.

## Word cap

In a version 3 spec, and in every visual scene, a scene shows at most **12 words** of primary and secondary text.
Kickers, source lines, attributions and the labels under pictures (icon-grid, logo-row, diagram, timeline and
matrix labels) don't count; they have their own short limits. Quiz and code scenes are exempt. Over the cap is a
`word_cap` error: the app's check asks Claude to cut the words (or move them into the narration) before you see it.

**`caption-rail`** Not a scene. Set top-level `captions`. `rail` uses `kit.js` captions;
`pill` uses `caption-pill-karaoke`; `highlight` uses `caption-highlight`.

Marks come from `hw-underline`, `hw-callout-circle`, `hw-arrow` and `inline-highlight`.
`data-chart` is vendored for reference; the `chart` scene draws its own bars and ring.

## Roles and reading load

Every piece of on-screen text has a role. It sets the reading order and the reading budget.

| Role | Meaning | Default for |
|------|---------|-------------|
| `primary` | The one thing to read first. At most one per scene. | `title` (title scenes), `headline`, `question`, a stat's `value` |
| `secondary` | The content that carries the message. | items, node labels, notes, `subtitle`, `verdict`, `closing`, a stat's `label` |
| `support` | Context that helps but can be skipped. | `kicker`, node `sub`, `source`, `actors`, `prompt`, side and beat labels |
| `decorative` | No information. Never set by default. | nothing |

The defaults cover most scenes. To change one, add optional `"role"` to an item object:
`items[]`, `nodes[]`, `steps[]`, `messages[]`, `beats[]`, or a comparison side. Plain string
fields keep their default.

- **Entrance order follows role order:** primary, then secondary, then support. Cues still decide
  the exact time, so write the script in that order too.
- **Budget:** primary + secondary + support words ≤ 3.5 × the scene's seconds. Captions and
  decorative text don't count. Code doesn't count either; code has its own line limits.
- **Short scenes:** under 3 seconds, one message element (one primary or secondary item; a
  stat's number and label count as one).
- The spec check estimates each scene's seconds from cue to cue at 2.5 words a second and reports
  a `reading_load` **warning** (never an error) for an over-budget scene, a short scene with more
  than one message, or a second primary. Fix by cutting on-screen words or giving the scene more script.

## Transitions (automatic, not in the spec)

- Ordinary seam: push left, 0.6s, `power3.inOut`, both scenes move together. This is the film's one direction.
- `recap-card` and the final scene: push up (the conclusion rises).
- `chapter: true`: `fade-through` (a topic change).
- The seam is the exit. Scenes never fade their content out before it.
- Last 0.7s: fade to the ground colour.

## Expander contract (built into the JobCairn app: packages/video)

Inputs: `spec.json`, `narration.wav`, word timings (`transcript.json`, else
`narration.timing.json` `words_estimated`).

Output: a composition folder that passes `hf lint` with 0 errors:
`index.html` (one root, `data-composition-id="main"`, 1920x1080, `data-duration` = audio length
rounded up to 0.1s), `theme.css`, `kit.js`, `compositions/<scene>.html` for vendored blocks
with content filled, `assets/fonts/` (Caveat for marks), `narration.wav` mounted as
`<audio id="narration">` at the root.

It must:
1. Resolve every cue to a time. Scene start = cue time minus 0.3s. Scene end = next scene start
   plus 0.6s (seam overlap). Last scene ends at the audio end.
2. Fill block content by data, keep each block's motion, and override colours and fonts with the theme.
3. Never add network assets beyond the pinned GSAP script.
4. Print the resolved timeline (scene, start, end, cue) so Claude can check it against the script.
5. Fail with a clear message on a missing cue, an over-limit field or an unknown type.

Source files: `${CLAUDE_PLUGIN_ROOT}/templates/video/components/` (vendored, headers kept,
Apache-2.0 license file beside them).

## Optional: manim scene

`{ "type": "manim", "cue": "...", "file": "scenes/derivation.py", "class": "Derivation" }`.
For maths that needs real geometry. Manim is an optional engine and is not installed by
default. If it is missing, use `flowchart` or `code-highlight` instead. When present, it renders
the class to a transparent clip that the expander mounts as a muted `<video>`.
