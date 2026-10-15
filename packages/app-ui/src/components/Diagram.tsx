import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { loadMermaid, type MermaidApi } from "./mermaid-load";

/**
 * A Mermaid diagram from a guide's ```mermaid block. Drawn lazily (when it scrolls near), in the app's colours, with
 * Mermaid's strict security level and plain SVG text labels (no HTML). Anything Mermaid can't parse shows as the
 * code block it came from, so the guide never loses content.
 *
 * The app's CSP has no 'unsafe-inline' styles, so Mermaid's own <style> element and style="" attributes would be
 * dropped. They are moved over through the CSSOM instead (a constructed stylesheet and element.style), which the CSP
 * allows, after the SVG is cleaned of scripts, event handlers, foreign HTML and outside links.
 */

/** The diagram kind from its first line ("flowchart LR" is "flowchart"), for the label. */
export function diagramKind(code: string): string {
  const line = code.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("%%") && l !== "---") ?? "";
  const word = (/^[A-Za-z-]+/.exec(line)?.[0] ?? "").toLowerCase();
  const NAMES: Record<string, string> = {
    flowchart: "flowchart", graph: "flowchart", sequencediagram: "sequence diagram", mindmap: "mind map", classdiagram: "class diagram",
    statediagram: "state diagram", "statediagram-v2": "state diagram", erdiagram: "entity diagram", timeline: "timeline", pie: "pie chart",
    journey: "journey", gantt: "timeline chart", quadrantchart: "quadrant chart",
  };
  return NAMES[word] ?? "diagram";
}

// ---- theme ------------------------------------------------------------------
function parseColor(c: string): [number, number, number, number] | null {
  const s = c.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) {
    const h = m[1]!.length === 3 ? m[1]!.replace(/./g, "$&$&") : m[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
}
const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/** A token colour as opaque hex over a background (Mermaid's colour maths needs plain colours, not rgba or var()). */
export function opaque(color: string, over: string, fallback: string): string {
  const c = parseColor(color), b = parseColor(over) ?? [0, 0, 0, 1];
  if (!c) return fallback;
  const a = c[3];
  return `#${hex(c[0] * a + b[0] * (1 - a))}${hex(c[1] * a + b[1] * (1 - a))}${hex(c[2] * a + b[2] * (1 - a))}`;
}

/** `color` at `amount` (0..1) over `bg`, both opaque hex. */
export function mix(color: string, bg: string, amount: number): string {
  const c = parseColor(color), b = parseColor(bg);
  if (!c || !b) return color;
  return `#${hex(c[0] * amount + b[0] * (1 - amount))}${hex(c[1] * amount + b[1] * (1 - amount))}${hex(c[2] * amount + b[2] * (1 - amount))}`;
}

function themeConfig(): Record<string, unknown> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = document.documentElement.dataset.theme !== "paper";
  const bg = opaque(v("--color-bg-raised"), "", "");
  const on = (name: string, fb = "") => opaque(v(name), bg, fb);
  const text = on("--color-text");
  const muted = on("--color-text-muted");
  const accent = on("--color-accent");
  const soft = on("--color-accent-soft", bg);
  const surface = on("--color-surface-hover", bg);
  const line = on("--color-border-strong", muted);
  const font = v("--font-family-text") || v("--font-family-sans");
  // Mind map branches (Mermaid's cScale0..11): the app's accent and status colours, tinted onto the background.
  const tints = ["--color-accent", "--color-info", "--color-success", "--color-warning", "--color-danger", "--color-text-muted"]
    .map((name) => mix(on(name, muted), bg, dark ? 0.3 : 0.22));
  const branches: Record<string, string> = {};
  for (let i = 0; i < 12; i++) { branches[`cScale${i}`] = tints[i % tints.length]!; branches[`cScaleLabel${i}`] = text; branches[`cScaleInv${i}`] = line; }
  // Mermaid's own font settings, set from the app's text token so labels are measured in the font they show in.
  const fontVars = { fontFamily: font, fontSize: v("--font-size-14") }; // brand-lint: mermaid-config
  const themeVariables = Object.fromEntries(Object.entries({
    darkMode: dark, background: bg, ...fontVars,
    primaryColor: soft, primaryBorderColor: accent, primaryTextColor: text,
    secondaryColor: surface, secondaryBorderColor: line, secondaryTextColor: text,
    tertiaryColor: bg, tertiaryBorderColor: line, tertiaryTextColor: text,
    lineColor: muted, textColor: text, mainBkg: soft, nodeBorder: accent, clusterBkg: surface, clusterBorder: line,
    titleColor: text, edgeLabelBackground: bg, labelBackground: bg,
    actorBkg: soft, actorBorder: accent, actorTextColor: text, actorLineColor: muted, signalColor: text, signalTextColor: text,
    labelBoxBkgColor: surface, labelBoxBorderColor: line, labelTextColor: text, loopTextColor: text,
    noteBkgColor: on("--color-warning-soft", surface), noteBorderColor: on("--color-warning", line), noteTextColor: text,
    activationBkgColor: surface, activationBorderColor: line, sequenceNumberColor: bg,
    ...branches,
  // A token that can't be read leaves Mermaid's own default in place.
  }).filter(([, x]) => x !== ""));
  return {
    startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "base", darkMode: dark, ...(font ? { fontFamily: font } : {}), // brand-lint: mermaid-config
    flowchart: { htmlLabels: false, curve: "basis", padding: 12, nodeSpacing: 30, rankSpacing: 36 },
    sequence: { useMaxWidth: true, mirrorActors: false },
    mindmap: { useMaxWidth: true },
    themeVariables,
  };
}

/** Re-renders when the app theme (html[data-theme]) changes. */
function useThemeName(): string {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "");
  useEffect(() => {
    const el = document.documentElement;
    const mo = new MutationObserver(() => setTheme(el.dataset.theme ?? ""));
    mo.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

// ---- drawing ----------------------------------------------------------------
// Mermaid's config is global, so diagrams draw one at a time.
let queue: Promise<unknown> = Promise.resolve();
function draw(id: string, code: string): Promise<string> {
  const job = queue.then(async () => {
    const m: MermaidApi = await loadMermaid();
    m.initialize(themeConfig());
    await m.parse(code);
    return (await m.render(id, code)).svg;
  });
  queue = job.catch(() => undefined);
  return job;
}

/** The width Mermaid laid the SVG out at (its viewBox), or 0. */
export function naturalWidth(svg: string): number {
  const m = /viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)/.exec(svg);
  return m ? Number(m[1]) : 0;
}

/** The same flowchart drawn top-down, or null when it isn't a left-to-right flowchart. */
export function toTopDown(code: string): string | null {
  const re = /^(\s*(?:flowchart|graph)\s+)(LR|RL)\b/m;
  return re.test(code) ? code.replace(re, "$1TD") : null;
}

/** Mermaid's SVG as a clean DOM node plus its stylesheet text, ready to insert under the app's CSP. */
export function cleanSvg(svg: string): { node: SVGSVGElement; css: string } {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("Not an SVG");
  let css = "";
  for (const el of [...root.querySelectorAll("style")]) { css += `${el.textContent ?? ""}\n`; el.remove(); }
  for (const el of [...root.querySelectorAll("script, foreignObject, iframe, object, embed, image")]) el.remove();
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(a.name);
      else if ((name === "href" || name === "xlink:href") && !a.value.trim().startsWith("#")) el.removeAttribute(a.name);
      else if (name === "style") { el.setAttribute("data-style", a.value); el.removeAttribute("style"); }
    }
  }
  const node = document.importNode(root, true) as unknown as SVGSVGElement;
  for (const el of [node, ...node.querySelectorAll<SVGElement>("[data-style]")]) {
    const s = el.getAttribute("data-style");
    if (s === null) continue;
    el.removeAttribute("data-style");
    el.style.cssText = s;
  }
  return { node, css };
}

function adoptCss(css: string): () => void {
  const doc = document as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
  if (!css.trim() || !doc.adoptedStyleSheets || typeof CSSStyleSheet === "undefined") return () => undefined;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    return () => { doc.adoptedStyleSheets = doc.adoptedStyleSheets!.filter((s) => s !== sheet); };
  } catch {
    return () => undefined;
  }
}

/** Starts true once the element is near the viewport (or at once where IntersectionObserver isn't available). */
function useNear(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !ref.current) return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setNear(true); }, { rootMargin: "400px 0px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

let seq = 0;
export function Diagram({ code }: { code: string }) {
  const rid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const box = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const near = useNear(box);
  const theme = useThemeName();
  const [state, setState] = useState<"drawing" | "ready" | "failed">("drawing");
  // The canvas takes a tab stop only when it scrolls sideways, so keyboard users can scroll it; otherwise it's skipped.
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el || state !== "ready") return undefined;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state]);
  const kind = diagramKind(code);

  useEffect(() => {
    if (!near) return undefined;
    let live = true;
    let release = () => undefined as void;
    setState((s) => (s === "failed" ? s : "drawing"));
    draw(`mmd-${rid}-${++seq}`, code).then(async (svg) => {
      if (!live || !canvas.current) return;
      // A left-to-right flowchart wider than the column would shrink its labels below about 12px: draw it top-down.
      const room = canvas.current.clientWidth;
      const tall = room > 0 && naturalWidth(svg) > room * 1.15 ? toTopDown(code) : null;
      if (tall) svg = await draw(`mmd-${rid}-${++seq}`, tall);
      if (!live || !canvas.current) return;
      const { node, css } = cleanSvg(svg);
      release = adoptCss(css);
      node.setAttribute("aria-hidden", "true");
      node.removeAttribute("role");
      canvas.current.replaceChildren(node);
      setState("ready");
    }).catch(() => { if (live) setState("failed"); });
    return () => { live = false; release(); };
  }, [near, code, theme, rid]);

  if (state === "failed") {
    return (
      <figure className="diagram diagram--failed" data-diagram="failed">
        <div className="diagram__note t-body-sm t-muted">This diagram couldn&apos;t be drawn, so here is its text.</div>
        <pre><code className="language-mermaid">{code}</code></pre>
      </figure>
    );
  }
  return (
    <figure ref={box} className="diagram" data-diagram={state} aria-busy={state === "drawing"}>
      <div ref={canvas} className="diagram__canvas" role="img" aria-label={`A ${kind}. Its text is below.`} tabIndex={scrolls ? 0 : undefined} />
      {state === "drawing" ? <span className="diagram__wait t-body-sm t-muted">Drawing the {kind}…</span> : null}
      <details className="diagram__src">
        <summary>Show text</summary>
        <pre><code className="language-mermaid">{code}</code></pre>
      </details>
    </figure>
  );
}
