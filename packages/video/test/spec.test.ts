import { describe, expect, it } from "vitest";
import { applySceneScripts, estimateSeconds, findPhrase, isPauseTooLong, parseScript, sceneBlocks, tokens } from "../src/script.js";
import { editableFields, isValidated, MAX_SPEC_BYTES, onScreenRoles, onScreenText, parseSpecText, readingLoad, requireValidated, sceneSeconds, setField, validateSpec } from "../src/spec.js";
import type { Scene } from "../src/types.js";
import { JD_SCRIPT, jdSpec, QUIZ_SCRIPT, quizSpec, typeOf } from "./fixtures.js";

const errors = (r: { issues: { level: string; message: string }[] }) => r.issues.filter((i) => i.level === "error").map((i) => i.message);
const jd = (spec = jdSpec(), script = JD_SCRIPT) => validateSpec(spec, { type: typeOf("jd-walkthrough"), script });

describe("parseScript", () => {
  it("splits paragraphs, drops notes lines and reads pauses", () => {
    const b = parseScript("# notes\nHello there.\n\n[pause 8]\n\n  Second <breath> line\nwraps.\n");
    expect(b).toEqual([
      { kind: "speech", text: "Hello there.", seconds: 0 }, { kind: "pause", text: "[pause 8]", seconds: 8 },
      { kind: "speech", text: "Second <breath> line wraps.", seconds: 0 },
    ]);
    expect(tokens(b).map((t) => t.norm)).toEqual(["hello", "there", "second", "line", "wraps"]);
    expect(findPhrase(tokens(b), "Line, wraps!")).toBe(3);
    expect(estimateSeconds(b)).toBe(+(0.5 + 5 / 2.5 + 8 + 0.45 + 1).toFixed(1));
  });
  it("gives each scene its paragraphs and puts edits back in place", () => {
    const blocks = parseScript(JD_SCRIPT);
    expect(sceneBlocks(blocks, jdSpec()).map((r) => [r.from, r.to])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    const next = applySceneScripts(JD_SCRIPT, jdSpec(), [{ index: 1, script: "The role asks for agents and retrieval. Your evidence is strong." }]);
    expect(next.split("\n\n")[1]).toBe("The role asks for agents and retrieval. Your evidence is strong.");
    expect(parseScript(next)).toHaveLength(4);
  });
});

describe("validateSpec", () => {
  it("accepts a good spec", () => {
    const r = jd();
    expect(errors(r)).toEqual([]);
    expect(r.spec?.scenes).toHaveLength(4);
  });

  it("says which cue went missing after a script edit (Review Focus 1)", () => {
    const script = JD_SCRIPT.replace("Your evidence is", "You have");
    expect(errors(jd(jdSpec(), script))).toEqual([
      'Scene 2: the cue "Your evidence" for cue_right is not in this scene\'s part of the script. Change the cue or put the words back.',
    ]);
    expect(errors(jd(jdSpec(), JD_SCRIPT.replace("Three things", "Some things")))).toContain(
      'Scene 3: the cue "Three things" is not in the script. Change the cue or put the words back.',
    );
  });

  it("wants cues in script order", () => {
    const spec = jdSpec();
    [spec.scenes[1], spec.scenes[2]] = [spec.scenes[2]!, spec.scenes[1]!];
    expect(errors(jd(spec)).join("\n")).toMatch(/Scene 3: the cue "The role asks" comes before the previous scene's cue/);
  });

  it("enforces catalog limits and refuses unknown fields (Review Focus 3)", () => {
    const spec = jdSpec() as unknown as { scenes: Record<string, unknown>[] };
    spec.scenes[0]!.title = "One two three four five six seven eight nine ten";
    (spec.scenes[2]!.items as unknown[]).push({ text: "a", cue: "First" }, { text: "b", cue: "First" });
    spec.scenes[3]!.closing = "x".repeat(5000);
    spec.scenes[1]!.headline = "Agents\u0000 matter";
    spec.scenes[0]!.html = "<img src=x onerror=alert(1)>";
    const msgs = errors(validateSpec(spec, { type: typeOf("jd-walkthrough"), script: JD_SCRIPT })).join("\n");
    expect(msgs).toMatch(/Scene 1: title has 10 words; keep it to 9\./);
    expect(msgs).toMatch(/Scene 3: items must have 2 to 4 entries; it has 5\./);
    expect(msgs).toMatch(/Scene 4: closing is too long \(5000 characters; at most 300\)\./);
    expect(msgs).toMatch(/Scene 2: headline has a control character\./);
    expect(msgs).toMatch(/Scene 1: html is not a field this scene uses\./);
  });

  it("refuses scene types the video type does not allow, and a wrong voice", () => {
    const spec = { ...jdSpec(), voice_type: "guide" as const, scenes: [...jdSpec().scenes, { type: "quiz", cue: "So remember" } as unknown as Scene] };
    const msgs = errors(jd(spec));
    expect(msgs).toContain('voice_type must be "slides" for JD walkthrough.');
    expect(msgs).toContain("Scene 5: JD walkthrough videos can't use quiz scenes.");
  });

  it("checks code size", () => {
    const t = typeOf("skill-gap-lesson");
    const script = "Here is the code.\n\nLook at it type.\n";
    const code = Array.from({ length: 11 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const spec = {
      version: 2, title: "Typing", voice_type: "guide",
      scenes: [{ type: "title", cue: "Here is", kicker: "Lesson", title: "Code" }, { type: "code-typing", cue: "Look", lang: "ts", code }, { type: "recap-card", cue: "type", headline: "h", items: [], closing: "c" }],
    };
    expect(errors(validateSpec(spec, { type: t, script })).join("\n")).toMatch(/Scene 2: code has 11 lines; at most 10\./);
  });

  it("matches quiz think time to the [pause N] line", () => {
    const t = typeOf("interview-prep");
    expect(errors(validateSpec(quizSpec(), { type: t, script: QUIZ_SCRIPT, mode: "practice" }))).toEqual([]);
    const off = quizSpec();
    (off.scenes[1] as { think_seconds: number }).think_seconds = 10;
    expect(errors(validateSpec(off, { type: t, script: QUIZ_SCRIPT, mode: "practice" }))).toContain("Scene 2: think_seconds is 10 but the script pauses for 8 seconds.");
    const watch = quizSpec();
    for (const s of watch.scenes) if (s.type === "quiz") s.think_seconds = 0;
    expect(errors(validateSpec(watch, { type: t, script: QUIZ_SCRIPT, mode: "watch" }))).toContain("Scene 2: watch mode has no pauses. Remove the [pause N] line.");
  });

  it("checks how many scenes of a kind the type needs", () => {
    const spec = quizSpec();
    spec.scenes.splice(2, 2);
    const script = QUIZ_SCRIPT.split("Second question")[0] + "So remember. Stories beat lists. Numbers win. Practise out loud.\n";
    expect(errors(validateSpec(spec, { type: typeOf("interview-prep"), script, mode: "practice" }))).toContain("Interview prep needs 3 to 6 quiz scenes; this spec has 1.");
  });

  it("refuses a script far longer than the type allows", () => {
    const long = JD_SCRIPT.replace("Three things matter most.", `Three things matter most. ${"word ".repeat(600)}`);
    expect(errors(jd(jdSpec(), long)).join("\n")).toMatch(/The script runs about \d+ seconds; this video should run about 150\. Shorten it\./);
  });
});

// expander.ts's buildHtml/expand accept only `ValidatedSpec` (Task 11 review: "buildHtml must
// only ever receive a VALIDATED spec"), and `requireValidated` is the only way to produce one.
describe("requireValidated", () => {
  it("returns a frozen, deep-cloned spec from a result with no error-level issues", () => {
    const r = jd();
    const v = requireValidated(r);
    expect(v).toEqual(r.spec); // same data...
    expect(v).not.toBe(r.spec); // ...but a different object: a structuredClone, not the same reference
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.scenes)).toBe(true);
    expect(Object.isFrozen(v.scenes[0])).toBe(true);
    expect(isValidated(v)).toBe(true);
  });

  it("refuses a spec with a control character in its text", () => {
    const spec = jdSpec();
    (spec.scenes[0] as { title: string }).title = "Bad\u0000title";
    const r = jd(spec);
    expect(() => requireValidated(r)).toThrow(/title has a control character/);
  });

  it("refuses a spec with an unknown scene type", () => {
    const spec = jdSpec();
    (spec.scenes[0] as unknown as { type: string }).type = "bogus-type";
    const r = jd(spec);
    expect(() => requireValidated(r)).toThrow(/"bogus-type" is not a scene type/);
  });

  it("refuses a grossly malformed spec (spec is null)", () => {
    const r = validateSpec({ not: "a video spec" }, { type: typeOf("jd-walkthrough"), script: JD_SCRIPT });
    expect(r.spec).toBeNull();
    expect(() => requireValidated(r)).toThrow(/spec is not valid/);
  });

  // Fix round 1: validateSpec itself used to return a branded ValidatedSpec even when there were
  // errors (so `if (r.spec) buildHtml(r.spec)` skipped requireValidated entirely), and
  // requireValidated just handed back the very same object it was given - so mutating the
  // *original* spec object after validation silently mutated what buildHtml would later see too.
  it("validateSpec's own result.spec is a plain, unbranded value - never itself a ValidatedSpec", () => {
    const r = jd();
    expect(isValidated(r.spec!)).toBe(false);
  });

  it("isValidated is false for a plain object that merely looks like a validated spec", () => {
    const r = jd();
    expect(isValidated(r.spec!)).toBe(false); // never went through requireValidated
    expect(isValidated(JSON.parse(JSON.stringify(r.spec)))).toBe(false);
  });

  it("the returned clone is immune to mutating the original spec object afterwards", () => {
    const spec = jdSpec();
    const v = requireValidated(jd(spec));
    (spec.scenes[0] as unknown as { type: string }).type = "bogus-type"; // mutate the ORIGINAL
    expect(v.scenes[0]!.type).toBe("title"); // the clone never saw it
    expect(isValidated(v)).toBe(true); // still a genuine validated spec
  });

  it("the returned clone throws on write (deep-frozen)", () => {
    const v = requireValidated(jd());
    expect(() => { (v as unknown as { title: string }).title = "x"; }).toThrow();
    expect(() => { (v.scenes[0] as unknown as { type: string }).type = "x"; }).toThrow();
    expect(() => { (v.scenes as unknown[]).push({}); }).toThrow();
  });
});

// Scripts and scene specs are written by Claude, so they're treated as untrusted input: these
// pin the bounds on size and nesting depth, and that hostile-looking (but harmless) text survives
// validation unmangled rather than being silently stripped.
describe("untrusted input", () => {
  it("refuses an oversized script before parsing it", () => {
    const huge = "word ".repeat(10_000); // 50,000 characters, well past the 20,000 limit
    const r = validateSpec(jdSpec(), { type: typeOf("jd-walkthrough"), script: huge });
    expect(r.spec).toBeNull();
    expect(errors(r).join("\n")).toMatch(/The script is 50000 characters; at most 20000\. Shorten it\./);
  });

  it("refuses deeply nested JSON without crashing", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 5000; i++) deep = { nested: deep };
    const spec = { ...jdSpec(), extra: deep } as unknown;
    let r: ReturnType<typeof validateSpec> | undefined;
    expect(() => { r = validateSpec(spec, { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }); }).not.toThrow();
    expect(r!.spec).toBeNull();
    expect(errors(r!).join("\n")).toMatch(/nested too deeply/);
  });

  it("handles __proto__ keys in raw JSON safely, without polluting anything", () => {
    // JSON.parse gives "__proto__" a real own data property (CreateDataProperty semantics), unlike
    // an object literal where `__proto__: x` sets the actual prototype link. Build the hostile
    // input the same way a hostile spec.json on disk would arrive: through JSON.parse.
    const json = JSON.stringify(jdSpec())
      .replace('{"version":2', '{"__proto__":{"polluted":true},"version":2')
      .replace('"type":"title"', '"type":"title","__proto__":{"polluted":true}');
    const raw: unknown = JSON.parse(json);
    let r: ReturnType<typeof validateSpec> | undefined;
    expect(() => { r = validateSpec(raw, { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }); }).not.toThrow();
    expect(errors(r!).some((m) => m.includes("__proto__"))).toBe(true);
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps </script> and onerror-style scene text unmangled (escaping happens later, in the expander)", () => {
    const spec = jdSpec();
    (spec.scenes[0] as unknown as { title: string }).title = "Beware </script> tags";
    (spec.scenes[3] as unknown as { closing: string }).closing = "Done. <img onerror=alert(1)> Stay sharp.";
    const r = validateSpec(spec, { type: typeOf("jd-walkthrough"), script: JD_SCRIPT });
    expect(errors(r)).toEqual([]);
    expect((r.spec!.scenes[0] as unknown as { title: string }).title).toBe("Beware </script> tags");
    expect((r.spec!.scenes[3] as unknown as { closing: string }).closing).toBe("Done. <img onerror=alert(1)> Stay sharp.");
  });

  // Fix round 1 (Important): list() used to log an oversized array but still return it, so every
  // caller iterated the whole thing (a single bullet-build with 2M items took ~790ms). It must
  // now refuse before any iteration, for every catalog list, not just items.
  // Fix round 2 changed these from 2,000,000 to 500 entries: tooDeep's own breadth bound (see
  // below) now refuses anything over MAX_SPEC_BREADTH (1000) generically, before list() ever runs,
  // so a 2,000,000-entry array no longer reaches list() at all. 500 stays under that ceiling (and
  // well over list()'s own ABSOLUTE_MAX_LIST of 200), so these tests still exercise list()'s own
  // specific-message ceiling rather than tooDeep's generic one.
  it("refuses a 500-entry items array quickly, before iterating it", () => {
    const spec = jdSpec();
    (spec.scenes[2] as unknown as { items: unknown[] }).items = new Array(500).fill({ text: "x", cue: "First" });
    const t0 = performance.now();
    const r = jd(spec);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(errors(r).join("\n")).toMatch(/items must have 2 to 4 entries; it has 500\./);
  });

  it("refuses a 500-entry flowchart nodes array quickly", () => {
    const script = "Here is the flow.\n\nLook at it.\n\nSo remember.\n";
    const spec = {
      version: 2, title: "Flow", voice_type: "guide",
      scenes: [
        { type: "title", cue: "Here is", kicker: "Lesson", title: "Flow" },
        { type: "flowchart", cue: "Look", headline: "The flow", direction: "lr", nodes: new Array(500).fill({ id: "a", label: "A", cue: "flow" }), edges: [] },
        { type: "recap-card", cue: "So remember", headline: "h", items: [{ text: "a", cue: "a" }, { text: "b", cue: "b" }, { text: "c", cue: "c" }], closing: "c" },
      ],
    };
    const t0 = performance.now();
    const r = validateSpec(spec, { type: typeOf("skill-gap-lesson"), script });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(errors(r).join("\n")).toMatch(/nodes must have 2 to 6 entries; it has 500\./);
  });

  it("refuses a 500-entry code-highlight steps array quickly", () => {
    const script = "Here is the code.\n\nLook at it type.\n\nSo remember.\n";
    const spec = {
      version: 2, title: "Typing", voice_type: "guide",
      scenes: [
        { type: "title", cue: "Here is", kicker: "Lesson", title: "Code" },
        { type: "code-highlight", cue: "Look", lang: "ts", code: "const a = 1;", steps: new Array(500).fill({ lines: [1, 1], note: "n", cue: "type" }) },
        { type: "recap-card", cue: "So remember", headline: "h", items: [{ text: "a", cue: "a" }, { text: "b", cue: "b" }, { text: "c", cue: "c" }], closing: "c" },
      ],
    };
    const t0 = performance.now();
    const r = validateSpec(spec, { type: typeOf("skill-gap-lesson"), script });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(errors(r).join("\n")).toMatch(/steps must have 1 to 4 entries; it has 500\./);
  });

  // Fix round 1 (Minor): onScreenText may be called on a scene that never went through
  // validateSpec (e.g. a direct fact check), so its recursive walk needs its own depth cap.
  it("caps onScreenText's recursive walk, safe even on unvalidated input", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 5000; i++) deep = { nested: deep };
    const hostile = { type: "bullet-build", cue: "x", headline: "h", items: [{ text: "t", cue: "c" }], evil: deep } as unknown as Scene;
    expect(() => onScreenText(hostile)).not.toThrow();
  });

  // Fix round 1 (Minor): an unbounded pause-duration regex let a huge numeral parse to Infinity
  // (via Number(...)), which then surfaced as "the script pauses for Infinity seconds". The regex
  // is now capped at 4 digits (2 decimals), so a too-long pause falls back to an ordinary speech
  // block and validateSpec gives a clear, finite "too long" error instead.
  it("gives a clear error for an oversized pause instead of 'Infinity seconds'", () => {
    const huge = "9".repeat(30);
    const block = parseScript(`Hello.\n\n[pause ${huge}]\n\nBye.\n`)[1]!;
    expect(block).toEqual({ kind: "speech", text: `[pause ${huge}]`, seconds: 0 });
    expect(isPauseTooLong(block.text)).toBe(true);
    expect(isPauseTooLong("[pause 8]")).toBe(false);

    const script = QUIZ_SCRIPT.replace("[pause 8]", `[pause ${huge}]`);
    const r = validateSpec(quizSpec(), { type: typeOf("interview-prep"), script, mode: "practice" });
    const msgs = errors(r).join("\n");
    expect(msgs).not.toMatch(/Infinity/);
    expect(msgs).toMatch(/pause that's too long/);
  });

  // Fix round 2 (Important): tooDeep used to treat "wider than MAX_SPEC_BREADTH" as "not too deep",
  // returning false and letting a caller further down iterate whatever the wide node contained —
  // including, as here, an element nested 5000 levels deep that tooDeep itself would otherwise have
  // refused. It must now refuse the wide node outright, so the deep element inside it is never even
  // looked at (which is also what keeps this fast: no recursion into the 5000-deep object at all).
  it("refuses a 1001-entry array hiding a 5000-level-deep object, quickly (breadth is checked before depth)", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 5000; i++) deep = { nested: deep };
    const evil = new Array(1000).fill("x");
    evil.push(deep);
    const spec = { ...jdSpec(), extra: evil } as unknown;
    const t0 = performance.now();
    let r: ReturnType<typeof validateSpec> | undefined;
    expect(() => { r = validateSpec(spec, { type: typeOf("jd-walkthrough"), script: JD_SCRIPT }); }).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r!.spec).toBeNull();
    expect(errors(r!).join("\n")).toMatch(/too many entries to check/);
  });

  // Fix round 2: a JS object's key count can't be bounded in O(1) before JSON.parse has already
  // built it, so spec.json's raw text must be capped by byte size instead, before parsing starts.
  // Later tasks reading spec.json from disk should go through parseSpecText, not JSON.parse
  // directly, so this cap and the friendly parse-error message are never bypassed.
  it("parseSpecText refuses oversized text before calling JSON.parse", () => {
    const huge = "x".repeat(MAX_SPEC_BYTES + 1);
    const { raw, issues } = parseSpecText(huge);
    expect(raw).toBeUndefined();
    expect(issues.join("\n")).toMatch(new RegExp(`spec\\.json is ${MAX_SPEC_BYTES + 1} bytes; at most ${MAX_SPEC_BYTES}\\.`));
  });

  it("parseSpecText turns invalid JSON into a plain issue instead of throwing", () => {
    expect(() => parseSpecText("{ not json")).not.toThrow();
    const { raw, issues } = parseSpecText("{ not json");
    expect(raw).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/spec\.json is not valid JSON/);
  });

  it("parseSpecText parses valid JSON normally, under the byte cap", () => {
    const { raw, issues } = parseSpecText(JSON.stringify(jdSpec()));
    expect(issues).toEqual([]);
    expect((raw as { title: string }).title).toBe(jdSpec().title);
  });

  // Fix round 3 (Minor): the cap must be checked in bytes, not in string .length. "中" is one
  // UTF-16 code unit (string .length counts it as 1) but 3 bytes in UTF-8, so this string's
  // .length is under MAX_SPEC_BYTES while its real UTF-8 byte length is over it.
  it("parseSpecText refuses multi-byte text whose UTF-8 byte length exceeds the cap even though .length doesn't", () => {
    const huge = "中".repeat(Math.ceil(MAX_SPEC_BYTES / 3) + 10);
    expect(huge.length).toBeLessThan(MAX_SPEC_BYTES);
    const { raw, issues } = parseSpecText(huge);
    expect(raw).toBeUndefined();
    expect(issues.join("\n")).toMatch(/spec\.json is \d+ bytes; at most \d+\./);
  });

  // Fix round 2 (onlyKeys and the issues list): a single hostile scene used to be able to make
  // validateSpec return as many issues as it has bad fields. Capped at 50, with one summary line
  // appended when more were found, instead of growing the returned list without bound. Uses 900
  // garbage keys (not 1,000,000) so the scene object itself stays under tooDeep's MAX_SPEC_BREADTH
  // (1000) and this test exercises the issues cap itself, not the breadth refusal added above.
  it("caps the number of issues validateSpec returns, even for a scene with hundreds of garbage keys", () => {
    const garbage: Record<string, string> = {};
    for (let i = 0; i < 900; i++) garbage[`garbage_${i}`] = "x";
    const spec = {
      version: 2, title: "T", voice_type: "guide",
      scenes: [{ type: "title", cue: "Here is", kicker: "Lesson", title: "Title", ...garbage }, { type: "recap-card", cue: "So remember", headline: "h", items: [{ text: "a", cue: "a" }, { text: "b", cue: "b" }, { text: "c", cue: "c" }], closing: "c" }],
    };
    const r = validateSpec(spec, { type: typeOf("skill-gap-lesson"), script: "Here is the thing.\n\nSo remember.\n" });
    expect(r.issues.length).toBeLessThanOrEqual(51);
    expect(r.issues.length).toBeLessThan(900);
    expect(r.issues.at(-1)!.message).toMatch(/\.\.\.and \d+ more problems?\./);
  });

  // Fix round 3 (Important, regression from round 2's issues cap): errorsIn() used to read the
  // *capped* issues array, so once scene 0's 900 garbage keys filled the whole 50-issue budget,
  // every later add() call for scene 1 was invisible to errorsIn(1) — including its genuine
  // "code is missing" error — making valid[1] wrongly true for a scene that is actually broken.
  //
  // Scene 1's cue ("Nope not here") also doesn't appear anywhere in the script. That's the probe:
  // if scene 1 is (incorrectly) treated as valid, validateSpec's cue-position search runs for it
  // and fails to find the cue, adding one more error; if scene 1 is (correctly) treated as invalid,
  // that search is skipped entirely and no such error is added. Either way the *returned* issues
  // array is capped at 51 (50 + the summary line) — both scenarios blow well past the cap — so the
  // only place the bug is visible from the public API is the summary line's count: it must be
  // exactly 852 (902 total add() calls - 50 kept). On a55260f (before this fix) the extra,
  // should-have-been-skipped cue error pushes the real total to 903, so the summary reads 853 and
  // this assertion fails.
  it("keeps a later scene's validity correct even after an earlier scene exhausts the issues budget", () => {
    const garbage: Record<string, string> = {};
    for (let i = 0; i < 900; i++) garbage[`garbage_${i}`] = "x";
    const script = "Here is the code.\n\nLook at it type.\n\nSo remember. First point lands. Second point lands too. Third point matters.\n";
    const spec = {
      version: 2, title: "T", voice_type: "guide",
      scenes: [
        { type: "title", cue: "Here is", kicker: "Lesson", title: "Title", ...garbage },
        // Invalid: required "code" is missing. This is scene 1, the one errorsIn()/valid[] must
        // get right even though scene 0 already used up the issues budget.
        { type: "code-typing", cue: "Nope not here", lang: "ts" },
        { type: "recap-card", cue: "So remember", headline: "h", items: [{ text: "a", cue: "First point" }, { text: "b", cue: "Second point" }, { text: "c", cue: "Third point" }], closing: "c" },
      ],
    };
    const r = validateSpec(spec, { type: typeOf("skill-gap-lesson"), script });
    expect(r.issues).toHaveLength(51);
    expect(r.issues.at(-1)!.message).toBe("...and 852 more problems.");
  });
});

describe("editing on-screen text", () => {
  it("lists editable fields and changes only those", () => {
    const s = jdSpec().scenes[2]!;
    expect(editableFields(s).map((f) => f.path)).toEqual(["headline", "items.0.text", "items.1.text", "items.2.text"]);
    setField(s, "items.1.text", "  Shipping to real users ");
    expect((s as { items: { text: string }[] }).items[1]!.text).toBe("Shipping to real users");
    expect(() => setField(s, "items.1.cue", "x")).toThrow(/can't be edited/);
    expect(() => setField(s, "__proto__.x", "x")).toThrow(/can't be edited/);
    expect(onScreenText(jdSpec().scenes[1]!)).toEqual(["Agents are the heart of this role", "The role asks", "Build LLM agents", "Your evidence", "Agent work in your history"]);
  });
});

// Task 18b: on-screen roles and the reading-load budget (scene-spec.md § Roles).
describe("on-screen roles and reading load", () => {
  const warnings = (r: { issues: { level: string; code: string; message: string }[] }) => r.issues.filter((i) => i.level === "warning" && i.code === "reading_load").map((i) => i.message);

  it("gives each field a default role and lets an item set its own", () => {
    const roles = (s: Scene) => onScreenRoles(s).map((x) => `${x.path}=${x.role}`);
    expect(roles(jdSpec().scenes[0]!)).toEqual(["kicker=support", "title=primary"]);
    expect(roles(jdSpec().scenes[1]!)).toEqual(["headline=primary", "left.label=support", "left.items.0=secondary", "right.label=support", "right.items.0=secondary"]);
    const s = jdSpec().scenes[2] as Extract<Scene, { type: "bullet-build" }>;
    s.items[2]!.role = "decorative";
    expect(roles(s)).toEqual(["headline=primary", "items.0.text=secondary", "items.1.text=secondary", "items.2.text=decorative"]);
    // The role word is never treated as on-screen text (the fact check reads onScreenText).
    expect(onScreenText(s)).not.toContain("decorative");
    expect(onScreenRoles({ type: "stat", cue: "x", value: 40, label: "Tickets a day", source: "Your history" })).toEqual([
      { path: "label", text: "Tickets a day", role: "secondary" }, { path: "source", text: "Your history", role: "support" }, { path: "value", text: "40", role: "primary" },
    ]);
  });

  it("accepts role as an optional field and refuses an unknown role", () => {
    const spec = jdSpec();
    (spec.scenes[2] as Extract<Scene, { type: "bullet-build" }>).items[0]!.role = "support";
    expect(errors(jd(spec))).toEqual([]);
    (spec.scenes[2] as unknown as { items: { role: string }[] }).items[0]!.role = "loud";
    expect(errors(jd(spec))).toEqual(["Scene 3: items.0.role must be primary, secondary, support or decorative."]);
  });

  it("estimates each scene's seconds from cue to cue", () => {
    const blocks = parseScript("One two three four five.\n\nSix seven eight nine ten.\n");
    // Lead 0.5 s, 2.5 words a second, 0.45 s between paragraphs, 1 s tail: 0.5 + 2 + 0.45 + 2 + 1 = 5.95.
    expect(sceneSeconds(blocks, [0, 5])).toEqual([2.95, 3]);
    expect(sceneSeconds(blocks, [0, -1])).toEqual([5.95, 0]);
  });

  it("warns, but never errors, when a scene shows more than 3.5 words a second", () => {
    expect(warnings(jd())).toEqual(["Scene 4: shows 22 words in about 6.2 seconds; keep it to 21. Cut on-screen words or give the scene more script."]);
    // Decorative text is outside the budget.
    const spec = jdSpec();
    (spec.scenes[3] as Extract<Scene, { type: "recap-card" }>).items[2]!.role = "decorative";
    expect(warnings(jd(spec))).toEqual([]);
    expect(errors(jd(spec))).toEqual([]);
  });

  it("wants one message in a scene under 3 seconds, and one primary per scene", () => {
    const bullet = jdSpec().scenes[2]!;
    expect(readingLoad(bullet, 2.5).map((w) => w.message)).toEqual([
      "shows 14 words in about 2.5 seconds; keep it to 8. Cut on-screen words or give the scene more script.",
      "runs about 2.5 seconds, so it can carry one message. It has 4.",
    ]);
    // A stat's number and its label count as one element.
    expect(readingLoad({ type: "stat", cue: "x", value: 3, label: "Replies", source: "Inbox" }, 2.5)).toEqual([]);
    (bullet as Extract<Scene, { type: "bullet-build" }>).items[0]!.role = "primary";
    expect(readingLoad(bullet, 10)).toEqual([{ path: "items.0.text", message: "has 2 primary items. Keep one, and make the rest secondary or support." }]);
  });
});
