import { CAPTION_STYLES } from "@careeros/core";
import { trimTrailingNewlines } from "./html.js";
import { estimateSeconds, findPhrase, isPauseTooLong, parseScript, sceneBlocks, tokens, WORDS_PER_SECOND, type ScriptBlock } from "./script.js";
import { IN_DEPTH_FROM_S, MAX_AVG_SCENE_S, MAX_SCENES, MIN_SCENES, maxScenes, sceneCountsFor } from "./lengths.js";
import { ARCH_KINDS, FLOW_KINDS, icon as packIcon, logo as packLogo } from "./packs.js";
import { CHECK_STATES, DIAGRAM_KINDS, MATCH_STATUS, SCENE_TYPES, SCENE_WORD_CAP, TEXT_ROLES, VISUAL_SCENE_TYPES, WORD_CAP_EXEMPT, type EditableField, type TextRole, type Issue, type Scene, type SceneSpec, type SceneType, type VideoMode, type VideoType } from "./types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const LINE_CTRL = /[\u0000-\u001f\u007f]/;
const CODE_CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const MAX_CHARS = 300;
export const wordsIn = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

// ---- untrusted-input bounds (scripts and specs are written by Claude; treat them as hostile) ----
// A script far longer than any real video needs (the 600 s ceiling at ~2.5 words/s is ~1,500 words, about 9,000 characters,
// well under this). Checked before parsing so a huge string never gets split/scanned.
const MAX_SCRIPT_CHARS = 20_000;
// Generous for v2's real shape (raw -> scenes -> scene -> e.g. left -> items -> string is 5 deep;
// flowchart node sources go one deeper). Anything past this is hostile, not a real spec.
const MAX_SPEC_DEPTH = 12;
// A sanity ceiling far above the real scene limit (2 to 60, by length; see lengths.ts): large enough to never affect a real spec,
// small enough that iterating this many scenes in the loops below can't be used as a DoS.
const ABSOLUTE_MAX_SCENES = 500;
// Every catalog list in a real spec maxes out at 8 (sources); this is a hard ceiling checked
// before any iteration, so a hostile multi-million-entry array is refused immediately rather than
// fully walked (every caller of list() iterates whatever it returns).
const ABSOLUTE_MAX_LIST = 200;
// Above this many children at one level, don't bother walking them for depth: list() and
// sources() independently refuse (and never iterate) anything this wide before our own code ever
// gets near its contents, so skipping the depth check here only trades a redundant scan for O(1).
const MAX_SPEC_BREADTH = 1000;

/** Bounded depth walk: stops as soon as `depth` exceeds the limit, so this can never stack-overflow
 * no matter how deep the input actually goes (recursion is capped at MAX_SPEC_DEPTH + 1 frames).
 * Also bounded in breadth (see MAX_SPEC_BREADTH): a node with more than that many children is
 * refused outright (an O(1) length check), rather than being treated as "not too deep" and left for
 * a caller further down to iterate. That used to let a huge-but-shallow array hide a hostile element
 * (e.g. something deeply nested) from this very walk, since skipping straight to `false` meant the
 * element was never looked at by anything. Refusing it here instead is also what makes the check
 * fast: it never has to walk into (or even look at) whatever the wide node contains. */
function tooDeep(v: unknown, limit = MAX_SPEC_DEPTH, depth = 0): boolean {
  if (depth > limit) return true;
  if (Array.isArray(v)) return v.length > MAX_SPEC_BREADTH || v.some((x) => tooDeep(x, limit, depth + 1));
  if (isObj(v)) { const vals = Object.values(v); return vals.length > MAX_SPEC_BREADTH || vals.some((x) => tooDeep(x, limit, depth + 1)); }
  return false;
}

const BASE_KEYS = ["type", "cue", "marks", "chapter", "hold", "sources"];
const KEYS: Record<SceneType, string[]> = {
  title: ["kicker", "title", "subtitle", "underline"], "bullet-build": ["headline", "items", "numbered"],
  "code-typing": ["lang", "code", "headline", "label", "cue_done"], "code-highlight": ["lang", "code", "headline", "steps"],
  "code-morph": ["lang", "from", "to", "headline", "cue_morph"], "code-diff": ["lang", "before", "after", "headline", "note"],
  flowchart: ["headline", "direction", "nodes", "edges"], sequence: ["headline", "actors", "messages"],
  comparison: ["headline", "left", "right", "cue_left", "cue_right", "verdict"], stat: ["value", "prefix", "suffix", "decimals", "label", "source"],
  quiz: ["kind", "question", "think_seconds", "beats", "strong", "weak", "prompt", "cue_review"], "recap-card": ["headline", "items", "closing"],
  "icon-grid": ["headline", "items"], "logo-row": ["headline", "items"], diagram: ["kind", "headline", "nodes", "edges", "groups"],
  match: ["headline", "left_label", "right_label", "rows"], checklist: ["headline", "items"], timeline: ["headline", "steps"],
  chart: ["kind", "headline", "bars", "value", "of", "label", "suffix", "source"], quote: ["text", "by"],
  "company-card": ["name", "location", "size", "detail"], "map-pin": ["city", "region", "label"], kinetic: ["lines", "emphasis"],
  matrix: ["headline", "cols", "rows"],
};
const isVisual = (t: unknown): boolean => (VISUAL_SCENE_TYPES as readonly unknown[]).includes(t);

/** `length_s`: the length the person asked for (Make video's preset or custom length). Without it the type's target
 * is used for the length check and the type's longest length for the scene ceiling. */
export interface SpecContext { type: VideoType; script: string; mode?: VideoMode; length_s?: number }

declare const VALIDATED: unique symbol;
/**
 * A `SceneSpec` that has passed `validateSpec` with zero error-level issues. The *type* alone
 * (Fix round 1) isn't the real guarantee - a cast, an `any` value from `JSON.parse`, or
 * `{ ...validated }` all typecheck as `ValidatedSpec` without ever calling `requireValidated`, and
 * a brand alone can't stop any of that; TypeScript's type system is erased at runtime. The real
 * guarantee is `requireValidated`'s module-level `WeakSet`, checked by `isValidated` below: a
 * `SceneSpec` is only ever added to it once, by `requireValidated` itself, and only as a fresh
 * deep-frozen `structuredClone` - so it can't be forged by a cast, can't be produced from parsed
 * JSON, can't be faked by copying a genuinely validated spec's shape into a new object (the set
 * holds object identity, not structural equality), and can't be mutated after the fact (frozen) or
 * have an earlier mutation of the *original* object flow through (it's a clone, not the same
 * reference). `buildHtml`/`expand` (expander.ts) check `isValidated` at runtime and throw a plain
 * error if it's false - the type is a second line of defense (catches honest mistakes at
 * compile time), not the only one.
 */
export type ValidatedSpec = SceneSpec & { readonly [VALIDATED]: true };
export interface SpecResult { spec: SceneSpec | null; issues: Issue[]; estimate_s: number }

// A single hostile scene can otherwise make validateSpec return as many issues as it has bad
// fields (e.g. a scene with a million unknown keys would return a million near-identical "is not
// a field this scene uses" messages). Capped well above anything a real spec ever produces (the
// catalog limits above mean a real scene has at most a few dozen fields to begin with).
const MAX_ISSUES = 50;

class Report {
  issues: Issue[] = [];
  private suppressed = 0;
  // Per-scene error counts, updated by every add() call regardless of whether the capped `issues`
  // array below still has room. A scene's validity (see errorsIn(), used to build `valid[]` in
  // validateSpec) must never depend on whether an earlier scene already used up the shared issues
  // budget: that used to let a scene with a genuine error (e.g. missing required code) be treated
  // as valid, just because an earlier hostile scene's flood of errors filled the capped array first.
  private sceneErrors = new Map<number, number>();
  add(level: Issue["level"], scene: number | null, path: string, message: string, code: string): void {
    if (level === "error" && scene !== null) this.sceneErrors.set(scene, (this.sceneErrors.get(scene) ?? 0) + 1);
    if (this.issues.length >= MAX_ISSUES) { this.suppressed++; return; }
    this.issues.push({ level, code, scene, path, message: scene === null ? message : `Scene ${scene + 1}: ${message}` });
  }
  err(scene: number | null, path: string, message: string, code = "spec"): void { this.add("error", scene, path, message, code); }
  warn(scene: number | null, path: string, message: string, code = "spec"): void { this.add("warning", scene, path, message, code); }
  /** Reads the unbounded per-scene counter, never the capped `issues` array, so this stays correct
   * no matter how many issues an earlier scene already used up. */
  errorsIn(scene: number): number { return this.sceneErrors.get(scene) ?? 0; }
  /** The issues to actually return: unchanged unless the cap above was hit, in which case one
   * summary line is appended rather than growing the list without bound. The count in that line is
   * every add() call that was dropped (errors and warnings alike), not just the ones belonging to
   * scenes that otherwise have no recorded issues. Doesn't mutate `issues` itself, so it's safe to
   * call from more than one return site. */
  finish(): Issue[] {
    if (!this.suppressed) return this.issues;
    return [...this.issues, { level: "error", code: "limit", scene: null, path: "", message: `...and ${this.suppressed} more problem${this.suppressed === 1 ? "" : "s"}.` }];
  }
}

interface TextOpts { required?: boolean; maxWords?: number; maxChars?: number }
function text(r: Report, o: Obj, key: string, sc: number | null, path: string, opts: TextOpts = {}): string | undefined {
  const v = o[key];
  const required = opts.required !== false;
  if (v === undefined || v === null) { if (required) r.err(sc, path, `${path} is missing.`); return undefined; }
  if (typeof v !== "string") { r.err(sc, path, `${path} must be text.`); return undefined; }
  if (LINE_CTRL.test(v)) { r.err(sc, path, `${path} has a control character.`); return undefined; }
  if (!v.trim()) { if (required) r.err(sc, path, `${path} is empty.`); return undefined; }
  const max = opts.maxChars ?? MAX_CHARS;
  if (v.length > max) r.err(sc, path, `${path} is too long (${v.length} characters; at most ${max}).`, "limit");
  else if (opts.maxWords && wordsIn(v) > opts.maxWords) r.err(sc, path, `${path} has ${wordsIn(v)} words; keep it to ${opts.maxWords}.`, "limit");
  return v;
}
function cue(r: Report, o: Obj, key: string, sc: number, path: string): void {
  const v = text(r, o, key, sc, path, { maxChars: 80 });
  if (v !== undefined && wordsIn(v) > 4) r.err(sc, path, `${path} should be 1 to 4 words copied from the script.`, "limit");
}
function code(r: Report, o: Obj, key: string, sc: number): number {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) { r.err(sc, key, `${key} is missing.`); return 0; }
  if (CODE_CTRL.test(v)) { r.err(sc, key, `${key} has a control character.`); return 0; }
  const lines = trimTrailingNewlines(v.replace(/\t/g, "  ")).split("\n");
  if (lines.length > 10) r.err(sc, key, `${key} has ${lines.length} lines; at most 10.`, "limit");
  lines.forEach((l, i) => { if (l.length > 60) r.err(sc, key, `${key} line ${i + 1} has ${l.length} characters; at most 60.`, "limit"); });
  return lines.length;
}
function list(r: Report, o: Obj, key: string, sc: number, min: number, max: number, path = key): unknown[] | undefined {
  const v = o[key];
  if (!Array.isArray(v)) { r.err(sc, path, `${path} must be a list.`); return undefined; }
  const sizeMsg = () => `${path} must have ${min === max ? min : `${min} to ${max}`} entries; it has ${v.length}.`;
  // Checked before any iteration (same shape as sources()'s own ceiling): a hostile
  // multi-million-entry array must never be walked, even just to type-check each entry, since
  // every caller of list() goes on to iterate whatever it gets back.
  if (v.length > ABSOLUTE_MAX_LIST) { r.err(sc, path, sizeMsg(), "limit"); return []; }
  if (v.length < min || v.length > max) r.err(sc, path, sizeMsg(), "limit");
  return v;
}
function onlyKeys(r: Report, o: Obj, allowed: string[], sc: number, prefix: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) r.err(sc, `${prefix}${k}`, `${prefix}${k} is not a field this scene uses.`);
}
function sources(r: Report, v: unknown, sc: number, path: string): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length > 8) { r.err(sc, path, `${path} must be a list of up to 8 sources.`); return; }
  v.forEach((s, i) => {
    const p = `${path}.${i}`;
    if (!isObj(s)) { r.err(sc, p, `${p} must be an object.`); return; }
    onlyKeys(r, s, ["file", "quote", "url"], sc, `${p}.`);
    const f = s.file;
    if (typeof f !== "string" || !f || f.length > 300 || LINE_CTRL.test(f) || f.startsWith("/") || f.includes("\\") || /^[A-Za-z]:/.test(f)
      || f.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
      r.err(sc, `${p}.file`, `${p}.file isn't a workspace file path.`);
    }
    if (s.quote !== undefined) text(r, s, "quote", sc, `${p}.quote`);
    if (s.url !== undefined && (typeof s.url !== "string" || !/^https:\/\/\S{1,490}$/.test(s.url))) r.err(sc, `${p}.url`, `${p}.url must be an https link.`);
  });
}
function role(r: Report, o: Obj, sc: number, path: string): void {
  if (o.role !== undefined && !(TEXT_ROLES as readonly unknown[]).includes(o.role)) r.err(sc, `${path}role`, `${path}role must be primary, secondary, support or decorative.`);
}
function cuedItems(r: Report, o: Obj, sc: number, min: number, max: number, maxWords: number): void {
  const items = list(r, o, "items", sc, min, max);
  items?.forEach((it, i) => {
    const p = `items.${i}`;
    if (!isObj(it)) { r.err(sc, p, `${p} must be an object.`); return; }
    onlyKeys(r, it, ["text", "cue", "sources", "role"], sc, `${p}.`);
    role(r, it, sc, `${p}.`);
    text(r, it, "text", sc, `${p}.text`, { maxWords });
    cue(r, it, "cue", sc, `${p}.cue`);
    sources(r, it.sources, sc, `${p}.sources`);
  });
}
function strings(r: Report, o: Obj, key: string, sc: number, min: number, max: number, maxWords: number): string[] {
  const v = list(r, o, key, sc, min, max) ?? [];
  return v.map((x, i) => text(r, { x }, "x", sc, `${key}.${i}`, { maxWords }) ?? "");
}

/** An item's optional `icon` / `logo`: a name the packs don't have is a warning (the expander picks a picture from
 * the label instead), never text that reaches the page. */
function picture(r: Report, o: Obj, sc: number, p: string): void {
  if (o.icon !== undefined && (typeof o.icon !== "string" || !packIcon(o.icon))) r.warn(sc, `${p}icon`, `${p}icon "${String(o.icon).slice(0, 40)}" is not in the icon pack, so a picture is picked from the label.`, "picture");
  if (o.logo !== undefined && (typeof o.logo !== "string" || !packLogo(o.logo))) r.warn(sc, `${p}logo`, `${p}logo "${String(o.logo).slice(0, 40)}" is not in the logo pack, so its initials are shown.`, "picture");
}
/** A list of cued objects with only `keys`; `each` checks one entry's own fields. */
function cuedList(r: Report, o: Obj, key: string, sc: number, min: number, max: number, keys: string[], each: (it: Obj, p: string) => void): unknown[] {
  const v = list(r, o, key, sc, min, max) ?? [];
  v.forEach((it, k) => {
    const p = `${key}.${k}`;
    if (!isObj(it)) { r.err(sc, p, `${p} must be an object.`); return; }
    onlyKeys(r, it, [...keys, "cue"], sc, `${p}.`);
    each(it, `${p}.`);
    cue(r, it, "cue", sc, `${p}.cue`);
    if (keys.includes("sources")) sources(r, it.sources, sc, `${p}.sources`);
  });
  return v;
}
const enumOf = (r: Report, o: Obj, key: string, sc: number, p: string, allowed: readonly string[]): void => {
  if (!allowed.includes(String(o[key]))) r.err(sc, `${p}${key}`, `${p}${key} must be ${allowed.slice(0, -1).join(", ")} or ${allowed.at(-1)}.`);
};
const number = (r: Report, o: Obj, key: string, sc: number, p: string, required = true): void => {
  const v = o[key];
  if (v === undefined && !required) return;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v >= 1e12) r.err(sc, `${p}${key}`, `${p}${key} must be a number from 0 up.`);
};

function visualScene(r: Report, s: Obj, i: number): void {
  const head = () => text(r, s, "headline", i, "headline", { required: false, maxWords: 8 });
  switch (s.type) {
    case "icon-grid":
      head();
      cuedList(r, s, "items", i, 2, 6, ["label", "icon", "logo", "sources"], (it, p) => { text(r, it, "label", i, `${p}label`, { maxWords: 3 }); picture(r, it, i, p); });
      break;
    case "logo-row":
      head();
      cuedList(r, s, "items", i, 2, 6, ["name", "sources"], (it, p) => { text(r, it, "name", i, `${p}name`, { maxWords: 3 }); });
      break;
    case "diagram": {
      head();
      enumOf(r, s, "kind", i, "", DIAGRAM_KINDS);
      const groups: string[] = [];
      if (s.groups !== undefined) {
        (list(r, s, "groups", i, 1, 3) ?? []).forEach((g, k) => {
          const p = `groups.${k}`;
          if (!isObj(g)) { r.err(i, p, `${p} must be an object.`); return; }
          onlyKeys(r, g, ["id", "label"], i, `${p}.`);
          if (typeof g.id !== "string" || !/^[a-z0-9_-]{1,20}$/.test(g.id) || groups.includes(g.id)) r.err(i, `${p}.id`, `${p}.id must be a short unique id like "core".`);
          else groups.push(g.id);
          text(r, g, "label", i, `${p}.label`, { maxWords: 3 });
        });
      }
      const ids: string[] = [];
      const kinds: readonly string[] = s.kind === "userflow" ? FLOW_KINDS : ARCH_KINDS;
      cuedList(r, s, "nodes", i, 2, 8, ["id", "label", "kind", "group", "icon", "logo", "sources"], (nd, p) => {
        if (typeof nd.id !== "string" || !/^[a-z0-9_-]{1,20}$/.test(nd.id) || ids.includes(nd.id)) r.err(i, `${p}id`, `${p}id must be a short unique id like "api".`);
        else ids.push(nd.id);
        text(r, nd, "label", i, `${p}label`, { maxWords: 3 });
        if (nd.kind !== undefined && !kinds.includes(String(nd.kind))) r.err(i, `${p}kind`, `${p}kind must be one of: ${kinds.join(", ")}.`);
        if (nd.group !== undefined && !groups.includes(String(nd.group))) r.err(i, `${p}group`, `${p}group names a group that does not exist.`);
        picture(r, nd, i, p);
      });
      const seen = new Set<string>();
      (list(r, s, "edges", i, s.kind === "mesh" ? 0 : 1, 12) ?? []).forEach((e, k) => {
        const p = `edges.${k}`;
        if (!isObj(e)) { r.err(i, p, `${p} must be {"from", "to"} with an optional "label".`); return; }
        onlyKeys(r, e, ["from", "to", "label"], i, `${p}.`);
        if (!ids.includes(String(e.from)) || !ids.includes(String(e.to)) || e.from === e.to) r.err(i, p, `${p} must link two different nodes that exist.`);
        const key = [String(e.from), String(e.to)].sort().join(">");
        if (seen.has(key)) r.err(i, p, `${p} repeats a link.`);
        seen.add(key);
        if (e.label !== undefined) text(r, e, "label", i, `${p}.label`, { maxWords: 3 });
      });
      break;
    }
    case "match":
      head();
      text(r, s, "left_label", i, "left_label", { required: false, maxWords: 3 });
      text(r, s, "right_label", i, "right_label", { required: false, maxWords: 3 });
      cuedList(r, s, "rows", i, 2, 5, ["ask", "status", "icon", "logo", "sources"], (it, p) => {
        text(r, it, "ask", i, `${p}ask`, { maxWords: 4 }); enumOf(r, it, "status", i, p, MATCH_STATUS); picture(r, it, i, p);
      });
      break;
    case "checklist":
      head();
      cuedList(r, s, "items", i, 2, 5, ["text", "state", "sources"], (it, p) => { text(r, it, "text", i, `${p}text`, { maxWords: 4 }); enumOf(r, it, "state", i, p, CHECK_STATES); });
      break;
    case "timeline":
      head();
      cuedList(r, s, "steps", i, 2, 5, ["label", "when", "icon", "logo", "sources"], (it, p) => {
        text(r, it, "label", i, `${p}label`, { maxWords: 3 }); text(r, it, "when", i, `${p}when`, { required: false, maxWords: 3 }); picture(r, it, i, p);
      });
      break;
    case "chart":
      head();
      enumOf(r, s, "kind", i, "", ["bar", "ring"]);
      text(r, s, "suffix", i, "suffix", { required: false, maxChars: 6 });
      text(r, s, "source", i, "source", { maxWords: 14 });
      if (s.kind === "bar") {
        if (s.value !== undefined || s.of !== undefined) r.err(i, "value", "a bar chart takes bars, not value or of.");
        cuedList(r, s, "bars", i, 2, 5, ["label", "value"], (b, p) => { text(r, b, "label", i, `${p}label`, { maxWords: 3 }); number(r, b, "value", i, p); });
        text(r, s, "label", i, "label", { required: false, maxWords: 6 });
      } else if (s.kind === "ring") {
        if (s.bars !== undefined) r.err(i, "bars", "a ring chart takes value and of, not bars.");
        number(r, s, "value", i, ""); number(r, s, "of", i, "", false);
        const of = typeof s.of === "number" ? s.of : 100;
        if (typeof s.value === "number" && (of <= 0 || s.value > of)) r.err(i, "value", "value must be from 0 to of (100 when of is left out).");
        text(r, s, "label", i, "label", { maxWords: 6 });
      }
      break;
    case "quote":
      text(r, s, "text", i, "text", { maxWords: 12 });
      text(r, s, "by", i, "by", { maxWords: 5 });
      break;
    case "company-card":
      text(r, s, "name", i, "name", { maxWords: 5 });
      text(r, s, "location", i, "location", { required: false, maxWords: 4 });
      text(r, s, "size", i, "size", { required: false, maxWords: 4 });
      text(r, s, "detail", i, "detail", { required: false, maxWords: 8 });
      break;
    case "map-pin":
      text(r, s, "city", i, "city", { maxWords: 3 });
      text(r, s, "region", i, "region", { required: false, maxWords: 3 });
      text(r, s, "label", i, "label", { required: false, maxWords: 6 });
      break;
    case "kinetic": {
      const lines = cuedList(r, s, "lines", i, 1, 3, ["text"], (it, p) => { text(r, it, "text", i, `${p}text`, { maxWords: 4 }); });
      const em = text(r, s, "emphasis", i, "emphasis", { required: false, maxWords: 2 });
      if (em && !lines.some((l) => isObj(l) && typeof l.text === "string" && l.text.includes(em))) r.warn(i, "emphasis", `emphasis "${em}" is not in any line, so nothing is lit up.`);
      break;
    }
    case "matrix": {
      head();
      const cols = strings(r, s, "cols", i, 2, 4, 2);
      cuedList(r, s, "rows", i, 2, 4, ["label", "cells"], (it, p) => {
        text(r, it, "label", i, `${p}label`, { maxWords: 3 });
        const cells = it.cells;
        if (!Array.isArray(cells) || cells.length !== cols.length || !cells.every((c) => (CHECK_STATES as readonly unknown[]).includes(c))) {
          r.err(i, `${p}cells`, `${p}cells must have ${cols.length} entries, each yes, partial or no.`);
        }
      });
      break;
    }
  }
}

/** On-screen words a scene asks the viewer to read: primary and secondary text (scene-spec.md § Word cap). */
export function screenWords(s: Scene): number {
  return onScreenRoles(s).filter((x) => x.role === "primary" || x.role === "secondary").reduce((n, x) => n + wordsIn(x.text), 0);
}

function scene(r: Report, s: Obj, i: number, ctx: SpecContext): void {
  const t = s.type as SceneType;
  onlyKeys(r, s, [...BASE_KEYS, ...KEYS[t]], i, "");
  cue(r, s, "cue", i, "cue");
  const mode = ctx.mode ?? (ctx.type.modes.includes("practice") ? "practice" : "watch");
  switch (t) {
    case "title": {
      text(r, s, "kicker", i, "kicker", { maxWords: 4 });
      const title = text(r, s, "title", i, "title", { maxWords: 9 });
      text(r, s, "subtitle", i, "subtitle", { required: false, maxWords: 14 });
      const u = text(r, s, "underline", i, "underline", { required: false, maxWords: 1 });
      if (u && title && !title.includes(u)) r.err(i, "underline", `underline "${u}" is not a word in the title.`);
      break;
    }
    case "bullet-build":
      text(r, s, "headline", i, "headline", { maxWords: 12 });
      cuedItems(r, s, i, 2, 4, 9);
      if (s.numbered !== undefined && typeof s.numbered !== "boolean") r.err(i, "numbered", "numbered must be true or false.");
      break;
    case "code-typing":
      text(r, s, "lang", i, "lang", { maxChars: 20 }); code(r, s, "code", i);
      text(r, s, "headline", i, "headline", { required: false, maxWords: 12 });
      text(r, s, "label", i, "label", { required: false, maxWords: 9 });
      if (s.cue_done !== undefined) cue(r, s, "cue_done", i, "cue_done");
      break;
    case "code-highlight": {
      text(r, s, "lang", i, "lang", { maxChars: 20 });
      const n = code(r, s, "code", i);
      text(r, s, "headline", i, "headline", { required: false, maxWords: 12 });
      list(r, s, "steps", i, 1, 4)?.forEach((st, k) => {
        const p = `steps.${k}`;
        if (!isObj(st)) { r.err(i, p, `${p} must be an object.`); return; }
        onlyKeys(r, st, ["lines", "note", "cue", "role"], i, `${p}.`);
        role(r, st, i, `${p}.`);
        const ln = st.lines;
        if (!Array.isArray(ln) || ln.length !== 2 || !ln.every((x) => Number.isInteger(x) && x >= 1 && x <= n) || (ln[0] as number) > (ln[1] as number)) {
          r.err(i, `${p}.lines`, `${p}.lines must be [first, last] line numbers from 1 to ${n}.`);
        }
        text(r, st, "note", i, `${p}.note`, { maxWords: 14 });
        cue(r, st, "cue", i, `${p}.cue`);
      });
      break;
    }
    case "code-morph":
      text(r, s, "lang", i, "lang", { maxChars: 20 }); code(r, s, "from", i); code(r, s, "to", i);
      text(r, s, "headline", i, "headline", { required: false, maxWords: 12 });
      cue(r, s, "cue_morph", i, "cue_morph");
      break;
    case "code-diff":
      text(r, s, "lang", i, "lang", { maxChars: 20 }); code(r, s, "before", i); code(r, s, "after", i);
      text(r, s, "headline", i, "headline", { required: false, maxWords: 12 });
      text(r, s, "note", i, "note", { maxWords: 14 });
      break;
    case "flowchart": {
      text(r, s, "headline", i, "headline", { maxWords: 12 });
      const dir = s.direction;
      if (dir !== "lr" && dir !== "tb") r.err(i, "direction", 'direction must be "lr" or "tb".');
      const nodes = list(r, s, "nodes", i, 2, dir === "tb" ? 4 : 6) ?? [];
      const ids: string[] = [];
      nodes.forEach((nd, k) => {
        const p = `nodes.${k}`;
        if (!isObj(nd)) { r.err(i, p, `${p} must be an object.`); return; }
        onlyKeys(r, nd, ["id", "label", "sub", "cue", "sources", "role"], i, `${p}.`);
        role(r, nd, i, `${p}.`);
        if (typeof nd.id !== "string" || !/^[a-z0-9_-]{1,20}$/.test(nd.id) || ids.includes(nd.id)) r.err(i, `${p}.id`, `${p}.id must be a short unique id like "a".`);
        else ids.push(nd.id);
        text(r, nd, "label", i, `${p}.label`, { maxWords: 6 });
        text(r, nd, "sub", i, `${p}.sub`, { required: false, maxWords: 9 });
        cue(r, nd, "cue", i, `${p}.cue`);
        sources(r, nd.sources, i, `${p}.sources`);
      });
      (list(r, s, "edges", i, 0, Math.max(0, nodes.length - 1)) ?? []).forEach((e, k) => {
        const p = `edges.${k}`;
        if (!Array.isArray(e) || e.length < 2 || e.length > 3) { r.err(i, p, `${p} must be [from, to] or [from, to, label].`); return; }
        const a = ids.indexOf(String(e[0])), b = ids.indexOf(String(e[1]));
        if (a < 0 || b < 0) r.err(i, p, `${p} names a node that does not exist.`);
        else if (Math.abs(a - b) !== 1) r.err(i, p, `${p} must link neighbouring nodes.`);
        if (e[2] !== undefined) text(r, { l: e[2] }, "l", i, `${p}.label`, { maxWords: 4 });
      });
      break;
    }
    case "sequence": {
      text(r, s, "headline", i, "headline", { maxWords: 12 });
      const actors = strings(r, s, "actors", i, 2, 4, 3);
      if (new Set(actors).size !== actors.length) r.err(i, "actors", "actors must be different names.");
      list(r, s, "messages", i, 1, 6)?.forEach((m, k) => {
        const p = `messages.${k}`;
        if (!isObj(m)) { r.err(i, p, `${p} must be an object.`); return; }
        onlyKeys(r, m, ["from", "to", "label", "cue", "role"], i, `${p}.`);
        role(r, m, i, `${p}.`);
        if (!actors.includes(String(m.from)) || !actors.includes(String(m.to)) || m.from === m.to) r.err(i, p, `${p} must go between two different actors.`);
        text(r, m, "label", i, `${p}.label`, { maxWords: 7 });
        cue(r, m, "cue", i, `${p}.cue`);
      });
      break;
    }
    case "comparison":
      text(r, s, "headline", i, "headline", { maxWords: 12 });
      for (const side of ["left", "right"] as const) {
        const o = s[side];
        if (!isObj(o)) { r.err(i, side, `${side} must be an object with label and items.`); continue; }
        onlyKeys(r, o, ["label", "items", "role"], i, `${side}.`);
        role(r, o, i, `${side}.`);
        text(r, o, "label", i, `${side}.label`, { maxWords: 4 });
        strings(r, o, "items", i, 1, 4, 9);
      }
      cue(r, s, "cue_left", i, "cue_left"); cue(r, s, "cue_right", i, "cue_right");
      text(r, s, "verdict", i, "verdict", { required: false, maxWords: 12 });
      break;
    case "stat":
      if (typeof s.value !== "number" || !Number.isFinite(s.value) || Math.abs(s.value) >= 1e12) r.err(i, "value", "value must be a number.");
      text(r, s, "prefix", i, "prefix", { required: false, maxChars: 6 });
      text(r, s, "suffix", i, "suffix", { required: false, maxChars: 6 });
      if (s.decimals !== undefined && !(Number.isInteger(s.decimals) && (s.decimals as number) >= 0 && (s.decimals as number) <= 2)) r.err(i, "decimals", "decimals must be 0, 1 or 2.");
      text(r, s, "label", i, "label", { maxWords: 12 });
      text(r, s, "source", i, "source", { maxWords: 14 });
      break;
    case "quiz": {
      if (!["behavioural", "technical", "system-design"].includes(String(s.kind))) r.err(i, "kind", 'kind must be "behavioural", "technical" or "system-design".');
      text(r, s, "question", i, "question", { maxWords: 30 });
      const th = s.think_seconds;
      if (mode === "practice" && !(Number.isInteger(th) && (th as number) >= 5 && (th as number) <= 15)) r.err(i, "think_seconds", "think_seconds must be a whole number from 5 to 15 in practice mode.");
      if (mode === "watch" && th !== 0) r.err(i, "think_seconds", "think_seconds must be 0 in watch mode.");
      list(r, s, "beats", i, 4, 4)?.forEach((b, k) => {
        const p = `beats.${k}`;
        if (!isObj(b)) { r.err(i, p, `${p} must be an object.`); return; }
        onlyKeys(r, b, ["label", "text", "cue", "role"], i, `${p}.`);
        role(r, b, i, `${p}.`);
        text(r, b, "label", i, `${p}.label`, { maxWords: 3 });
        text(r, b, "text", i, `${p}.text`, { maxWords: 9 });
        cue(r, b, "cue", i, `${p}.cue`);
      });
      strings(r, s, "strong", i, 2, 2, 9);
      strings(r, s, "weak", i, 2, 2, 9);
      text(r, s, "prompt", i, "prompt", { maxWords: 12 });
      cue(r, s, "cue_review", i, "cue_review");
      break;
    }
    case "recap-card":
      text(r, s, "headline", i, "headline", { maxWords: 12 });
      cuedItems(r, s, i, 3, 3, 9);
      text(r, s, "closing", i, "closing", { maxWords: 14 });
      break;
    default:
      visualScene(r, s, i);
  }
  const marks = s.marks;
  if (marks !== undefined) {
    if (!Array.isArray(marks) || marks.length > 2) r.err(i, "marks", "marks must be a list of up to 2 marks.");
    else marks.forEach((m, k) => {
      const p = `marks.${k}`;
      if (!isObj(m)) { r.err(i, p, `${p} must be an object.`); return; }
      onlyKeys(r, m, ["type", "target", "cue"], i, `${p}.`);
      if (!["underline", "circle", "arrow", "highlight"].includes(String(m.type))) r.err(i, `${p}.type`, `${p}.type must be underline, circle, arrow or highlight.`);
      text(r, m, "target", i, `${p}.target`, { maxChars: 60 });
      cue(r, m, "cue", i, `${p}.cue`);
    });
  }
  if (s.chapter !== undefined && typeof s.chapter !== "boolean") r.err(i, "chapter", "chapter must be true or false.");
  if (s.hold !== undefined && !(typeof s.hold === "number" && s.hold >= 0 && s.hold <= 3)) r.err(i, "hold", "hold must be from 0 to 3 seconds.");
  sources(r, s.sources, i, "sources");
}

export function itemCues(s: Scene): { key: string; cue: string }[] {
  switch (s.type) {
    case "bullet-build": case "recap-card": return s.items.map((it, i) => ({ key: `items.${i}`, cue: it.cue }));
    case "code-typing": return s.cue_done ? [{ key: "cue_done", cue: s.cue_done }] : [];
    case "code-highlight": return s.steps.map((st, i) => ({ key: `steps.${i}`, cue: st.cue }));
    case "code-morph": return [{ key: "cue_morph", cue: s.cue_morph }];
    case "flowchart": return s.nodes.map((nd, i) => ({ key: `nodes.${i}`, cue: nd.cue }));
    case "sequence": return s.messages.map((m, i) => ({ key: `messages.${i}`, cue: m.cue }));
    case "comparison": return [{ key: "cue_left", cue: s.cue_left }, { key: "cue_right", cue: s.cue_right }];
    case "quiz": return [...s.beats.map((b, i) => ({ key: `beats.${i}`, cue: b.cue })), { key: "cue_review", cue: s.cue_review }];
    case "icon-grid": case "logo-row": case "checklist": return s.items.map((it, i) => ({ key: `items.${i}`, cue: it.cue }));
    case "diagram": return s.nodes.map((nd, i) => ({ key: `nodes.${i}`, cue: nd.cue }));
    case "match": case "matrix": return s.rows.map((r, i) => ({ key: `rows.${i}`, cue: r.cue }));
    case "timeline": return s.steps.map((st, i) => ({ key: `steps.${i}`, cue: st.cue }));
    case "chart": return (s.bars ?? []).map((b, i) => ({ key: `bars.${i}`, cue: b.cue }));
    case "kinetic": return s.lines.map((l, i) => ({ key: `lines.${i}`, cue: l.cue }));
    default: return [];
  }
}

// A JS object's key count (or nesting) can't be bounded in O(1) before JSON.parse has already
// built the object, so the raw text itself is capped by byte size instead, before parsing ever
// starts. 1 MiB is enormous for a real spec.json (a few KB in practice) and small enough that
// JSON.parse can never be asked to run on a hostile multi-gigabyte string.
export const MAX_SPEC_BYTES = 1024 * 1024;

/** Parses spec.json's raw text into an unknown value, refusing oversized input before ever calling
 * JSON.parse and turning a parse error into a plain issue instead of throwing. Later code that
 * reads spec.json from disk should go through this, not `JSON.parse` directly, so the byte cap and
 * friendly parse-error message are never bypassed. */
export function parseSpecText(text: string): { raw?: unknown; issues: string[] } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SPEC_BYTES) return { issues: [`spec.json is ${bytes} bytes; at most ${MAX_SPEC_BYTES}. Shorten it.`] };
  try {
    return { raw: JSON.parse(text) as unknown, issues: [] };
  } catch (e) {
    return { issues: [`spec.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

export function validateSpec(raw: unknown, ctx: SpecContext): SpecResult {
  const r = new Report();
  // Untrusted-input bounds, checked before any parsing or structural walk: scripts and specs are
  // written by Claude, so a run away/hostile size or nesting depth must be refused cheaply, not
  // processed. These never fire on a real spec (see the constants above for the margins used).
  if (ctx.script.length > MAX_SCRIPT_CHARS) {
    r.err(null, "script", `The script is ${ctx.script.length} characters; at most ${MAX_SCRIPT_CHARS}. Shorten it.`, "limit");
    return { spec: null, issues: r.finish(), estimate_s: 0 };
  }
  const blocks = parseScript(ctx.script);
  const estimate_s = estimateSeconds(blocks);
  for (const b of blocks) {
    if (b.kind === "speech" && isPauseTooLong(b.text)) {
      r.err(null, "script", `The script has a pause that's too long: "${b.text}". Keep it to at most 4 digits, with up to 2 decimal places, e.g. [pause 8].`, "limit");
    }
  }
  if (!isObj(raw)) { r.err(null, "", "spec.json must be a JSON object."); return { spec: null, issues: r.finish(), estimate_s }; }
  // Checked before any further structural walk (including Array.isArray/Object.keys on nested
  // values below): a hostile depth must be refused without ever recursing into it ourselves.
  if (tooDeep(raw)) { r.err(null, "", "spec.json is nested too deeply, or has too many entries to check."); return { spec: null, issues: r.finish(), estimate_s }; }
  for (const k of Object.keys(raw)) if (!["version", "title", "voice_type", "audio", "words", "captions", "format", "scenes"].includes(k)) r.err(null, k, `${k} is not a spec field.`);
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) r.err(null, "version", "version must be 3.");
  text(r, raw, "title", null, "title", { maxWords: 12 });
  if (raw.voice_type !== ctx.type.voice_type) r.err(null, "voice_type", `voice_type must be "${ctx.type.voice_type}" for ${ctx.type.label}.`);
  if (raw.captions !== undefined && !(CAPTION_STYLES as readonly unknown[]).includes(raw.captions)) r.err(null, "captions", "captions must be rail, pill, highlight or none.");
  if (raw.format !== undefined && raw.format !== "1920x1080") r.err(null, "format", "format must be 1920x1080.");
  if (!Array.isArray(raw.scenes)) { r.err(null, "scenes", "scenes must be a list."); return { spec: null, issues: r.finish(), estimate_s }; }
  const scenes = raw.scenes as unknown[];
  if (scenes.length > ABSOLUTE_MAX_SCENES) {
    // A hostile array of thousands of scenes must not be walked at all, even just to count or
    // type-check each entry: refuse it with the same message shape as the ordinary limit below.
    r.err(null, "scenes", `A video needs ${MIN_SCENES} to ${MAX_SCENES} scenes; this spec has ${scenes.length}.`, "limit");
    return { spec: null, issues: r.finish(), estimate_s };
  }
  const asked = ctx.length_s && ctx.length_s > 0 ? ctx.length_s : null;
  const sceneCap = maxScenes(asked ?? ctx.type.length.max_s);
  if (scenes.length < MIN_SCENES || scenes.length > sceneCap) {
    r.err(null, "scenes", `A video ${asked ? "this long " : ""}needs ${MIN_SCENES} to ${sceneCap} scenes; this spec has ${scenes.length}.`, "limit");
  }

  const valid: boolean[] = [];
  scenes.forEach((s, i) => {
    if (!isObj(s)) { r.err(i, "", "must be an object."); valid.push(false); return; }
    if (!(SCENE_TYPES as readonly unknown[]).includes(s.type)) { r.err(i, "type", `"${String(s.type)}" is not a scene type.`, "unknown_type"); valid.push(false); return; }
    if (!ctx.type.scene_types.includes(s.type as SceneType)) { r.err(i, "type", `${ctx.type.label} videos can't use ${String(s.type)} scenes.`, "type_not_allowed"); valid.push(false); return; }
    scene(r, s, i, ctx);
    // The word cap: an error in a version 3 spec and in any visual scene, so the check's fix pass asks Claude to cut
    // it. A version 1 or 2 spec (written before the cap, or the weekly recap template) is left alone: its scripts
    // still make their videos, and the reading-load warning already covers dense scenes.
    if (r.errorsIn(i) === 0 && !WORD_CAP_EXEMPT.includes(s.type as SceneType) && (raw.version === 3 || isVisual(s.type))) {
      const n = screenWords(s as unknown as Scene);
      if (n > SCENE_WORD_CAP) r.err(i, "", `shows ${n} words on screen; keep it to ${SCENE_WORD_CAP}. Say the rest in the narration, or pick a visual scene.`, "word_cap");
    }
    valid.push(r.errorsIn(i) === 0);
  });
  for (const [t, c] of Object.entries(sceneCountsFor(ctx.type, asked ?? ctx.type.length.target_s))) {
    const n = scenes.filter((s) => isObj(s) && s.type === t).length;
    if (c && (n < c.min || n > c.max)) r.err(null, "scenes", `${ctx.type.label} needs ${c.min === c.max ? c.min : `${c.min} to ${c.max}`} ${t} scene${c.max === 1 ? "" : "s"}; this spec has ${n}.`, "limit");
  }

  const spec = raw as unknown as SceneSpec;
  const toks = tokens(blocks);
  if (!toks.length) r.err(null, "script", "The script is empty.");
  else {
    const pos: number[] = [];
    let cursor = 0;
    spec.scenes.forEach((s, i) => {
      if (!valid[i]) { pos.push(-1); return; }
      const at = findPhrase(toks, s.cue, cursor);
      if (at < 0) {
        const anywhere = findPhrase(toks, s.cue, 0);
        r.err(i, "cue", anywhere >= 0
          ? `the cue "${s.cue}" comes before the previous scene's cue in the script. Cues must follow the script order.`
          : `the cue "${s.cue}" is not in the script. Change the cue or put the words back.`, "cue");
        pos.push(-1);
      } else { pos.push(at); cursor = at + 1; }
    });
    spec.scenes.forEach((s, i) => {
      if (pos[i]! < 0) return;
      const end = pos.slice(i + 1).find((p) => p >= 0) ?? toks.length;
      let c = pos[i]!;
      for (const { key, cue: phrase } of itemCues(s)) {
        const at = findPhrase(toks, phrase, c, end);
        if (at < 0) r.err(i, key, `the cue "${phrase}" for ${key} is not in this scene's part of the script. Change the cue or put the words back.`, "cue");
        else c = at + 1;
      }
      (s.marks ?? []).forEach((m, k) => {
        if (findPhrase(toks, m.cue, pos[i]!, end) < 0) r.err(i, `marks.${k}.cue`, `the cue "${m.cue}" for marks.${k} is not in this scene's part of the script.`, "cue");
      });
    });
    const ranges = sceneBlocks(blocks, spec);
    const mode = ctx.mode ?? (ctx.type.modes.includes("practice") ? "practice" : "watch");
    spec.scenes.forEach((s, i) => {
      if (!valid[i] || s.type !== "quiz") return;
      const rg = ranges[i]!;
      const pauses = blocks.slice(rg.from, rg.to).filter((b) => b.kind === "pause");
      if (mode === "watch") { if (pauses.length) r.err(i, "think_seconds", "watch mode has no pauses. Remove the [pause N] line.", "pause_mismatch"); return; }
      if (pauses.length !== 1) r.err(i, "think_seconds", "needs exactly one [pause N] line after the question.", "pause_mismatch");
      else if (pauses[0]!.seconds !== s.think_seconds) r.err(i, "think_seconds", `think_seconds is ${s.think_seconds} but the script pauses for ${pauses[0]!.seconds} seconds.`, "pause_mismatch");
    });
    const secs = sceneSeconds(blocks, pos);
    spec.scenes.forEach((s, i) => {
      if (!valid[i] || pos[i]! < 0) return;
      for (const w of readingLoad(s, secs[i]!)) r.warn(i, w.path, w.message, "reading_load");
    });
  }
  // Judged against the length asked for (a 1-minute request that comes back at 6 minutes is an error even though the
  // type allows 10), with the type's own range as the outer bound.
  const { min_s, max_s } = ctx.type.length;
  const want = Math.min(max_s, Math.max(min_s, asked ?? ctx.type.length.target_s));
  const hi = Math.min(max_s * 1.25, want * 1.5);
  const lo = Math.max(min_s * 0.75, want * 0.6);
  if (estimate_s > hi) r.err(null, "script", `The script runs about ${Math.round(estimate_s)} seconds; this video should run about ${want}. Shorten it.`, "length");
  else if (estimate_s < lo) r.warn(null, "script", `The script runs about ${Math.round(estimate_s)} seconds; aim for about ${want}.`, "length");
  // A longer video gets more scenes, not more words per scene.
  if (scenes.length >= MIN_SCENES && estimate_s / scenes.length > MAX_AVG_SCENE_S) {
    r.warn(null, "scenes", `Scenes run about ${Math.round(estimate_s / scenes.length)} seconds each. Split them so each runs 4 to 15 seconds.`, "scene_length");
  }
  if (want >= IN_DEPTH_FROM_S) {
    const chapters = scenes.filter((s) => isObj(s) && s.chapter === true).length;
    if (chapters < 2) r.warn(null, "scenes", `A video this long is split into chapters. Mark the first scene of each chapter with "chapter": true (this spec has ${chapters}).`, "chapters");
  }
  return { spec, issues: r.finish(), estimate_s };
}

// Holds the exact objects `requireValidated` has produced - identity, not structure, is what
// counts (Fix round 1). A `WeakSet` so a validated spec that's no longer referenced elsewhere can
// still be garbage-collected; nothing outside this module can add to it (not exported), so the
// only way in is actually calling `requireValidated`.
const VALIDATED_SPECS = new WeakSet<object>();

/** Recursively `Object.freeze`s `v` (objects and arrays; primitives are already immutable), so no
 * property - at any depth - can be written to afterwards. Safe to call on anything `structuredClone`
 * can produce (no cycles to worry about beyond what `Object.freeze` itself already handles, since
 * freezing doesn't recurse into values that were already visited by a different path in practice
 * for this package's plain JSON-shaped specs). */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/**
 * Turns a `validateSpec` result into a `ValidatedSpec`, or throws a plain `Error` listing every
 * error-level issue (a result with no spec at all - a grossly malformed input - is reported the
 * same way, using every issue it has). The returned value is a fresh `structuredClone` of
 * `result.spec`, deep-frozen and recorded in `VALIDATED_SPECS` - never the same object reference
 * `result.spec` was, so mutating the spec object the caller originally passed to `validateSpec`
 * (before or after this call) can never reach what `buildHtml`/`expand` will actually see, and the
 * returned spec itself can't be mutated either. This is the only way anything in this package can
 * add to `VALIDATED_SPECS`, which is what `isValidated` (and so `buildHtml`/`expand`) actually
 * check - see the `ValidatedSpec` doc comment above for why the type alone isn't enough.
 */
export function requireValidated(result: SpecResult): ValidatedSpec {
  const errors = result.issues.filter((i) => i.level === "error");
  if (!result.spec || errors.length) {
    const msgs = (errors.length ? errors : result.issues).map((i) => i.message);
    throw new Error(`spec is not valid:\n${msgs.join("\n")}`);
  }
  const clone = deepFreeze(structuredClone(result.spec)) as ValidatedSpec;
  VALIDATED_SPECS.add(clone);
  return clone;
}

/**
 * Whether `spec` is literally an object `requireValidated` produced - the real check behind
 * `ValidatedSpec` (see that type's doc comment). `buildHtml`/`expand` call this at runtime and
 * throw a plain error if it's false, so a cast, a value parsed fresh from JSON, or a spread copy
 * of a genuinely validated spec (all of which typecheck as `ValidatedSpec`) are refused all the
 * same - identity in `VALIDATED_SPECS`, not the TypeScript type, is what's actually checked.
 */
export function isValidated(spec: SceneSpec): spec is ValidatedSpec {
  return VALIDATED_SPECS.has(spec);
}

export function sceneHeadline(s: Scene): string {
  switch (s.type) {
    case "title": return s.title;
    case "quiz": return s.question;
    case "stat": return s.label;
    case "code-typing": return s.headline ?? s.label ?? `${s.lang} code`;
    case "code-highlight": case "code-morph": case "code-diff": return s.headline ?? `${s.lang} code`;
    case "quote": return s.text;
    case "company-card": return s.name;
    case "map-pin": return s.city;
    case "kinetic": return s.lines.map((l) => l.text).join(" ");
    case "chart": return s.headline ?? s.label ?? "Chart";
    case "icon-grid": return s.headline ?? s.items.map((x) => x.label).join(", ");
    case "logo-row": return s.headline ?? s.items.map((x) => x.name).join(", ");
    case "diagram": return s.headline ?? s.nodes.map((x) => x.label).join(", ");
    case "match": return s.headline ?? s.rows.map((x) => x.ask).join(", ");
    case "matrix": return s.headline ?? s.rows.map((x) => x.label).join(", ");
    case "checklist": return s.headline ?? s.items.map((x) => x.text).join(", ");
    case "timeline": return s.headline ?? s.steps.map((x) => x.label).join(", ");
    default: return s.headline;
  }
}

const NOT_ON_SCREEN = new Set(["role", "type", "cue", "cue_left", "cue_right", "cue_review", "cue_morph", "cue_done", "lang", "code", "from", "to", "before", "after", "sources", "id", "direction", "kind", "marks", "lines", "edges", "think_seconds", "decimals", "hold", "chapter", "numbered", "underline", "icon", "logo", "status", "state", "group", "cells", "of", "emphasis"]);

/** Every piece of text the scene shows (not code, cues or ids). Used by the fact check. */
// onScreenText may be called on a scene that never went through validateSpec (e.g. a direct fact
// check), so it needs its own bound: a scene this deep could not have passed validation (scenes
// are only a few levels deep by construction), but the walk must still be safe on unvalidated input.
const MAX_ONSCREEN_DEPTH = 12;

export function onScreenText(s: Scene): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string, depth = 0): void => {
    if (depth > MAX_ONSCREEN_DEPTH) return;
    if (NOT_ON_SCREEN.has(key)) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, "", depth + 1));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(s, "");
  if (s.type === "stat") out.push(String(s.value));
  return out;
}

const F = (path: string, label: string, value: string | undefined, max_words: number): EditableField => ({ path, label, value: value ?? "", max_words });

/** On-screen text the candidate may edit in the script review. Code, cues and sources are not editable there. */
export function editableFields(s: Scene): EditableField[] {
  switch (s.type) {
    case "title": return [F("kicker", "Kicker", s.kicker, 4), F("title", "Title", s.title, 9), ...(s.subtitle !== undefined ? [F("subtitle", "Subtitle", s.subtitle, 14)] : [])];
    case "bullet-build": return [F("headline", "Headline", s.headline, 12), ...s.items.map((it, i) => F(`items.${i}.text`, `Point ${i + 1}`, it.text, 9))];
    case "recap-card": return [F("headline", "Headline", s.headline, 12), ...s.items.map((it, i) => F(`items.${i}.text`, `Takeaway ${i + 1}`, it.text, 9)), F("closing", "Closing line", s.closing, 14)];
    case "comparison": return [
      F("headline", "Headline", s.headline, 12), F("left.label", "Left label", s.left.label, 4), ...s.left.items.map((x, i) => F(`left.items.${i}`, `Left ${i + 1}`, x, 9)),
      F("right.label", "Right label", s.right.label, 4), ...s.right.items.map((x, i) => F(`right.items.${i}`, `Right ${i + 1}`, x, 9)),
      ...(s.verdict !== undefined ? [F("verdict", "Verdict", s.verdict, 12)] : []),
    ];
    case "stat": return [F("label", "Claim", s.label, 12), F("source", "Source line", s.source, 14)];
    case "quiz": return [
      F("question", "Question", s.question, 30), ...s.beats.map((b, i) => F(`beats.${i}.text`, b.label, b.text, 9)),
      ...s.strong.map((x, i) => F(`strong.${i}`, `Lands well ${i + 1}`, x, 9)), ...s.weak.map((x, i) => F(`weak.${i}`, `Falls flat ${i + 1}`, x, 9)), F("prompt", "Practice prompt", s.prompt, 12),
    ];
    case "flowchart": return [F("headline", "Headline", s.headline, 12), ...s.nodes.flatMap((n, i) => [F(`nodes.${i}.label`, `Step ${i + 1}`, n.label, 6), ...(n.sub !== undefined ? [F(`nodes.${i}.sub`, `Step ${i + 1} detail`, n.sub, 9)] : [])])];
    case "sequence": return [F("headline", "Headline", s.headline, 12), ...s.messages.map((m, i) => F(`messages.${i}.label`, `Message ${i + 1}`, m.label, 7))];
    case "code-typing": return [...(s.headline !== undefined ? [F("headline", "Headline", s.headline, 12)] : []), ...(s.label !== undefined ? [F("label", "Label", s.label, 9)] : [])];
    case "code-highlight": return [...(s.headline !== undefined ? [F("headline", "Headline", s.headline, 12)] : []), ...s.steps.map((st, i) => F(`steps.${i}.note`, `Note ${i + 1}`, st.note, 14))];
    case "code-morph": return s.headline !== undefined ? [F("headline", "Headline", s.headline, 12)] : [];
    case "code-diff": return [...(s.headline !== undefined ? [F("headline", "Headline", s.headline, 12)] : []), F("note", "Why it changed", s.note, 14)];
    default: return visualFields(s);
  }
}

const optF = (path: string, label: string, value: string | undefined, max: number): EditableField[] => (value !== undefined ? [F(path, label, value, max)] : []);

function visualFields(s: Scene): EditableField[] {
  const head = "headline" in s ? optF("headline", "Headline", s.headline as string | undefined, 8) : [];
  switch (s.type) {
    case "icon-grid": return [...head, ...s.items.map((it, i) => F(`items.${i}.label`, `Label ${i + 1}`, it.label, 3))];
    case "logo-row": return [...head, ...s.items.map((it, i) => F(`items.${i}.name`, `Name ${i + 1}`, it.name, 3))];
    case "diagram": return [...head, ...s.nodes.map((n, i) => F(`nodes.${i}.label`, `Box ${i + 1}`, n.label, 3))];
    case "match": return [...head, ...s.rows.map((r, i) => F(`rows.${i}.ask`, `Ask ${i + 1}`, r.ask, 4))];
    case "checklist": return [...head, ...s.items.map((it, i) => F(`items.${i}.text`, `Item ${i + 1}`, it.text, 4))];
    case "timeline": return [...head, ...s.steps.flatMap((st, i) => [F(`steps.${i}.label`, `Step ${i + 1}`, st.label, 3), ...optF(`steps.${i}.when`, `Step ${i + 1} when`, st.when, 3)])];
    case "chart": return [...head, ...optF("label", "Label", s.label, 6), ...(s.bars ?? []).map((b, i) => F(`bars.${i}.label`, `Bar ${i + 1}`, b.label, 3)), F("source", "Source line", s.source, 14)];
    case "quote": return [F("text", "Quote", s.text, 12), F("by", "From", s.by, 5)];
    case "company-card": return [F("name", "Company", s.name, 5), ...optF("location", "Location", s.location, 4), ...optF("size", "Size", s.size, 4), ...optF("detail", "Detail", s.detail, 8)];
    case "map-pin": return [F("city", "City", s.city, 3), ...optF("region", "Region", s.region, 3), ...optF("label", "Label", s.label, 6)];
    case "kinetic": return s.lines.map((l, i) => F(`lines.${i}.text`, `Line ${i + 1}`, l.text, 4));
    case "matrix": return [...head, ...s.cols.map((c, i) => F(`cols.${i}`, `Column ${i + 1}`, c, 2)), ...s.rows.map((r, i) => F(`rows.${i}.label`, `Row ${i + 1}`, r.label, 3))];
    default: return [];
  }
}

export function setField(s: Scene, path: string, value: string): void {
  if (!editableFields(s).some((f) => f.path === path)) throw new Error(`"${path}" can't be edited here.`);
  const parts = path.split(".");
  let o = s as unknown as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
  o[parts.at(-1)!] = value.trim();
}

// ---- on-screen roles and reading load (scene-spec.md § Roles) ----
/** Words the viewer can read per second of scene, captions not counted. */
export const READING_WORDS_PER_SECOND = 3.5;
/** Below this many seconds a scene carries one message element (one primary or secondary line). */
export const SHORT_SCENE_S = 3;
const PRIMARY_KEYS = new Set(["headline", "question", "value"]);
const SUPPORT_KEYS = new Set(["kicker", "sub", "source", "prefix", "suffix", "actors", "prompt", "by", "when", "left_label", "right_label", "region", "size", "cols", "groups"]);
/** Scenes whose list labels caption a picture (an icon, a logo, a diagram node): support text, outside the word cap. */
const PICTURE_LABELS: ReadonlySet<SceneType> = new Set(["icon-grid", "logo-row", "diagram", "timeline", "matrix"]);
/** Top-level fields that are a visual scene's one primary item when it has no headline. */
const PRIMARY_TOP: Partial<Record<SceneType, string>> = { quote: "text", "company-card": "name", "map-pin": "city" };

export interface RoleText { path: string; text: string; role: TextRole }

/** Every on-screen text item with its role: the item's own `role` when set, else the field's default.
 * Defaults: the title (title scenes), headline, question and stat value are primary; kickers, node
 * details, sources, actors, prompts and the labels of comparison sides and quiz beats are support;
 * everything else is secondary. Nothing is decorative unless the spec says so. */
export function onScreenRoles(s: Scene): RoleText[] {
  const out: RoleText[] = [];
  const isRole = (v: unknown): v is TextRole => (TEXT_ROLES as readonly unknown[]).includes(v);
  const walk = (v: unknown, path: string, key: string, parentKey: string, own: TextRole | null, depth: number): void => {
    if (depth > MAX_ONSCREEN_DEPTH || NOT_ON_SCREEN.has(key)) return;
    if (typeof v === "string") {
      const fallback: TextRole = (key === "title" && depth === 1 && s.type === "title") || PRIMARY_KEYS.has(key) || (depth === 1 && PRIMARY_TOP[s.type] === key) ? "primary"
        : SUPPORT_KEYS.has(key) || SUPPORT_KEYS.has(parentKey) || (key === "label" && ["left", "right", "beats"].includes(parentKey))
          || (PICTURE_LABELS.has(s.type) && (key === "label" || key === "name") && depth > 1) ? "support" : "secondary";
      out.push({ path, text: v, role: own ?? fallback });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`, key, key, own, depth + 1));
    else if (isObj(v)) {
      const mine = isRole(v.role) ? v.role : own;
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, k, key, mine, depth + 1);
    }
  };
  walk(s, "", "", "", null, 0);
  if (s.type === "stat" && typeof s.value === "number") out.push({ path: "value", text: String(s.value), role: "primary" });
  return out;
}

/** Rough seconds each scene is on screen, from its cue to the next scene's cue, using the same
 * narration estimate as `estimateSeconds` (lead 0.5 s, 0.45 s between paragraphs, 1 s tail).
 * `pos` holds each scene's cue token index (-1 when not found). The first scene starts at 0. */
export function sceneSeconds(blocks: ScriptBlock[], pos: number[]): number[] {
  const at: number[] = [];
  let t = 0.5, speech = 0;
  for (const b of blocks) {
    if (b.kind === "pause") { t += b.seconds; continue; }
    if (speech++ > 0) t += 0.45;
    for (let k = tokens([b]).length; k > 0; k--) { at.push(t); t += 1 / WORDS_PER_SECOND; }
  }
  const total = t + 1;
  const startOf = (i: number) => (i === 0 ? 0 : pos[i]! >= 0 ? at[pos[i]!] ?? total : -1);
  return pos.map((_, i) => {
    const from = startOf(i);
    if (from < 0) return 0;
    const next = pos.slice(i + 1).map((_, k) => startOf(i + 1 + k)).find((x) => x >= 0) ?? total;
    return +Math.max(0, next - from).toFixed(2);
  });
}

/** Reading-load warnings for one scene: on-screen words (primary, secondary and support; captions
 * and decorative text don't count) above 3.5 per second, more than one primary item, or more than
 * one message element in a scene under 3 seconds. Warnings only: the spec still renders. */
export function readingLoad(s: Scene, seconds: number): { path: string; message: string }[] {
  const items = onScreenRoles(s);
  const out: { path: string; message: string }[] = [];
  const primaries = items.filter((x) => x.role === "primary");
  if (primaries.length > 1) out.push({ path: primaries[1]!.path, message: `has ${primaries.length} primary items. Keep one, and make the rest secondary or support.` });
  if (!(seconds > 0)) return out;
  const words = items.filter((x) => x.role !== "decorative").reduce((n, x) => n + wordsIn(x.text), 0);
  const budget = Math.floor(READING_WORDS_PER_SECOND * seconds);
  if (words > budget) out.push({ path: "", message: `shows ${words} words in about ${seconds.toFixed(1)} seconds; keep it to ${budget}. Cut on-screen words or give the scene more script.` });
  // A stat's number and its label read as one element, so the label is not counted again.
  const messages = items.filter((x) => (x.role === "primary" || x.role === "secondary") && !(s.type === "stat" && x.path === "label")).length;
  if (seconds < SHORT_SCENE_S && messages > 1) out.push({ path: "", message: `runs about ${seconds.toFixed(1)} seconds, so it can carry one message. It has ${messages}.` });
  return out;
}
