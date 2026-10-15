const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// C0 controls and DEL, except tab (\u0009) and LF (\u000a), which are kept so multi-line text
// still reads as text. \p{Default_Ignorable_Code_Point} covers the bidi controls (U+202A-202E,
// U+2066-2069), zero-width space (U+200B), BOM (U+FEFF), soft hyphen (U+00AD) and the other
// invisible/formatting code points a hostile spec or script string could hide a payload behind -
// except ZWJ (U+200D), ZWNJ (U+200C) and the variation selectors (U+FE00-FE0F), which are excluded
// from the strip (negative lookahead below) because real text needs them: ZWJ/ZWNJ join emoji
// sequences and some scripts' conjunct forms, and variation selectors pick an emoji's presentation.
const STRIP = /(?!\u200c|\u200d|[\ufe00-\ufe0f])[\u0000-\u0008\u000b-\u001f\u007f\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Strips the same disallowed control and default-ignorable code points `esc` does (bidi overrides,
 * zero-width space, BOM, soft hyphen, ... - see `STRIP` above), but without the HTML-entity escaping
 * `esc` also does. For text that reaches a context `esc` itself must never be used on - JSON
 * embedded in a `<script>` block, for instance - but that can still carry the same invisible/bidi
 * payload a hostile or malformed source might hide behind. ZWJ, ZWNJ and the variation selectors
 * survive, same as in `esc`.
 */
export function stripInvisible(s: string): string {
  return String(s).replace(STRIP, "");
}

/**
 * Text for an HTML text node or a quoted attribute value. Strips disallowed control and
 * default-ignorable code points, then entity-escapes `& < > " '` in a single pass so inserted
 * entities are never themselves re-scanned - calling `esc` once can never double-escape.
 * Never call this on anything destined for script, a URL, an unquoted attribute, or a tag/attribute/
 * class/id name - those contexts aren't safe for arbitrary text no matter how it's escaped.
 */
export function esc(s: string): string {
  return stripInvisible(s).replace(/[&<>"']/g, (c) => ENT[c]!);
}

// Built from code points, not source literals, so the two line-terminator characters below can
// never be silently normalized away by a text pipeline between here and the interpreter.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/**
 * JSON that is safe to inline inside a `<script>` block: escapes `<`, `>`, `&` and the two
 * line-terminator code points U+2028/U+2029 that JSON allows raw but JS treats as a line break, so
 * `</script>` can never close the block and a terminator can never split a statement.
 */
export function jsJson(v: unknown): string {
  return JSON.stringify(v)
    .split("<").join("\\u003c")
    .split(">").join("\\u003e")
    .split("&").join("\\u0026")
    .split(LINE_SEP).join("\\u2028")
    .split(PARA_SEP).join("\\u2029");
}

/** A finite time or size for markup and script, rounded to at most two decimals, no trailing
 * zeros. NaN and +/-Infinity (a hostile or malformed number should never reach `JSON`-less script
 * text) map to 0 rather than ever emitting "NaN" or "Infinity" into generated JS. */
export const n2 = (x: number): string => String(Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);
export const pad2 = (n: number): string => String(Number.isFinite(n) ? n : 0).padStart(2, "0");

/**
 * Strips trailing `\n` characters in O(length): a single index walk, one final slice. A
 * `/\n+$/`-style regex replace is the obvious way to write this, but is effectively quadratic on a
 * long run of trailing newlines (every attempt to anchor the match re-walks from a new start
 * position), so a hostile or just oversized "almost-empty" code string (tens of thousands of
 * trailing newlines) can stall it for seconds. Shared by `scenes.ts`'s `codeLines` (render) and
 * `spec.ts`'s code validator, so neither can be stalled this way.
 */
export function trimTrailingNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 10) end--;
  return s.slice(0, end);
}

/** Page styles from explainer.html, interview-qa.html and slides.html, plus the classes new scene types need. Colours are theme.css values. */
export const PAGE_CSS = `
.center { justify-content: center; }
.head { margin-top: 20px; }
.sub { margin-top: 32px; }
.bullets { margin-top: 56px; display: flex; flex-direction: column; gap: 34px; }
.bullet { display: flex; align-items: baseline; gap: 28px; }
.bullet .label { min-width: 64px; color: #f2b441; }
.flow { margin-top: 64px; display: flex; align-items: center; }
.flow.tb { flex-direction: column; align-items: flex-start; margin-top: 36px; }
.node { width: 430px; min-height: 200px; display: flex; flex-direction: column; gap: 14px; }
.flow.tb .node { width: 980px; min-height: 0; padding: 22px 36px; flex-direction: row; align-items: baseline; gap: 28px; }
.node .h { font-weight: 700; font-size: 44px; line-height: 1.1; }
.edge-wrap { position: relative; display: flex; align-items: center; justify-content: center; width: 120px; }
.flow.tb .edge-wrap { width: 980px; height: 56px; justify-content: flex-start; padding-left: 60px; }
.edge { display: block; width: 120px; height: 6px; background: #f2b441; transform-origin: left center; }
.flow.tb .edge { width: 6px; height: 56px; transform-origin: center top; }
.edge-label { position: absolute; top: -40px; }
.flow.tb .edge-label { position: static; margin-left: 24px; }
.split { margin-top: 48px; display: flex; gap: 56px; align-items: flex-start; }
.split .code { width: 1080px; }
.code-wrap { margin-top: 40px; width: 1400px; }
.code-wrap .label { margin-bottom: 18px; }
.code .ch { opacity: 0; }
.code-hl { transform-origin: left top; }
.code.diff .ln { padding-left: 52px; }
.code.diff .sign { position: absolute; left: 0; width: 40px; color: #a3adb7; }
.code.diff .ln.add { opacity: 0; }
.code.diff .bar { position: absolute; left: -44px; right: -44px; top: 0; height: 54px; background: rgba(236, 122, 108, 0.16); transform-origin: left center; transform: scaleX(0); }
.code.diff .ln.add::before { content: ""; position: absolute; left: -44px; right: -44px; top: 0; height: 54px; background: rgba(108, 196, 154, 0.14); }
.morph { position: relative; margin-top: 48px; width: 1400px; min-height: 420px; }
.morph .code { position: absolute; left: 0; top: 0; width: 100%; }
.later { opacity: 0; }
.notes { position: relative; width: 500px; height: 420px; }
.note { position: absolute; left: 0; top: 0; width: 100%; opacity: 0; }
.trio { margin-top: 56px; display: flex; gap: 40px; }
.trio .card { flex: 1; min-height: 300px; display: flex; flex-direction: column; gap: 18px; }
.rule { display: block; width: 240px; height: 8px; background: #f2b441; transform-origin: left center; margin: 36px 0; }
.close { margin-top: 48px; }
.verdict { margin-top: 40px; }
.big { font-weight: 900; font-size: 220px; line-height: 1; letter-spacing: -0.04em; }
.foot { margin-top: 36px; }
.q { font-weight: 700; font-size: 76px; line-height: 1.12; letter-spacing: -0.03em; max-width: 1500px; margin-top: 36px; }
.pane { position: absolute; inset: 0; padding: 96px 140px 220px; display: flex; flex-direction: column; }
.timer { margin-top: 64px; width: 900px; }
.timer .label { margin-bottom: 18px; }
.track { display: block; width: 900px; height: 14px; border-radius: 7px; background: #202830; overflow: hidden; }
.fill { display: block; width: 900px; height: 14px; background: #f2b441; transform-origin: left center; }
.beats { margin-top: 48px; display: flex; flex-direction: column; gap: 22px; }
.beat { display: flex; gap: 36px; align-items: baseline; padding: 26px 36px; }
.beat .kicker { min-width: 230px; }
.cols { margin-top: 52px; display: flex; gap: 44px; }
.col { flex: 1; display: flex; flex-direction: column; gap: 20px; min-height: 300px; }
.col.good { border-color: #6cc49a; }
.col.bad { border-color: #ec7a6c; }
.good .kicker { color: #6cc49a; }
.bad .kicker { color: #ec7a6c; }
.turn { margin-top: 44px; font-weight: 700; font-size: 48px; }
.seq { margin-top: 48px; display: grid; grid-template-columns: repeat(var(--cols), 1fr); column-gap: 40px; row-gap: 22px; width: 1640px; }
.actor { text-align: center; padding: 22px 28px; }
.actor .h { font-weight: 700; font-size: 40px; }
.msg { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 0 60px; }
.arrow { display: block; width: 100%; height: 6px; background: #f2b441; transform-origin: left center; }
.msg.rev .arrow { transform-origin: right center; }
.mk { position: relative; display: inline-block; }
.mk-ink { position: absolute; pointer-events: none; transform-origin: left center; }
.mk-underline .mk-ink { left: 0; right: 0; bottom: -6px; height: 8px; border-radius: 4px; background: #f2b441; }
.mk-highlight .mk-ink { left: -8px; right: -8px; top: 8%; bottom: 8%; background: rgba(242, 180, 65, 0.28); z-index: -1; }
.mk-circle .mk-ink { left: -18px; right: -18px; top: -12px; bottom: -12px; border: 5px solid #f2b441; border-radius: 50%; opacity: 0; transform-origin: center center; }
.mk-arrow .mk-ink { left: -70px; top: 50%; width: 52px; height: 6px; background: #f2b441; opacity: 0; }
#root.cap-pill .cg { border-radius: 999px; padding: 12px 34px; font-size: 40px; }
#root.cap-highlight .cg { background: none; text-shadow: 0 3px 14px rgba(9, 12, 15, 0.9); }
`;
