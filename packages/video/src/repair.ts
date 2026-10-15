import { findPhrase, parseScript, tokens } from "./script.js";

/**
 * Fixes the obvious shape slips a writer makes in spec.json before the check runs, so a script isn't sent back
 * for a typo the check would only report. It never invents content:
 * - a source written as `{ "path": ... }` becomes `{ "file": ... }` (only when `file` is absent, or equal);
 * - a plain-text point in a bullet-build or recap-card `items` list becomes `{ "text", "cue" }`, the cue being the
 *   point's first one or two words, preferring words the script really says;
 * - a list longer than its limit loses only empty or repeated points. Anything else over the limit stays for the
 *   check to report.
 * It walks only the known places (scene sources, those two scene types' items, item and node sources), and refuses
 * input past the same bounds spec.ts uses, so hostile input is never iterated.
 */
export interface RepairResult { spec: unknown; changed: boolean; repairs: string[] }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Same ceilings as spec.ts (ABSOLUTE_MAX_SCENES, ABSOLUTE_MAX_LIST): past them nothing is walked. */
const MAX_SCENES = 500;
const MAX_LIST = 200;
/** Scene types whose `items` are cued points, and the most points each allows (spec.ts). */
const CUED_ITEMS: Record<string, number> = { "bullet-build": 4, "recap-card": 3 };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function repairSpec(raw: unknown, script: string): RepairResult {
  const none: RepairResult = { spec: raw, changed: false, repairs: [] };
  if (!isObj(raw) || !Array.isArray(raw.scenes) || raw.scenes.length > MAX_SCENES) return none;
  const toks = tokens(parseScript(typeof script === "string" && script.length <= 20_000 ? script : ""));
  const spec = structuredClone(raw) as Obj & { scenes: unknown[] };
  const repairs: string[] = [];
  let renamed = 0;

  const fixSources = (v: unknown) => {
    if (!Array.isArray(v) || v.length > MAX_LIST) return;
    for (const s of v) {
      if (!isObj(s) || typeof s.path !== "string") continue;
      if (s.file === undefined) { s.file = s.path; delete s.path; renamed++; }
      else if (s.file === s.path) { delete s.path; renamed++; }
    }
  };
  const cueFor = (text: string): string => {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const two = words.slice(0, 2).join(" ");
    const one = words[0] ?? "";
    if (words.length >= 2 && findPhrase(toks, two) >= 0) return two;
    if (one && findPhrase(toks, one) >= 0) return one;
    return two;
  };

  spec.scenes.forEach((scene, i) => {
    if (!isObj(scene)) return;
    fixSources(scene.sources);
    if (Array.isArray(scene.nodes) && scene.nodes.length <= MAX_LIST) for (const n of scene.nodes) if (isObj(n)) fixSources(n.sources);
    const max = typeof scene.type === "string" ? CUED_ITEMS[scene.type] : undefined;
    if (max === undefined || !Array.isArray(scene.items) || scene.items.length > MAX_LIST) return;
    let items = scene.items as unknown[];
    if (items.length > max) {
      const seen = new Set<string>();
      const kept = items.filter((it) => {
        const text = typeof it === "string" ? it : isObj(it) && typeof it.text === "string" ? it.text : null;
        if (text === null) return true; // not a point we understand: the check reports it
        const key = text.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (kept.length < items.length) {
        repairs.push(`Scene ${i + 1}: removed ${plural(items.length - kept.length, "empty or repeated point")}.`);
        items = kept;
      }
    }
    let wrapped = 0;
    items = items.map((it) => {
      if (typeof it !== "string" || !it.trim()) return it;
      wrapped++;
      return { text: it.trim(), cue: cueFor(it) };
    });
    for (const it of items) if (isObj(it)) fixSources(it.sources);
    if (wrapped) repairs.push(`Scene ${i + 1}: turned ${plural(wrapped, "plain-text point")} into points with cues.`);
    scene.items = items;
  });
  if (renamed) repairs.unshift(`Changed ${plural(renamed, "source")} from "path" to "file".`);
  return repairs.length ? { spec, changed: true, repairs } : none;
}
