/**
 * Marketing and guide videos: screen recordings of the made-up example workspace in the app-ui vite mock, read by the
 * app's own voice (Supertonic, Maya), with the app's music bed, the "AI voice" mark on every frame and English captions
 * as a separate .vtt. See scripts/marketing/README.md for the shot list format and how to run it.
 *
 *   npx tsx scripts/marketing/make-video.ts scripts/marketing/shots/find-and-score.json [--out DIR] [--base URL]
 *     [--chrome PATH] [--reuse] [--only N,N]
 *
 * Every frame is the fictional example (Alex Example, Acme Corp). The visible text of every beat and the captions go
 * through the privacy rules (denylist) before anything is written out; a hit stops the run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  WATERMARK_CSS, disclosureMetadata, groupCaptions, nodeProcessRunner, toVtt, watermarkHtml, wordsFromTiming, type Timeline, type Word,
} from "@careeros/video";
import { mixSound } from "../../packages/video/src/sound.js";
// @ts-expect-error plain ESM without types
import { checkText, loadDenylist } from "../privacy/rules.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const FPS = 30;
/** Every beat is recorded at this size and scaled down for 720p, so text is drawn once at full resolution. */
const REC = { width: 1920, height: 1080 };
const OUT_RES = { "1080p": { width: 1920, height: 1080 }, "720p": { width: 1280, height: 720 } } as const;

// ---- Shot list ----------------------------------------------------------------------------------------------

/** One thing done on screen. `at` (seconds into the beat) is only used in `steps`. */
export interface Action {
  at?: number;
  /** Click the first visible element with this text (cursor moves there first). `exact` matches the whole text. */
  click?: string; exact?: boolean;
  /** Click by ARIA role and accessible name. */
  role?: string; name?: string;
  /** Click a CSS selector. */
  css?: string;
  /** Go to an app route, like "#/jobs". */
  hash?: string;
  /** Scroll the main pane so this text (or selector) sits near the top, smoothly. */
  scrollTo?: string; scrollSelector?: string; offset?: number;
  /** Scroll the main pane by this many pixels, smoothly. */
  scrollBy?: number;
  /** Zoom the page around this text (or selector) to `scale` over `ms`. */
  zoom?: string; zoomSelector?: string; scale?: number; ms?: number;
  /** Zoom back out over `ms`. */
  unzoom?: boolean;
  /** Move the cursor over this text without clicking. */
  hover?: string;
  /** Type into a field (by CSS selector or by its label) one character at a time. */
  type?: { selector?: string; label?: string; text: string };
  /** Press a key, like "Escape". */
  press?: string;
  /** Wait for this text to show (pre steps only). */
  waitFor?: string;
  /** Pause, in milliseconds (pre steps only). */
  wait?: number;
}
export interface Beat {
  id: string;
  /** What the voice says (one paragraph). Empty for a silent beat. */
  voice: string;
  /** "title" or "end": the whole beat (or its first `cardFor` seconds) is that card. */
  card?: "title" | "end";
  cardFor?: number;
  /** Extra mock preview parameters for this beat's fresh load, like "score" or "chrome=on" (main.tsx). */
  params?: string;
  /** The route the beat opens on (before recording starts). */
  route?: string;
  /** Done before recording starts (not seen). */
  pre?: Action[];
  /** Done while recording, each at its `at`. */
  steps?: Action[];
  /** Silence before the line, after it, and the shortest the beat may be (seconds). */
  lead?: number; tail?: number; min?: number;
}
export interface ShotList {
  slug: string; title: string; resolution: keyof typeof OUT_RES;
  /** The app's layout width in CSS pixels (1440 looks like a laptop; 1280 reads better at 720p). */
  layoutWidth: number;
  theme: "dark" | "light";
  /** The browser clock at the start (the mock's data is dated around Jan 2026). */
  clock: string;
  /** Text swapped in the page before it is drawn: [from, to]. */
  replace?: [string, string][];
  cards: { title: { heading: string; sub?: string }; end: { heading: string; sub?: string }; disclaimer: string };
  poster: { beat: string; at: number };
  /** Target file sizes, used to pick the encoder's rate cap. */
  maxMB: number;
  beats: Beat[];
}

// ---- Small helpers ------------------------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const log = (...a: unknown[]) => console.log("[mktvid]", ...a);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function run(cmd: string, args: string[], what: string): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${what} failed (${cmd} exit ${r.status}):\n${(r.stderr || r.stdout || "").slice(-2000)}`);
  return r.stdout + r.stderr;
}
const ff = (args: string[], what: string) => run("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], what);
function probeDuration(file: string): number {
  return Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], "ffprobe").trim());
}

const DEFAULT_CHROME = path.join(os.homedir(), ".agent-browser/browsers/chrome-155.0.8059.39/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

// ---- Privacy -------------------------------------------------------------------------------------------------

const DENYLIST_FILE = path.join(os.homedir(), ".config/careeros/denylist.txt");
const deny: string[] = fs.existsSync(DENYLIST_FILE) ? loadDenylist(DENYLIST_FILE) : [];
/** Throws on a denylist hit or the old product name. Never prints the entry itself (rules.mjs masks it). */
function privacyCheck(where: string, text: string): void {
  const found = checkText(where, text, deny) as { line: number; rule: string; sample: string }[];
  if (/careeros/i.test(text)) found.push({ line: 0, rule: "old-name", sample: "CareerOS" });
  if (found.length) throw new Error(`privacy check failed in ${where}: ${found.map((f) => `line ${f.line} ${f.rule} ${f.sample}`).join("; ")}`);
}

// ---- Page setup ----------------------------------------------------------------------------------------------

/** Injected into every page before the app runs: hide the tour and job-board logos, swap text, the fake cursor. */
function pageInit(o: { css: string; replace: [string, string][]; zoom: number }) {
  const swap = (root: Node) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      let t = n.nodeValue ?? "";
      for (const [a, b] of o.replace) if (t.includes(a)) t = t.split(a).join(b);
      if (t !== n.nodeValue) n.nodeValue = t;
    }
  };
  const swapAttr = (el: Element) => {
    for (const at of ["title", "aria-label", "placeholder"]) {
      const v = el.getAttribute(at);
      if (!v) continue;
      let t = v;
      for (const [a, b] of o.replace) if (t.includes(a)) t = t.split(a).join(b);
      if (t !== v) el.setAttribute(at, t);
    }
  };
  // The fake cursor (a headless browser draws none). Made on first use, and again if the page ever drops it.
  (window as unknown as { mktCursor(): HTMLElement }).mktCursor = () => {
    let c = document.getElementById("mkt-cursor");
    if (!c) {
      c = document.createElement("div");
      c.id = "mkt-cursor";
      c.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 10-6.5 1.5L16 21l-3 1.3-3.4-7.6L4 19z" fill="#f4f1ea" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
      document.documentElement.append(c);
    }
    return c;
  };
  document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.style.zoom = String(o.zoom);
    const s = document.createElement("style");
    s.textContent = o.css;
    document.head.append(s);
    swap(document.body);
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "characterData") swap(m.target);
        for (const n of m.addedNodes) { swap(n); if (n instanceof Element) { swapAttr(n); n.querySelectorAll("[title],[aria-label],[placeholder]").forEach(swapAttr); } }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

const PAGE_CSS = `
.tour-layer { display: none !important; }
.source-badge__mark, .source-badge__mono, .role-cell__source { display: none !important; }
*, *::before, *::after { caret-color: transparent; }
#mkt-cursor { position: fixed; left: 70%; top: 78%; z-index: 2147483647; pointer-events: none; transition: left 0.6s cubic-bezier(.3,.7,.2,1), top 0.6s cubic-bezier(.3,.7,.2,1), transform 0.12s; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
#mkt-cursor.down { transform: scale(0.85); }
#root { transition: transform 0.9s cubic-bezier(.4,0,.2,1); }
`;

/** tsx (esbuild) wraps named functions in `__name(...)`; functions sent to the page need it defined there too. */
const ESBUILD_NAME_SHIM = "window.__name = window.__name || ((f) => f);";

async function freshPage(browser: Browser, s: ShotList): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: REC, deviceScaleFactor: 1, colorScheme: s.theme, timezoneId: "Australia/Sydney", locale: "en-AU", reducedMotion: "no-preference",
  });
  await ctx.addInitScript({ content: ESBUILD_NAME_SHIM });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(s.clock) });
  await page.clock.resume();
  await page.addInitScript(pageInit, { css: PAGE_CSS, replace: s.replace ?? [], zoom: REC.width / s.layoutWidth });
  return page;
}

/** Fresh load in example mode: the welcome screen, "Try example", then the beat's route. */
async function openExample(page: Page, base: string, beat: Beat): Promise<void> {
  const q = ["onboarding", ...(beat.params ? beat.params.split("&") : [])].join("&");
  await page.goto(`${base}/?${q}`);
  await page.getByText("Try example", { exact: true }).first().waitFor({ timeout: 15_000 });
  if (beat.route === "#/welcome") { await assertFonts(page); return; } // stay on the welcome screen
  await page.getByText("Try example", { exact: true }).first().click();
  await page.getByText("You're exploring an example job search").first().waitFor({ timeout: 10_000 });
  // `?maildemo` opens with the "Re-check filed mail" prompt; it isn't part of any shot.
  const recheck = page.getByRole("dialog", { name: "Re-check filed mail" });
  if (await recheck.isVisible({ timeout: 1200 }).catch(() => false)) await recheck.getByRole("button", { name: "Not now" }).click();
  if (beat.route) await page.evaluate((h) => { location.hash = h; }, beat.route);
  await page.waitForTimeout(900);
  await assertFonts(page);
}

/** The app's own fonts must have loaded. A worktree whose node_modules links to another checkout gets them refused by
 * vite's serving allow list, and the page quietly falls back to system fonts. */
async function assertFonts(page: Page): Promise<void> {
  const ok = await page.evaluate(async () => {
    await document.fonts.ready;
    const loaded = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
    return ["Geist", "Instrument Serif"].every((f) => loaded.includes(f));
  });
  if (!ok) throw new Error("the app's fonts (Geist, Instrument Serif) didn't load; copy node_modules/@fontsource into this checkout instead of a symlink (see README)");
}

async function locate(page: Page, a: Action) {
  if (a.role) return page.getByRole(a.role as Parameters<Page["getByRole"]>[0], { name: a.name, exact: true }).first();
  if (a.css) return page.locator(a.css).first();
  const text = a.click ?? a.hover ?? "";
  return page.getByText(text, { exact: !!a.exact }).filter({ visible: true }).first();
}

async function moveCursorTo(page: Page, el: Awaited<ReturnType<typeof locate>>): Promise<void> {
  await el.waitFor({ state: "visible", timeout: 5000 });
  await el.evaluate((node) => {
    // Off screen: bring it to the middle (not the top, where sticky bars would cover it).
    const pre = node.getBoundingClientRect();
    if (pre.top < window.innerHeight * 0.18 || pre.bottom > window.innerHeight) node.scrollIntoView({ block: "center", behavior: "instant" });
    const r = node.getBoundingClientRect();
    const z = Number(document.documentElement.style.zoom) || 1;
    // With CSS zoom on <html>, rects are in zoomed pixels and fixed positions in unzoomed ones.
    const c = (window as unknown as { mktCursor(): HTMLElement }).mktCursor();
    c.style.left = `${(r.left + Math.min(r.width / 2, 60)) / z}px`;
    c.style.top = `${(r.top + r.height / 2) / z}px`;
  });
  await page.waitForTimeout(650);
}

async function doAction(page: Page, a: Action): Promise<void> {
  if (a.hash) { await page.evaluate((h) => { location.hash = h; }, a.hash); return; }
  if (a.wait) { await page.waitForTimeout(a.wait); return; }
  if (a.waitFor) { await page.getByText(a.waitFor).first().waitFor({ timeout: 10_000 }); return; }
  if (a.press) { await page.keyboard.press(a.press); return; }
  if (a.click || a.role || a.css) {
    const el = await locate(page, a);
    await moveCursorTo(page, el);
    await page.evaluate(() => (window as unknown as { mktCursor(): HTMLElement }).mktCursor().classList.add("down"));
    // Playwright's hit test can miss under CSS zoom far from the top left; a DOM click is the fallback.
    const ok = await el.click({ trial: true, timeout: 400 }).then(() => true, () => false);
    if (ok) await el.click({ timeout: 3000 });
    else await el.evaluate((node) => (node as HTMLElement).click());
    await page.evaluate(() => setTimeout(() => document.getElementById("mkt-cursor")?.classList.remove("down"), 140));
    return;
  }
  if (a.hover) { const el = await locate(page, a); await moveCursorTo(page, el); await el.hover(); return; }
  if (a.type) {
    const el = a.type.label ? page.getByLabel(a.type.label, { exact: true }).first() : page.locator(a.type.selector ?? "input").first();
    await moveCursorTo(page, el);
    await el.click();
    await el.pressSequentially(a.type.text, { delay: 55 });
    return;
  }
  if (a.scrollTo || a.scrollSelector || a.scrollBy) {
    await page.evaluate(({ text, sel, by, offset }) => {
      const find = (): Element | null => {
        if (sel) return document.querySelector(sel);
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue?.includes(text!) && n.parentElement?.offsetParent) return n.parentElement;
        return null;
      };
      const scroller = (el: Element | null): Element => {
        for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
          const st = getComputedStyle(p);
          if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight) return p;
        }
        return document.scrollingElement!;
      };
      if (by) {
        const main = document.querySelector("main") ?? document.body;
        const sc = scroller(main.firstElementChild ?? main);
        sc.scrollBy({ top: by, behavior: "smooth" });
        return;
      }
      const el = find();
      if (!el) throw new Error(`scroll target not found: ${text ?? sel}`);
      // scrollIntoView with a scroll margin, so the browser does the zoom maths.
      (el as HTMLElement).style.scrollMarginTop = `${offset ?? 120}px`;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, { text: a.scrollTo, sel: a.scrollSelector, by: a.scrollBy, offset: a.offset });
    return;
  }
  if (a.zoom || a.zoomSelector) {
    await page.evaluate(({ text, sel, scale, ms }) => {
      const root = document.getElementById("root")!;
      let el: Element | null = sel ? document.querySelector(sel) : null;
      if (!el && text) {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue?.includes(text) && n.parentElement?.offsetParent) { el = n.parentElement; break; }
      }
      if (!el) throw new Error(`zoom target not found: ${text ?? sel}`);
      const rr = root.getBoundingClientRect(), er = el.getBoundingClientRect();
      const k = rr.width / root.offsetWidth;
      root.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
      root.style.transformOrigin = `${(er.left + er.width / 2 - rr.left) / k}px ${(er.top + er.height / 2 - rr.top) / k}px`;
      root.style.transform = `scale(${scale})`;
    }, { text: a.zoom, sel: a.zoomSelector, scale: a.scale ?? 1.6, ms: a.ms ?? 900 });
    return;
  }
  if (a.unzoom) {
    await page.evaluate((ms) => { const root = document.getElementById("root")!; root.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`; root.style.transform = "none"; }, a.ms ?? 700);
    return;
  }
  throw new Error(`unknown action: ${JSON.stringify(a)}`);
}

// ---- Recording -----------------------------------------------------------------------------------------------

interface Frame { file: string; t: number }

/** Records `seconds` of the page with the DevTools screencast (a frame on every paint), running `steps` on time. */
async function recordBeat(page: Page, dir: string, seconds: number, steps: Action[]): Promise<Frame[]> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  let t0 = 0;
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const ts = f.metadata.timestamp ?? Date.now() / 1000;
    if (!t0) t0 = ts;
    const file = path.join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: ts - t0 });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: REC.width, maxHeight: REC.height, everyNthFrame: 1 });
  const start = Date.now();
  // A tiny repaint every 100 ms so a still screen still sends frames (and the first frame comes at once).
  await page.evaluate(() => { const d = document.createElement("div"); d.id = "mkt-tick"; d.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:2147483646"; document.body.append(d); let k = 0; (window as unknown as { mktTick: number }).mktTick = window.setInterval(() => { d.style.background = (k++ % 2) ? "#000" : "#010101"; }, 100); });
  for (const s of [...steps].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    const wait = (s.at ?? 0) * 1000 - (Date.now() - start);
    if (wait > 0) await page.waitForTimeout(wait);
    try { await doAction(page, s); } catch (e) { throw new Error(`step ${JSON.stringify(s)} failed: ${String(e).split("\n")[0]}`); }
  }
  const left = seconds * 1000 + 300 - (Date.now() - start);
  if (left > 0) await page.waitForTimeout(left);
  await cdp.send("Page.stopScreencast");
  await page.evaluate(() => clearInterval((window as unknown as { mktTick: number }).mktTick));
  await cdp.detach();
  if (!frames.length) throw new Error("no frames recorded");
  return frames;
}

/** A segment of exactly `seconds` from timed frames (each held until the next), at FPS and the output size. */
function framesToSegment(frames: Frame[], seconds: number, out: string, res: { width: number; height: number }, fade?: { inS?: number; outS?: number }): void {
  const list = path.join(path.dirname(out), `${path.basename(out, ".mp4")}.txt`);
  const usable = frames.filter((f) => f.t < seconds);
  const lines: string[] = [];
  usable.forEach((f, i) => {
    const next = i + 1 < usable.length ? usable[i + 1]!.t : seconds;
    lines.push(`file '${f.file}'`, `duration ${r3(Math.max(0.001, next - (i === 0 ? 0 : f.t)))}`);
  });
  lines.push(`file '${usable.at(-1)!.file}'`);
  fs.writeFileSync(list, lines.join("\n") + "\n");
  const fades = [fade?.inS ? `fade=t=in:st=0:d=${fade.inS}` : "", fade?.outS ? `fade=t=out:st=${r3(seconds - fade.outS)}:d=${fade.outS}` : ""].filter(Boolean);
  ff(["-f", "concat", "-safe", "0", "-i", list, "-vf", [`fps=${FPS}`, `scale=${res.width}:${res.height}:flags=lanczos`, ...fades, "format=yuv420p"].join(","),
    "-t", String(seconds), "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-an", out], "segment encode");
}

// ---- Cards and the mark --------------------------------------------------------------------------------------

const MONTSERRAT = path.join(REPO, "plugin/templates/video/assets/fonts/montserrat-latin-wght-normal.woff2");

/** Title or end card, drawn in the app's own page (its fonts and colours), recorded so its fade-in is real motion. */
async function cardFrames(page: Page, s: ShotList, which: "title" | "end", dir: string, seconds: number): Promise<Frame[]> {
  const c = s.cards[which];
  await page.evaluate(({ c, disclaimer, which, mark }) => {
    const el = document.createElement("div");
    el.id = "mkt-card";
    el.innerHTML = `
      <div class="mkt-card__in">
        <div class="mkt-card__brand">${mark}<span>JobCairn</span></div>
        <h1>${c.heading}</h1>
        ${c.sub ? `<p class="mkt-card__sub">${c.sub}</p>` : ""}
        <p class="mkt-card__note">${disclaimer}</p>
      </div>`;
    el.dataset.which = which;
    const st = document.createElement("style");
    st.textContent = `
      #mkt-card { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; background: radial-gradient(120% 90% at 20% 10%, #1d1b18 0%, #0d0e11 55%, #0a0b0d 100%); color: #f1ede4; }
      .mkt-card__in { width: min(980px, 80vw); display: flex; flex-direction: column; gap: 22px; opacity: 0; transform: translateY(10px); animation: mktIn 0.9s 0.15s cubic-bezier(.2,.7,.2,1) forwards; }
      .mkt-card__brand { display: flex; align-items: center; gap: 12px; font-family: var(--font-family-display, Georgia, serif); font-size: 30px; color: #e8e2d6; }
      .mkt-card__brand svg { width: 40px; height: 40px; }
      #mkt-card h1 { margin: 0; font-family: var(--font-family-display, Georgia, serif); font-weight: 400; font-size: 76px; line-height: 1.04; letter-spacing: -0.01em; }
      .mkt-card__sub { margin: 0; font-family: var(--font-family-sans, system-ui); font-size: 26px; line-height: 1.4; color: #c9c2b4; }
      .mkt-card__note { margin: 26px 0 0; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.12); font-family: var(--font-family-sans, system-ui); font-size: 19px; color: #a39c8f; }
      @keyframes mktIn { to { opacity: 1; transform: none; } }`;
    document.head.append(st);
    document.body.append(el);
  }, { c, disclaimer: s.cards.disclaimer, which, mark: fs.readFileSync(path.join(REPO, "packages/brand/assets/mark.svg"), "utf8") });
  const frames = await recordBeat(page, dir, seconds, []);
  await page.evaluate(() => { document.getElementById("mkt-card")?.remove(); });
  return frames;
}

/** The "AI voice" mark (watermark.ts) as a transparent PNG at the output size, bottom right. */
async function markPng(browser: Browser, res: { width: number; height: number }, file: string): Promise<void> {
  const ctx = await browser.newContext({ viewport: res, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const font = fs.readFileSync(MONTSERRAT).toString("base64");
  // The mark's own CSS, moved to the bottom right (the app's banner and buttons sit top right) and scaled for 720p.
  // Drawn for a 1920 x 1080 stage; a little larger than plain scaling at 720p so "AI voice" stays readable.
  const k = (res.width / 1920) * (res.width >= 1920 ? 1 : 1.2);
  await page.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: "Montserrat"; font-weight: 100 900; src: url(data:font/woff2;base64,${font}) format("woff2"); }
    html, body { margin: 0; background: transparent; width: ${res.width}px; height: ${res.height}px; overflow: hidden; }
    #root { position: relative; width: 1920px; height: 1080px; transform: scale(${k}); transform-origin: 100% 100%; position: absolute; right: 0; bottom: 0; }
    ${WATERMARK_CSS}
    .ai-mark { top: auto !important; bottom: 26px; right: 28px; }
  </style></head><body><div id="root">${watermarkHtml()}</div></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: true });
  await ctx.close();
}

/** PNG to webp under `maxBytes`, encoded by the browser (ffmpeg here has no webp encoder; no extra tool needed). */
async function toWebp(chrome: string, png: string, out: string, maxBytes: number): Promise<void> {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    const src = `data:image/png;base64,${fs.readFileSync(png).toString("base64")}`;
    for (const q of [0.82, 0.74, 0.66, 0.58, 0.5, 0.42]) {
      const b64 = await page.evaluate(async ({ src, q }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d")!.drawImage(img, 0, 0);
        return c.toDataURL("image/webp", q).split(",")[1]!;
      }, { src, q });
      fs.writeFileSync(out, Buffer.from(b64, "base64"));
      if (fs.statSync(out).size < maxBytes) return;
    }
  } finally {
    await browser.close();
  }
}

// ---- Narration -----------------------------------------------------------------------------------------------

interface Para { index: number; text: string; start: number; end: number }
interface NarrationTiming { total: number; engine: string; voice: string; fell_back: boolean; paragraphs: Para[]; words_estimated: Word[] }

function narrate(s: ShotList, work: string): NarrationTiming {
  const spoken = s.beats.filter((b) => b.voice.trim());
  fs.writeFileSync(path.join(work, "script.txt"), spoken.map((b) => b.voice.trim()).join("\n\n") + "\n");
  const python = path.join(os.homedir(), ".careeros/venv/bin/python");
  run(python, ["-I", path.join(REPO, "plugin/skills/voice/scripts/narrate.py"), "--text-file", path.join(work, "script.txt"), "--voice", "F4", "--lang", "en",
    "--engine", "supertonic", "--no-download", "--no-expressions", "--out", path.join(work, "voice-raw.wav"), "--timing", path.join(work, "voice-raw.json"),
    "--cache-dir", path.join(work, "narration-cache")], "narration");
  const t = JSON.parse(fs.readFileSync(path.join(work, "voice-raw.json"), "utf8")) as NarrationTiming;
  if (t.engine !== "supertonic" || t.fell_back) throw new Error(`narration used ${t.engine} (fell back: ${t.fell_back}); Supertonic is required`);
  if (t.paragraphs.length !== spoken.length) throw new Error(`narration has ${t.paragraphs.length} paragraphs for ${spoken.length} lines`);
  return t;
}

interface Plan { beat: Beat; start: number; dur: number; speech: Para | null; speechAt: number }

/** Each beat's length: lead + its line + tail, at least `min`. The voice of beat i starts at start + lead. */
function planBeats(s: ShotList, t: NarrationTiming): Plan[] {
  let k = 0, at = 0;
  return s.beats.map((beat) => {
    const speech = beat.voice.trim() ? t.paragraphs[k++]! : null;
    const lead = beat.lead ?? 0.35, tail = beat.tail ?? 0.7;
    const dur = r3(Math.max(beat.min ?? 0, speech ? lead + (speech.end - speech.start) + tail : 0));
    const p = { beat, start: r3(at), dur, speech, speechAt: r3(at + lead) };
    at += dur;
    return p;
  });
}

/** The full-length voice track: each line cut from the narration and placed at its beat's time. */
function buildVoice(plans: Plan[], raw: string, out: string): number {
  const total = r3(plans.reduce((a, p) => a + p.dur, 0));
  const parts: string[] = [];
  const labels: string[] = [];
  plans.forEach((p, i) => {
    if (!p.speech) return;
    const s = Math.max(0, p.speech.start - 0.04), e = p.speech.end + 0.12;
    const ms = Math.round((p.speechAt - 0.04) * 1000);
    parts.push(`[0:a]atrim=start=${r3(s)}:end=${r3(e)},asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[v${i}]`);
    labels.push(`[v${i}]`);
  });
  const graph = `${parts.join(";")};${labels.join("")}amix=inputs=${labels.length}:normalize=0,apad[out]`;
  ff(["-i", raw, "-filter_complex", graph, "-map", "[out]", "-t", String(total), "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out], "voice track");
  return total;
}

/** Where speech really starts in the voice track (Supertonic leaves a little air before each line). */
function speechOnsets(voice: string): number[] {
  const out = run("ffmpeg", ["-hide_banner", "-nostdin", "-i", voice, "-af", "silencedetect=n=-40dB:d=0.25", "-f", "null", "-"], "silence detect");
  return [...out.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
}

function captions(plans: Plan[], t: NarrationTiming, onsets: number[]): string {
  const words: Word[] = [];
  const all = wordsFromTiming(t);
  for (const p of plans) {
    if (!p.speech) continue;
    // Line the first word up with the heard onset, when one is found just after the line's slot starts.
    const onset = onsets.find((o) => o >= p.speechAt - 0.1 && o <= p.speechAt + 0.9);
    const shift = (onset ?? p.speechAt) - p.speech.start;
    for (const w of all) if (w.start >= p.speech.start - 0.01 && w.end <= p.speech.end + 0.05) words.push({ text: w.text, start: r3(w.start + shift), end: r3(w.end + shift) });
  }
  // No one-word cue left dangling ("of."): it joins the cue before it when they run on.
  const groups = groupCaptions(words, { maxWords: 9, maxChars: 50, gap: 0.6 });
  for (let i = groups.length - 1; i > 0; i--) {
    const g = groups[i]!, prev = groups[i - 1]!;
    if (g.words.length === 1 && g.start - prev.end < 0.3 && !/[.!?]$/.test(prev.text)) {
      groups.splice(i - 1, 2, { words: [...prev.words, ...g.words], start: prev.start, end: g.end, text: `${prev.text} ${g.text}` });
    }
  }
  return toVtt(groups);
}

// ---- Main ----------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const shotFile = process.argv[2];
  if (!shotFile || shotFile.startsWith("--")) throw new Error("usage: make-video.ts <shots.json> [--out DIR] [--base URL] [--chrome PATH] [--reuse] [--only N,N]");
  const s = JSON.parse(fs.readFileSync(shotFile, "utf8")) as ShotList;
  const base = (arg("base") ?? "http://127.0.0.1:5392").replace(/\/$/, "");
  const work = path.resolve(arg("work") ?? path.join(REPO, "tmp/marketing", s.slug));
  const outDir = path.resolve(arg("out") ?? path.join(work, "out"));
  const res = OUT_RES[s.resolution];
  const reuse = has("reuse");
  const only = arg("only")?.split(",").map(Number);
  fs.mkdirSync(path.join(work, "beats"), { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (!deny.length) throw new Error(`no denylist at ${DENYLIST_FILE}; the privacy check needs it`);

  log(`narrating ${s.beats.filter((b) => b.voice).length} lines (Supertonic, Maya)`);
  const t = narrate(s, work);
  const plans = planBeats(s, t);
  const total = buildVoice(plans, path.join(work, "voice-raw.wav"), path.join(work, "narration.wav"));
  log(`length ${total.toFixed(1)} s:`, plans.map((p) => `${p.beat.id} ${p.dur.toFixed(1)}`).join(", "));

  const browser = await chromium.launch({ executablePath: arg("chrome") ?? DEFAULT_CHROME, headless: true });
  const segs: string[] = [];
  const pageText: string[] = [];
  try {
    for (const [i, p] of plans.entries()) {
      const seg = path.join(work, "beats", `${String(i).padStart(2, "0")}-${p.beat.id}.mp4`);
      const textFile = `${seg}.txt`;
      segs.push(seg);
      if ((reuse && fs.existsSync(seg) && !(only && only.includes(i))) || (only && !only.includes(i) && fs.existsSync(seg))) {
        if (fs.existsSync(textFile)) pageText.push(fs.readFileSync(textFile, "utf8"));
        continue;
      }
      log(`recording ${i} ${p.beat.id} (${p.dur.toFixed(1)} s)`);
      const page = await freshPage(browser, s);
      try {
        const cardFor = p.beat.card ? (p.beat.cardFor ?? p.dur) : 0;
        let frames: Frame[] = [];
        if (p.beat.card && cardFor >= p.dur) {
          await page.goto(`${base}/?onboarding`);
          await page.getByText("Try example", { exact: true }).first().waitFor({ timeout: 15_000 });
          await assertFonts(page);
          frames = await cardFrames(page, s, p.beat.card, path.join(work, "beats", `${i}-frames`), p.dur);
        } else {
          await openExample(page, base, p.beat);
          for (const a of p.beat.pre ?? []) await doAction(page, a);
          await page.waitForTimeout(400);
          if (p.beat.card) {
            const cf = await cardFrames(page, s, p.beat.card, path.join(work, "beats", `${i}-card`), cardFor);
            const rest = await recordBeat(page, path.join(work, "beats", `${i}-frames`), p.dur - cardFor, (p.beat.steps ?? []));
            frames = [...cf.filter((f) => f.t < cardFor), ...rest.map((f) => ({ ...f, t: f.t + cardFor }))];
          } else {
            frames = await recordBeat(page, path.join(work, "beats", `${i}-frames`), p.dur, p.beat.steps ?? []);
          }
        }
        const text = await page.evaluate(() => document.body.innerText);
        fs.writeFileSync(textFile, text);
        pageText.push(text);
        privacyCheck(`beat ${p.beat.id}`, text);
        const first = i === 0, last = i === plans.length - 1;
        framesToSegment(frames, p.dur, seg, res, { inS: first ? 0.5 : undefined, outS: last ? 0.8 : undefined });
      } finally {
        await page.context().close();
      }
    }
    const mark = path.join(work, "mark.png");
    await markPng(browser, res, mark);
  } finally {
    await browser.close();
  }
  for (const [i, text] of pageText.entries()) privacyCheck(`page text ${i}`, text);

  // Picture: the beats back to back, with the mark over every frame.
  const list = path.join(work, "segments.txt");
  fs.writeFileSync(list, segs.map((f) => `file '${f}'`).join("\n") + "\n");
  const picture = path.join(work, "picture.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", picture], "join beats");

  // Sound: the app's music bed under the voice, ducked by it, loudness set to -16 LUFS (sound.ts).
  const mix = await mixSound({ runner: nodeProcessRunner(), ffmpeg: "ffmpeg", folderAbs: work, tl: { total, scenes: [], issues: [] } as Timeline, effects: false, music: true, signal: new AbortController().signal });
  if (!mix) throw new Error("no sound mix");
  log("loudness", mix.loudness);

  const vtt = captions(plans, t, speechOnsets(path.join(work, "narration.wav")));
  privacyCheck("captions", vtt);
  const mp4 = path.join(outDir, `${s.slug}.mp4`);
  const kbps = Math.floor((s.maxMB * 8 * 1024 * 0.88) / total) - 96;
  ff(["-i", picture, "-i", path.join(work, "mark.png"), "-i", mix.file,
    "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[v]", "-map", "[v]", "-map", "2:a",
    "-c:v", "libx264", "-preset", "slow", "-tune", "stillimage", "-crf", s.resolution === "1080p" ? "22" : "23", "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`,
    "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", String(FPS * 4),
    "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2", "-shortest",
    ...disclosureMetadata(s.title, t.engine), "-movflags", "+faststart", mp4], "final encode");
  fs.writeFileSync(path.join(outDir, `${s.slug}.en.vtt`), vtt);

  // Poster: one frame from the finished file (so it carries the mark), as webp under 150 KB.
  const pp = plans.find((p) => p.beat.id === s.poster.beat) ?? plans[1]!;
  const png = path.join(work, "poster.png");
  ff(["-ss", String(r3(pp.start + s.poster.at)), "-i", mp4, "-frames:v", "1", png], "poster frame");
  const webp = path.join(outDir, `${s.slug}-poster.webp`);
  await toWebp(arg("chrome") ?? DEFAULT_CHROME, png, webp, 150 * 1024);

  // QA: one still per beat (middle) for a look, and the numbers.
  const qa = path.join(work, "qa");
  fs.rmSync(qa, { recursive: true, force: true });
  fs.mkdirSync(qa, { recursive: true });
  for (const [i, p] of plans.entries()) {
    for (const f of [0.25, 0.75]) ff(["-ss", String(r3(p.start + p.dur * f)), "-i", mp4, "-frames:v", "1", "-vf", "scale=960:-2", path.join(qa, `${String(i).padStart(2, "0")}-${p.beat.id}-${f === 0.25 ? "a" : "b"}.jpg`)], "qa frame");
  }
  fs.writeFileSync(path.join(work, "plan.json"), JSON.stringify(plans.map((p) => ({ id: p.beat.id, start: p.start, dur: p.dur, voiceAt: p.speechAt, line: p.beat.voice })), null, 2));
  const dur = probeDuration(mp4);
  log(`done: ${mp4} ${(fs.statSync(mp4).size / 1048576).toFixed(2)} MB, ${dur.toFixed(1)} s; poster ${(fs.statSync(webp).size / 1024).toFixed(0)} KB; qa stills in ${qa}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
