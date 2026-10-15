import fs from "node:fs";
import path from "node:path";
import { insideRoot, writeFileAtomic } from "@careeros/core";
import { sanitizeCueText } from "./captions.js";
import { stripControl } from "./errors.js";
import { esc, jsJson, n2, PAGE_CSS, stripInvisible } from "./html.js";
import { buildScene, type MediaRefs } from "./scenes.js";
import { VISUAL_CSS } from "./visuals.js";
import { watermarkHtml, WATERMARK_CSS } from "./watermark.js";
import { isValidated, type ValidatedSpec } from "./spec.js";
import { printTimeline, resolveTimeline, type Timeline } from "./timeline.js";
import type { CaptionStyle, Word } from "./types.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

export const GSAP_REL = "vendor/gsap/dist/gsap.min.js";
/** Where the theme's fonts live, under the templates folder and inside each composition. */
export const FONTS_SRC_REL = "assets/fonts";
export const FONTS_REL = "fonts";
const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
/**
 * The theme's two fonts (SIL OFL 1.1, from Fontsource 5.3.0 variable builds; licences next to the files), shipped
 * with the app and copied into every composition. HyperFrames only fetches a font family from Google Fonts when the
 * page has no @font-face for it, so declaring these keeps the check and the render off the network.
 */
export const VIDEO_FONTS = [
  { family: "Montserrat", file: "montserrat-latin-wght-normal.woff2", range: LATIN },
  { family: "Montserrat", file: "montserrat-latin-ext-wght-normal.woff2", range: LATIN_EXT },
  { family: "JetBrains Mono", file: "jetbrains-mono-latin-wght-normal.woff2", range: LATIN },
  { family: "JetBrains Mono", file: "jetbrains-mono-latin-ext-wght-normal.woff2", range: LATIN_EXT },
] as const;
/** The @font-face rules for VIDEO_FONTS, inline in index.html (HyperFrames reads the page itself for them). */
export const FONT_CSS = VIDEO_FONTS.map((f) =>
  `@font-face{font-family:"${f.family}";font-style:normal;font-weight:100 900;font-display:block;src:url("${FONTS_REL}/${f.file}") format("woff2");unicode-range:${f.range};}`).join("\n");
export const COMP_FILES = ["index.html", "theme.css", "kit.js", GSAP_REL, "narration.wav", "timeline.txt", ...VIDEO_FONTS.map((f) => `${FONTS_REL}/${f.file}`)] as const;
/** Written into `work/` (never into `comp-next/` or `comp/` itself) just before the first of the
 * two swap renames begins, and removed once the second succeeds (Fix round 1) - the Task 11
 * review's original fix for this put an equivalent marker file *inside* comp-next/, which then
 * rode along through the rename and leaked into the live comp/ every caller sees, breaking the
 * "comp/ holds exactly the composition contract" guarantee. Living in `work/` instead, it can
 * never end up inside comp/ no matter which of the two renames has or hasn't happened. Its
 * presence as a genuine regular file (checked with `lstat`, never followed) is what makes a
 * `work/comp-old/` found at the start of a later call trustworthy enough to restore: it means a
 * swap through *this* function was genuinely in progress when the process ended, not that
 * comp-old/ is a leftover from anywhere else. See the self-heal step in `expand` for how it's used. */
export const SWAP_PENDING = "swap-pending";
export const CAPTION_OPTIONS: Record<CaptionStyle, string | null> = {
  rail: "{ until: END - 0.7 }",
  pill: "{ until: END - 0.7, maxWords: 3, maxChars: 24 }",
  highlight: "{ until: END - 0.7, maxWords: 4 }",
  none: null,
};

export interface BuildResult { html: string; timeline: Timeline; warnings: string[] }
/** Pictures the media stage gathered: what scenes may show (`refs`) and the files to copy into `comp/assets/`. */
export interface MediaBundle { refs: MediaRefs; files: { abs: string; rel: string }[] }
export interface BuildOptions { media?: MediaRefs; motion?: "full" | "reduced" }
export interface ExpandInput {
  folder: string; root: string; spec: ValidatedSpec; words: Word[]; total: number; captions: CaptionStyle;
  templatesDir: string; gsapFile: string;
  /** Pictures gathered by the media stage. Absent: none. */
  media?: MediaBundle;
  /** Settings > Videos > Motion. Absent: full. */
  motion?: "full" | "reduced";
  /** The mixed soundtrack (narration, sound effects, music) to use as the composition's audio. Absent: narration.wav. */
  audio?: string;
}
/** A composition asset path: assets/<plain name>.<picture type>, nothing else. */
export const ASSET_REL = /^assets\/[a-z0-9][a-z0-9-]{0,40}\.(png|jpe?g|webp|svg)$/;
export interface ExpandResult extends BuildResult { compDir: string }

const NOT_CHECKED = "This video spec wasn't checked.";

// How long a sane word's own text can run in an error message before it's just noise - a very
// long hostile/malformed word must not be able to blow out the message (Fix round 1, item 5).
const MAX_ECHOED_WORD = 80;

/** A finite, non-negative time, with `end` no earlier than `start` - the bar `buildHtml` itself
 * holds narrated words to (Fix round 1), independent of `resolveTimeline`'s own, more lenient
 * handling (timeline.ts silently drops an unusable word rather than throwing, since it's built to
 * always return a complete timeline). A word that fails this is refused with a plain error instead
 * of ever reaching that silent-drop path.
 *
 * (Task 11 review, b; Fix round 1, item 5) `w.text` is untrusted the same way a mark's target is,
 * so it goes through the same sanitizeCueText treatment scenes.ts's MarkSet.warnings uses, plus
 * errors.ts's shared stripControl (one control-character set, not a second narrower one
 * maintained here independently), before it's interpolated into this error message and capped at
 * ~80 characters - a hostile word can't forge a second log line, carry a raw control character
 * (e.g. an ANSI escape or a C1 control), or blow out the message with sheer length. */
function assertSaneWords(words: Word[]): void {
  for (const w of words) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end < 0 || w.end < w.start) {
      const text = stripControl(sanitizeCueText(w.text)).slice(0, MAX_ECHOED_WORD);
      throw new Error(`a narrated word has an invalid time: "${text}" (start ${w.start}, end ${w.end}).`);
    }
  }
}

/**
 * Builds the single-file composition HTML for a spec. `spec`'s static type is `ValidatedSpec`,
 * but (Fix round 1 review) that type alone doesn't stop a cast, a value parsed fresh from JSON, or
 * a spread copy of a genuinely validated spec from typechecking here too - so this also checks
 * `isValidated(spec)` at runtime (spec.ts's module-level record of exactly which objects
 * `requireValidated` produced) and throws a plain error if it's false. That's the only real
 * guarantee this function was ever handed a spec that actually passed `validateSpec`.
 */
export function buildHtml(spec: ValidatedSpec, words: Word[], total: number, captions: CaptionStyle, opts: BuildOptions = {}): BuildResult {
  if (!isValidated(spec)) throw new Error(NOT_CHECKED);
  // `captions` only ever reaches a quoted HTML class attribute and a plain object lookup below -
  // both unsafe for arbitrary text (Fix round 1: `CAPTION_OPTIONS[captions]` resolves an inherited
  // key like "constructor" to a live value, and `class="cap-${captions}"` is unescaped). Checking
  // `Object.hasOwn` first refuses anything that isn't one of the four real caption styles, so
  // nothing past this line can be hostile text or a prototype property.
  if (!Object.hasOwn(CAPTION_OPTIONS, captions)) throw new Error(`unknown caption style: ${JSON.stringify(captions)}.`);
  assertSaneWords(words);
  const timeline = resolveTimeline(spec, words, total);
  const reduced = opts.motion === "reduced";
  const sections: string[] = [];
  const js: string[] = [];
  const warnings: string[] = [];
  spec.scenes.forEach((scene, i) => {
    const t = timeline.scenes[i]!;
    const out = buildScene(scene, { t, index: i, count: spec.scenes.length, media: safeRefs(opts.media), reduced });
    sections.push(out.html);
    warnings.push(...out.warnings);
    js.push(`// ${t.id} ${scene.type}`);
    if (i > 0) {
      const dir = scene.type === "recap-card" || i === spec.scenes.length - 1 ? "up" : "left";
      js.push(`K.seam(tl, "#s${i}-stage", "#${t.id}-stage", ${n2(t.start)}, "${dir}", SEAM);`);
      if (scene.chapter) {
        js.push(`tl.fromTo("#fade", { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power2.in" }, ${n2(t.start - 0.25)});`);
        js.push(`tl.to("#fade", { opacity: 0, duration: 0.35, ease: "power2.out" }, ${n2(t.start + 0.1)});`);
      }
    }
    js.push(...out.js);
  });
  const capOpts = CAPTION_OPTIONS[captions];
  // Every video type's page gets this, not just one template: `words` is untrusted (a
  // transcript, or a hand-edited timing file - see timeline.ts) and its `text` reaches the page as
  // JSON inside a <script> block (via jsJson below), a context `esc()` itself must never be used
  // on. `jsJson` alone only neutralises what could break out of the script tag; it doesn't strip
  // bidi overrides or other invisible/default-ignorable characters, so `stripInvisible` (the same
  // strip `esc` does, minus the HTML-entity escaping) runs on each word's text first - keeping ZWJ,
  // ZWNJ and the variation selectors, same as `esc`.
  const transcript = words.map((w) => ({ text: stripInvisible(w.text), start: w.start, end: w.end }));
  const html = [
    "<!doctype html>",
    `<!-- Made by ${identity.name} from spec.json. Scenes, motion and theme from the ${identity.name} video templates (adapted from HyperFrames, Apache-2.0). Do not edit by hand: edit the script and re-render. -->`,
    `<html lang="en">`, "<head>", `<meta charset="UTF-8" />`, `<meta name="viewport" content="width=1920, height=1080" />`,
    `<title>${esc(spec.title)}</title>`, `<script src="${GSAP_REL}"></script>`, `<link rel="stylesheet" href="theme.css" />`,
    `<style>\n${FONT_CSS}\n${PAGE_CSS}\n${VISUAL_CSS}\n${WATERMARK_CSS}</style>`, "</head>", "<body>",
    `<div id="root" class="cap-${captions}" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="${n2(timeline.total)}"${reduced ? ' data-motion="reduced"' : ""}>`,
    `<div id="bg" class="bg"><div class="bg-glow"></div><div id="bg-grid" class="bg-grid"></div></div>`,
    ...sections,
    `<audio id="narration" src="narration.wav" data-start="0" data-track-index="10"></audio>`,
    `<div id="captions" class="caption-band"></div>`, `<div id="fade" class="fade"></div>`,
    // The "AI voice" mark (watermark.ts): last, so it stays on every frame, the end fade included.
    watermarkHtml(), "</div>",
    `<script>\nconst TRANSCRIPT = ${jsJson(transcript)};\n</script>`,
    `<script src="kit.js"></script>`,
    "<script>",
    "window.__timelines = window.__timelines || {};",
    "const K = window.CareerKit;", "const W = K.clean(TRANSCRIPT);", `const END = ${n2(timeline.total)};`, "const SEAM = 0.6;",
    "const tl = gsap.timeline({ paused: true });",
    `K.drift(tl, "#bg-grid", END);`,
    ...js,
    ...(capOpts ? [`K.captions(tl, W, ${capOpts});`] : []),
    `tl.to("#fade", { opacity: 1, duration: 0.6, ease: "power2.in" }, END - 0.7);`,
    `window.__timelines["main"] = tl;`,
    "</script>", "</body>", "</html>", "",
  ].join("\n");
  return { html, timeline, warnings };
}

/**
 * Throws a plain error unless `p`'s realpath is inside `root`'s realpath (reusing
 * `@careeros/core`'s `insideRoot`, the same helper `jobs.ts` uses to keep writes inside the
 * workspace) and `p` itself is not a symlink. Checked with `lstat`, not `stat`, so the check can't
 * be fooled by following the very link it exists to refuse - a symlinked `work/`, `comp/` or
 * `narration.wav` is refused outright, even one that happens to point back inside `root`, since
 * the point is that `expand` never follows a link at any of these specific locations, not just
 * that it stays inside the workspace (Fix round 1: "a symlinked work/ made rmSync delete data
 * outside the folder", "a symlinked narration.wav copied a secret file into comp/"). Used both up
 * front and again immediately before every destructive operation below, to narrow the window a
 * symlink swapped in after an earlier check could exploit.
 */
function assertSafe(root: string, p: string, label: string): void {
  if (!insideRoot(root, p)) throw new Error(`refusing to touch ${label}: outside the workspace (${p}).`);
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return; } // doesn't exist (yet) - nothing to refuse
  if (st.isSymbolicLink()) throw new Error(`refusing to follow a symlink at ${label}: ${p}`);
}

/** True only if `p` lstats as a genuine regular file - checked with `lstat`, not `stat`, so a
 * symlink planted at this path (to make an untrusted work/comp-old/ merely *look* like a swap was
 * genuinely in progress) is refused rather than followed (Task 11 review, a; Fix round 1: the
 * marker moved from inside comp-next/ to `work/swap-pending`). Missing, or any error reading it,
 * is "no" - never "yes" by default. */
function isRegularFile(p: string): boolean {
  try { return fs.lstatSync(p).isFile(); } catch { return false; }
}

/** Re-checks `work` itself with `assertSafe` before touching anything inside it (Fix round 3, item
 * 2: `work` is otherwise only ever checked once, at the top of `expand` - every later removal of
 * something inside it needs its own check too, since a symlink swapped in for `work` itself in the
 * meantime would otherwise be followed transparently by the OS when resolving any path through it,
 * no matter how carefully the removed path's own final component is checked), then clears `p` if
 * it's a directory or a symlink - non-following either way, so neither case can delete or expose
 * anything outside what `p` itself names - and leaves a genuine regular file (or nothing)
 * untouched for the caller's own removal to handle as before (Fix round 2, item 4; Fix round 3,
 * item 1: reused here for the healthy-comp branch's own removal of `work/swap-pending`, which had
 * the identical gap - a non-recursive `rmSync` there throws a raw EISDIR for a directory, on every
 * single run, since that branch is reached whenever comp/ already exists). */
function clearIfDirOrSymlink(root: string, work: string, p: string): void {
  assertSafe(root, work, "work/");
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(p); } catch { return; } // doesn't exist - nothing to clear
  if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  else if (st.isSymbolicLink()) fs.rmSync(p, { force: true });
}

/**
 * Copies `src` into a brand-new `dest` without ever following a symlink at either end, and
 * refuses to read `src` at all unless it's a plain regular file. `src` is opened with
 * `O_NOFOLLOW`: the open call itself refuses atomically if `src` is a symlink, which (unlike an
 * `lstat` check followed by a separate open-by-path call) can't be defeated by swapping a symlink
 * in during the gap between the two. It's also opened with `O_NONBLOCK` - without it, opening a
 * FIFO for reading blocks until some other process opens it for writing, which here would mean
 * `expand` (and the whole process) hangs forever on a narration.wav that's actually a pipe with no
 * writer, rather than failing with a plain error (Task 11 review, c). The open fd is then
 * `fstat`-ed, and anything that isn't a regular file - a FIFO, a Unix socket, a device node - is
 * refused before a single byte is read from it. A FIFO still succeeds at `open()` itself (that's
 * what O_NONBLOCK is for); a Unix socket or certain other special files don't - `open()` on those
 * fails outright, with whatever OS-specific errno the platform happens to report - so that failure
 * is caught too and remapped to the same plain message, unless it's ENOENT/EACCES/ELOOP (a
 * genuinely missing file, a permissions problem, or an actual symlink), which stay as themselves
 * since they're meaningfully different problems (Fix round 1, item 9). `dest` is created with
 * `O_CREAT | O_EXCL`, so it refuses outright if anything - file, directory or symlink - already
 * exists at that path, rather than following or overwriting it.
 */
/** Media refs a scene may use: only asset paths of the allowed shape survive, and names are capped. */
function safeRefs(m: MediaRefs | undefined): MediaRefs | undefined {
  if (!m) return undefined;
  const name = (s: string) => Array.from(stripInvisible(String(s))).slice(0, 40).join("");
  return {
    ...(m.logo && ASSET_REL.test(m.logo.src) ? { logo: { src: m.logo.src, company: name(m.logo.company) } } : {}),
    ...(m.board ? { board: { ...(m.board.src && ASSET_REL.test(m.board.src) ? { src: m.board.src } : {}), name: name(m.board.name) } } : {}),
  };
}

export function copyFileNoFollow(src: string, dest: string): void {
  const notRegular = (): never => { throw new Error(`refusing to read ${src}: not a regular file.`); };
  let srcFd: number;
  try {
    srcFd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "ELOOP") throw e;
    // Some other open() failure - previously every one of these was reported as "not a regular
    // file", which is only true for a socket, FIFO or device (open() itself can fail outright for
    // those, unlike a FIFO opened with O_NONBLOCK, which succeeds and is caught by the fstat check
    // below instead). Anything else - EMFILE (too many open files), EIO, ENAMETOOLONG, ENOTDIR,
    // ... - is a real I/O/resource/path problem that has nothing to do with the file's type, so
    // lstat the path to find out which case this actually is before choosing the message
    // (Fix round 2, item 9). A plain, path-free error either way: this function's whole point is
    // that a hostile or broken narration.wav can't leak its own filesystem path into the error.
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(src); } catch { /* can't even lstat it - treat as the generic case below */ }
    if (st && (st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice())) return notRegular();
    throw new Error(`could not open the narration audio${code ? ` (${code})` : ""}.`);
  }
  try {
    if (!fs.fstatSync(srcFd).isFile()) return notRegular();
    const destFd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    try {
      fs.writeFileSync(destFd, fs.readFileSync(srcFd));
    } finally {
      fs.closeSync(destFd);
    }
  } finally {
    fs.closeSync(srcFd);
  }
}

/**
 * Writes a complete HyperFrames composition folder from a spec, narration and templates: builds
 * the new folder in `<folder>/work/comp-next/`, then swaps it in over `<folder>/comp/` through two
 * renames (`comp/` -> `work/comp-old/`, then `comp-next/` -> `comp/`) so there's never a moment
 * `comp/` is missing or half-written - a crash between the two renames leaves `comp/` missing and
 * `comp-old/` present, which the *next* call to `expand` detects and repairs before doing
 * anything else (Fix round 1, "Make the swap atomic").
 *
 * `input.folder` must be inside `input.root` (the workspace root) - checked with `@careeros/core`'s
 * `insideRoot` - and every path this function touches (`folder` itself, `work/`, `work/comp-next/`,
 * `comp/`, `work/comp-old/` and `narration.wav`) is refused if it's ever a symlink. `input.spec`
 * must satisfy `isValidated` for the same reason `buildHtml` requires it (checked here too, before
 * anything else, so an unvalidated spec never causes so much as a filesystem read).
 */
export function expand(input: ExpandInput): ExpandResult {
  if (!isValidated(input.spec)) throw new Error(NOT_CHECKED);
  const { folder, root } = input;
  assertSafe(root, folder, "the composition folder");

  const built = buildHtml(input.spec, input.words, input.total, input.captions, { media: input.media?.refs, motion: input.motion });
  const assets = (input.media?.files ?? []).filter((f) => ASSET_REL.test(f.rel));
  for (const f of assets) assertSafe(root, f.abs, "a picture for the video");
  if (input.audio) assertSafe(root, input.audio, "the mixed soundtrack");

  const work = path.join(folder, "work");
  const next = path.join(work, "comp-next");
  const compDir = path.join(folder, "comp");
  const oldDir = path.join(work, "comp-old");
  const swapPending = path.join(work, SWAP_PENDING);
  const narrationSrc = path.join(folder, "narration.wav");

  assertSafe(root, work, "work/");
  assertSafe(root, narrationSrc, "narration.wav");

  // Self-heal a crash between the two renames of an earlier call to this function: if comp/ is
  // missing but work/comp-old/ is present, that call got as far as comp/ -> comp-old/ but never
  // reached comp-next/ -> comp/. Restore comp-old/ before doing anything else - but only if
  // work/swap-pending genuinely lstats as a regular file (Task 11 review, a; Fix round 1): that's
  // what means a swap through *this* function was actually in progress, as opposed to comp-old/
  // being a leftover from anywhere else (a different process, something planted at that path).
  // Anything that fails that check is discarded - removed non-following - rather than blindly
  // promoted to comp/.
  assertSafe(root, oldDir, "work/comp-old/");
  if (!fs.existsSync(compDir)) {
    if (fs.existsSync(oldDir)) {
      if (isRegularFile(swapPending)) fs.renameSync(oldDir, compDir);
      else {
        assertSafe(root, work, "work/"); // Fix round 3, item 2: re-check right before removing
        fs.rmSync(oldDir, { recursive: true, force: true });
      }
    }
  } else {
    // comp/ is already healthy - any leftover work/swap-pending or work/comp-old/ is stale from a
    // crash some earlier call should have cleaned up (e.g. one that crashed in the narrow window
    // after its own comp-next/ -> comp/ rename succeeded but before its final cleanup ran). Left in
    // place, they'd sit there indefinitely, available to be mistakenly restored later; clearing
    // them now, non-following, closes that window (Fix round 2, item 5). A DIRECTORY at
    // swap-pending would otherwise make the plain, non-recursive removal below throw a raw EISDIR
    // on every single run, since this branch is reached whenever comp/ already exists (Fix round
    // 3, item 1) - clearIfDirOrSymlink handles that (and a symlink there) before the plain removal.
    clearIfDirOrSymlink(root, work, swapPending);
    fs.rmSync(swapPending, { force: true });
    assertSafe(root, work, "work/"); // Fix round 3, item 2: re-check right before removing
    fs.rmSync(oldDir, { recursive: true, force: true });
  }

  // A leftover comp-next/ - from a call that crashed mid-build, or was simply cancelled - must
  // never be trusted; clear it before writing fresh files into it.
  assertSafe(root, next, "work/comp-next/");
  assertSafe(root, work, "work/"); // Fix round 3, item 2: re-check right before removing
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(path.join(next, path.dirname(GSAP_REL)), { recursive: true });
  writeFileAtomic(path.join(next, "index.html"), built.html);
  fs.copyFileSync(path.join(input.templatesDir, "theme.css"), path.join(next, "theme.css"));
  fs.copyFileSync(path.join(input.templatesDir, "kit.js"), path.join(next, "kit.js"));
  fs.copyFileSync(input.gsapFile, path.join(next, GSAP_REL));
  fs.mkdirSync(path.join(next, FONTS_REL));
  for (const f of VIDEO_FONTS) fs.copyFileSync(path.join(input.templatesDir, FONTS_SRC_REL, f.file), path.join(next, FONTS_REL, f.file));
  copyFileNoFollow(input.audio ?? narrationSrc, path.join(next, "narration.wav"));
  if (assets.length) fs.mkdirSync(path.join(next, "assets"), { recursive: true });
  for (const f of assets) copyFileNoFollow(f.abs, path.join(next, f.rel));
  writeFileAtomic(path.join(next, "timeline.txt"), `${printTimeline(built.timeline, input.spec)}\n`);

  // A leftover comp-old/ (e.g. from a crash this very call just healed above, or one that was
  // never cleaned up for some other reason) must not block this call's own swap below.
  assertSafe(root, oldDir, "work/comp-old/");
  assertSafe(root, work, "work/"); // Fix round 3, item 2: re-check right before removing
  fs.rmSync(oldDir, { recursive: true, force: true });

  // The atomic swap itself: two renames, re-checked immediately before each one (the window since
  // the checks above is as small as this function can make it, not zero - see the task report for
  // what's out of scope here). work/swap-pending is written just before the first rename and
  // removed only once the second succeeds (Fix round 1) - living in work/, never in comp-next/ or
  // comp/ itself, so it can never leak into the composition's own file listing the way the
  // previous in-comp-next/ marker did. A crash anywhere between writing it and removing it is what
  // the self-heal step above recognises and trusts next time.
  // writeFileAtomic renames a temp file over swapPending - if a DIRECTORY (or a symlink) is
  // sitting there instead of a plain file, that rename fails outright (a raw EISDIR for a
  // directory), breaking every call to expand(), not just a self-heal. clearIfDirOrSymlink handles
  // either case, non-following, before writing (Fix round 2, item 4).
  clearIfDirOrSymlink(root, work, swapPending);
  writeFileAtomic(swapPending, "A HyperFrames composition swap was in progress.\n");
  assertSafe(root, compDir, "comp/");
  if (fs.existsSync(compDir)) fs.renameSync(compDir, oldDir);
  assertSafe(root, next, "work/comp-next/");
  fs.renameSync(next, compDir);
  assertSafe(root, work, "work/"); // Fix round 3, item 2: re-check right before removing
  fs.rmSync(swapPending, { force: true });
  assertSafe(root, oldDir, "work/comp-old/");
  assertSafe(root, work, "work/"); // Fix round 3, item 2: re-check right before removing
  fs.rmSync(oldDir, { recursive: true, force: true });

  return { ...built, compDir };
}
