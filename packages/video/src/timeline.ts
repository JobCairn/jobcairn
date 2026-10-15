import { sanitizeCueText } from "./captions.js";
import { findPhrase, norm } from "./script.js";
import { itemCues, sceneHeadline } from "./spec.js";
import type { Issue, SceneSpec, SceneType, Word } from "./types.js";

export const SEAM = 0.6;
export const LEAD_IN = 0.3;
export interface SceneTime {
  index: number; id: string; type: SceneType; cue: number; start: number; end: number;
  items: Record<string, number>; marks: number[]; think: { start: number; end: number } | null;
}
export interface Timeline { total: number; scenes: SceneTime[]; issues: Issue[] }

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Turns narrated word timings into the scene and reveal times the composition actually plays, at
 * build time (expander contract in scene-spec.md): scene 1 starts at 0; scene N starts 0.3 s
 * (`LEAD_IN`) before its cue word; a scene stays 0.6 s (`SEAM`) past the next scene's start so the
 * seam can play; the last scene ends at the narration's total. Item reveals land 0.1 s before
 * their cue word, never before their scene starts; mark reveals follow the same rule and chain
 * off each other exactly like items do, seeded at the scene start. A cue the voice never said is
 * a plain `cue` issue (reported for every scene, including scene 1, purely for visibility - it
 * never changes scene 1's start) and the reveal falls back to one second after the previous
 * reveal (item, mark, or scene start), so the timeline this returns is always complete - never
 * partial, never throwing on a bad cue, and never going backwards.
 *
 * A quiz scene's `think` window is the single longest silence between two consecutive heard
 * words inside that scene's part of the narration, whatever its size - the composition decides
 * how to present a short one. It's `null` only when there's no adjacent pair to measure at all
 * (the scene has at most one heard word in its range).
 *
 * `words` and `total` ultimately come from narration (a transcript, or a hand-edited timing file),
 * so they're treated as hostile (Ruling 1): `total` must be a finite, non-negative number or this
 * throws a plain Error (there is no sane timeline to build without one); a word whose start/end
 * is non-finite, or whose end comes before its start, was never really heard, so it's dropped
 * before it can touch a cue match or a timestamp - the cue-miss fallback applies to it exactly
 * like a cue the voice skipped. Every number this returns is finite, rounded to 0.01 s, clamped
 * into [0, total], and every scene has start <= end, regardless of how hostile the input was.
 *
 * Cost: one `findPhrase` scan per scene cue, per item cue and per mark, each over (at most) the
 * whole heard-words list - O(scenes x items x words) at most, bounded by the same scene/item caps
 * `spec.ts` already enforces (2-12 scenes, items capped per scene type). The quiz think-time scan
 * is a single linear pass per quiz scene, not a scan per word, so it adds no further blow-up.
 */
export function resolveTimeline(spec: SceneSpec, words: Word[], total: number): Timeline {
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`resolveTimeline: total must be a finite, non-negative number (got ${total}).`);
  }
  const t = r2(total);
  const clamp = (x: number): number => r2(Math.min(t, Math.max(0, x)));

  // A word with a non-finite or reversed (end before start) time was never really heard (Ruling
  // 1): drop it up front so it can never be matched to a cue or turn into a timestamp. Negative or
  // out-of-order (but otherwise sane) times are left alone here - they're allowed on a heard word -
  // and get clamped into range below like everything else.
  const heard = words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  const toks = heard.map((w) => ({ norm: norm(w.text) }));

  const issues: Issue[] = [];
  const miss = (i: number, path: string, phrase: string, what: string) => issues.push({
    level: "error", code: "cue", scene: i, path,
    message: `Scene ${i + 1}: the cue "${phrase}"${what} was not heard in the narration. Check the script, then narrate again.`,
  });

  // Where each scene's cue word lands, in script order. Scene 1 always starts at 0 regardless
  // of whether its own cue was heard (there's nothing to fall back to and nothing downstream
  // depends on it for timing), but a missed cue is still reported here for visibility - a
  // scene-0 cue the voice never said is just as real a problem as any other.
  const at: number[] = [];
  let cursor = 0;
  spec.scenes.forEach((s, i) => {
    const k = findPhrase(toks, s.cue, i === 0 ? 0 : cursor);
    if (k < 0) {
      miss(i, "cue", s.cue, "");
      if (i === 0) { at.push(0); cursor = 1; } else at.push(Math.min(cursor, Math.max(0, toks.length - 1)));
    } else { at.push(k); cursor = k + 1; }
  });

  const starts = spec.scenes.map((_, i) => (i === 0 ? 0 : clamp((heard[at[i]!]?.start ?? 0) - LEAD_IN)));
  for (let i = 1; i < starts.length; i++) if (starts[i]! <= starts[i - 1]!) starts[i] = clamp(starts[i - 1]! + 0.5);

  const scenes: SceneTime[] = spec.scenes.map((s, i) => {
    const from = at[i]!;
    const to = i + 1 < at.length ? Math.max(from + 1, at[i + 1]!) : toks.length;
    const start = starts[i]!;
    const end = i + 1 < starts.length ? clamp(Math.min(t, starts[i + 1]! + SEAM)) : t;
    const items: Record<string, number> = {};
    let c = from, last = start;
    for (const { key, cue } of itemCues(s)) {
      const k = findPhrase(toks, cue, c, to);
      if (k < 0) { miss(i, key, cue, ` for ${key}`); last = clamp(Math.min(end, last + 1)); }
      else { last = clamp(Math.max(start, heard[k]!.start - 0.1)); c = k + 1; }
      items[key] = last;
    }
    const markCues = s.marks ?? [];
    const marks: number[] = [];
    let mc = from, lastMark = start;
    for (let k = 0; k < markCues.length; k++) {
      const m = markCues[k]!;
      const j = findPhrase(toks, m.cue, mc, to);
      if (j < 0) { miss(i, `marks.${k}.cue`, m.cue, ` for marks.${k}`); lastMark = clamp(Math.min(end, lastMark + 1)); }
      else { lastMark = clamp(Math.max(start, heard[j]!.start - 0.1)); mc = j + 1; }
      marks.push(lastMark);
    }
    let think: SceneTime["think"] = null;
    if (s.type === "quiz") {
      let best = 0;
      for (let k = from; k + 1 < to && k + 1 < heard.length; k++) {
        const gap = heard[k + 1]!.start - heard[k]!.end;
        if (gap > best) { best = gap; think = { start: clamp(heard[k]!.end), end: clamp(heard[k + 1]!.start) }; }
      }
    }
    return { index: i, id: `s${i + 1}`, type: s.type, cue: clamp(heard[from]?.start ?? 0), start, end, items, marks, think };
  });
  return { total: t, scenes, issues };
}

/** A readable dump of a timeline for logs and humans. Scene headlines come from the spec, which
 * (like any narration-pipeline input) can be hostile, so they're sanitized the same way caption
 * text is before being folded into a line (Ruling 3) - a spec can't use a crafted headline to
 * forge a second log line or spoof cue-timing syntax. */
export function printTimeline(t: Timeline, spec: SceneSpec): string {
  const lines: string[] = [];
  for (const s of t.scenes) {
    const headline = sanitizeCueText(sceneHeadline(spec.scenes[s.index]!));
    lines.push(`${s.id}  ${s.start.toFixed(2)} -> ${s.end.toFixed(2)}  ${s.type}  ${headline}`);
    for (const [k, v] of Object.entries(s.items)) lines.push(`    ${k}  ${v.toFixed(2)}`);
    if (s.think) lines.push(`    think  ${s.think.start.toFixed(2)} -> ${s.think.end.toFixed(2)}`);
  }
  return lines.join("\n");
}
