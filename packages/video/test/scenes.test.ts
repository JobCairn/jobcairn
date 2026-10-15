import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { codeLines, buildScene } from "../src/scenes.js";
import { diffLines, highlightLine, tokenize, typeLine } from "../src/code.js";
import { esc, jsJson, n2, pad2 } from "../src/html.js";
import { validateSpec } from "../src/spec.js";
import { SCENE_TYPES, VISUAL_SCENE_TYPES } from "../src/types.js";
import type { SceneTime } from "../src/timeline.js";
import type { Mark, Scene } from "../src/types.js";
import { typeOf } from "./fixtures.js";

const time = (over: Partial<SceneTime> = {}): SceneTime => ({ index: 1, id: "s2", type: "title", cue: 10, start: 10, end: 20, items: {}, marks: [], think: null, ...over });
const ctx = (over: Partial<SceneTime> = {}) => ({ t: time(over), index: 1, count: 5 });
const TIMING_LIMIT_MS = 2000; // generous, to avoid flakiness on slower CI machines

describe("escaping", () => {
  it("escapes text and script data", () => {
    expect(esc(`<b a="1">'&'</b>`)).toBe("&lt;b a=&quot;1&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;");
    expect(esc("a\u0000b\u0007c")).toBe("abc");
    expect(jsJson(["</script>", "\u2028"])).toBe('["\\u003c/script\\u003e","\\u2028"]');
  });

  it("keeps tab and newline but drops the rest of C0, DEL and most default-ignorable code points", () => {
    expect(esc("a\tb\nc")).toBe("a\tb\nc");
    expect(esc("a\u007fb")).toBe("ab");
    // Bidi overrides (U+202E RLO, U+2066 LRI), zero-width space (U+200B) and BOM (U+FEFF) are
    // still stripped - none of these are needed for ordinary text to render correctly.
    expect(esc("a\u202eb\u2066c\u200bd\ufeffe")).toBe("abcde");
    // Soft hyphen (U+00AD) is also stripped.
    expect(esc("a\u00adb")).toBe("ab");
  });

  it("keeps ZWJ, ZWNJ and variation selectors so emoji and scripts that need them still render", () => {
    // U+200D ZWJ (e.g. joins a multi-codepoint emoji sequence), U+200C ZWNJ (breaks a ligature/
    // conjunct in Persian, Hindi, ...), U+FE0F VS-16 (emoji presentation selector).
    expect(esc("a\u200db\u200cc\ufe0fd")).toBe("a\u200db\u200cc\ufe0fd");
  });

  it("never double-escapes when esc is called exactly once", () => {
    expect(esc("&")).toBe("&amp;");
    expect(esc(esc("&"))).not.toBe(esc("&")); // calling it twice is a caller bug, not what builders do
  });

  it("n2 maps non-finite numbers to 0 instead of emitting NaN/Infinity into script", () => {
    expect(n2(NaN)).toBe("0");
    expect(n2(Infinity)).toBe("0");
    expect(n2(-Infinity)).toBe("0");
    expect(n2(1.005 * 10)).not.toMatch(/NaN|Infinity/);
  });

  it("pad2 never emits NaN for a non-finite index", () => {
    expect(pad2(NaN)).toBe("00");
  });
});

describe("code", () => {
  it("highlights a line of TypeScript", () => {
    expect(highlightLine('const x = load("a<b", 2); // go', "ts")).toBe(
      '<span class="k">const</span> x = <span class="f">load</span>(<span class="s">&quot;a&lt;b&quot;</span>, <span class="n">2</span>); <span class="c">// go</span>',
    );
    expect(highlightLine("SELECT name FROM jobs", "sql")).toBe('<span class="k">SELECT</span> name <span class="k">FROM</span> jobs');
    expect(highlightLine("def f(): # hi", "python")).toBe('<span class="k">def</span> <span class="f">f</span>(): <span class="c"># hi</span>');
  });
  it("splits typing into one span per character", () => {
    expect(typeLine("a <b", "ts")).toBe('<span class="ch">a</span><span class="ch"> </span><span class="ch">&lt;</span><span class="ch">b</span>');
  });
  it("diffs lines", () => {
    expect(diffLines(["a", "b", "c"], ["a", "c", "d"])).toEqual([
      { op: "same", text: "a" }, { op: "del", text: "b" }, { op: "same", text: "c" }, { op: "add", text: "d" },
    ]);
  });

  it("stays linear on a 100k-character line with an unterminated string or comment", () => {
    const hostileString = `const a = "${"x".repeat(100_000)}`; // never closes
    const t0 = Date.now();
    const tokensStr = tokenize(hostileString, "ts");
    expect(Date.now() - t0).toBeLessThan(TIMING_LIMIT_MS);
    expect(tokensStr.some((t) => t.cls === "s")).toBe(true);

    const hostileComment = `// ${"y".repeat(100_000)}`; // never ends, no newline
    const t1 = Date.now();
    const tokensComment = tokenize(hostileComment, "ts");
    expect(Date.now() - t1).toBeLessThan(TIMING_LIMIT_MS);
    expect(tokensComment).toEqual([{ cls: "c", text: hostileComment }]);

    // A long run of ordinary identifiers (the case that would blow up with naive per-iteration
    // substring slicing) must also stay fast.
    const hostileIdents = Array.from({ length: 50_000 }, () => "a").join(" ");
    const t2 = Date.now();
    tokenize(hostileIdents, "ts");
    expect(Date.now() - t2).toBeLessThan(TIMING_LIMIT_MS);
  });

  it("falls back to a simple all-del/all-add split above the diff line cap", () => {
    const a = Array.from({ length: 2001 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 2001 }, (_, i) => `b${i}`);
    const t0 = Date.now();
    const rows = diffLines(a, b);
    expect(Date.now() - t0).toBeLessThan(TIMING_LIMIT_MS);
    expect(rows).toHaveLength(a.length + b.length);
    expect(rows.slice(0, a.length).every((r) => r.op === "del")).toBe(true);
    expect(rows.slice(a.length).every((r) => r.op === "add")).toBe(true);
  });

  it("codeLines trims a 200k-newline tail in linear time", () => {
    const code = `const a = 1;${"\n".repeat(200_000)}`;
    const t0 = Date.now();
    const lines = codeLines(code);
    expect(Date.now() - t0).toBeLessThan(TIMING_LIMIT_MS);
    expect(lines).toEqual(["const a = 1;"]);
  });
});

describe("scene builders", () => {
  it("builds a title with an underline and a mark", () => {
    const s: Scene = { type: "title", cue: "Here", kicker: "Lesson", title: "Learn RAG today", subtitle: "Retrieval first", underline: "RAG", marks: [{ type: "highlight", target: "Retrieval", cue: "first" }] };
    const out = buildScene(s, ctx({ marks: [12.5] }));
    expect(out.html).toContain('<section id="s2" class="clip scene" data-start="10" data-duration="10" data-track-index="1">');
    expect(out.html).toContain('<h1 id="s2-title" class="hero">Learn <span id="s2-ul" class="mk mk-underline">RAG<i class="mk-ink"></i></span> today</h1>');
    expect(out.html).toContain('<span id="s2-m0" class="mk mk-highlight">Retrieval<i class="mk-ink"></i></span> first');
    expect(out.js).toContain('K.draw(tl, "#s2-m0 .mk-ink", 12.5, 0.5);');
    expect(out.warnings).toEqual([]);
  });

  it("gives a title's own mark a span even when the title also has an underline (Fix round 1, item 7)", () => {
    // Before the fix, `m.text(s.title)` was called once (to find marks), then discarded whole if
    // `underline` was also set - so the mark's span never made it into the HTML, yet `used[k]`
    // was already (wrongly) set true by that discarded call, so the script still tried to animate
    // a selector that doesn't exist in the DOM, and no warning was ever raised either.
    const s: Scene = {
      type: "title", cue: "x", kicker: "Lesson", title: "Learn RAG about retrieval today", underline: "RAG",
      marks: [{ type: "circle", target: "retrieval", cue: "x" }],
    };
    const out = buildScene(s, ctx());
    expect(out.html).toContain('<span id="s2-m0" class="mk mk-circle">retrieval<i class="mk-ink"></i></span>');
    expect(out.warnings).toEqual([]);
    expect(out.js.some((l) => l.includes("s2-m0"))).toBe(true);
  });

  it("warns, rather than silently dropping the mark, when a title mark's target overlaps the underlined text", () => {
    const s: Scene = { type: "title", cue: "x", kicker: "Lesson", title: "Learn RAG today", underline: "RAG", marks: [{ type: "circle", target: "RAG", cue: "x" }] };
    const out = buildScene(s, ctx());
    expect(out.html).not.toContain("s2-m0");
    expect(out.warnings).toEqual(['Scene 2: the mark "RAG" is not in the on-screen text, so it is not drawn.']);
  });

  it("warns about a mark whose words are not on screen", () => {
    const s: Scene = { type: "bullet-build", cue: "x", headline: "Two things", items: [{ text: "One", cue: "a" }, { text: "Two", cue: "b" }], marks: [{ type: "circle", target: "Three", cue: "b" }] };
    expect(buildScene(s, ctx({ items: { "items.0": 11, "items.1": 13 }, marks: [13] })).warnings).toEqual(['Scene 2: the mark "Three" is not in the on-screen text, so it is not drawn.']);
  });

  it("matches marks by position in the text, not by their order in the marks array (Fix round 1, item 8)", () => {
    // "Second" appears after "First" in the headline, but is listed *first* in `marks`. Before the
    // fix, `text()` tried marks strictly in array order against the current remaining string and
    // only ever recursed on the text *after* whichever match it took - so when the earlier-listed
    // mark's target actually occurs later in the text, the text before it (which holds the other,
    // later-listed mark) was never re-scanned for that other mark at all, and it was wrongly
    // reported as "not on screen" even though it's right there in the headline.
    const s: Scene = {
      type: "bullet-build", cue: "x", headline: "First thing, then Second thing", items: [{ text: "x", cue: "a" }],
      marks: [{ type: "circle", target: "Second", cue: "x" }, { type: "underline", target: "First", cue: "x" }],
    };
    const out = buildScene(s, ctx());
    expect(out.warnings).toEqual([]);
    expect(out.html).toContain('<span id="s2-m0" class="mk mk-circle">Second<i class="mk-ink"></i></span>');
    expect(out.html).toContain('<span id="s2-m1" class="mk mk-underline">First<i class="mk-ink"></i></span>');
    // And "First" must still appear *before* "Second" in the rendered order, proving the earlier
    // occurrence (mark index 1) was matched and wrapped before the later one (mark index 0).
    expect(out.html.indexOf('id="s2-m1"')).toBeLessThan(out.html.indexOf('id="s2-m0"'));
  });

  it("sanitizes a mark's target text in the warning message (Fix round 1, item 9)", () => {
    // sanitizeCueText (shared with captions.ts) normalizes line breaks/default-ignorables and
    // collapses whitespace - it doesn't strip bare C0 controls, so this uses U+2028 (a line
    // separator it does collapse to a space) rather than \u0000, to test what it actually handles.
    const s: Scene = { type: "bullet-build", cue: "x", headline: "Two things", items: [{ text: "One", cue: "a" }], marks: [{ type: "circle", target: "Not\u2028Here", cue: "a" }] };
    const out = buildScene(s, ctx());
    expect(out.warnings).toEqual(['Scene 2: the mark "Not Here" is not in the on-screen text, so it is not drawn.']);
  });

  it("strips remaining C0 controls (e.g. ESC) from a mark's target text in the warning message (Task 11 review)", () => {
    // sanitizeCueText doesn't strip bare C0 controls (see the test above) - a mark's target text
    // is spec input, so a control character like ESC must still never reach a warning line raw.
    const s: Scene = { type: "bullet-build", cue: "x", headline: "Two things", items: [{ text: "One", cue: "a" }], marks: [{ type: "circle", target: "Not\u001bHere", cue: "a" }] };
    const out = buildScene(s, ctx());
    expect(out.warnings).toEqual(['Scene 2: the mark "NotHere" is not in the on-screen text, so it is not drawn.']);
  });

  it("falls back a missing mark time to just after the scene start, not to absolute 0 (Fix round 1, item 4)", () => {
    // `ctx.t.marks` is shorter than the scene's `marks` array - this mirrors what a hostile or
    // just-incomplete timeline would hand the builder. Before the fix, `this.times[k] ?? 0` fell
    // back straight to the literal JS time 0, almost always outside this scene's own window.
    const s: Scene = { type: "bullet-build", cue: "x", headline: "x", items: [{ text: "See the point", cue: "a" }], marks: [{ type: "circle", target: "point", cue: "a" }] };
    const out = buildScene(s, ctx({ start: 50, end: 60, marks: [] }));
    const line = out.js.find((l) => l.includes("s2-m0"))!;
    expect(line).toBeDefined();
    const t = Number(line.match(/,\s*([\d.]+)\s*\);$/)![1]);
    expect(t).toBeGreaterThanOrEqual(50);
    expect(t).toBeLessThanOrEqual(60);
  });

  it("builds a quiz with three panes and think time only when there is a pause", () => {
    const q: Scene = {
      type: "quiz", cue: "Tell", kind: "behavioural", question: "Tell me about a launch.", think_seconds: 8,
      beats: ["Situation", "Task", "Action", "Result"].map((label, i) => ({ label, text: `${label} line`, cue: `c${i}` })),
      strong: ["A number", "Ownership"], weak: ["Only we", "No result"], prompt: "Your turn.", cue_review: "listen",
    };
    const items = { "beats.0": 22, "beats.1": 23, "beats.2": 24, "beats.3": 25, cue_review: 27 };
    const practice = buildScene(q, ctx({ end: 32, items, think: { start: 12, end: 20 } }));
    expect(practice.html).toMatch(/id="s2-q"[\s\S]*id="s2-a" class="pane later"[\s\S]*id="s2-r" class="pane later"/);
    expect(practice.js).toContain('tl.fromTo("#s2-fill", { scaleX: 0 }, { scaleX: 1, duration: 8, ease: "none" }, 12);');
    const watch = buildScene(q, ctx({ end: 32, items, think: null }));
    expect(watch.html).not.toContain("s2-timer");
  });

  it("clamps the think-fill duration so it never runs past the scene end (Task 11 review)", () => {
    // `think` (from the timeline) can span far past a scene that got squeezed short by its
    // neighbours - the fill bar's duration must never let the tween run past `end`, however long
    // the measured silence was.
    const q: Scene = {
      type: "quiz", cue: "x", kind: "behavioural", question: "Q?", think_seconds: 20,
      beats: [{ label: "A", text: "a", cue: "a" }], strong: ["s"], weak: ["w"], prompt: "p", cue_review: "r",
    };
    const out = buildScene(q, ctx({ end: 12, think: { start: 10, end: 30 } }));
    const line = out.js.find((l) => l.includes("-fill"))!;
    expect(line).toContain("duration: 1.9,");
  });

  it("draws vertical edges for a top-to-bottom flow and leaves a gap where no edge is given", () => {
    const f: Scene = {
      type: "flowchart", cue: "x", headline: "Flow", direction: "tb",
      nodes: [{ id: "a", label: "A", cue: "a" }, { id: "b", label: "B", cue: "b" }, { id: "c", label: "C", cue: "c" }], edges: [["a", "b"]],
    };
    const out = buildScene(f, ctx({ items: { "nodes.0": 11, "nodes.1": 12, "nodes.2": 13 } }));
    expect(out.html).toContain('<div class="flow tb">');
    expect(out.html).toContain('<span id="s2-e0" class="edge"></span>');
    expect(out.html).not.toContain('id="s2-e1"');
    expect(out.js).toContain('tl.fromTo("#s2-e0", { scaleY: 0 }, { scaleY: 1, duration: 0.4, ease: "power3.inOut" }, 11.7);');
  });

  it("types code without putting code text in the script", () => {
    const s: Scene = { type: "code-typing", cue: "x", lang: "ts", code: "const a = 1;\nconst b = 2;" };
    const out = buildScene(s, ctx());
    expect(out.html.match(/class="ch/g)).toHaveLength(24);
    expect(out.js.join("\n")).not.toContain("const a");
  });

  it("puts stat affixes into the script only as escaped JSON", () => {
    const s: Scene = { type: "stat", cue: "x", value: 120, prefix: "</scr", suffix: "+", label: "People", source: "About page" };
    const js = buildScene(s, ctx()).js.join("\n");
    expect(js).toContain('K.count(tl, "#s2-num", 0, 120, 10.5, 1.4, { prefix: "\\u003c/scr", suffix: "+", decimals: 0 });');
    expect(js).not.toContain("</scr");
  });

  it("marks deletions and additions in a diff", () => {
    const s: Scene = { type: "code-diff", cue: "x", lang: "ts", before: "let a = 1;", after: "const a = 1;", note: "Use const" };
    const out = buildScene(s, ctx());
    expect(out.html).toContain('class="ln del"');
    expect(out.html).toContain('class="ln add"');
  });

  it("never lets a non-finite stat value or decimals reach the script", () => {
    const s: Scene = { type: "stat", cue: "x", value: NaN, prefix: "", suffix: "", decimals: Infinity as unknown as number, label: "People", source: "About page" };
    const js = buildScene(s, ctx()).js.join("\n");
    expect(js).not.toMatch(/NaN|Infinity/);
  });

  it("maps a mark's type through a fixed class table, never into a raw class name (Fix round 1, item 1)", () => {
    const hostile = { type: '" onclick="alert(1)', target: "word", cue: "a" } as unknown as Mark;
    const s: Scene = { type: "bullet-build", cue: "x", headline: "x", items: [{ text: "the word here", cue: "a" }], marks: [hostile] };
    const out = buildScene(s, ctx());
    expect(out.html).toContain('<span id="s2-m0" class="mk mk-highlight">word<i class="mk-ink"></i></span>'); // unknown type -> safe default
    expect(out.html).not.toContain("onclick");
    expect(out.js.some((l) => l.includes('K.draw(tl, "#s2-m0 .mk-ink"'))).toBe(true); // js branch agrees with the same table
  });

  it("clamps code-highlight line numbers into 1..lines.length before writing them anywhere (Fix round 1, item 2)", () => {
    const s: Scene = {
      type: "code-highlight", cue: "x", lang: "ts", code: "a();\nb();", // 2 lines
      steps: [{ lines: [NaN, 999] as unknown as [number, number], note: "x", cue: "a" }],
    };
    const out = buildScene(s, ctx());
    expect(out.html).toContain(">lines 1 to 2<"); // clamped into [1, lines.length], not "NaN"/"999"
    expect(out.html).not.toMatch(/NaN|999/);
    expect(out.js.join("\n")).not.toMatch(/NaN|999/);
  });
});

describe("linear trimming of a huge trailing-newline tail (Fix round 1, item 3)", () => {
  it("buildScene stays fast on a code-typing scene with 200k trailing newlines", () => {
    const s: Scene = { type: "code-typing", cue: "x", lang: "ts", code: `const a = 1;${"\n".repeat(200_000)}` };
    const t0 = Date.now();
    const out = buildScene(s, ctx());
    expect(Date.now() - t0).toBeLessThan(TIMING_LIMIT_MS);
    // One code line only (typeLine renders one character per `<span class="ch">`, so the single
    // "const a = 1;" line never appears as a contiguous substring) - proves the 200k-newline tail
    // was trimmed away rather than turning into 200,000 extra blank `<span class="ln">` lines.
    expect(out.html.match(/<span class="ln">/g)).toHaveLength(1);
  });

  it("validateSpec stays fast on a code-typing scene with 200k trailing newlines", () => {
    const script = ["Here is your lesson on recursion.", "Watch this code run.", "Now remember the pattern."].join("\n\n") + "\n";
    const spec = {
      version: 2 as const, title: "A lesson", voice_type: "guide" as const,
      scenes: [
        { type: "title" as const, cue: "Here is", kicker: "Lesson", title: "A lesson on recursion" },
        { type: "code-typing" as const, cue: "Watch this", lang: "ts", code: `const a = 1;${"\n".repeat(200_000)}` },
        {
          type: "recap-card" as const, cue: "Now remember", headline: "What to remember",
          items: [{ text: "Keep practicing", cue: "remember" }, { text: "It compiles", cue: "pattern" }], closing: "Good luck.",
        },
      ],
    };
    const t0 = Date.now();
    const r = validateSpec(spec, { type: typeOf("skill-gap-lesson"), script });
    expect(Date.now() - t0).toBeLessThan(TIMING_LIMIT_MS);
    const codeErr = r.issues.find((i) => i.path === "code");
    expect(codeErr).toBeUndefined();
  });
});

describe("finite, clamped times for very short scenes (Fix round 1, item 4)", () => {
  // Every reveal/draw/seam/count time this library ever emits into generated JS must be a finite
  // number inside the scene's own [start, end] window, even when the scene is far too short for
  // its usual choreography (0.3s, or even 0.05s - shorter than the 0.1s "just after start" margin
  // every other builder assumes it has).
  const callTimes = (js: string[]): number[] => {
    const text = js.join("\n");
    const times: number[] = [];
    const push = (re: RegExp, group = 1) => { for (const m of text.matchAll(re)) times.push(Number(m[group])); };
    push(/K\.reveal\(tl, "#[^"]+", (-?[\d.]+),/g);
    push(/K\.draw\(tl, "#[^"]+", (-?[\d.]+),/g);
    push(/K\.count\(tl, "#[^"]+", -?[\d.]+, -?[\d.]+, (-?[\d.]+),/g);
    push(/tl\.to\("#[^"]+", \{[^}]*\}, (-?[\d.]+)\);/g);
    push(/tl\.fromTo\("#[^"]+", \{[^}]*\}, \{[^}]*\}, (-?[\d.]+)\);/g);
    push(/tl\.set\(el, \{ opacity: 1 \}, (-?[\d.]+) \+ i \*/g); // code-typing's t0
    return times;
  };

  for (const [label, start, end] of [["0.3s scene", 10, 10.3], ["0.05s scene", 10, 10.05]] as const) {
    it(`every emitted time is finite and inside [start, end] for a ${label}`, () => {
      const scenes: Scene[] = [
        { type: "title", cue: "x", kicker: "K", title: "T word here", subtitle: "S", underline: "word" },
        { type: "stat", cue: "x", value: 42, label: "L", source: "Src" },
        {
          type: "quiz", cue: "x", kind: "behavioural", question: "Q?", think_seconds: 5,
          beats: [{ label: "A", text: "a", cue: "a" }], strong: ["s"], weak: ["w"], prompt: "p", cue_review: "a",
        },
        { type: "code-typing", cue: "x", lang: "ts", code: "const a = 1;" },
        { type: "bullet-build", cue: "x", headline: "H", items: [{ text: "one", cue: "a" }] },
        { type: "flowchart", cue: "x", headline: "H", direction: "lr", nodes: [{ id: "a", label: "A", cue: "a" }, { id: "b", label: "B", cue: "b" }], edges: [["a", "b"]] },
      ];
      for (const s of scenes) {
        const c = ctx({ start, end, think: s.type === "quiz" ? { start: start + 0.01, end: start + 0.02 } : null, marks: [start + 0.01] });
        const out = buildScene(s, c);
        const combined = out.js.join("\n");
        expect(combined).not.toMatch(/NaN|Infinity/);
        for (const t of callTimes(out.js)) {
          expect(Number.isFinite(t)).toBe(true);
          expect(t).toBeGreaterThanOrEqual(start - 1e-9);
          expect(t).toBeLessThanOrEqual(end + 1e-9);
        }
      }
    });
  }

  it("code-typing clamps its per-character step so the last character lands by end - 0.4, even from a non-finite cue_done", () => {
    const s: Scene = { type: "code-typing", cue: "x", lang: "ts", code: "const a = 1;\nconst b = 2;", cue_done: "x" };
    const out = buildScene(s, ctx({ items: { cue_done: NaN } }));
    const line = out.js.find((l) => l.includes(".ch"))!;
    const m = line.match(/tl\.set\(el, \{ opacity: 1 \}, ([\d.]+) \+ i \* ([\d.]+)\)/)!;
    const t0 = Number(m[1]), dt = Number(m[2]);
    expect(Number.isFinite(t0)).toBe(true);
    expect(Number.isFinite(dt)).toBe(true);
    expect(dt).toBeGreaterThan(0);
    const chars = 24; // "const a = 1;" + "const b = 2;" = 12 + 12
    expect(t0 + chars * dt).toBeLessThanOrEqual(ctx().t.end - 0.4 + 1e-9);
  });
});

describe("XSS: hostile spec/script text never reaches script, a URL, or breaks out of an attribute", () => {
  const PAYLOAD = '</script><script>alert(1)</script>"><img src=x onerror=alert(1)>javascript:alert(1){{x}}\u2028\u202e';
  // Two distinct substrings used as mark targets, deliberately embedded so the *second* one
  // (MARK_B) occurs before the first (MARK_A) in the text, and listed in the marks array in that
  // same "wrong" order - so this also exercises order-independent mark matching (item 8) inside
  // the full XSS sweep, not just the dedicated unit test above.
  const MARK_A = 'alpha"onerror=1';
  const MARK_B = "beta<bad>tag";
  const MARKED = `lead ${MARK_B} mid </script><script>alert(1)</script> ${MARK_A} tail \u2028\u202e`;
  const MARKS: Mark[] = [{ type: "circle", target: MARK_A, cue: "x" }, { type: "arrow", target: MARK_B, cue: "x" }];

  function sceneFor(type: Scene["type"]): Scene {
    switch (type) {
      case "title":
        return { type: "title", cue: "x", kicker: PAYLOAD, title: PAYLOAD, subtitle: MARKED, marks: MARKS };
      case "bullet-build":
        return { type: "bullet-build", cue: "x", headline: PAYLOAD, items: [{ text: MARKED, cue: "a" }], marks: MARKS };
      case "code-typing":
        return { type: "code-typing", cue: "x", lang: "ts", headline: MARKED, label: PAYLOAD, code: `const s = "${PAYLOAD}";`, marks: MARKS };
      case "code-highlight":
        return { type: "code-highlight", cue: "x", lang: "ts", headline: MARKED, code: `const s = "${PAYLOAD}";`, steps: [{ lines: [1, 1], note: PAYLOAD, cue: "a" }], marks: MARKS };
      case "code-morph":
        return { type: "code-morph", cue: "x", lang: "ts", headline: MARKED, from: `const s = "${PAYLOAD}";`, to: `const t = "${PAYLOAD}";`, cue_morph: "a", marks: MARKS };
      case "code-diff":
        return { type: "code-diff", cue: "x", lang: "ts", headline: MARKED, before: `const s = "${PAYLOAD}";`, after: `const t = "${PAYLOAD}";`, note: PAYLOAD, marks: MARKS };
      case "flowchart":
        return {
          type: "flowchart", cue: "x", headline: PAYLOAD, direction: "lr",
          nodes: [{ id: "a", label: MARKED, sub: PAYLOAD, cue: "a" }, { id: "b", label: PAYLOAD, cue: "b" }], edges: [["a", "b", PAYLOAD]], marks: MARKS,
        };
      case "sequence":
        return {
          type: "sequence", cue: "x", headline: PAYLOAD, actors: [PAYLOAD, "B"],
          messages: [{ from: PAYLOAD, to: "B", label: MARKED, cue: "a" }], marks: MARKS,
        };
      case "comparison":
        return {
          type: "comparison", cue: "x", headline: PAYLOAD, left: { label: MARKED, items: [PAYLOAD] }, right: { label: PAYLOAD, items: [PAYLOAD] },
          cue_left: "a", cue_right: "b", verdict: PAYLOAD, marks: MARKS,
        };
      case "stat":
        return { type: "stat", cue: "x", value: 42, prefix: PAYLOAD, suffix: PAYLOAD, label: MARKED, source: PAYLOAD, marks: MARKS };
      case "quiz":
        return {
          type: "quiz", cue: "x", kind: "behavioural", question: MARKED, think_seconds: 0,
          beats: [{ label: PAYLOAD, text: PAYLOAD, cue: "a" }], strong: [PAYLOAD], weak: [PAYLOAD], prompt: PAYLOAD, cue_review: "b", marks: MARKS,
        };
      case "recap-card":
        return { type: "recap-card", cue: "x", headline: PAYLOAD, items: [{ text: MARKED, cue: "a" }], closing: PAYLOAD, marks: MARKS };
      default:
        return visualSceneFor(type);
    }
  }

  /** Every visual scene with the payload in each text field and in each pack name (icon, logo, kind). */
  function visualSceneFor(type: Scene["type"]): Scene {
    const P = { icon: PAYLOAD, logo: PAYLOAD };
    switch (type) {
      case "icon-grid": return { type, cue: "x", headline: MARKED, items: [{ label: PAYLOAD, cue: "a", ...P }, { label: "Prometheus", cue: "b" }, { label: "Data sharding", cue: "c" }], marks: MARKS };
      case "logo-row": return { type, cue: "x", headline: MARKED, items: [{ name: PAYLOAD, cue: "a" }, { name: "Python", cue: "b" }], marks: MARKS };
      case "diagram": return {
        type, cue: "x", kind: "architecture", headline: MARKED, groups: [{ id: "g", label: PAYLOAD }],
        nodes: [{ id: "a", label: PAYLOAD, kind: PAYLOAD, group: "g", cue: "a", ...P }, { id: "b", label: "Queue", kind: "queue", cue: "b" }],
        edges: [{ from: "a", to: "b", label: PAYLOAD }], marks: MARKS,
      };
      case "match": return { type, cue: "x", headline: MARKED, left_label: PAYLOAD, right_label: PAYLOAD, rows: [{ ask: PAYLOAD, status: "gap", cue: "a", ...P }, { ask: "Python", status: PAYLOAD as never, cue: "b" }], marks: MARKS };
      case "checklist": return { type, cue: "x", headline: MARKED, items: [{ text: PAYLOAD, state: "yes", cue: "a" }, { text: PAYLOAD, state: PAYLOAD as never, cue: "b" }], marks: MARKS };
      case "timeline": return { type, cue: "x", headline: MARKED, steps: [{ label: PAYLOAD, when: PAYLOAD, cue: "a", ...P }, { label: "Ship", cue: "b" }], marks: MARKS };
      case "chart": return { type, cue: "x", kind: "bar", headline: MARKED, bars: [{ label: PAYLOAD, value: 3, cue: "a" }, { label: "B", value: NaN, cue: "b" }], label: PAYLOAD, suffix: PAYLOAD, source: PAYLOAD, marks: MARKS };
      case "quote": return { type, cue: "x", text: MARKED, by: PAYLOAD, marks: MARKS };
      case "company-card": return { type, cue: "x", name: MARKED, location: PAYLOAD, size: PAYLOAD, detail: PAYLOAD, marks: MARKS };
      case "map-pin": return { type, cue: "x", city: MARKED, region: PAYLOAD, label: PAYLOAD, marks: MARKS };
      case "kinetic": return { type, cue: "x", lines: [{ text: MARKED, cue: "a" }, { text: PAYLOAD, cue: "b" }], emphasis: PAYLOAD, marks: MARKS };
      case "matrix": return { type, cue: "x", headline: MARKED, cols: [PAYLOAD, "B"], rows: [{ label: PAYLOAD, cells: ["yes", PAYLOAD as never], cue: "a" }], marks: MARKS };
      default: throw new Error(`no hostile sample for ${type}`);
    }
  }

  const ALLOWED_TAGS = new Set(["section", "div", "p", "span", "h1", "h2", "i"]);
  const ALLOWED_CLASSES = new Set([
    "stage", "clip", "scene", "center", "kicker", "rule", "hero", "lede", "sub",
    "mk", "mk-underline", "mk-circle", "mk-arrow", "mk-highlight", "mk-ink",
    "bullets", "bullet", "label", "body", "step", "card", "trio", "close",
    "cols", "col", "good", "bad", "verdict", "big", "num", "accent", "foot",
    "pane", "later", "q", "timer", "track", "fill", "beats", "beat", "turn",
    "flow", "tb", "edge-wrap", "edge", "edge-label", "node", "h", "h2", "head",
    "seq", "actor", "msg", "rev", "arrow",
    "code", "code-wrap", "ln", "ch", "k", "s", "n", "f", "c", "code-hl",
    "split", "notes", "note", "morph", "diff", "sign", "bar", "add", "del", "same",
  ]);
  const ID_RE = /^s\d+(-[a-z]+\d*)*$/;

  function assertSafeDom(html: string): void {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    const all = Array.from(dom.window.document.body.querySelectorAll("*"));
    expect(all.length).toBeGreaterThan(0);
    for (const el of all) {
      expect(ALLOWED_TAGS.has(el.tagName.toLowerCase())).toBe(true);
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        expect(name === "id" || name === "class" || name === "style" || name.startsWith("data-")).toBe(true);
        if (name === "id") expect(attr.value).toMatch(ID_RE);
        if (name === "class") {
          for (const token of attr.value.split(/\s+/).filter(Boolean)) expect(ALLOWED_CLASSES.has(token)).toBe(true);
        }
        if (name === "style") {
          const stripped = attr.value.replace(/--cols|grid-row|grid-column/g, "").replace(/[:;]/g, " ");
          expect(stripped).toMatch(/^[\s\d/]*$/);
        }
      }
    }
  }

  // Visual scenes add SVG pictures, an <img> for a workspace logo, and positioned diagram boxes. Their own allow-list:
  // pack and layout numbers only in geometry attributes, an assets/ path only in src, and no spec text anywhere but
  // escaped text nodes.
  const VISUAL_TAGS = new Set([...ALLOWED_TAGS, "svg", "path", "circle", "rect", "line", "ellipse", "polyline", "polygon", "g", "img"]);
  const GEOMETRY = new Set(["d", "points", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "viewbox", "transform", "pathlength", "stroke-dasharray", "stroke-dashoffset"]);
  const PRESENTATION = new Set(["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "aria-hidden", "preserveaspectratio", "alt"]);
  function assertSafeVisualDom(html: string): void {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    const all = Array.from(dom.window.document.body.querySelectorAll("*"));
    for (const el of all) {
      expect(VISUAL_TAGS.has(el.tagName.toLowerCase())).toBe(true);
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("data-")) continue;
        if (name === "id") expect(attr.value).toMatch(ID_RE);
        else if (name === "class") expect(attr.value).toMatch(/^[a-z0-9 -]*$/);
        else if (name === "style") expect(attr.value.replace(/--cols|--brand|left|top|width|height|px|#[0-9a-f]{6}/g, "").replace(/[:;.\s-]/g, "")).toMatch(/^\d*$/);
        else if (name === "src") expect(attr.value).toMatch(/^assets\/[a-z0-9-]+\.(png|jpe?g|webp|svg)$/);
        else if (GEOMETRY.has(name)) expect(attr.value).toMatch(/^[-\d.\sMLCZHVSQTAmlczhvsqta,()rotaensl]*$/);
        else if (PRESENTATION.has(name)) expect(attr.value).not.toContain("<");
        else throw new Error(`unexpected attribute ${name}`);
      }
    }
  }

  it.each(VISUAL_SCENE_TYPES)("visual scene %s: safe markup, pack names never interpolated, no spec text in the script", (type) => {
    const out = buildScene(sceneFor(type), ctx({ marks: [10.1, 10.2] }));
    assertSafeVisualDom(out.html);
    expect(out.html).not.toContain("<script");
    const js = out.js.join("\n");
    expect(js).not.toMatch(/NaN|Infinity/);
    if (type === "chart") expect(js).toContain(jsJson(PAYLOAD));
    else expect(js).not.toContain(PAYLOAD);
    expect(js).not.toContain(MARK_A);
  });

  it.each(SCENE_TYPES.filter((t) => !(VISUAL_SCENE_TYPES as readonly string[]).includes(t)))("scene type %s: safe tags/attributes/ids/classes/styles, and no spec text in the script", (type) => {
    const scene = sceneFor(type);
    const out = buildScene(scene, ctx({ think: type === "quiz" ? { start: 10.2, end: 10.4 } : null, marks: [10.1, 10.2] }));

    assertSafeDom(out.html);

    const js = out.js.join("\n");
    expect(js).not.toMatch(/NaN|Infinity/);
    if (type === "stat") {
      // The only place spec text is allowed in the script at all: the stat affixes, JSON-encoded.
      expect(js).toContain(jsJson(PAYLOAD));
    } else {
      expect(js).not.toContain(PAYLOAD);
      expect(js).not.toContain(MARK_A);
      expect(js).not.toContain(MARK_B);
    }
    // Marks were found and wrapped (not silently dropped) wherever this scene type has a
    // mark-capable text field.
    expect(out.warnings).toEqual([]);
  });

  it("jsJson output can never close a script block even when fed the raw payload", () => {
    const encoded = jsJson(PAYLOAD);
    expect(encoded).not.toContain("</script>");
    expect(encoded).not.toContain("<script");
    expect(encoded).not.toContain("\u2028");
    expect(encoded).not.toContain("\u2029");
    // Round-trips back to the exact original string for a well-behaved consumer.
    expect(JSON.parse(encoded.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&"))).toBe(PAYLOAD);
  });
});
