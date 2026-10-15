import { describe, expect, it } from "vitest";
import { repairSpec } from "../src/repair.js";
import { validateSpec } from "../src/spec.js";
import type { SceneSpec } from "../src/types.js";
import { typeOf } from "./fixtures.js";
import { PITCH_SCRIPT, pitchSpec } from "./type-specs.js";

const HISTORY = "me/history/roles.md";
const JD = "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md";

/** The shapes seen in a real failed pitch run, rebuilt with fictional data: `path` sources and string items. */
function slipped(): Record<string, unknown> {
  const s = pitchSpec() as unknown as { scenes: Record<string, unknown>[] };
  s.scenes[0]!.sources = [{ path: JD }];
  s.scenes[1]!.sources = [{ path: HISTORY }];
  s.scenes[1]!.items = ["AI Engineer at Example Labs", "Since 2024 building agents"];
  s.scenes[2]!.sources = [{ path: JD, quote: "Build LLM agents." }, { path: HISTORY }];
  s.scenes[3]!.sources = [{ path: JD }, { path: HISTORY }];
  s.scenes[3]!.items = [{ text: "Build LLM agents", cue: "build", sources: [{ path: HISTORY }] }, { text: "Join a team that ships", cue: "team" }, { text: "Apply where I fit", cue: "applied" }];
  return s as unknown as Record<string, unknown>;
}

describe("repairSpec", () => {
  it("fixes path sources and string items so the pitch spec passes its check", () => {
    const before = validateSpec(slipped(), { type: typeOf("pitch"), script: PITCH_SCRIPT });
    expect(before.issues.filter((i) => i.level === "error").length).toBeGreaterThan(5);
    const r = repairSpec(slipped(), PITCH_SCRIPT);
    expect(r.changed).toBe(true);
    const spec = r.spec as SceneSpec;
    expect(spec.scenes[0]!.sources).toEqual([{ file: JD }]);
    expect(spec.scenes[1]).toMatchObject({ items: [{ text: "AI Engineer at Example Labs", cue: "AI Engineer" }, { text: "Since 2024 building agents", cue: "Since 2024" }] });
    const after = validateSpec(r.spec, { type: typeOf("pitch"), script: PITCH_SCRIPT });
    expect(after.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.repairs).toEqual([
      'Changed 7 sources from "path" to "file".',
      "Scene 2: turned 2 plain-text points into points with cues.",
    ]);
  });

  it("prefers a cue the script actually says, falling back to the first two words", () => {
    const script = "Hello there.\n\nRight now I build agents. My second point.\n";
    const raw = { version: 2, scenes: [{ type: "bullet-build", cue: "Right now", headline: "x", items: ["Agents for support teams", "Unheard words here"] }] };
    const out = repairSpec(raw, script).spec as { scenes: { items: { cue: string }[] }[] };
    expect(out.scenes[0]!.items.map((i) => i.cue)).toEqual(["Agents", "Unheard words"]);
  });

  it("never touches comparison sides, whose items are plain text by design", () => {
    const raw = pitchSpec();
    const r = repairSpec(structuredClone(raw), PITCH_SCRIPT);
    expect(r.changed).toBe(false);
    expect(r.repairs).toEqual([]);
    expect(r.spec).toEqual(raw);
  });

  it("leaves a source alone when both file and path are there and differ", () => {
    const raw = { version: 2, scenes: [{ type: "title", sources: [{ file: JD, path: HISTORY }, { file: JD, path: JD }] }] };
    const out = repairSpec(raw, "").spec as { scenes: { sources: unknown[] }[] };
    expect(out.scenes[0]!.sources).toEqual([{ file: JD, path: HISTORY }, { file: JD }]);
  });

  it("drops only empty or repeated points when a list is over its limit, never real content", () => {
    const script = "Intro here.\n\nRight now one two three four five.\n";
    const five = { version: 2, scenes: [{ type: "bullet-build", cue: "Right now", headline: "x", items: ["one", "two", "three", "four", "five"] }] };
    const r1 = repairSpec(five, script);
    expect((r1.spec as { scenes: { items: unknown[] }[] }).scenes[0]!.items).toHaveLength(5);
    expect(r1.repairs.join(" ")).not.toMatch(/removed/i);

    const dup = { version: 2, scenes: [{ type: "bullet-build", cue: "Right now", headline: "x", items: ["one", "two", "", "three", "two"] }] };
    const r2 = repairSpec(dup, script);
    expect((r2.spec as { scenes: { items: { text: string }[] }[] }).scenes[0]!.items.map((i) => i.text)).toEqual(["one", "two", "three"]);
    expect(r2.repairs).toContain("Scene 1: removed 2 empty or repeated points.");
  });

  it("doesn't add a missing closing line or invent text", () => {
    const raw = pitchSpec() as unknown as { scenes: Record<string, unknown>[] };
    delete raw.scenes[3]!.closing;
    const r = repairSpec(raw, PITCH_SCRIPT);
    expect((r.spec as { scenes: Record<string, unknown>[] }).scenes[3]!.closing).toBeUndefined();
    expect(r.changed).toBe(false);
  });

  it("refuses to walk hostile input", () => {
    expect(repairSpec(null, "").changed).toBe(false);
    expect(repairSpec({ scenes: "nope" }, "").changed).toBe(false);
    const huge = { scenes: Array.from({ length: 600 }, () => ({ type: "bullet-build", items: ["a"] })) };
    expect(repairSpec(huge, "").changed).toBe(false);
    const wide = { scenes: [{ type: "bullet-build", items: Array.from({ length: 300 }, () => "a") }] };
    expect(repairSpec(wide, "").changed).toBe(false);
  });
});
