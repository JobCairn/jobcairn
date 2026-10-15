import { norm, parseScript, tokens } from "./script.js";
import type { Word } from "./types.js";

export interface CaptionGroup { words: Word[]; start: number; end: number; text: string }
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// `alignWords` runs a longest-common-subsequence match between the script's tokens and the
// heard words, which is O(n*m) in both time and memory. Both lists come from untrusted input
// (a speech transcript or a timing file someone can hand-edit or a flaky engine can pad with
// junk), so both are capped: above either cap we skip the LCS entirely and fall back to
// proportional timing (spread the heard span evenly over the script tokens). We don't throw,
// because losing word-accurate captions on an oversized input is much better than a video
// render failing outright; a caller that cares can compare the input length against these
// caps itself. Exported so callers can detect (and, if they want, report) the fallback.
export const MAX_ALIGN_SCRIPT_TOKENS = 5000;
export const MAX_ALIGN_HEARD_WORDS = 5000;

const MATCH = 1, MOVE_I = 2, MOVE_J = 3;

/**
 * Longest common subsequence between the script tokens and the heard words, by normalised
 * spelling. Returns the matched (scriptIndex, heardIndex) anchor pairs in order.
 *
 * Memory-bounded on purpose (review ruling): the classic LCS table is an (n+1)x(m+1) grid of
 * counts, which at the caps above would be tens of megabytes of 32-bit numbers. Instead we
 * compute the counts with a rolling pair of rows (O(m) numbers alive at once) and record only
 * the one byte per cell we actually need to backtrack — which way the optimal path goes
 * (match / advance script / advance heard) — in a flat Uint8Array. That direction table is
 * still O(n*m), but at one byte per cell instead of four, and it's the only O(n*m) structure
 * that survives past this function.
 */
function lcsAnchors(st: { norm: string }[], hw: { n: string }[]): [number, number][] {
  const n = st.length, m = hw.length;
  const dir = new Uint8Array(n * m);
  let prev = new Int32Array(m + 1); // dp[i+1][*]
  let cur = new Int32Array(m + 1); // dp[i][*], filled in for j in [0, m)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (st[i]!.norm === hw[j]!.n) {
        cur[j] = prev[j + 1]! + 1;
        dir[i * m + j] = MATCH;
      } else if (prev[j]! >= cur[j + 1]!) {
        cur[j] = prev[j]!;
        dir[i * m + j] = MOVE_I;
      } else {
        cur[j] = cur[j + 1]!;
        dir[i * m + j] = MOVE_J;
      }
    }
    const swap = prev; prev = cur; cur = swap;
  }
  const anchors: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    const d = dir[i * m + j];
    if (d === MATCH) { anchors.push([i, j]); i++; j++; }
    else if (d === MOVE_I) i++;
    else j++;
  }
  return anchors;
}

/** Above the caps: spread the heard span evenly over the script tokens, in script order and
 * script spelling. No attempt at word-accurate matching — just a bound on cost. */
function alignProportional(st: { raw: string }[], hw: { start: number; end: number }[]): Word[] {
  const n = st.length;
  const start = hw[0]!.start, end = hw[hw.length - 1]!.end;
  const step = n > 0 ? Math.max(0, end - start) / n : 0;
  return st.map((t, i) => ({ text: t.raw, start: r3(start + i * step), end: r3(start + (i + 1) * step) }));
}

/**
 * Ruling (spec §3.4 stage 7): the script is the truth for spelling, the transcript is the
 * truth for time. Align by longest common subsequence on normalised words. Matched pairs are
 * anchors; script words between two anchors share the time of the heard words between the
 * same anchors, spread evenly (so "cube control" heard for "kubectl" becomes one caption word
 * "kubectl" spanning from the start of "cube" to the end of "control"). Extra heard words
 * (fillers, misheard extras) are dropped. Script words the voice skipped get the silence
 * between the anchors around them.
 */
export function alignWords(script: string, heard: Word[]): Word[] {
  const st = tokens(parseScript(script));
  const hw = heard.map((h) => ({ ...h, n: norm(h.text) })).filter((h) => h.n);
  if (!st.length || !hw.length) return [];
  if (st.length > MAX_ALIGN_SCRIPT_TOKENS || hw.length > MAX_ALIGN_HEARD_WORDS) return alignProportional(st, hw);

  const n = st.length, m = hw.length;
  const anchors = lcsAnchors(st, hw);
  const out: Word[] = new Array(n);
  const fill = (from: number, to: number, start: number, end: number) => {
    const count = to - from;
    if (count <= 0) return;
    const step = Math.max(0, end - start) / count;
    for (let k = 0; k < count; k++) out[from + k] = { text: st[from + k]!.raw, start: r3(start + k * step), end: r3(start + (k + 1) * step) };
  };
  let pi = -1, pj = -1;
  for (const [ai, aj] of [...anchors, [n, m] as [number, number]]) {
    const runHeard = aj - pj - 1;
    let start: number, end: number;
    if (runHeard > 0) { start = hw[pj + 1]!.start; end = hw[aj - 1]!.end; }
    else {
      start = pj >= 0 ? hw[pj]!.end : Math.max(0, (aj < m ? hw[aj]!.start : 0) - 0.3 * (ai - pi - 1));
      end = aj < m ? hw[aj]!.start : start + 0.3 * (ai - pi - 1);
    }
    fill(pi + 1, ai, start, end);
    if (ai < n) out[ai] = { text: st[ai]!.raw, start: r3(hw[aj]!.start), end: r3(hw[aj]!.end) };
    pi = ai; pj = aj;
  }
  return out;
}

// Safe caption text (Ruling 3): SRT and VTT are line-based formats, so caption text that came
// from a word that was itself heard/estimated from untrusted audio must never be able to
// inject cue structure. CR, LF and the two Unicode line/paragraph separators all end a line in
// at least one of these formats, so all four collapse to a space. "-->" is the SRT/VTT cue
// timing delimiter; if it ever appeared in payload text, lenient parsers could misread it as
// the start of the next cue, so it's rewritten to "->". Default_Ignorable_Code_Point covers
// zero-width characters (ZWSP, BOM/ZWNBSP, variation selectors, …) that render as nothing but
// can still be used to hide content or defeat the checks above if applied in the wrong order;
// stripping them first makes every other check operate on what a viewer would actually see.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;
const ARROW = /-->/g;

export function sanitizeCueText(text: string): string {
  return text.replace(IGNORABLE, "").replace(LINE_BREAKS, " ").replace(ARROW, "->").replace(/\s+/g, " ").trim();
}

export function groupCaptions(words: Word[], o: { maxWords?: number; maxChars?: number; gap?: number } = {}): CaptionGroup[] {
  const maxWords = o.maxWords ?? 5, maxChars = o.maxChars ?? 42, gap = o.gap ?? 0.35;
  const groups: Word[][] = [];
  let cur: Word[] = [], chars = 0;
  const flush = () => { if (cur.length) groups.push(cur); cur = []; chars = 0; };
  for (const w of words) {
    const text = sanitizeCueText(w.text);
    if (!text) continue;
    if (cur.length) {
      const prev = cur.at(-1)!;
      if (w.start - prev.end > gap || cur.length >= maxWords || chars + text.length + 1 > maxChars) flush();
    }
    cur.push({ text, start: w.start, end: w.end });
    chars += text.length + 1;
    if (/[.!?]["')]?$/.test(text)) flush();
    else if (/[,;:]$/.test(text) && cur.length >= 3) flush();
  }
  flush();
  return groups.map((g, i) => {
    const next = groups[i + 1]?.[0]?.start ?? Infinity;
    return { words: g, start: g[0]!.start, end: r3(Math.min(g.at(-1)!.end + 0.4, next - 0.04)), text: g.map((x) => x.text).join(" ") };
  });
}

/** Formats a time in seconds as `HH:MM:SS<sep>mmm`. Negative times clamp to zero. Every field
 * (h, m, s, ms) is derived from the same rounded millisecond integer via floor division, so a
 * value that rounds up to a whole minute or hour carries correctly (59.9995 -> 00:01:00,000,
 * never 00:00:60,000): there is no per-field rounding to go out of sync. */
function stamp(t: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  const p = (x: number, n = 2) => String(x).padStart(n, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}

export function toSrt(groups: CaptionGroup[]): string {
  return `${groups.map((g, i) => `${i + 1}\n${stamp(g.start, ",")} --> ${stamp(g.end, ",")}\n${sanitizeCueText(g.text) || " "}\n`).join("\n")}\n`;
}

export function toVtt(groups: CaptionGroup[]): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `WEBVTT\n\n${groups.map((g) => `${stamp(g.start, ".")} --> ${stamp(g.end, ".")}\n${esc(sanitizeCueText(g.text) || " ")}\n`).join("\n")}\n`;
}

/**
 * narrate.py's `words_estimated`, used when local transcription isn't available. `timing` is
 * whatever a narration engine (or a hand-edited file) handed back, so it's `unknown` and
 * validated field by field; this never throws, even on a hostile getter, a circular object or
 * an array full of garbage — it just skips what it can't use and returns [] in the worst case
 * (Ruling 2). Entries with a non-finite, negative, or reversed (end before start) start/end
 * are dropped. The list is capped the same as the heard-words side of `alignWords`, since it's
 * the same kind of untrusted, unbounded input. The surviving words are also made monotonic: a
 * word's start is clamped forward to the previous word's end (and its end to at least its own
 * start), so no caption can end before it starts or overlap the previous one going backwards.
 */
export function wordsFromTiming(timing: unknown): Word[] {
  try {
    const list = (timing as { words_estimated?: unknown } | null)?.words_estimated;
    if (!Array.isArray(list)) return [];
    const out: Word[] = [];
    let prevEnd = 0;
    for (const raw of list.slice(0, MAX_ALIGN_HEARD_WORDS)) {
      try {
        if (raw === null || typeof raw !== "object") continue;
        const { text, start, end } = raw as { text?: unknown; start?: unknown; end?: unknown };
        if (typeof text !== "string" || typeof start !== "number" || typeof end !== "number") continue;
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (start < 0 || end < 0 || end < start) continue;
        const s = Math.max(start, prevEnd);
        const e = Math.max(end, s);
        out.push({ text, start: r3(s), end: r3(e) });
        prevEnd = e;
      } catch { /* a hostile getter on one entry must not take down the rest of the list */ }
    }
    return out;
  } catch {
    return [];
  }
}
