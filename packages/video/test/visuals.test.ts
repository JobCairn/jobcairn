import { describe, expect, it } from "vitest";
import { diagramLayout } from "../src/visuals.js";
import { layered, ranks, ring } from "../src/layout.js";
import { icon, iconFor, initials, logo, logosIn, pictureFor, ICON_NAMES, LOGO_SLUGS } from "../src/packs.js";
import { findPlace, project } from "../src/places.js";
import { BUILDERS, buildScene } from "../src/scenes.js";
import { editableFields, itemCues, screenWords, sceneHeadline, setField, validateSpec } from "../src/spec.js";
import { SCENE_TYPES, SCENE_WORD_CAP, VISUAL_SCENE_TYPES, type Scene, type SceneSpec } from "../src/types.js";
import type { SceneTime } from "../src/timeline.js";
import { SHAPE_EXAMPLES, visualLines } from "../src/writer.js";
import { AFTER_SCRIPT, afterSpec } from "./sample-jd.js";
import { typeOf } from "./fixtures.js";

const time = (over: Partial<SceneTime> = {}): SceneTime => ({ index: 1, id: "s2", type: "title", cue: 10, start: 10, end: 20, items: {}, marks: [], think: null, ...over });
const sample = (type: string): Scene => afterSpec().scenes.find((s) => s.type === type)! as Scene;
const JD = typeOf("jd-walkthrough");

describe("scene vocabulary", () => {
  it("every scene type has a builder, a headline, editable fields and cues for its list", () => {
    for (const t of SCENE_TYPES) expect(BUILDERS[t], t).toBeTypeOf("function");
    for (const t of VISUAL_SCENE_TYPES) {
      const s = sample(t) ?? null;
      if (!s) continue;
      expect(sceneHeadline(s), t).toBeTruthy();
      expect(editableFields(s).length, t).toBeGreaterThan(0);
    }
  });

  it("the sample uses most of the visual scenes and passes the check with no errors", () => {
    const r = validateSpec(afterSpec(), { type: JD, script: AFTER_SCRIPT, length_s: 60 });
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(new Set(afterSpec().scenes.map((s) => s.type)).size).toBeGreaterThanOrEqual(9);
  });

  it("writer examples exist for the visual scenes writers get wrong most", () => {
    for (const t of ["icon-grid", "diagram", "match"] as const) expect(SHAPE_EXAMPLES[t]).toBeTruthy();
  });

  it("validates the scene type list: unknown types, types the video can't use, and the new enums", () => {
    const base = afterSpec();
    const bad = (scene: object) => validateSpec({ ...base, scenes: [base.scenes[0], scene] }, { type: JD, script: AFTER_SCRIPT, length_s: 60 }).issues.filter((i) => i.scene === 1 && i.level === "error").map((i) => i.message);
    expect(bad({ type: "hologram", cue: "The role" })).toEqual(['Scene 2: "hologram" is not a scene type.']);
    expect(validateSpec({ ...base, scenes: [base.scenes[0], { type: "quiz", cue: "The role" }] }, { type: JD, script: AFTER_SCRIPT }).issues.some((i) => i.code === "type_not_allowed")).toBe(true);
    expect(bad({ type: "match", cue: "The role", rows: [{ ask: "A", status: "maybe", cue: "role" }, { ask: "B", status: "gap", cue: "based" }] }).join(" ")).toMatch(/rows\.0\.status must be match, partial or gap/);
    expect(bad({ type: "checklist", cue: "The role", items: [{ text: "A", state: "sure", cue: "role" }, { text: "B", state: "no", cue: "based" }] }).join(" ")).toMatch(/state must be yes, partial or no/);
    expect(bad({ type: "chart", kind: "pie", cue: "The role", source: "x" }).join(" ")).toMatch(/kind must be bar or ring/);
    expect(bad({ type: "chart", kind: "ring", cue: "The role", value: 7, of: 5, label: "x", source: "x" }).join(" ")).toMatch(/value must be from 0 to of/);
  });

  it("checks diagrams: node ids, node kinds for the diagram kind, groups and edges", () => {
    const base = afterSpec();
    const errs = (scene: object) => validateSpec({ ...base, scenes: [base.scenes[0], scene] }, { type: JD, script: AFTER_SCRIPT, length_s: 60 }).issues.filter((i) => i.scene === 1 && i.level === "error").map((i) => i.message).join("\n");
    const d = (over: object) => ({ type: "diagram", kind: "architecture", cue: "The role", nodes: [{ id: "a", label: "A", cue: "role" }, { id: "b", label: "B", cue: "based" }], edges: [{ from: "a", to: "b" }], ...over });
    expect(errs(d({}))).toBe("");
    expect(errs(d({ edges: [{ from: "a", to: "zz" }] }))).toMatch(/must link two different nodes/);
    expect(errs(d({ edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] }))).toMatch(/repeats a link/);
    expect(errs(d({ nodes: [{ id: "a", label: "A", kind: "spaceship", cue: "role" }, { id: "b", label: "B", cue: "based" }] }))).toMatch(/kind must be one of: service, queue/);
    expect(errs(d({ kind: "userflow", nodes: [{ id: "a", label: "A", kind: "decision", cue: "role" }, { id: "b", label: "B", kind: "gpu", cue: "based" }] }))).toMatch(/kind must be one of: screen, decision, start, end/);
    expect(errs(d({ nodes: [{ id: "a", label: "A", group: "nope", cue: "role" }, { id: "b", label: "B", cue: "based" }] }))).toMatch(/group names a group that does not exist/);
    expect(errs(d({ kind: "mesh", edges: [] }))).toBe("");
  });

  it("an unknown icon or logo is a warning, not an error: a picture is picked from the label", () => {
    const base = afterSpec();
    const scene = { type: "icon-grid", cue: "The role", items: [{ label: "Python", icon: "nonsense", cue: "role" }, { label: "Data sharding", logo: "nope", cue: "based" }] };
    const r = validateSpec({ ...base, scenes: [base.scenes[0], scene] }, { type: JD, script: AFTER_SCRIPT, length_s: 60 });
    const mine = r.issues.filter((i) => i.scene === 1);
    expect(mine.every((i) => i.level === "warning" && i.code === "picture")).toBe(true);
    expect(mine).toHaveLength(2);
  });

  it("edits on-screen text of a visual scene through its editable fields only", () => {
    const s = structuredClone(sample("icon-grid")) as Extract<Scene, { type: "icon-grid" }>;
    setField(s, "items.0.label", "Snapshots");
    expect(s.items[0]!.label).toBe("Snapshots");
    expect(() => setField(s, "items.0.icon", "x")).toThrow();
  });
});

describe("word cap", () => {
  const spec3 = (scene: object): SceneSpec => ({ ...afterSpec(), scenes: [afterSpec().scenes[0]!, scene as Scene] });
  const long = { type: "bullet-build", cue: "The role", headline: "Five words in this headline", items: [{ text: "Point number one is long", cue: "role" }, { text: "Point number two is long", cue: "based" }] };

  it(`counts primary and secondary words; kickers, labels under pictures and source lines don't count (cap ${SCENE_WORD_CAP})`, () => {
    expect(screenWords({ type: "title", cue: "x", kicker: "Four words of kicker", title: "Three word title" })).toBe(3);
    expect(screenWords({ type: "icon-grid", cue: "x", headline: "Two words", items: [{ label: "Three word label", cue: "a" }, { label: "Another three words", cue: "b" }] })).toBe(2);
    expect(screenWords({ type: "quote", cue: "x", text: "Ship research code to real users.", by: "From the job ad" })).toBe(6);
    expect(screenWords({ type: "chart", kind: "ring", cue: "x", value: 4, label: "Years asked for", source: "A long source line here" })).toBe(3);
  });

  it("is an error in a version 3 spec, so the check's fix pass asks Claude to cut it", () => {
    const r = validateSpec(spec3(long), { type: JD, script: AFTER_SCRIPT, length_s: 60 });
    const cap = r.issues.find((i) => i.code === "word_cap")!;
    expect(cap).toMatchObject({ level: "error", scene: 1 });
    expect(cap.message).toBe(`Scene 2: shows 15 words on screen; keep it to ${SCENE_WORD_CAP}. Say the rest in the narration, or pick a visual scene.`);
  });

  it("leaves a version 2 spec alone (written before the cap), but still caps a visual scene in it", () => {
    const v2 = { ...spec3(long), version: 2 as const };
    expect(validateSpec(v2, { type: JD, script: AFTER_SCRIPT, length_s: 60 }).issues.some((i) => i.code === "word_cap")).toBe(false);
    const wordy = { type: "kinetic", cue: "The role", lines: [{ text: "One two three four", cue: "role" }, { text: "five six seven eight", cue: "based" }, { text: "nine ten eleven twelve", cue: "Brisbane" }], emphasis: "twelve" };
    const ok = validateSpec({ ...v2, scenes: [v2.scenes[0]!, wordy as Scene] }, { type: JD, script: AFTER_SCRIPT, length_s: 60 });
    expect(ok.issues.some((i) => i.code === "word_cap")).toBe(false);
    const over = { ...wordy, lines: [...wordy.lines.slice(0, 2), { text: "nine ten eleven twelve thirteen", cue: "Brisbane" }] };
    // A line is capped at 4 words on its own; the scene total of 13 is over the cap too.
    const r = validateSpec({ ...v2, scenes: [v2.scenes[0]!, over as Scene] }, { type: JD, script: AFTER_SCRIPT, length_s: 60 });
    expect(r.issues.some((i) => i.level === "error" && i.scene === 1)).toBe(true);
  });

  it("never applies to quiz and code scenes", () => {
    const code = { type: "code-highlight", cue: "x", lang: "ts", headline: "A headline that is quite long for a code scene", code: "a();", steps: [{ lines: [1, 1], note: "One two three four five six seven eight nine ten", cue: "x" }] };
    expect(screenWords(code as Scene)).toBeGreaterThan(SCENE_WORD_CAP);
    const r = validateSpec({ version: 3, title: "T", voice_type: "guide", scenes: [{ type: "title", cue: "x", kicker: "K", title: "T" }, code] }, { type: typeOf("skill-gap-lesson"), script: "x\n\nx\n" });
    expect(r.issues.some((i) => i.code === "word_cap")).toBe(false);
  });

  it("the writer is told the cap and the scene to pick for each kind of idea", () => {
    const lines = visualLines(JD).join("\n");
    expect(lines).toContain(`at most ${SCENE_WORD_CAP} words a scene`);
    expect(lines).toContain("  - logo-row: technologies or tools by name");
    expect(visualLines(typeOf("weekly-recap"))).toEqual([]);
  });
});

describe("expander output per scene type", () => {
  const items = (s: Scene): Record<string, number> => Object.fromEntries(itemCues(s).map((c, k) => [c.key, 11 + k * 1.5]));

  it.each(VISUAL_SCENE_TYPES.filter((t) => afterSpec().scenes.some((s) => s.type === t)))("%s: reveals land on their cue times, all inside the scene", (t) => {
    const s = sample(t);
    const it_ = items(s);
    const out = buildScene(s, { t: time({ type: s.type, items: it_ }), index: 1, count: 10 });
    const js = out.js.join("\n");
    for (const at of Object.values(it_)) expect(js, `${t} reveal at ${at}`).toContain(`, ${at}, `);
    for (const m of js.matchAll(/, (\d+(?:\.\d+)?)(?:, [^)]*)?\);/g)) {
      const n = Number(m[1]);
      if (n > 5) { expect(n).toBeGreaterThanOrEqual(10); expect(n).toBeLessThanOrEqual(20); }
    }
    expect(out.warnings).toEqual([]);
  });

  it("icon-grid: named icons and logos are drawn from the packs, and the label's own logo when none is named", () => {
    const html = buildScene(sample("icon-grid"), { t: time(), index: 1, count: 10 }).html;
    expect(html).toContain(logo("prometheus")!.path.slice(0, 40));
    expect(html).toContain(logo("grafana")!.path.slice(0, 40));
    expect(html).toContain('class="ic"');
    expect(html).toContain('stroke-dashoffset="1"'); // icons draw themselves in
  });

  it("diagram: nodes are placed by the layout, edges draw after both ends appear, groups surround their nodes", () => {
    const s = sample("diagram") as Extract<Scene, { type: "diagram" }>;
    const out = buildScene(s, { t: time({ items: { "nodes.0": 11, "nodes.1": 12, "nodes.2": 13, "nodes.3": 14, "nodes.4": 15 } }), index: 1, count: 10 });
    const js = out.js.join("\n");
    expect(js).toContain('K.drawPath(tl, "#s2-e0", 13.25, 0.55);'); // p1 (11) to relay (13)
    expect(js).toContain('K.drawPath(tl, "#s2-e3", 15.25, 0.55);'); // relay to prom (15)
    expect(out.html).toContain('class="dg-group"');
    expect(out.html.match(/class="dg-node/g)).toHaveLength(5);
  });

  it("reduced motion: no icon drawing, no Ken Burns, edges drawn already", () => {
    const d = buildScene(sample("diagram"), { t: time(), index: 1, count: 10, reduced: true });
    expect(d.html).not.toContain('stroke-dashoffset="1"');
    expect(d.js.join("\n")).not.toContain("K.drawIcon");
    const cc = buildScene({ type: "company-card", cue: "x", name: "Example Labs" }, { t: time(), index: 1, count: 10, reduced: true, media: { logo: { src: "assets/company-logo.svg", company: "Example Labs" } } });
    expect(cc.html).toContain('src="assets/company-logo.svg"');
  });

  it("title and company card show the workspace logo with a slow push-in, and the board mark", () => {
    const media = { logo: { src: "assets/company-logo.png", company: "Example Labs" }, board: { src: "assets/board-seek.png", name: "SEEK" } };
    const t = buildScene({ type: "title", cue: "x", kicker: "K", title: "T" }, { t: time(), index: 0, count: 10, media });
    expect(t.html).toContain('src="assets/company-logo.png"');
    expect(t.html).toContain('src="assets/board-seek.png"');
    expect(t.js.join("\n")).toContain('K.kenBurns(tl, "#s2-img", 10, 20);');
    const bare = buildScene({ type: "title", cue: "x", kicker: "K", title: "T" }, { t: time(), index: 0, count: 10 });
    expect(bare.html).not.toContain("<img");
  });

  it("map-pin: a known Australian city sits on the dot map; anywhere else gets a plain globe", () => {
    const au = buildScene({ type: "map-pin", cue: "x", city: "Brisbane" }, { t: time(), index: 1, count: 10 }).html;
    expect(au).toContain("mp-dots");
    const away = buildScene({ type: "map-pin", cue: "x", city: "Lisbon" }, { t: time(), index: 1, count: 10 }).html;
    expect(away).toContain("mp-globe");
  });
});

describe("packs", () => {
  it("ships open-licence icons and logos with the names the writer is told", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(100);
    expect(LOGO_SLUGS).toEqual(expect.arrayContaining(["python", "prometheus", "grafana", "kubernetes", "pytorch"]));
    for (const s of LOGO_SLUGS) expect(["CC0-1.0", "MIT", "Apache-2.0"]).toContain(logo(s)!.license);
  });

  it("finds logos in a label: 'Prometheus and Grafana' gives both", () => {
    expect(logosIn("Prometheus and Grafana").map((l) => l.slug)).toEqual(["prometheus", "grafana"]);
    expect(logo("k8s")!.slug).toBe("kubernetes");
    expect(logo("constructor")).toBeNull();
    expect(icon("constructor")).toBeNull();
  });

  it("picks a picture: named logo, named icon, a logo or icon from the label, else initials", () => {
    expect(pictureFor("Anything", { logo: "python" })).toMatchObject({ kind: "logo" });
    expect(pictureFor("Anything", { icon: "database" })).toMatchObject({ kind: "icon", name: "database" });
    expect(pictureFor("Async Python")).toMatchObject({ kind: "logo" });
    expect(iconFor("Checkpointing")).toBe("hard-drive");
    expect(pictureFor("Zxqv Wplm")).toEqual({ kind: "initials", text: "ZW" });
    expect(initials("AWS")).toBe("AWS");
  });
});

describe("layout", () => {
  it("ranks nodes left to right by longest path and ignores a back edge", () => {
    const r = ranks([{ id: "a", w: 1, h: 1 }, { id: "b", w: 1, h: 1 }, { id: "c", w: 1, h: 1 }], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, { from: "a", to: "c" }]);
    expect([...r.entries()]).toEqual([["a", 0], ["b", 1], ["c", 2]]);
  });

  it("is deterministic and stays inside its area", () => {
    const s = sample("diagram") as Extract<Scene, { type: "diagram" }>;
    const a = diagramLayout(s, true), b = diagramLayout(s, true);
    expect(a).toEqual(b);
    for (const n of a.nodes) { expect(n.x).toBeGreaterThanOrEqual(0); expect(n.x + n.w).toBeLessThanOrEqual(1640); expect(n.y).toBeGreaterThanOrEqual(0); expect(n.y + n.h).toBeLessThanOrEqual(540); }
  });

  it("a mesh with no edges links every pair, on a ring", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({ id, w: 100, h: 100 }));
    const L = ring(nodes, [], { x: 0, y: 0, w: 1000, h: 600 });
    expect(L.edges).toHaveLength(6);
    expect(layered(nodes, [], { x: 0, y: 0, w: 1000, h: 600 }).nodes).toHaveLength(4);
  });

  it("puts an edge label above a straight lead-out, clear of the curve", () => {
    const nodes = ["a", "b"].map((id) => ({ id, w: 200, h: 100 }));
    const L = layered(nodes, [{ from: "a", to: "b", lead: 150 }], { x: 0, y: 0, w: 1000, h: 400 });
    const a = L.nodes.find((n) => n.id === "a")!, e = L.edges[0]!;
    expect(e.d).toMatch(/^M [\d.]+ [\d.]+ L /);
    expect(e.label.align).toBe("start");
    expect(e.label.y).toBeLessThan(a.y + a.h / 2 - 20);
    const plain = layered(nodes, [{ from: "a", to: "b" }], { x: 0, y: 0, w: 1000, h: 400 }).edges[0]!;
    expect(plain.d).not.toContain(" L ");
  });

  it("knows Australian cities and states, and projects them onto the map box", () => {
    expect(findPlace("Brisbane")).toMatchObject({ region: "Queensland" });
    expect(findPlace("Somewhere", "NSW")).toMatchObject({ region: "New South Wales" });
    expect(findPlace("Lisbon")).toBeNull();
    const p = project(153.03, -27.47);
    expect(p.x).toBeGreaterThan(700);
  });
});
