# Brief and script

Adapted from HyperFrames (Apache-2.0): faceless-explainer story design, hyperframes-creative
story spine and narration guide.

## 1. Brief (write it in one message, then ask "Make it like this?")

- **Strategy line:** "This video teaches <who> <one idea> so they can <outcome>."
- **Source:** the JD line, the interview question, or the topic the user named. Quote it.
- **Length:** the length asked for, at 2.5 words per second (90s is about 225 words). Quick is
  about 1 minute, Standard 2 to 3, In-depth 5 to 8. Hard cap 10 minutes.
- **Longer videos:** more scenes and chapters, never more words per scene. Scenes still run 4 to
  15 seconds with 1 to 3 short sentences, on-screen words stay within 3.5 per second, and the
  narration pace does not change. From 5 minutes, split the video into chapters of 1 to 2
  minutes and set `"chapter": true` on the first scene of each chapter (after the title).
- **Scene table:** one row per scene: `type · cue · what is on screen · seconds · why it is there`.
  A scene whose "why" does not serve the strategy line gets cut.
- **Pacing:** calm or editorial scenes run 4 to 8 seconds, fast ones 2.5 to 5. A scene under
  3 seconds carries one message. On-screen words stay within 3.5 per second
  (`scene-spec.md` § Roles and reading load).

## 2. Pick one structure

| Structure | Use when | Shape |
|-----------|----------|-------|
| Concept | One idea the viewer half knows | hook → name it → mechanism layer by layer → so what → recap |
| How-to | An ordered procedure | hook → 3 to 5 steps on one stage → recap |
| Compare | Two options or before/after | hook → option A → option B → when to pick which → recap |
| Drill | One interview question | question + think time → model answer → strong vs weak → your turn |

Do not follow the source's paragraph order. Reorder, merge, cut. The thesis lands by scene 2.

## 3. Hook (first 5 seconds)

The strongest visual is on screen by 1.5 seconds. Pick one: a real question the viewer has ("Why does my API return 429?"), a common belief
that is wrong, a concrete stake ("This comes up in most backend interviews"), or a scenario
("Imagine a thousand clients hit you at once"). Never open with a definition or "In this video".

## 4. Make each scene land

Name the technique per scene: analogy, worked example with real numbers, before/after,
counterexample (where it breaks), frame-then-fill (state the shape, then fill it), rule of
three, callback to the hook. Write "explain X" and you have no technique yet.

## 5. Script rules

- One paragraph per scene, blank line between. 1 to 3 short sentences each.
- 2.3 to 2.6 words per second (the narrator averages about 2.5). The script should feel a bit
  short for the video. Count each paragraph's words and set its seconds from that count, not
  from a guess, before you write the spec.
- Write each sentence as discrete cues: "First the bucket. Then the refill. Then the spend."
  Each named noun is a reveal cue. One long clause gives the visuals nothing to land on.
- Say numbers the way a person says them: "about two hundred milliseconds", "ten times".
  The screen can show the exact figure.
- Spell out acronyms the first time if a listener could mishear them ("A P I" is not needed,
  "J W T" is). Keep code identifiers off the voice where possible; show them on screen.
- Contractions are good. Vary sentence length. Read it aloud in your head.
- Expression tags (Supertonic only): `<breath>` before a turn, `<laugh>` after a light line,
  `<sigh>` on a familiar pain. At most one tag per 30 seconds. Never in a drill question.
- Think time in drills: a paragraph that is only `[pause 8]`.
- Lines starting with `#` are notes for you; the narrator skips them.

## 6. Recipes

**JD-gap lesson** (`learning/<topic-slug>/`). Source is the job ad line. Hook on why the role
needs it. Teach the core mechanism with one diagram scene and one code or example scene.
End with "how to talk about it in an interview" as the recap closing line. Do not claim the
candidate has the skill.

**Interview explainer** (`companies/<slug>/jobs/<id>/interview/<slug>/`). What the
interviewer is testing, the shape of a strong answer, one common trap.

**Question drill** (same folder). Scene 1 `quiz`: question verbatim, `[pause N]`. Model
answer uses the candidate's real experience from their profile when it fits. Otherwise use a
neutral example and say it is an example. Behavioural: STAR. Technical: Clarify, Approach,
Trade-off, Result. End with the practice prompt.

## 7. Facts and voice check (before narrating)

- Every technical claim is correct and current. If unsure, say less, not more.
- Facts about the candidate come from their profile and resume only. No invented metrics.
- No employer secrets, client names or internal project names.
- Short plain sentences. No em-dashes. No "unlock", "seamless", "dive in", "game-changer".
- Example names: use "Alex Example", never a real person.
