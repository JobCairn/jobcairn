import { sanitizeCueText } from "./captions.js";
import { esc, n2, pad2 } from "./html.js";
import type { SceneTime } from "./timeline.js";
import type { Mark, Scene } from "./types.js";

/** What the expander knows beyond the spec: pictures gathered from the workspace (media stage) and the motion setting. */
export interface MediaRefs {
  /** The company's own logo, copied into the composition (`assets/...`). */
  logo?: { src: string; company: string };
  /** The job board the ad came from: its bundled mark when there is one, else just its name (shown as a monogram). */
  board?: { src?: string; name: string };
}

export interface BuildCtx { t: SceneTime; index: number; count: number; media?: MediaRefs; reduced?: boolean }
export interface SceneOut { html: string; js: string[]; warnings: string[] }
export type Builder<S extends Scene = Scene> = (s: S, c: BuildCtx, m: MarkSet) => { html: string; js: string[] };

/** A finite number, or `fallback` (0 by default) - a hostile or malformed spec number (NaN,
 * +/-Infinity) must never reach generated JS or a numeric style/attribute value. */
export const num = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);

/** The usable numeric window for a scene's own reveal times: normally `[start + 0.1, end - 0.4]`,
 * but both ends collapse toward `end` for a scene shorter than 0.5 s, so a clamped time can never
 * land after the scene's own end even when the scene is only 0.05 s long. A non-finite input (a
 * hostile or malformed spec/timeline number) falls back to `start` before clamping, so this always
 * returns a finite number inside `[start, end]`. */
export const clampNum = (c: BuildCtx, x: number): number => {
  const { start, end } = c.t;
  const lo = Math.min(start + 0.1, end);
  const hi = Math.max(lo, end - 0.4);
  return Math.min(Math.max(num(x, start), lo), hi);
};
/** `clampNum`, formatted for direct interpolation into generated JS. Every emitted reveal/draw/
 * seam time in this file goes through this (Ruling: finite, clamped times everywhere). */
export const clampT = (c: BuildCtx, x: number): string => n2(clampNum(c, x));
/** A finite, strictly positive duration - GSAP tweens need a non-zero, forward-running duration,
 * so a non-finite or non-positive input (e.g. a quiz think-window computed from hostile/malformed
 * timeline data) falls back to `fallback` instead of ever reaching generated JS as "NaN" or 0. */
export const clampDur = (x: number, fallback = 0.3): number => (Number.isFinite(x) && x > 0 ? x : fallback);

/** Maps a mark's `type` to its CSS class through a fixed table (Ruling 1: classes never come from
 * spec text) - a `type` value a future/older spec schema didn't anticipate falls back to
 * "mk-highlight" rather than ever reaching the DOM as raw interpolated text. Used for both the
 * class name itself and (so the two can't drift) the underline-vs-highlight-vs-other behaviour
 * split in `MarkSet.js`. */
const MARK_CLASS: Record<string, string> = { underline: "mk-underline", circle: "mk-circle", arrow: "mk-arrow", highlight: "mk-highlight" };
const markClass = (type: string): string => MARK_CLASS[type] ?? "mk-highlight";

/** Wraps the first on-screen occurrence of each mark's words, and animates it at its cue time. */
export class MarkSet {
  private used: boolean[];
  constructor(private marks: Mark[], private id: string, private c: BuildCtx) { this.used = marks.map(() => false); }

  /** Finds every not-yet-used mark's target in `raw` and wraps whichever occurs *earliest*, not
   * whichever is simply tried first - so the order marks happen to be listed in the spec can never
   * cause an earlier-appearing mark to be skipped (and wrongly warned "not on screen") just because
   * a later mark in the array was checked against this text first. */
  text(raw: string): string {
    let bestK = -1, bestAt = -1;
    for (let k = 0; k < this.marks.length; k++) {
      if (this.used[k]) continue;
      const at = raw.indexOf(this.marks[k]!.target);
      if (at >= 0 && (bestK < 0 || at < bestAt)) { bestK = k; bestAt = at; }
    }
    if (bestK < 0) return esc(raw);
    const m = this.marks[bestK]!;
    this.used[bestK] = true;
    return `${esc(raw.slice(0, bestAt))}<span id="${this.id}-m${bestK}" class="mk ${markClass(m.type)}">${esc(m.target)}<i class="mk-ink"></i></span>${this.text(raw.slice(bestAt + m.target.length))}`;
  }
  js(): string[] {
    return this.marks.flatMap((m, k) => {
      if (!this.used[k]) return [];
      const sel = `"#${this.id}-m${k} .mk-ink"`;
      // A missing or non-finite mark time (hostile/malformed timeline data) falls back to just
      // after the scene starts, never to an absolute 0 - a mark drawn at global time 0 would
      // almost always land outside this scene's own window entirely.
      const raw = this.c.t.marks[k];
      const t = clampT(this.c, Number.isFinite(raw) ? raw! : this.c.t.start + 0.1);
      const cls = markClass(m.type);
      return cls === "mk-underline" || cls === "mk-highlight"
        ? [`K.draw(tl, ${sel}, ${t}, 0.5);`]
        : [`tl.fromTo(${sel}, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.4, ease: "power3.out" }, ${t});`];
    });
  }
  warnings(index: number): string[] {
    // The mark's own target text came from the spec, so it's sanitized the same way caption text
    // is (Ruling 3) before it goes into a log/issue line - a hostile target can't forge a second
    // line or carry a raw control character into the message.
    return this.marks.flatMap((m, k) => (this.used[k] ? [] : [`Scene ${index + 1}: the mark "${sanitizeCueText(m.target).replace(C0, "")}" is not in the on-screen text, so it is not drawn.`]));
  }
}

// sanitizeCueText (shared with captions.ts) rewrites line breaks and the "-->" cue-timing
// delimiter but leaves other C0 controls (e.g. ESC) alone - this package echoes spec text (a
// mark's target) into a plain warning/log line, which must never carry one raw either.
const C0 = /[\u0000-\u001f\u007f]/g;

export const item = (c: BuildCtx, key: string, fallback: number) => c.t.items[key] ?? fallback;
export const step = (c: BuildCtx) => `<p class="step">${pad2(c.index + 1)} / ${pad2(c.count)}</p>`;
export const head = (id: string, m: MarkSet, text: string | undefined) => (text ? `<h2 id="${id}-head" class="h2 head">${m.text(text)}</h2>` : "");
export const headJs = (id: string, c: BuildCtx, text: string | undefined) => (text ? [`K.reveal(tl, "#${id}-head", ${clampT(c, c.t.start + 0.3)}, { y: 20 }, 0.5);`] : []);
