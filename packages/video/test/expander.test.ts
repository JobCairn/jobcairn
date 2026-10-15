import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildHtml, COMP_FILES, expand, FONTS_REL, FONTS_SRC_REL, SWAP_PENDING, VIDEO_FONTS } from "../src/expander.js";
import { requireValidated, validateSpec, type ValidatedSpec } from "../src/spec.js";
import type { CaptionStyle } from "../src/types.js";
import { CATALOG_SCRIPT, catalogSpec, catalogType } from "./catalog.js";
import { fakeWords, JD_SCRIPT, jdSpec, typeOf } from "./fixtures.js";
import { TEMPLATES, tmpDir } from "./helpers.js";

const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");

const jd = (spec = jdSpec(), script = JD_SCRIPT, captions: "rail" | "pill" | "highlight" | "none" = "rail") => {
  const { words, total } = fakeWords(script);
  const validated = requireValidated(validateSpec(spec, { type: typeOf("jd-walkthrough"), script }));
  return buildHtml(validated, words, total, captions);
};

/** A workspace root with a composition folder inside it, narration.wav already in place, and a
 * genuinely validated JD-walkthrough spec. Used by every `expand` test below so each gets a fresh
 * temp root and doesn't share state (symlinks, leftover work/ dirs, ...) with any other test. */
function setup() {
  const root = tmpDir();
  const folder = path.join(root, "companies", "acme-corp", "videos", "jd-1");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "narration.wav"), "RIFF fake");
  const { words, total } = fakeWords(JD_SCRIPT);
  const validated = requireValidated(validateSpec(jdSpec(), { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));
  return { root, folder, words, total, validated };
}

describe("buildHtml", () => {
  it("matches the golden JD walkthrough", async () => {
    const r = jd();
    expect(r.timeline.issues).toEqual([]);
    expect(r.warnings).toEqual([]);
    await expect(r.html).toMatchFileSnapshot("./golden/jd-walkthrough.html");
  });

  it("matches the golden file for every catalog type", async () => {
    const { words, total } = fakeWords(CATALOG_SCRIPT);
    const validated = requireValidated(validateSpec(catalogSpec(), { type: catalogType(), script: CATALOG_SCRIPT, mode: "practice" }));
    const r = buildHtml(validated, words, total, "rail");
    expect(r.timeline.issues).toEqual([]);
    expect(r.html.match(/<section id="s\d+" class="clip scene"/g)).toHaveLength(12);
    await expect(r.html).toMatchFileSnapshot("./golden/catalog.html");
  });

  it("has the composition contract HyperFrames needs and no network address", () => {
    const { html } = jd();
    expect(html).toContain('<div id="root" class="cap-rail" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="27.25">');
    expect(html).toContain('<script src="vendor/gsap/dist/gsap.min.js"></script>');
    expect(html).toContain('<audio id="narration" src="narration.wav" data-start="0" data-track-index="10"></audio>');
    expect(html).toContain('window.__timelines["main"] = tl;');
    expect(html).toContain('K.seam(tl, "#s1-stage", "#s2-stage", 6.25, "left", SEAM);');
    expect(html).toContain('K.seam(tl, "#s3-stage", "#s4-stage", 20.75, "up", SEAM);');
    expect(html).not.toMatch(/https?:/);
  });

  it("keeps hostile text out of the script (Review Focus 3)", () => {
    const spec = jdSpec();
    Object.assign(spec.scenes[0]!, { kicker: `{{SLOT}} "q" 'a'`, title: "</script><img src=x onerror=alert(1)>", subtitle: "مرحبا 👋 שלום" });
    const { words, total } = fakeWords(JD_SCRIPT);
    words[0]!.text = "</script><b>";
    const validated = requireValidated(validateSpec(spec, { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));
    const { html } = buildHtml(validated, words, total, "rail");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("{{SLOT}} &quot;q&quot; &#39;a&#39;");
    expect(html).toContain("مرحبا 👋 שלום");
    expect(html).toContain("\\u003c/script\\u003e\\u003cb\\u003e");
    expect(html.match(/<script/g)).toHaveLength(4);
  });

  // The transcript embedded for captions (TRANSCRIPT, via jsJson) is built from `words`, which is
  // untrusted the same way any narrated text is. jsJson alone only neutralises what could break
  // out of the <script> tag (< > & and the two line-terminator code points); it doesn't strip bidi
  // overrides or other invisible characters, so a hostile or malformed word could otherwise carry
  // an RLO override or a zero-width space straight into the page. Every video type shares this one
  // buildHtml, so the fix (stripInvisible, same set esc() uses) covers all of them, not just one
  // template.
  it("strips bidi overrides and other invisible characters from the transcript, keeping ZWJ/ZWNJ/VS16", () => {
    const { words, total } = fakeWords(JD_SCRIPT);
    // RLO, ZWSP, BOM mixed in with ZWJ, ZWNJ and VS16 - the first three must go, the last three
    // must survive (ZWJ/ZWNJ join emoji/script sequences, VS16 picks an emoji's presentation).
    words[0]!.text = "a‮b​c﻿d‍E‌F️G";
    const validated = requireValidated(validateSpec(jdSpec(), { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));
    const { html } = buildHtml(validated, words, total, "rail");
    expect(html).not.toMatch(/‮/);
    expect(html).not.toMatch(/​/);
    expect(html).not.toMatch(/﻿/);
    expect(html).toContain("abcd‍E‌F️G");
  });

  it("applies the caption style", () => {
    expect(jd(jdSpec(), JD_SCRIPT, "pill").html).toContain('class="cap-pill"');
    expect(jd(jdSpec(), JD_SCRIPT, "pill").html).toContain("K.captions(tl, W, { until: END - 0.7, maxWords: 3, maxChars: 24 });");
    expect(jd(jdSpec(), JD_SCRIPT, "none").html).not.toContain("K.captions(");
  });

  it("fades through a chapter break", () => {
    const spec = jdSpec();
    spec.scenes[2]!.chapter = true;
    expect(jd(spec).html).toContain('tl.fromTo("#fade", { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power2.in" }, 12.85);');
  });

  it("refuses a spec that failed validation before it can reach buildHtml (Task 10 review)", () => {
    // Carried from the Task 10 review: buildHtml must only ever receive a VALIDATED spec. That's
    // structural (buildHtml's parameter type is ValidatedSpec, producible only by
    // requireValidated), and requireValidated itself refuses here at runtime: an unknown scene
    // type never gets a chance to reach buildScene/buildHtml.
    const spec = jdSpec();
    (spec.scenes[0] as unknown as { type: string }).type = "bogus-type";
    const result = validateSpec(spec, { type: typeOf("jd-walkthrough"), script: JD_SCRIPT });
    expect(() => requireValidated(result)).toThrow(/"bogus-type" is not a scene type/);
  });
});

// Fix round 1: the ValidatedSpec *type* alone doesn't stop a cast, a value parsed fresh from
// JSON, or a spread copy of a genuinely validated spec from typechecking as one too - all four
// still reach buildHtml/expand without ever calling requireValidated. The real guard is
// isValidated (spec.ts's module-level WeakSet, checked at runtime), tested directly here.
describe("the ValidatedSpec guarantee can't be bypassed (Fix round 1)", () => {
  it("refuses a spec that was only cast to ValidatedSpec, never validated", () => {
    const spec = jdSpec() as unknown as ValidatedSpec;
    const { words, total } = fakeWords(JD_SCRIPT);
    expect(() => buildHtml(spec, words, total, "rail")).toThrow(/wasn't checked/);
  });

  it("refuses a spec parsed fresh from JSON and cast to ValidatedSpec", () => {
    const raw = JSON.parse(JSON.stringify(jdSpec())) as ValidatedSpec;
    const { words, total } = fakeWords(JD_SCRIPT);
    expect(() => buildHtml(raw, words, total, "rail")).toThrow(/wasn't checked/);
  });

  it("refuses a spread copy of a genuinely validated spec (same shape, different object)", () => {
    const validated = requireValidated(validateSpec(jdSpec(), { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));
    const copy = { ...validated } as ValidatedSpec;
    const { words, total } = fakeWords(JD_SCRIPT);
    expect(() => buildHtml(copy, words, total, "rail")).toThrow(/wasn't checked/);
  });

  it("a mutation of the original spec object after validation never reaches the validated clone", () => {
    const spec = jdSpec();
    const validated = requireValidated(validateSpec(spec, { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));
    (spec.scenes[0] as unknown as { type: string }).type = "bogus-type"; // mutate the ORIGINAL object
    const { words, total } = fakeWords(JD_SCRIPT);
    expect(() => buildHtml(validated, words, total, "rail")).not.toThrow(); // the clone never saw it
  });

  it("expand refuses a spec that wasn't validated, before touching the filesystem", () => {
    const { root, folder, words, total } = setup();
    const spec = jdSpec() as unknown as ValidatedSpec;
    expect(() => expand({ folder, root, spec, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP })).toThrow(/wasn't checked/);
    expect(fs.existsSync(path.join(folder, "comp"))).toBe(false);
    expect(fs.existsSync(path.join(folder, "work"))).toBe(false);
  });
});

// Fix round 1: captions reached the HTML unchecked - CAPTION_OPTIONS[captions] resolves an
// inherited key like "constructor" to a live value, and class="cap-${captions}" is unescaped.
describe("buildHtml refuses an unknown caption style (Fix round 1)", () => {
  it("refuses HTML-injection text instead of interpolating it unescaped into the class attribute", () => {
    const validated = requireValidated(validateSpec(jdSpec(), { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));
    const { words, total } = fakeWords(JD_SCRIPT);
    const hostile = '"><img src=x onerror=alert(1)>' as unknown as CaptionStyle;
    expect(() => buildHtml(validated, words, total, hostile)).toThrow(/unknown caption style/);
  });

  it("refuses an inherited Object.prototype key instead of resolving it in CAPTION_OPTIONS", () => {
    const validated = requireValidated(validateSpec(jdSpec(), { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));
    const { words, total } = fakeWords(JD_SCRIPT);
    const hostile = "constructor" as unknown as CaptionStyle;
    expect(() => buildHtml(validated, words, total, hostile)).toThrow(/unknown caption style/);
  });
});

// Fix round 1: buildHtml now holds narrated words to the same sanity bar resolveTimeline's own
// (more lenient, silent-drop) handling doesn't enforce on its own.
describe("buildHtml refuses invalid word times (Fix round 1)", () => {
  const validated = () => requireValidated(validateSpec(jdSpec(), { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));

  it("refuses a non-finite word start or end", () => {
    const { words: w1, total } = fakeWords(JD_SCRIPT);
    w1[0]!.start = NaN;
    expect(() => buildHtml(validated(), w1, total, "rail")).toThrow(/invalid time/);
    const { words: w2 } = fakeWords(JD_SCRIPT);
    w2[0]!.end = Infinity;
    expect(() => buildHtml(validated(), w2, total, "rail")).toThrow(/invalid time/);
  });

  it("refuses a negative word start or end", () => {
    const { words, total } = fakeWords(JD_SCRIPT);
    words[0]!.start = -1;
    expect(() => buildHtml(validated(), words, total, "rail")).toThrow(/invalid time/);
  });

  it("refuses end before start", () => {
    const { words, total } = fakeWords(JD_SCRIPT);
    words[0]!.end = words[0]!.start - 1;
    expect(() => buildHtml(validated(), words, total, "rail")).toThrow(/invalid time/);
  });

  // Task 11 review (b): the word's own text came straight from a transcript, so it's untrusted
  // the same way a mark's target is (scenes.ts's MarkSet.warnings) - a raw control character
  // must never reach the error message this throws.
  it("strips control characters from the word text in its error message", () => {
    const { words, total } = fakeWords(JD_SCRIPT);
    words[0] = { ...words[0]!, text: "a\nFAKE\u001b[31m", start: NaN };
    let message = "";
    try { buildHtml(validated(), words, total, "rail"); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("a FAKE[31m");
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  // Fix round 1, item 5: assertSaneWords kept its own narrow, local C0-only regex instead of
  // sharing errors.ts's broader CONTROL set (C0/C1/bidi/ALM/ZWSP/BOM/line separators) - one
  // character class to maintain, not two that can silently drift apart. Also caps the echoed word
  // at about 80 characters, so a very long hostile/malformed word can't blow out the error message.
  it("caps the echoed word at about 80 characters and strips the same broader control-character set errors.ts's lastLine does", () => {
    const { words, total } = fakeWords(JD_SCRIPT);
    const long = `${"x".repeat(90)}\u0085`; // 91 chars; \u0085 (NEL, a C1 control) wasn't in the old local-only C0 regex
    words[0] = { ...words[0]!, text: long, start: NaN };
    let message = "";
    try { buildHtml(validated(), words, total, "rail"); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(`"${"x".repeat(80)}"`);
    expect(message).not.toContain("\u0085");
  });
});

describe("expand", () => {
  it("writes a complete composition and replaces the old one", () => {
    const { root, folder, words, total, validated } = setup();
    fs.mkdirSync(path.join(folder, "comp"), { recursive: true });
    fs.writeFileSync(path.join(folder, "comp", "stale.html"), "old");
    const r = expand({ folder, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
    expect(r.compDir).toBe(path.join(folder, "comp"));
    // Fix round 1: comp/ must hold exactly the composition contract files - no CareerOS-internal
    // bookkeeping marker leaking into it (the previous .careeros-comp marker did exactly that).
    expect(fs.readdirSync(r.compDir).sort()).toEqual(["fonts", "index.html", "kit.js", "narration.wav", "theme.css", "timeline.txt", "vendor"]);
    for (const f of COMP_FILES) expect(fs.statSync(path.join(r.compDir, f)).size, f).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(r.compDir, "kit.js"), "utf8")).toBe(fs.readFileSync(path.join(TEMPLATES, "kit.js"), "utf8"));
    expect(fs.readFileSync(path.join(r.compDir, "theme.css"), "utf8")).toBe(fs.readFileSync(path.join(TEMPLATES, "theme.css"), "utf8"));
    expect(fs.readFileSync(path.join(r.compDir, "vendor", "gsap", "dist", "gsap.min.js"))).toEqual(fs.readFileSync(GSAP));
    expect(fs.existsSync(path.join(folder, "work", "comp-next"))).toBe(false);
  });

  it("clears a leftover comp-next/ from a previous crashed or cancelled run (Fix round 1)", () => {
    const { root, folder, words, total, validated } = setup();
    fs.mkdirSync(path.join(folder, "work", "comp-next"), { recursive: true });
    fs.writeFileSync(path.join(folder, "work", "comp-next", "garbage.txt"), "leftover junk");
    const r = expand({ folder, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
    expect(fs.existsSync(path.join(folder, "work", "comp-next"))).toBe(false);
    expect(fs.existsSync(path.join(r.compDir, "garbage.txt"))).toBe(false);
    expect(fs.readdirSync(r.compDir).sort()).toEqual(["fonts", "index.html", "kit.js", "narration.wav", "theme.css", "timeline.txt", "vendor"]);
  });

  it("leaves the live comp/ untouched after a failure mid-build, and still succeeds on retry (Fix round 1)", () => {
    const { root, folder, words, total, validated } = setup();
    const args = { folder, root, spec: validated, words, total, captions: "rail" as const, templatesDir: TEMPLATES, gsapFile: GSAP };
    const first = expand(args);
    const before = fs.readFileSync(path.join(first.compDir, "index.html"), "utf8");
    const badArgs = { ...args, gsapFile: path.join(root, "does-not-exist.js") };
    expect(() => expand(badArgs)).toThrow();
    expect(fs.readFileSync(path.join(folder, "comp", "index.html"), "utf8")).toBe(before); // untouched
    const second = expand(args); // retry with the good args
    expect(second.compDir).toBe(first.compDir);
    expect(fs.readdirSync(second.compDir).sort()).toEqual(["fonts", "index.html", "kit.js", "narration.wav", "theme.css", "timeline.txt", "vendor"]);
  });

  it("recovers from a crash between the two swap renames (Fix round 1)", () => {
    const { root, folder, words, total, validated } = setup();
    const args = { folder, root, spec: validated, words, total, captions: "rail" as const, templatesDir: TEMPLATES, gsapFile: GSAP };
    expand(args); // first run: comp/ doesn't exist yet, so there's no comp/ -> comp-old/ rename at all

    // Fail specifically the comp-next/ -> comp/ rename (the second of the two swap renames), not
    // whichever renameSync call happens to come along first - writeFileAtomic (used while building
    // comp-next/) does its own internal tmp-file renames, so counting calls would be fragile.
    const realRename = fs.renameSync;
    const next = path.join(folder, "work", "comp-next");
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((...a: Parameters<typeof fs.renameSync>) => {
      if (String(a[0]) === next) throw new Error("simulated crash");
      return realRename(...(a as [fs.PathLike, fs.PathLike]));
    });
    expect(() => expand(args)).toThrow("simulated crash");
    spy.mockRestore();

    // Crash state: the first rename (comp/ -> comp-old/) went through; the second (comp-next/ ->
    // comp/) never happened.
    expect(fs.existsSync(path.join(folder, "comp"))).toBe(false);
    expect(fs.existsSync(path.join(folder, "work", "comp-old"))).toBe(true);

    const r = expand(args); // self-heals (comp-old/ -> comp/), then completes a fresh swap
    expect(r.compDir).toBe(path.join(folder, "comp"));
    expect(fs.existsSync(path.join(folder, "work", "comp-old"))).toBe(false);
    expect(fs.existsSync(path.join(folder, "work", "comp-next"))).toBe(false);
    expect(fs.readdirSync(r.compDir).sort()).toEqual(["fonts", "index.html", "kit.js", "narration.wav", "theme.css", "timeline.txt", "vendor"]);
  });

  // Fix round 2, item 4: writeFileAtomic writes to a temp file then renames it over the
  // destination - if work/swap-pending happens to be a DIRECTORY (left behind somehow, or planted),
  // that rename fails with a raw EISDIR and breaks every subsequent call to expand(), since the
  // swap-pending write happens on every successful run, not just a self-heal.
  it("clears a directory at work/swap-pending instead of crashing with a raw EISDIR (Fix round 2)", () => {
    const { root, folder, words, total, validated } = setup();
    fs.mkdirSync(path.join(folder, "work", SWAP_PENDING), { recursive: true });
    fs.writeFileSync(path.join(folder, "work", SWAP_PENDING, "junk.txt"), "leftover");
    const r = expand({ folder, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
    expect(r.compDir).toBe(path.join(folder, "comp"));
    expect(fs.existsSync(path.join(folder, "work", SWAP_PENDING))).toBe(false);
    expect(fs.readdirSync(r.compDir).sort()).toEqual(["fonts", "index.html", "kit.js", "narration.wav", "theme.css", "timeline.txt", "vendor"]);
  });

  // Task 11 review (a); Fix round 1: the self-heal above restores work/comp-old/ unconditionally -
  // it never checked that comp-old/ was actually left behind by a crashed call to *this*
  // function, so a directory from anywhere else (a leftover from some unrelated process, a
  // directory an attacker placed at that path) would be blindly promoted to comp/ as if it were
  // trustworthy. work/swap-pending, written just before the first swap rename and removed once the
  // second succeeds, is what comp-old/ needs alongside it - as a genuine regular file - before
  // it's ever restored; otherwise comp-old/ is discarded instead. (The original fix put the marker
  // *inside* comp-next/ instead, which leaked it into comp/ once the rename completed - this round
  // moves it to work/, a sibling of comp-old/ and comp-next/, so it can never end up inside comp/.)
  describe("comp-old/ is only trusted when work/swap-pending is a genuine regular file (Fix round 1)", () => {
    it("discards a comp-old/ with no swap-pending flag, instead of promoting it to comp/, when this call itself then crashes", () => {
      const { root, folder, words, total, validated } = setup();
      const oldDir = path.join(folder, "work", "comp-old");
      fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, "untrusted.txt"), "not ours");
      const args = { folder, root, spec: validated, words, total, captions: "rail" as const, templatesDir: TEMPLATES, gsapFile: GSAP };
      // A crash during THIS call's own build (before its own swap) is exactly when the self-heal
      // decision becomes externally observable: a blind restore would have already promoted
      // comp-old/ to comp/ by the time this throws.
      const spy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => { throw new Error("simulated crash mid-build"); });
      expect(() => expand(args)).toThrow("simulated crash mid-build");
      spy.mockRestore();
      expect(fs.existsSync(path.join(folder, "comp"))).toBe(false);
      expect(fs.existsSync(oldDir)).toBe(false); // discarded, not left in place either
    });

    it("discards a comp-old/ when work/swap-pending is itself a symlink, not a genuine regular file", () => {
      const { root, folder, words, total, validated } = setup();
      const oldDir = path.join(folder, "work", "comp-old");
      fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, "untrusted.txt"), "not ours");
      const target = path.join(root, "outside-swap-pending-target.txt");
      fs.writeFileSync(target, "not the real flag");
      fs.symlinkSync(target, path.join(folder, "work", SWAP_PENDING));
      const args = { folder, root, spec: validated, words, total, captions: "rail" as const, templatesDir: TEMPLATES, gsapFile: GSAP };
      const spy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => { throw new Error("simulated crash mid-build"); });
      expect(() => expand(args)).toThrow("simulated crash mid-build");
      spy.mockRestore();
      expect(fs.existsSync(path.join(folder, "comp"))).toBe(false);
      expect(fs.readFileSync(target, "utf8")).toBe("not the real flag"); // the symlink target itself was never touched
    });

    it("restores a comp-old/ when work/swap-pending is a genuine regular file, before this call's own (crashed) build even starts", () => {
      const { root, folder, words, total, validated } = setup();
      const args = { folder, root, spec: validated, words, total, captions: "rail" as const, templatesDir: TEMPLATES, gsapFile: GSAP };
      const first = expand(args); // produces a genuine comp/
      // Simulate an earlier call that wrote the pending flag, renamed comp/ -> comp-old/, then
      // crashed before the second rename (comp-next/ -> comp/) - exactly the window the flag exists
      // to protect.
      fs.renameSync(first.compDir, path.join(folder, "work", "comp-old"));
      fs.writeFileSync(path.join(folder, "work", SWAP_PENDING), "A HyperFrames composition swap was in progress.\n");
      const spy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => { throw new Error("simulated crash mid-build"); });
      expect(() => expand(args)).toThrow("simulated crash mid-build");
      spy.mockRestore();
      expect(fs.existsSync(path.join(folder, "comp", "index.html"))).toBe(true); // restored before the crash
    });
  });

  // Fix round 2, item 5: the self-heal check above only ever looks at work/comp-old/ and
  // work/swap-pending when comp/ is MISSING - but a crash in the narrow window right after this
  // function's own second rename succeeds (comp-next/ -> comp/) and before its own two final
  // cleanup calls (removing swap-pending, then comp-old/) leaves comp/ already present ALONGSIDE a
  // stale comp-old/ and swap-pending that this call's self-heal would then skip entirely (its
  // guard is "comp/ missing"). Those stale leftovers would otherwise sit untouched indefinitely,
  // available to be mistakenly restored by some later, unrelated chain of events. Self-heal now
  // actively clears both, non-following, whenever it finds comp/ already healthy.
  it("clears a stale work/swap-pending and work/comp-old when comp/ is already healthy (Fix round 2)", () => {
    const { root, folder, words, total, validated } = setup();
    const args = { folder, root, spec: validated, words, total, captions: "rail" as const, templatesDir: TEMPLATES, gsapFile: GSAP };
    expand(args); // produces a healthy comp/
    // Plant a stale backup + flag alongside the now-healthy comp/, as if an earlier crash's final
    // cleanup never completed.
    const oldDir = path.join(folder, "work", "comp-old");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "stale-v1.html"), "an older composition");
    const swapPendingPath = path.join(folder, "work", SWAP_PENDING);
    fs.writeFileSync(swapPendingPath, "stale flag\n");
    // Crash this call during its own build, BEFORE it would reach its own unconditional
    // "leftover comp-old/" cleanup later in the function - isolating self-heal's own behaviour.
    const spy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => { throw new Error("simulated crash mid-build"); });
    expect(() => expand(args)).toThrow("simulated crash mid-build");
    spy.mockRestore();
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(swapPendingPath)).toBe(false);
    expect(fs.existsSync(path.join(folder, "comp", "index.html"))).toBe(true); // the healthy comp/ from before is untouched
  });

  // Fix round 3, item 1: the healthy-comp branch above removed work/swap-pending with a plain,
  // non-recursive fs.rmSync({ force: true }) - fine for a stale regular file, but a DIRECTORY there
  // makes that throw a raw EISDIR, on every single run (this branch is reached whenever comp/
  // already exists, i.e. almost always), leaking the path and leaving expand() permanently broken
  // for that folder.
  it("clears a directory at work/swap-pending in the healthy-comp branch, instead of crashing with a raw EISDIR (Fix round 3)", () => {
    const { root, folder, words, total, validated } = setup();
    const args = { folder, root, spec: validated, words, total, captions: "rail" as const, templatesDir: TEMPLATES, gsapFile: GSAP };
    expand(args); // produces a healthy comp/
    const swapPendingPath = path.join(folder, "work", SWAP_PENDING);
    fs.mkdirSync(path.join(swapPendingPath, "sub"), { recursive: true });
    fs.writeFileSync(path.join(swapPendingPath, "sub", "f"), "leftover");
    const r = expand(args); // must succeed, not crash with EISDIR
    expect(r.compDir).toBe(path.join(folder, "comp"));
    expect(fs.readdirSync(r.compDir).sort()).toEqual(["fonts", "index.html", "kit.js", "narration.wav", "theme.css", "timeline.txt", "vendor"]);
    expect(fs.readdirSync(path.join(folder, "work"))).toEqual([]); // a clean successful run leaves work/ empty
  });

  // Same branch, swap-pending as a symlink pointing outside the workspace instead of a directory -
  // plain (non-recursive) rmSync never follows a symlink for removal purposes even without
  // `recursive`, so this case was already safe before this round's fix; kept as an explicit
  // regression guard now that the removal goes through the shared clearIfDirOrSymlink helper too.
  it("clears a symlink at work/swap-pending pointing outside the workspace, and the outside target survives (Fix round 3)", () => {
    const { root, folder, words, total, validated } = setup();
    const args = { folder, root, spec: validated, words, total, captions: "rail" as const, templatesDir: TEMPLATES, gsapFile: GSAP };
    expand(args); // produces a healthy comp/
    const outside = path.join(root, "outside-swap-pending-target");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "important.txt"), "do not delete me");
    fs.symlinkSync(outside, path.join(folder, "work", SWAP_PENDING));
    const r = expand(args);
    expect(r.compDir).toBe(path.join(folder, "comp"));
    expect(fs.readFileSync(path.join(outside, "important.txt"), "utf8")).toBe("do not delete me"); // never followed, never touched
    expect(fs.readdirSync(path.join(folder, "work"))).toEqual([]);
  });

  // Fix round 3, item 2: work/ itself is only ever checked with assertSafe once, at the very top of
  // expand() - every later removal of something inside work/ (swap-pending, comp-old, comp-next)
  // trusted that single check, even though real time passes (filesystem I/O, building HTML) between
  // it and those later removals. If work/ itself were swapped for a symlink in that window - not
  // oldDir/next/swap-pending individually, which are each lstat-checked at their own removal, but
  // their shared ANCESTOR directory - every later rmSync targeting a path "inside" work/ would
  // silently resolve through that symlink instead, since only a path's own final component (not an
  // ancestor) is special-cased by lstat. Simulated here with a mocked fs.lstatSync that reports
  // work/ as a normal directory on its first check (the one at the top of expand(), matching
  // reality at that moment) and as a symlink on every later check, proving it's the *repeated*
  // check - not just the first - that catches this.
  it("re-checks work/ for a symlink before each later removal, not only once at the start", () => {
    const { root, folder, words, total, validated } = setup();
    const args = { folder, root, spec: validated, words, total, captions: "rail" as const, templatesDir: TEMPLATES, gsapFile: GSAP };
    expand(args); // comp/ now exists, so the next call takes the healthy-comp self-heal branch
    const work = path.join(folder, "work");
    const outside = path.join(root, "outside-work-target");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "important.txt"), "do not delete me");
    const realLstatSync = fs.lstatSync;
    let workChecks = 0;
    const spy = vi.spyOn(fs, "lstatSync").mockImplementation((...a: Parameters<typeof fs.lstatSync>) => {
      if (String(a[0]) === work) {
        workChecks++;
        if (workChecks > 1) return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false } as fs.Stats;
      }
      return realLstatSync(...a);
    });
    try {
      expect(() => expand(args)).toThrow(/symlink/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(outside, "important.txt"), "utf8")).toBe("do not delete me"); // untouched
  });

  // Fix round 1: a probe showed a symlinked work/ made rmSync delete data outside the folder, a
  // symlinked narration.wav copied a secret file into comp/, and nothing stopped a folder outside
  // the workspace root from being used at all.
  describe("symlinks and the workspace root (Fix round 1)", () => {
    it("refuses a symlinked work/ rather than deleting through it", () => {
      const { root, folder, words, total, validated } = setup();
      const outside = path.join(root, "outside-data");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "important.txt"), "do not delete me");
      fs.symlinkSync(outside, path.join(folder, "work"));
      expect(() => expand({ folder, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP })).toThrow(/symlink/);
      expect(fs.readFileSync(path.join(outside, "important.txt"), "utf8")).toBe("do not delete me");
    });

    it("refuses a symlinked narration.wav rather than copying through it", () => {
      const { root, folder, words, total, validated } = setup();
      fs.rmSync(path.join(folder, "narration.wav"));
      const secret = path.join(root, "secret.txt");
      fs.writeFileSync(secret, "top secret contents");
      fs.symlinkSync(secret, path.join(folder, "narration.wav"));
      expect(() => expand({ folder, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP })).toThrow(/symlink/);
      expect(fs.existsSync(path.join(folder, "comp"))).toBe(false);
    });

    it("refuses a symlinked comp/ rather than following it", () => {
      const { root, folder, words, total, validated } = setup();
      const outside = path.join(root, "outside-comp-target");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "untouched.txt"), "still here");
      fs.symlinkSync(outside, path.join(folder, "comp"));
      expect(() => expand({ folder, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP })).toThrow(/symlink/);
      expect(fs.readFileSync(path.join(outside, "untouched.txt"), "utf8")).toBe("still here");
    });

    // Task 11 review (c): copyFileNoFollow opened narration.wav with O_NOFOLLOW (refusing a
    // symlink) but never checked *what kind* of file it actually opened - a FIFO, socket or
    // device at that path would still be read from and copied. fstat-ing the open fd and
    // refusing anything that isn't a regular file closes that gap.
    it.skipIf(process.platform === "win32")("refuses a FIFO at narration.wav instead of reading from it", () => {
      const { root, folder, words, total, validated } = setup();
      fs.rmSync(path.join(folder, "narration.wav"));
      execFileSync("mkfifo", [path.join(folder, "narration.wav")]);
      expect(() => expand({ folder, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP })).toThrow(/not a regular file/);
      expect(fs.existsSync(path.join(folder, "comp"))).toBe(false);
    });

    // Task 11 review (c) fixed FIFOs via O_NONBLOCK + fstat, but opening a UNIX domain socket
    // with a plain open(2) fails at the open() call itself (a different errno, not FIFO-like
    // success) - so it took its own raw, unmapped OS error straight out of expand(), instead of
    // the same plain "not a regular file" message every other non-regular narration.wav gets
    // (Fix round 1, item 9).
    //
    // A UNIX domain socket's path has an OS-level length limit (~104 bytes on macOS) that the
    // usual setup()-based root (under os.tmpdir(), deeply nested) exceeds - so this one test
    // builds its own short root directly under /tmp (Fix round 2, item 10: previously worked
    // around by binding the socket at a short path and hard-linking it onto the real
    // narration.wav; simpler to just keep this one test's whole root short enough to bind the
    // socket at narration.wav directly, no hard link needed).
    it.skipIf(process.platform === "win32")("maps a socket at narration.wav to the same 'not a regular file' message, not a raw OS error", async () => {
      const root = fs.mkdtempSync("/tmp/cv-");
      const folder = path.join(root, "f");
      fs.mkdirSync(folder, { recursive: true });
      const { words, total } = fakeWords(JD_SCRIPT);
      const validated = requireValidated(validateSpec(jdSpec(), { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));
      const sock = path.join(folder, "narration.wav");
      const srv = net.createServer();
      await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(sock, resolve); });
      try {
        expect(() => expand({ folder, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP })).toThrow(/not a regular file/);
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    // Fix round 2, item 9: every open() failure other than ENOENT/EACCES/ELOOP used to be reported
    // as "not a regular file" - true for a socket, FIFO or device, but not for EMFILE (too many
    // open files), EIO, ENAMETOOLONG, ENOTDIR and the like, which have nothing to do with the
    // file's type and were being misreported. Simulated here with a mocked fs.openSync (real
    // filesystem reproduction of e.g. ENAMETOOLONG on narration.wav specifically, without also
    // tripping every other path expand() touches under the same folder, isn't practical) - every
    // other fs.openSync call passes through to the real implementation unchanged.
    it("lets an open() failure unrelated to the file's type through as a plain error that doesn't name the path", () => {
      const { root, folder, words, total, validated } = setup();
      const narrationSrc = path.join(folder, "narration.wav");
      const realOpenSync = fs.openSync;
      const spy = vi.spyOn(fs, "openSync").mockImplementation((...a: Parameters<typeof fs.openSync>) => {
        if (String(a[0]) === narrationSrc) {
          const e = new Error(`ENAMETOOLONG: name too long, open '${narrationSrc}'`) as NodeJS.ErrnoException;
          e.code = "ENAMETOOLONG";
          throw e;
        }
        return realOpenSync(...a);
      });
      let message = "";
      try {
        expand({ folder, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
      } catch (e) {
        message = (e as Error).message;
      } finally {
        spy.mockRestore();
      }
      expect(message).not.toBe("");
      expect(message).not.toMatch(/not a regular file/);
      expect(message).not.toContain(narrationSrc);
      expect(fs.existsSync(path.join(folder, "comp"))).toBe(false);
    });

    it("refuses a folder outside the given root", () => {
      const root = tmpDir();
      const folderOutside = tmpDir(); // a different temp dir entirely, not inside root
      fs.writeFileSync(path.join(folderOutside, "narration.wav"), "RIFF fake");
      const { words, total } = fakeWords(JD_SCRIPT);
      const validated = requireValidated(validateSpec(jdSpec(), { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }));
      expect(() => expand({ folder: folderOutside, root, spec: validated, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP })).toThrow(/outside the workspace/);
      expect(fs.existsSync(path.join(folderOutside, "comp"))).toBe(false);
    });
  });
});

describe("the theme's fonts ship with the app (no Google Fonts fetch)", () => {
  it("declares an @font-face in the page for every font family the theme names", () => {
    const html = jd().html;
    const theme = fs.readFileSync(path.join(TEMPLATES, "theme.css"), "utf8");
    const named = new Set([...theme.matchAll(/font-family:\s*"([^"]+)"/g)].map((m) => m[1]!));
    expect([...named].sort()).toEqual(["JetBrains Mono", "Montserrat"]);
    for (const family of named) expect(html).toContain(`@font-face{font-family:"${family}"`);
    // Inline in index.html, not in the linked theme.css: HyperFrames reads the page itself to decide what to fetch.
    expect(html.indexOf("@font-face")).toBeLessThan(html.indexOf("</head>"));
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });

  it("has every font file and its OFL licence in the templates folder", () => {
    for (const f of VIDEO_FONTS) expect(fs.statSync(path.join(TEMPLATES, FONTS_SRC_REL, f.file)).size, f.file).toBeGreaterThan(10_000);
    for (const l of ["OFL-Montserrat.txt", "OFL-JetBrainsMono.txt"]) {
      const text = fs.readFileSync(path.join(TEMPLATES, FONTS_SRC_REL, l), "utf8");
      expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(fs.readFileSync(path.resolve(TEMPLATES, "../../../licenses", l), "utf8")).toBe(text);
    }
  });

  it("copies the fonts into the composition next to index.html", () => {
    const s = setup();
    const r = expand({ ...s, spec: s.validated, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
    for (const f of VIDEO_FONTS) {
      expect(fs.readFileSync(path.join(r.compDir, FONTS_REL, f.file))).toEqual(fs.readFileSync(path.join(TEMPLATES, FONTS_SRC_REL, f.file)));
      expect(r.html).toContain(`url("${FONTS_REL}/${f.file}")`);
    }
  });
});
