import type { SceneSpec } from "./types.js";

export interface ScriptBlock { kind: "speech" | "pause"; text: string; seconds: number }
export interface Token { raw: string; norm: string; block: number }
export interface SceneRange { scene: number; from: number; to: number }

// Capped at 4 digits (plus up to 2 decimals), i.e. at most 9999.99 seconds: comfortably above any
// real pause (existing scripts use single-digit seconds) and small enough that Number(...) can
// never round the result to Infinity.
const PAUSE = /^\[pause\s+(\d{1,4}(?:\.\d{1,2})?)\]$/i;
// A [pause N] attempt whose number didn't fit the bounds above (too many digits or decimals), so
// validateSpec can give a clear "pause is too long" error instead of silently treating the whole
// line as spoken text (script.ts itself has no error-reporting channel; it just marks this as an
// ordinary speech block, same as any other unrecognised bracketed text).
const PAUSE_ATTEMPT = /^\[pause\s+\d+(?:\.\d+)?\]$/i;
const TAGS = /<\/?\s*(laugh|breath|sigh)\s*\/?>/gi;
export const WORDS_PER_SECOND = 2.5;

/** True for a `[pause ...]` line whose number is too long to be accepted (too many digits or
 * decimal places), so a caller can report it clearly instead of silently treating it as text. */
export function isPauseTooLong(blockText: string): boolean {
  return PAUSE_ATTEMPT.test(blockText) && !PAUSE.test(blockText);
}

/** Removes the narration expression tags (<laugh>, <breath>, <sigh>). */
export const stripTags = (s: string): string => s.replace(TAGS, " ").replace(/\s+/g, " ").trim();
/** Same comparison as kit.js: lower case, letters and numbers only. */
export const norm = (t: string): string => t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Paragraphs separated by blank lines; "#" lines dropped; a paragraph that is only [pause N] is silence (same rules as narrate.py). */
export function parseScript(text: string): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)) {
    const lines = para.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (!lines.length) continue;
    const joined = lines.join(" ");
    const m = PAUSE.exec(joined);
    out.push(m ? { kind: "pause", text: joined, seconds: Number(m[1]) } : { kind: "speech", text: joined, seconds: 0 });
  }
  return out;
}

export function joinBlocks(blocks: ScriptBlock[]): string {
  return blocks.length ? `${blocks.map((b) => b.text).join("\n\n")}\n` : "";
}

export function tokens(blocks: ScriptBlock[]): Token[] {
  const out: Token[] = [];
  blocks.forEach((b, block) => {
    if (b.kind !== "speech") return;
    for (const raw of stripTags(b.text).split(/\s+/)) { const n = norm(raw); if (n) out.push({ raw, norm: n, block }); }
  });
  return out;
}

export function phraseTokens(phrase: string): string[] { return phrase.split(/\s+/).map(norm).filter(Boolean); }

/** Index of the first token where `phrase` starts, searching [from, to). -1 when not found. */
export function findPhrase(toks: readonly { norm: string }[], phrase: string, from = 0, to = toks.length): number {
  const p = phraseTokens(phrase);
  if (!p.length) return -1;
  for (let i = Math.max(0, from); i + p.length <= to; i++) if (p.every((w, j) => toks[i + j]!.norm === w)) return i;
  return -1;
}

/** Rough spoken length, using narrate.py's defaults (lead 0.5 s, gap 0.45 s, tail 1.0 s). */
export function estimateSeconds(blocks: ScriptBlock[]): number {
  const speech = blocks.filter((b) => b.kind === "speech").length;
  const pauses = blocks.reduce((s, b) => s + (b.kind === "pause" ? b.seconds : 0), 0);
  return +(0.5 + tokens(blocks).length / WORDS_PER_SECOND + pauses + Math.max(0, speech - 1) * 0.45 + 1).toFixed(1);
}

/** Which blocks each scene owns: from the block holding its cue to the block holding the next scene's cue. */
export function sceneBlocks(blocks: ScriptBlock[], spec: SceneSpec): SceneRange[] {
  const toks = tokens(blocks);
  const starts: number[] = [];
  let cursor = 0;
  spec.scenes.forEach((s, i) => {
    const at = typeof s.cue === "string" ? findPhrase(toks, s.cue, cursor) : -1;
    if (at >= 0) cursor = at + 1;
    starts.push(i === 0 ? 0 : at >= 0 ? toks[at]!.block : starts[i - 1]!);
  });
  return spec.scenes.map((_, i) => {
    const from = starts[i]!;
    const next = i + 1 < starts.length ? starts[i + 1]! : blocks.length;
    return { scene: i, from, to: Math.max(from, next) };
  });
}

/** Replaces the paragraphs of the edited scenes and keeps everything else as it was. */
export function applySceneScripts(script: string, spec: SceneSpec, edits: { index: number; script: string }[]): string {
  const blocks = parseScript(script);
  const byScene = new Map(edits.map((e) => [e.index, e.script]));
  const out: ScriptBlock[] = [];
  for (const r of sceneBlocks(blocks, spec)) {
    const e = byScene.get(r.scene);
    out.push(...(e !== undefined ? parseScript(e) : blocks.slice(r.from, r.to)));
  }
  return joinBlocks(out);
}
