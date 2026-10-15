# Motion and design rules

Read only when editing HTML by hand (manual fallback or a fix). The expander and the templates
already follow these. Adapted from HyperFrames (Apache-2.0): motion-doctrine,
faceless-explainer motion-language and visual-design, hyperframes-creative typography,
video-composition and motion-principles, hyperframes-core determinism rules.

## Motion doctrine

1. **Smooth beats bouncy.** Entrances use `power3.out` (0.5 to 0.8s). Fast arrivals `expo.out`.
   No `back`, `elastic` or `bounce` eases. Exits, where allowed, use `.in` and run about 75%
   of the entrance time.
2. **The voice leads.** At t=0 of a scene only what the voice is saying is on screen. Each
   further piece appears on its spoken cue, spread over the back half of the scene. Dumping
   everything in the first quarter and freezing is the main failure (the slideshow look).
3. **No idle wobble.** No breathing scale loops, floating or glow pulses. A held frame is better
   than bad motion. Something meaningful should be moving at most moments: a reveal landing, an
   edge drawing, an icon drawing its strokes, a count ticking. Two slow movements are allowed, and
   only these: the background grid drifts across the whole video (one linear, transform-only tween,
   `K.drift`), and a picture (a workspace logo) pushes in slowly across its scene (Ken Burns,
   `K.kenBurns`, scale 1 to 1.08, linear). Both are left out with reduced motion.
3a. **Diagrams build up.** Nodes land on their cues; an edge draws (SVG stroke, `K.drawPath`) only once
   both its ends are on screen, then its arrowhead fades in. Icons draw their strokes in (`K.drawIcon`).
3b. **Reduced motion** (Settings > Videos > Motion, written as `data-motion="reduced"` on the root):
   every reveal becomes a short fade, seams cross-fade, counts land on their value, no drift or
   push-in. Meaning stays; movement goes.
4. **Stillness before the key moment.** Leave 0.3 to 0.75s of stillness before the result,
   the takeaway or the final number. Then land it.
5. **One direction.** Ordinary seams push left (the film's current). Up is reserved for the
   conclusion. Never alternate directions. A direction change needs a reason (a new chapter).
6. **Seams are the exit.** Outgoing and incoming stages move together, same axis, same ease,
   same duration, cut mid-motion. Never fade a scene out and then start the next one.
7. **Two or three transition types per video**, repeated. Default: push left; push up for the
   recap; fade-through for a chapter change.
8. **Vary inside a scene.** Not every item enters from `y: 30`. Mix left, right, scale and
   opacity-only. Order of entry is role order (primary, secondary, support; see scene-spec.md § Roles and reading load). Total stagger of a group under 0.5s.
9. **Do not start at exactly 0.** Offset the first reveal 0.1 to 0.3s.

## Layout and type

- Canvas 1920x1080. Content inside 140px side margins and 96px from the top.
- Caption band y 880 to 1040 is reserved. Key content stays above 860.
- The main visual fills 40 to 60% of the frame. Never a small cluster in empty space.
- Three layers per scene: still background (glow, grid), the content, small accents (labels, rules).
- Sizes: hero 100 to 120px, headline 64 to 72px, body 40px, labels 24px. Nothing under 24px.
- Weight contrast is big: 900 or 700 for headings, 400 for body.
- Display tracking tight (-0.03em). Numbers in columns use `tabular-nums`.
- Headlines are full claims ("Tokens refill at a fixed rate"), not labels ("Refill").
- On-screen text: up to 9 words per line. 3 seconds on screen must read in 2.
- No `<br>` in body text. Let `max-width` wrap it.
- Pictures: icons are line icons in amber on a dark tile; technology logos are drawn in ink with the
  brand's own colour as a thin bar under the tile (only when it reads on the dark ground).
- Colour: one accent (amber). Green and red only for good/bad or added/removed (match and gap chips). No pure
  black or white. No purple-blue gradients, no gradient text, no neon.
- Contrast is checked by `hf check` (WCAG AA). Text must read with the background removed.

## Seek-safe rules (the renderer seeks frame by frame)

- One paused timeline: `gsap.timeline({ paused: true })`, registered at the end as
  `window.__timelines["main"] = tl`. The key matches the root `data-composition-id`.
- All motion lives on that timeline. No CSS `transition` or `@keyframes`. No bare `gsap.to()`.
- Entrances use `fromTo` with `opacity` in both states. Never `from()` on an element whose CSS
  already has `opacity: 0`.
- No `Date.now()`, `performance.now()`, `Math.random()`, network fetches, hover or scroll state.
- No `repeat: -1`. Any loop is a finite count.
- Never tween `visibility`, `display` or `autoAlpha` on a `.clip`. Animate a child (`.stage`).
- Never set a CSS `transform` on an element GSAP moves. Center with flex, not `translate(-50%)`.
- Animate transforms and opacity. `width`, `height`, `left`, `top`, `fontSize` and
  `letterSpacing` tweens stutter and fail lint. Grow bars with `scaleX`. Draw an SVG line by tweening
  its `stroke-dashoffset` attribute from 1 to 0 with `pathLength="1"` and `stroke-dasharray="1"`.
- Scaled or moved elements must be block-level with a real size.
- A clip shows on `[start, start + duration)`. Land final states a little before the end.
- Every `<audio>` and `<video>` needs an `id`. No `crossorigin`. Silent video gets `muted`.
- Fonts: only Montserrat and JetBrains Mono (theme) and Caveat (marks, shipped as a file).
- Ids are unique across the whole page. Prefix with the scene id (`s3-n2`).
