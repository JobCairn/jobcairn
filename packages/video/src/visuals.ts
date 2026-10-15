import { esc, jsJson, n2, pad2 } from "./html.js";
import { layered, ring, type Layout, type LNode } from "./layout.js";
import { archKind, pictureFor, type Picture } from "./packs.js";
import { clampT, head, headJs, item, num, step, type BuildCtx, type Builder, type MarkSet } from "./scene-kit.js";
import { AU_OUTLINE, AU_TAS, findPlace, project, MAP_BOX } from "./places.js";
import type { CheckState, MatchStatus, Scene, VisualSceneType } from "./types.js";

/**
 * The visual scenes (spec version 3). Each one shows a picture first and at most a few words: icons, logos and
 * diagrams come from the bundled packs (packs.ts), a company logo from the workspace (media stage). Every reveal
 * lands on its cue word; with reduced motion the same reveals are short fades.
 *
 * Safety: spec text only ever reaches the page through `esc` (or MarkSet.text, which escapes), names from the spec
 * are looked up in the packs (never interpolated), and every time and size goes through `clampT` / `n2`.
 */
type B<T extends VisualSceneType> = Builder<Extract<Scene, { type: T }>>;

const ICON_TAGS = /<(path|circle|rect|line|ellipse|polyline|polygon) /g;

/** A picture as markup. `draw`: icon strokes start hidden so `K.drawIcon` can draw them in. */
export function pictureHtml(p: Picture, draw: boolean): string {
  if (p.kind === "icon") {
    const body = draw ? p.icon.svg.replace(ICON_TAGS, '<$1 pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" ') : p.icon.svg;
    return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }
  if (p.kind === "logo") return `<svg class="lg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${esc(p.logo.path)}"/></svg>`;
  return `<span class="ini">${esc(p.text)}</span>`;
}

/** The tile's brand accent: a logo's own colour when it reads on the dark ground, else the theme line colour. */
function accent(p: Picture): string {
  if (p.kind !== "logo" || !/^[0-9A-Fa-f]{6}$/.test(p.logo.hex)) return "";
  const v = parseInt(p.logo.hex, 16);
  const lum = (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
  return lum < 0.25 ? "" : ` style="--brand: #${p.logo.hex.toLowerCase()}"`;
}

const drawJs = (c: BuildCtx, sel: string, t: number): string[] => (c.reduced ? [] : [`K.drawIcon(tl, "${sel} .ic", ${clampT(c, t)});`]);
const pop = (c: BuildCtx, sel: string, t: number, from = "{ scale: 0.86, y: 18 }") => `K.reveal(tl, "${sel}", ${clampT(c, t)}, ${from}, 0.55);`;

// ---- icon grid ----
const iconGrid: B<"icon-grid"> = (s, c, m) => {
  const id = c.t.id, n = s.items.length, cols = n <= 3 ? n : n === 4 ? 4 : 3;
  const tiles = s.items.map((it, k) => {
    const p = pictureFor(it.label, it);
    return `<div id="${id}-i${k}" class="vg-tile"><span class="vg-pic${p.kind === "logo" ? " is-logo" : ""}"${accent(p)}>${pictureHtml(p, !c.reduced)}</span><p class="vg-label">${m.text(it.label)}</p></div>`;
  });
  return {
    html: [step(c), head(id, m, s.headline), `<div class="vg${s.headline ? "" : " tall"}" style="--cols: ${cols}">`, ...tiles, `</div>`].join("\n"),
    js: [...headJs(id, c, s.headline), ...s.items.flatMap((_, k) => {
      const t = item(c, `items.${k}`, c.t.start + 0.8 + 0.6 * k);
      return [pop(c, `#${id}-i${k}`, t), ...drawJs(c, `#${id}-i${k}`, t + 0.1)];
    })],
  };
};

// ---- logo row ----
const logoRow: B<"logo-row"> = (s, c, m) => {
  const id = c.t.id;
  const tiles = s.items.map((it, k) => {
    const p = pictureFor(it.name);
    return `<div id="${id}-i${k}" class="lr-tile"><span class="lr-pic${p.kind === "logo" ? " is-logo" : ""}"${accent(p)}>${pictureHtml(p, !c.reduced)}</span><p class="lr-name">${m.text(it.name)}</p></div>`;
  });
  return {
    html: [step(c), head(id, m, s.headline), `<div class="lr${s.headline ? "" : " tall"}">`, `<span id="${id}-rail" class="lr-rail"></span>`, ...tiles, `</div>`].join("\n"),
    js: [...headJs(id, c, s.headline), `K.draw(tl, "#${id}-rail", ${clampT(c, c.t.start + 0.4)}, 0.9);`,
      ...s.items.flatMap((_, k) => { const t = item(c, `items.${k}`, c.t.start + 0.8 + 0.5 * k); return [pop(c, `#${id}-i${k}`, t, "{ y: 40, scale: 0.9 }"), ...drawJs(c, `#${id}-i${k}`, t + 0.1)]; })],
  };
};

// ---- diagram ----
const NODE_SIZE: Record<string, { w: number; h: number }> = {
  default: { w: 300, h: 190 }, decision: { w: 220, h: 220 }, start: { w: 240, h: 116 }, end: { w: 240, h: 116 }, mesh: { w: 200, h: 200 },
};

export function diagramLayout(s: Extract<Scene, { type: "diagram" }>, hasHead: boolean): Layout {
  const area = { x: 0, y: 0, w: 1640, h: hasHead ? 540 : 660 };
  const ln: LNode[] = s.nodes.map((n) => {
    const sz = s.kind === "mesh" ? NODE_SIZE.mesh! : s.kind === "userflow" && n.kind && NODE_SIZE[n.kind] ? NODE_SIZE[n.kind]! : NODE_SIZE.default!;
    return { id: n.id, w: sz.w, h: sz.h, group: n.group };
  });
  // A labelled edge gets a straight run out of its source, so the label sits above a flat line, not across a curve.
  const edges = s.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { lead: Math.min(260, 40 + 15 * e.label.length) } : {}) }));
  return s.kind === "mesh" ? ring(ln, edges, area) : layered(ln, edges, area);
}

const diagram: B<"diagram"> = (s, c, m) => {
  const id = c.t.id;
  const L = diagramLayout(s, !!s.headline);
  const H = s.headline ? 540 : 660;
  const at = new Map(L.nodes.map((p) => [p.id, p]));
  const html: string[] = [step(c), head(id, m, s.headline), `<div class="dg dg-${s.kind}" style="height: ${H}px">`];
  L.groups.forEach((g, k) => {
    const label = s.groups?.find((x) => x.id === g.id)?.label ?? "";
    html.push(`<div id="${id}-g${k}" class="dg-group" style="left: ${n2(g.box.x)}px; top: ${n2(g.box.y)}px; width: ${n2(g.box.w)}px; height: ${n2(g.box.h)}px"><p class="dg-glabel">${m.text(label)}</p></div>`);
  });
  html.push(`<svg class="dg-edges" viewBox="0 0 1640 ${H}" width="1640" height="${H}" aria-hidden="true">`);
  L.edges.forEach((e, k) => {
    html.push(`<path id="${id}-e${k}" class="dg-e" d="${e.d}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${c.reduced ? 0 : 1}"/>`);
    html.push(`<polygon id="${id}-a${k}" class="dg-arrow" points="0,-9 16,0 0,9" transform="translate(${n2(e.end.x)} ${n2(e.end.y)}) rotate(${n2(e.end.angle)})"/>`);
  });
  html.push(`</svg>`);
  const edgeLabels = s.edges.map((e, k) => {
    const r = L.edges.find((x) => x.from === e.from && x.to === e.to);
    return r && e.label ? `<p id="${id}-l${k}" class="dg-elabel${r.label.align === "start" ? " at-start" : ""}" style="left: ${n2(r.label.x)}px; top: ${n2(r.label.y)}px">${m.text(e.label)}</p>` : "";
  });
  s.nodes.forEach((nd, k) => {
    const p = at.get(nd.id)!;
    const pic = pictureFor(nd.label, { icon: nd.icon, logo: nd.logo, kind: s.kind === "architecture" ? nd.kind : undefined });
    const shape = s.kind === "userflow" && nd.kind && ["decision", "start", "end"].includes(nd.kind) ? ` is-${nd.kind}` : "";
    const kindLabel = s.kind === "architecture" && nd.kind ? archKind(nd.kind)?.label ?? "" : s.kind === "userflow" && nd.kind === "screen" ? "Screen" : "";
    const showPic = !(s.kind === "userflow" && (nd.kind === "decision" || nd.kind === "start" || nd.kind === "end"));
    html.push(`<div id="${id}-n${k}" class="dg-node${shape}" style="left: ${n2(p.x)}px; top: ${n2(p.y)}px; width: ${n2(p.w)}px; height: ${n2(p.h)}px">`
      + (shape === " is-decision" ? `<svg class="dg-diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="50,2 98,50 50,98 2,50"/></svg>` : "")
      + (showPic ? `<span class="dg-pic${pic.kind === "logo" ? " is-logo" : ""}">${pictureHtml(pic, !c.reduced)}</span>` : "")
      + `<p class="dg-label">${m.text(nd.label)}</p>${kindLabel ? `<p class="dg-kind">${esc(kindLabel)}</p>` : ""}</div>`);
  });
  html.push(...edgeLabels.filter(Boolean), `</div>`);
  const js = [...headJs(id, c, s.headline)];
  L.groups.forEach((_, k) => js.push(`K.reveal(tl, "#${id}-g${k}", ${clampT(c, c.t.start + 0.3)}, { scale: 0.98, y: 0 }, 0.6);`));
  const times = new Map<string, number>();
  s.nodes.forEach((nd, k) => {
    const t = item(c, `nodes.${k}`, c.t.start + 0.8 + 0.7 * k);
    times.set(nd.id, t);
    js.push(pop(c, `#${id}-n${k}`, t, s.kind === "mesh" ? "{ scale: 0.6, y: 0 }" : "{ scale: 0.88, y: 0, x: -24 }"), ...drawJs(c, `#${id}-n${k}`, t + 0.1));
  });
  L.edges.forEach((e, k) => {
    const t = Math.max(times.get(e.from) ?? c.t.start, times.get(e.to) ?? c.t.start) + 0.25;
    js.push(`K.drawPath(tl, "#${id}-e${k}", ${clampT(c, t)}, 0.55);`, `K.fade(tl, "#${id}-a${k}", ${clampT(c, t + 0.45)}, 0.2);`);
  });
  s.edges.forEach((e, k) => {
    if (!e.label) return;
    const t = Math.max(times.get(e.from) ?? c.t.start, times.get(e.to) ?? c.t.start) + 0.5;
    js.push(`K.fade(tl, "#${id}-l${k}", ${clampT(c, t)}, 0.3);`);
  });
  return { html: html.join("\n"), js };
};

// ---- status glyphs (match, checklist, matrix) ----
const GLYPH: Record<CheckState, string> = {
  yes: `<path d="M5 12.5 10 17.5 19 7" pathLength="1"/>`,
  partial: `<path d="M6 12h12" pathLength="1"/>`,
  no: `<path d="M7 7 17 17M17 7 7 17" pathLength="1"/>`,
};
const STATE_CLASS: Record<CheckState, string> = { yes: "good", partial: "mid", no: "bad" };
/** A table lookup that only ever returns the table's own values (a hostile key like "constructor" gets the fallback). */
const own = <V>(t: Record<string, V>, k: unknown, fallback: V): V => (typeof k === "string" && Object.hasOwn(t, k) ? t[k]! : fallback);
const glyph = (st: CheckState, draw: boolean) => `<svg class="gl" viewBox="0 0 24 24" aria-hidden="true">${own(GLYPH, st, GLYPH.partial).replace('pathLength="1"', `pathLength="1" stroke-dasharray="1" stroke-dashoffset="${draw ? 1 : 0}"`)}</svg>`;
const MATCH_STATE: Record<MatchStatus, CheckState> = { match: "yes", partial: "partial", gap: "no" };
const MATCH_WORD: Record<MatchStatus, string> = { match: "Match", partial: "Partly", gap: "Gap" };

const match: B<"match"> = (s, c, m) => {
  const id = c.t.id;
  const rows = s.rows.map((r, k) => {
    const st = own(MATCH_STATE, r.status, "partial" as CheckState);
    const p = pictureFor(r.ask, r);
    return `<div id="${id}-r${k}" class="mt-row"><span class="mt-pic${p.kind === "logo" ? " is-logo" : ""}">${pictureHtml(p, false)}</span><p class="mt-ask">${m.text(r.ask)}</p><span class="mt-lead"></span>`
      + `<span id="${id}-c${k}" class="chip ${own(STATE_CLASS, st, "mid")}">${glyph(st, !c.reduced)}<span>${own(MATCH_WORD, r.status, "Partly")}</span></span></div>`;
  });
  const meter = s.rows.map((r, k) => `<span id="${id}-s${k}" class="mt-seg ${STATE_CLASS[own(MATCH_STATE, r.status, "partial" as CheckState)]}"></span>`).join("");
  const matched = s.rows.filter((r) => r.status === "match").length;
  return {
    html: [step(c), head(id, m, s.headline),
      `<div class="mt-head"><p class="kicker">${esc(s.left_label ?? "The role asks")}</p><p class="kicker mt-you">${esc(s.right_label ?? "You")}</p></div>`,
      `<div class="mt">`, ...rows, `</div>`,
      `<div id="${id}-meter" class="mt-meter"><span class="mt-segs">${meter}</span><p class="label">${matched} of ${s.rows.length} matched</p></div>`].join("\n"),
    js: [...headJs(id, c, s.headline), `K.fade(tl, "#${id}-meter", ${clampT(c, c.t.start + 0.5)}, 0.4);`,
      ...s.rows.flatMap((_, k) => {
        const t = item(c, `rows.${k}`, c.t.start + 0.8 + 0.8 * k);
        return [`K.reveal(tl, "#${id}-r${k}", ${clampT(c, t)}, { x: -36, y: 0 }, 0.5);`, pop(c, `#${id}-c${k}`, t + 0.35, "{ scale: 0.7, y: 0 }"),
          ...(c.reduced ? [] : [`K.drawPath(tl, "#${id}-c${k} .gl path", ${clampT(c, t + 0.45)}, 0.35);`]), `K.draw(tl, "#${id}-s${k}", ${clampT(c, t + 0.35)}, 0.3);`];
      })],
  };
};

// ---- checklist ----
const checklist: B<"checklist"> = (s, c, m) => {
  const id = c.t.id;
  return {
    html: [step(c), head(id, m, s.headline), `<div class="ck">`,
      ...s.items.map((it, k) => `<div id="${id}-i${k}" class="ck-row"><span id="${id}-b${k}" class="ck-box ${own(STATE_CLASS, it.state, "mid")}">${glyph(own(STATE_CLASS, it.state, "") ? it.state : "partial", !c.reduced)}</span><p class="ck-text">${m.text(it.text)}</p></div>`),
      `</div>`].join("\n"),
    js: [...headJs(id, c, s.headline), ...s.items.flatMap((_, k) => {
      const t = item(c, `items.${k}`, c.t.start + 0.8 + 0.7 * k);
      return [`K.reveal(tl, "#${id}-i${k}", ${clampT(c, t)}, { x: -30, y: 0 }, 0.45);`, ...(c.reduced ? [] : [`K.drawPath(tl, "#${id}-b${k} .gl path", ${clampT(c, t + 0.25)}, 0.4);`])];
    })],
  };
};

// ---- timeline ----
const timeline: B<"timeline"> = (s, c, m) => {
  const id = c.t.id, n = s.steps.length;
  const xs = s.steps.map((_, k) => (n === 1 ? 820 : 120 + (1400 * k) / (n - 1)));
  return {
    html: [step(c), head(id, m, s.headline), `<div class="tl${s.headline ? "" : " tall"}">`, `<span id="${id}-track" class="tl-track"></span>`, `<span id="${id}-fill" class="tl-fill"></span>`,
      ...s.steps.map((st, k) => {
        const p = pictureFor(st.label, st);
        return `<div id="${id}-s${k}" class="tl-step" style="left: ${n2(xs[k]! - 150)}px">${st.when ? `<p class="tl-when">${m.text(st.when)}</p>` : `<p class="tl-when">${pad2(k + 1)}</p>`}`
          + `<span class="tl-dot${p.kind === "logo" ? " is-logo" : ""}">${pictureHtml(p, !c.reduced)}</span><p class="tl-label">${m.text(st.label)}</p></div>`;
      }), `</div>`].join("\n"),
    js: [...headJs(id, c, s.headline), `tl.set("#${id}-fill", { scaleX: 0 }, 0);`, `K.draw(tl, "#${id}-track", ${clampT(c, c.t.start + 0.3)}, 0.8);`,
      ...s.steps.flatMap((_, k) => {
        const t = item(c, `steps.${k}`, c.t.start + 0.8 + 0.8 * k);
        const frac = n === 1 ? 1 : k / (n - 1);
        return [`tl.to("#${id}-fill", { scaleX: ${n2(frac)}, duration: ${c.reduced ? 0.01 : 0.5}, ease: "power3.inOut" }, ${clampT(c, t - 0.2)});`,
          pop(c, `#${id}-s${k}`, t, "{ y: 30, scale: 0.92 }"), ...drawJs(c, `#${id}-s${k}`, t + 0.1)];
      })],
  };
};

// ---- chart ----
const chart: B<"chart"> = (s, c, m) => {
  const id = c.t.id, T = c.t.start, suffix = s.suffix ?? "";
  if (s.kind === "ring") {
    const of = num(s.of ?? 100, 100) || 100, value = Math.min(of, Math.max(0, num(s.value ?? 0)));
    return {
      html: [step(c), head(id, m, s.headline), `<div class="ch-ring">`,
        `<svg class="ring" viewBox="0 0 400 400" aria-hidden="true"><circle class="ring-track" cx="200" cy="200" r="170"/><circle id="${id}-arc" class="ring-arc" cx="200" cy="200" r="170" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${c.reduced ? n2(1 - value / of) : 1}" transform="rotate(-90 200 200)"/></svg>`,
        `<p id="${id}-num" class="ring-num num">${(0).toFixed(0)}${esc(suffix)}</p>`,
        `<div class="ch-side"><p id="${id}-label" class="h2 ch-label">${m.text(s.label ?? "")}</p><p id="${id}-src" class="label">Source: ${esc(s.source)}</p></div>`, `</div>`].join("\n"),
      js: [...headJs(id, c, s.headline),
        ...(c.reduced ? [] : [`tl.fromTo("#${id}-arc", { attr: { "stroke-dashoffset": 1 } }, { attr: { "stroke-dashoffset": ${n2(1 - value / of)} }, duration: 1.4, ease: "power3.out" }, ${clampT(c, T + 0.5)});`]),
        `K.count(tl, "#${id}-num", 0, ${value}, ${clampT(c, T + 0.5)}, 1.4, { suffix: ${jsJson(suffix)} });`,
        `K.reveal(tl, "#${id}-label", ${clampT(c, T + 1.1)}, { x: 30, y: 0 });`, `K.fade(tl, "#${id}-src", ${clampT(c, T + 1.6)}, 0.4);`],
    };
  }
  const bars = s.bars ?? [];
  const max = Math.max(1, ...bars.map((b) => num(b.value)));
  return {
    html: [step(c), head(id, m, s.headline), `<div class="ch-bars">`,
      ...bars.map((b, k) => `<div id="${id}-b${k}" class="bar-row"><p class="bar-label">${m.text(b.label)}</p><span class="bar-track"><span id="${id}-f${k}" class="bar-fill" style="width: ${n2((num(b.value) / max) * 1000)}px"></span></span><p id="${id}-v${k}" class="bar-val num">${esc(String(num(b.value)))}${esc(suffix)}</p></div>`),
      `</div>`, `<p id="${id}-src" class="label foot">${s.label ? `${esc(s.label)}. ` : ""}Source: ${esc(s.source)}</p>`].join("\n"),
    js: [...headJs(id, c, s.headline), ...bars.flatMap((b, k) => {
      const t = item(c, `bars.${k}`, T + 0.8 + 0.6 * k);
      return [`K.reveal(tl, "#${id}-b${k}", ${clampT(c, t)}, { x: -20, y: 0 }, 0.4);`, `K.draw(tl, "#${id}-f${k}", ${clampT(c, t + 0.1)}, 0.8);`,
        `K.count(tl, "#${id}-v${k}", 0, ${num(b.value)}, ${clampT(c, t + 0.1)}, 0.8, { suffix: ${jsJson(suffix)} });`];
    }), `K.fade(tl, "#${id}-src", ${clampT(c, T + 1.4)}, 0.4);`],
  };
};

// ---- quote ----
const quote: B<"quote"> = (s, c, m) => {
  const id = c.t.id, T = c.t.start;
  const words = s.text.trim().split(/\s+/);
  const board = c.media?.board;
  return {
    html: [`<div class="qt">`, `<svg id="${id}-mark" class="qt-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>`,
      `<p class="qt-text">${words.map((w, k) => `<span id="${id}-w${k}" class="qt-w">${m.text(w)}</span>`).join(" ")}</p>`,
      `<div id="${id}-by" class="qt-by"><span class="qt-rule"></span><p class="label">${esc(s.by)}</p>${board ? boardChip(board) : ""}</div>`, `</div>`].join("\n"),
    js: [`K.reveal(tl, "#${id}-mark", ${clampT(c, T + 0.2)}, { scale: 0.7, y: 0 }, 0.5);`,
      `K.words(tl, "#${id} .qt-w", ${clampT(c, T + 0.5)}, ${n2(Math.min(0.12, 1.6 / Math.max(1, words.length)))});`,
      `K.reveal(tl, "#${id}-by", ${clampT(c, T + 0.9 + Math.min(1.6, 0.12 * words.length))}, { y: 14 });`],
  };
};

export function boardChip(b: NonNullable<NonNullable<BuildCtx["media"]>["board"]>): string {
  const mark = b.src ? `<img class="bd-img" src="${esc(b.src)}" alt="" />` : `<span class="bd-ini">${esc(Array.from(b.name.replace(/[^\p{L}\p{N}]/gu, "")).slice(0, 2).join("").toUpperCase())}</span>`;
  return `<span class="bd">${mark}<span class="bd-name">${esc(b.name)}</span></span>`;
}

// ---- company card ----
const companyCard: B<"company-card"> = (s, c, m) => {
  const id = c.t.id, T = c.t.start;
  const logo = c.media?.logo;
  const pic = logo ? `<img id="${id}-img" class="cc-img" src="${esc(logo.src)}" alt="" />` : `<span class="cc-ini">${esc(pictureFor(s.name).kind === "initials" ? (pictureFor(s.name) as { text: string }).text : s.name.slice(0, 2).toUpperCase())}</span>`;
  const chip = (icon: string, text: string, k: string) => `<span id="${id}-${k}" class="cc-chip">${pictureHtml(pictureFor("", { icon }), false)}<span>${m.text(text)}</span></span>`;
  return {
    html: [`<div class="cc">`, `<div id="${id}-tile" class="cc-tile">${pic}</div>`, `<div class="cc-body">`,
      `<p id="${id}-name" class="hero cc-name">${m.text(s.name)}</p>`,
      `<div class="cc-chips">${s.location ? chip("map-pin", s.location, "loc") : ""}${s.size ? chip("users", s.size, "size") : ""}</div>`,
      s.detail ? `<p id="${id}-detail" class="lede">${m.text(s.detail)}</p>` : "", c.media?.board ? `<div id="${id}-bd">${boardChip(c.media.board)}</div>` : "", `</div>`, `</div>`].filter(Boolean).join("\n"),
    js: [`K.reveal(tl, "#${id}-tile", ${clampT(c, T + 0.2)}, { scale: 0.9, y: 0 }, 0.7);`,
      ...(logo ? [`K.kenBurns(tl, "#${id}-img", ${n2(c.t.start)}, ${n2(c.t.end)});`] : []),
      `K.reveal(tl, "#${id}-name", ${clampT(c, T + 0.45)}, { x: 40, y: 0 }, 0.6);`,
      ...(s.location ? [pop(c, `#${id}-loc`, T + 0.9, "{ y: 16, scale: 0.95 }")] : []), ...(s.size ? [pop(c, `#${id}-size`, T + 1.05, "{ y: 16, scale: 0.95 }")] : []),
      ...(s.detail ? [`K.reveal(tl, "#${id}-detail", ${clampT(c, T + 1.4)}, { y: 16 });`] : []), ...(c.media?.board ? [`K.fade(tl, "#${id}-bd", ${clampT(c, T + 1.7)}, 0.4);`] : [])],
  };
};

// ---- map pin ----
const mapPin: B<"map-pin"> = (s, c, m) => {
  const id = c.t.id, T = c.t.start;
  const place = findPlace(s.city, s.region);
  let map: string;
  let pin: { x: number; y: number };
  if (place) {
    const dots = auDots();
    pin = project(place.lon, place.lat);
    map = `<svg id="${id}-map" class="mp-map" viewBox="0 0 ${MAP_BOX.w} ${MAP_BOX.h}" aria-hidden="true"><path class="mp-shape" d="${outlinePath()}"/>${dots}</svg>`;
  } else {
    pin = { x: MAP_BOX.w / 2, y: MAP_BOX.h / 2 };
    const r = 330, cx = MAP_BOX.w / 2, cy = MAP_BOX.h / 2;
    const lines = [0.35, 0.7].map((k) => `<ellipse cx="${cx}" cy="${cy}" rx="${n2(r * k)}" ry="${r}"/><ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${n2(r * k)}"/>`).join("");
    map = `<svg id="${id}-map" class="mp-map mp-globe" viewBox="0 0 ${MAP_BOX.w} ${MAP_BOX.h}" aria-hidden="true"><circle cx="${cx}" cy="${cy}" r="${r}"/>${lines}<line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}"/><line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}"/></svg>`;
  }
  const px = n2(pin.x), py = n2(pin.y);
  return {
    html: [`<div class="mp">`, `<div class="mp-stage">`, map,
      `<span id="${id}-ring0" class="mp-ring" style="left: ${px}px; top: ${py}px"></span>`, `<span id="${id}-ring1" class="mp-ring" style="left: ${px}px; top: ${py}px"></span>`,
      `<span id="${id}-pin" class="mp-pin" style="left: ${px}px; top: ${py}px">${pictureHtml(pictureFor("", { icon: "map-pin" }), false)}</span>`, `</div>`,
      `<div class="mp-card"><p id="${id}-region" class="kicker">${esc(s.region ?? place?.region ?? "")}</p><p id="${id}-city" class="hero mp-city">${m.text(s.city)}</p>${s.label ? `<p id="${id}-label" class="lede">${m.text(s.label)}</p>` : ""}</div>`, `</div>`].join("\n"),
    js: [`K.fade(tl, "#${id}-map", ${clampT(c, T + 0.15)}, 0.8);`, ...(c.reduced ? [] : [`tl.fromTo("#${id}-map", { scale: 1.04 }, { scale: 1, duration: ${n2(Math.max(1, c.t.end - T))}, ease: "none" }, ${n2(T)});`]),
      `K.reveal(tl, "#${id}-pin", ${clampT(c, T + 0.7)}, { y: -70, scale: 1 }, 0.6);`,
      ...(c.reduced ? [] : [0, 1].map((k) => `tl.fromTo("#${id}-ring${k}", { opacity: 0.7, scale: 0.3 }, { opacity: 0, scale: 2.4, duration: 1.2, ease: "power2.out" }, ${clampT(c, T + 1.2 + 0.5 * k)});`)),
      `K.reveal(tl, "#${id}-city", ${clampT(c, T + 0.9)}, { x: 40, y: 0 }, 0.6);`, `K.fade(tl, "#${id}-region", ${clampT(c, T + 1.1)}, 0.4);`,
      ...(s.label ? [`K.reveal(tl, "#${id}-label", ${clampT(c, T + 1.4)}, { y: 16 });`] : [])],
  };
};

let dotsCache = "";
function auDots(): string {
  if (dotsCache) return dotsCache;
  const poly = [AU_OUTLINE, AU_TAS].map((ring) => ring.map(([lon, lat]) => project(lon, lat)));
  const inside = (x: number, y: number) => poly.some((pts) => {
    let ins = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!, b = pts[j]!;
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
    }
    return ins;
  });
  const out: string[] = [];
  for (let y = 11; y < MAP_BOX.h; y += 22) for (let x = 11; x < MAP_BOX.w; x += 22) if (inside(x, y)) out.push(`<circle cx="${x}" cy="${y}" r="5"/>`);
  dotsCache = `<g class="mp-dots">${out.join("")}</g>`;
  return dotsCache;
}
function outlinePath(): string {
  return [AU_OUTLINE, AU_TAS].map((ring) => `M ${ring.map(([lon, lat]) => { const p = project(lon, lat); return `${n2(p.x)} ${n2(p.y)}`; }).join(" L ")} Z`).join(" ");
}

// ---- kinetic captions ----
const kinetic: B<"kinetic"> = (s, c, m) => {
  const id = c.t.id;
  const em = s.emphasis?.trim();
  const html = s.lines.map((l, k) => {
    const words = l.text.trim().split(/\s+/);
    const body = words.map((w, j) => {
      const hot = !!em && em.split(/\s+/).includes(w.replace(/[^\p{L}\p{N}'-]/gu, ""));
      return `<span class="kn-w${hot ? " hot" : ""}">${m.text(w)}${hot ? `<i class="kn-ink"></i>` : ""}</span>`;
    }).join(" ");
    return `<p id="${id}-l${k}" class="kn-line">${body}</p>`;
  });
  return {
    html: [`<div class="kn">`, ...html, `</div>`].join("\n"),
    js: s.lines.flatMap((_, k) => {
      const t = item(c, `lines.${k}`, c.t.start + 0.3 + 1.2 * k);
      return [`K.words(tl, "#${id}-l${k} .kn-w", ${clampT(c, t)}, 0.07);`, `K.draw(tl, "#${id}-l${k} .kn-ink", ${clampT(c, t + 0.5)}, 0.4);`];
    }),
  };
};

// ---- matrix ----
const matrix: B<"matrix"> = (s, c, m) => {
  const id = c.t.id;
  return {
    html: [step(c), head(id, m, s.headline), `<div class="mx" style="--cols: ${s.cols.length}">`, `<span></span>`,
      ...s.cols.map((col, k) => `<p id="${id}-h${k}" class="kicker mx-col">${m.text(col)}</p>`),
      ...s.rows.flatMap((r, k) => [`<p id="${id}-r${k}" class="mx-row">${m.text(r.label)}</p>`,
        ...s.cols.map((_, j) => { const st = r.cells[j] ?? "partial"; return `<span id="${id}-c${k}-j${j}" class="mx-cell ${own(STATE_CLASS, st, "mid")}">${glyph(st, false)}</span>`; })]),
      `</div>`].join("\n"),
    js: [...headJs(id, c, s.headline), ...s.cols.map((_, k) => `K.fade(tl, "#${id}-h${k}", ${clampT(c, c.t.start + 0.4 + 0.08 * k)}, 0.3);`),
      ...s.rows.flatMap((_, k) => {
        const t = item(c, `rows.${k}`, c.t.start + 0.8 + 0.8 * k);
        return [`K.reveal(tl, "#${id}-r${k}", ${clampT(c, t)}, { x: -24, y: 0 }, 0.4);`, ...s.cols.map((_, j) => pop(c, `#${id}-c${k}-j${j}`, t + 0.15 + 0.08 * j, "{ scale: 0.5, y: 0 }"))];
      })],
  };
};

export const VISUAL_BUILDERS = {
  "icon-grid": iconGrid, "logo-row": logoRow, diagram, match, checklist, timeline, chart, quote, "company-card": companyCard, "map-pin": mapPin, kinetic, matrix,
} satisfies { [K in VisualSceneType]: B<K> };

export const VISUAL_STAGE_CLASS: Partial<Record<VisualSceneType, string>> = { quote: " center", kinetic: " center", "company-card": " center", "map-pin": " center" };

/** Styles for the visual scenes. Colours are theme.css values; sizes follow the video type ramp (nothing under 24px). */
export const VISUAL_CSS = `
.tall { margin-top: 90px; }
.title-row { display: flex; align-items: center; gap: 80px; }
.title-text { flex: 1; min-width: 0; }
.title-row .hero { font-size: 100px; }
.title-logo { width: 380px; height: 380px; border-radius: 44px; overflow: hidden; background: #eef1f3; flex: none; }
.title-logo .cc-img { width: 380px; height: 380px; }
.title-board { margin-top: 40px; }
.ic, .lg { display: block; width: 100%; height: 100%; }
.ini { font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 52px; color: #f2b441; letter-spacing: 0.04em; }
.vg { margin-top: 64px; display: grid; grid-template-columns: repeat(var(--cols), 1fr); gap: 40px 44px; width: 1640px; }
.vg-tile { display: flex; flex-direction: column; align-items: center; gap: 22px; padding: 34px 20px 30px; background: #181e24; border: 2px solid #2c353f; border-radius: 26px; }
.vg-pic, .lr-pic { display: flex; align-items: center; justify-content: center; width: 132px; height: 132px; padding: 28px; border-radius: 30px; background: #202830; color: #f2b441; border-bottom: 6px solid var(--brand, #2c353f); }
.vg-pic.is-logo, .lr-pic.is-logo, .dg-pic.is-logo, .mt-pic.is-logo, .tl-dot.is-logo { color: #eef1f3; }
.vg-label { font-weight: 700; font-size: 38px; line-height: 1.15; text-align: center; }
.lr { position: relative; margin: auto 0; display: flex; justify-content: center; gap: 48px; width: 1640px; }
.lr-rail { position: absolute; left: 0; right: 0; top: 110px; height: 4px; background: #2c353f; transform-origin: left center; }
.lr-tile { position: relative; display: flex; flex-direction: column; align-items: center; gap: 26px; width: 230px; }
.lr-pic { width: 220px; height: 220px; padding: 52px; border: 2px solid #2c353f; border-bottom: 8px solid var(--brand, #2c353f); background: #181e24; }
.lr-name { font-weight: 700; font-size: 36px; text-align: center; }
.dg { position: relative; margin-top: 40px; width: 1640px; }
.dg-edges { position: absolute; left: 0; top: 0; overflow: visible; }
.dg-e { fill: none; stroke: #6b7885; stroke-width: 4; stroke-linecap: round; }
.dg-arrow { fill: #6b7885; opacity: 0; }
.dg-elabel { position: absolute; transform: translate(-50%, -50%); }
.dg-elabel.at-start { transform: translate(0, -50%); }
.dg-elabel { font-family: "JetBrains Mono", monospace; font-size: 24px; color: #a3adb7; background: #0f1317; padding: 4px 12px; border-radius: 10px; opacity: 0; white-space: nowrap; }
.dg-group { position: absolute; border: 3px dashed #3a4550; border-radius: 26px; background: rgba(24, 30, 36, 0.45); }
.dg-glabel { position: absolute; left: 22px; top: 8px; font-family: "JetBrains Mono", monospace; font-size: 24px; color: #a3adb7; letter-spacing: 0.08em; text-transform: uppercase; }
.dg-node { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: #181e24; border: 2px solid #3a4550; border-radius: 22px; padding: 14px; text-align: center; }
.dg-mesh .dg-node { border-radius: 50%; }
.dg-node.is-decision { background: none; border: none; }
.dg-node.is-start, .dg-node.is-end { border-radius: 60px; border-color: #f2b441; }
.dg-diamond { position: absolute; inset: 0; width: 100%; height: 100%; }
.dg-diamond polygon { fill: #181e24; stroke: #f2b441; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.dg-pic { position: relative; display: block; width: 72px; height: 72px; color: #f2b441; }
.dg-label { position: relative; font-weight: 700; font-size: 34px; line-height: 1.1; }
.dg-kind { position: relative; font-family: "JetBrains Mono", monospace; font-size: 24px; color: #a3adb7; }
.mt-head { margin-top: 52px; display: flex; justify-content: space-between; width: 1640px; padding: 0 8px; }
.mt { margin-top: 18px; display: flex; flex-direction: column; gap: 18px; width: 1640px; }
.mt-row { display: flex; align-items: center; gap: 28px; padding: 18px 28px; background: #181e24; border: 2px solid #2c353f; border-radius: 22px; }
.mt-pic { display: block; width: 52px; height: 52px; color: #f2b441; flex: none; }
.mt-ask { font-weight: 700; font-size: 42px; }
.mt-lead { flex: 1; height: 0; border-bottom: 3px dotted #3a4550; }
.chip { display: flex; align-items: center; gap: 12px; padding: 10px 24px 10px 16px; border-radius: 999px; font-weight: 700; font-size: 32px; border: 2px solid currentColor; }
.chip .gl { width: 36px; height: 36px; }
.gl { display: block; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.good { color: #6cc49a; } .mid { color: #f2b441; } .bad { color: #ec7a6c; }
.chip.good { background: rgba(108, 196, 154, 0.12); } .chip.mid { background: rgba(242, 180, 65, 0.12); } .chip.bad { background: rgba(236, 122, 108, 0.12); }
.mt-meter { margin-top: 26px; display: flex; align-items: center; gap: 24px; opacity: 0; }
.mt-segs { display: flex; gap: 8px; }
.mt-seg { display: block; width: 90px; height: 12px; border-radius: 6px; background: currentColor; transform-origin: left center; }
.ck { margin: auto 0; display: flex; flex-direction: column; gap: 30px; }
.ck-row { display: flex; align-items: center; gap: 34px; }
.ck-box { display: flex; align-items: center; justify-content: center; width: 84px; height: 84px; border: 3px solid currentColor; border-radius: 20px; padding: 12px; }
.ck-box .gl { width: 54px; height: 54px; }
.ck-text { font-weight: 700; font-size: 52px; letter-spacing: -0.02em; }
.tl { position: relative; margin-top: 80px; width: 1640px; height: 440px; }
.tl.tall { margin-top: 150px; }
.tl-track, .tl-fill { position: absolute; left: 120px; width: 1400px; top: 152px; height: 6px; border-radius: 3px; transform-origin: left center; }
.tl-track { background: #2c353f; }
.tl-fill { background: #f2b441; }
.tl-step { position: absolute; top: 0; width: 300px; display: flex; flex-direction: column; align-items: center; gap: 18px; text-align: center; }
.tl-when { font-family: "Montserrat", sans-serif; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 26px; color: #a3adb7; height: 40px; }
.tl-dot { display: block; width: 104px; height: 104px; padding: 24px; border-radius: 50%; background: #181e24; border: 4px solid #f2b441; color: #f2b441; }
.tl-label { font-weight: 700; font-size: 38px; line-height: 1.15; }
.ch-ring { margin-top: 40px; position: relative; display: flex; align-items: center; gap: 90px; }
.ring { width: 520px; height: 520px; }
.ring-track { fill: none; stroke: #202830; stroke-width: 36; }
.ring-arc { fill: none; stroke: #f2b441; stroke-width: 36; stroke-linecap: round; }
.ring-num { position: absolute; left: 0; top: 0; width: 520px; height: 520px; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 120px; letter-spacing: -0.04em; }
.ch-side { display: flex; flex-direction: column; gap: 28px; max-width: 900px; }
.ch-bars { margin-top: 64px; display: flex; flex-direction: column; gap: 34px; }
.bar-row { display: flex; align-items: center; gap: 32px; }
.bar-label { width: 360px; font-weight: 700; font-size: 38px; text-align: right; }
.bar-track { display: block; width: 1000px; height: 56px; }
.bar-fill { display: block; height: 56px; border-radius: 12px; background: #f2b441; transform-origin: left center; }
.bar-val { font-weight: 900; font-size: 44px; }
.qt { display: flex; flex-direction: column; gap: 40px; max-width: 1500px; }
.qt-mark { width: 150px; height: 150px; fill: #f2b441; }
.qt-text { font-weight: 700; font-size: 92px; line-height: 1.12; letter-spacing: -0.035em; }
.qt-w { display: inline-block; opacity: 0; }
.qt-by { display: flex; align-items: center; gap: 24px; }
.qt-rule { display: block; width: 80px; height: 4px; background: #f2b441; }
.bd { display: inline-flex; align-items: center; gap: 14px; padding: 8px 20px 8px 8px; background: #181e24; border: 2px solid #2c353f; border-radius: 999px; }
.bd-img { display: block; width: 44px; height: 44px; border-radius: 10px; }
.bd-ini { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 10px; background: #202830; font-family: "JetBrains Mono", monospace; font-size: 24px; color: #f2b441; }
.bd-name { font-family: "JetBrains Mono", monospace; font-size: 24px; color: #a3adb7; }
.cc { display: flex; align-items: center; gap: 90px; }
.cc-tile { display: flex; align-items: center; justify-content: center; width: 420px; height: 420px; border-radius: 48px; overflow: hidden; background: #eef1f3; flex: none; }
.cc-img { display: block; width: 420px; height: 420px; object-fit: contain; }
.cc-ini { font-weight: 900; font-size: 160px; color: #0f1317; letter-spacing: -0.04em; }
.cc-body { display: flex; flex-direction: column; gap: 32px; max-width: 1050px; }
.cc-name { font-size: 104px; }
.cc-chips { display: flex; gap: 20px; }
.cc-chip { display: flex; align-items: center; gap: 14px; padding: 12px 26px 12px 18px; border-radius: 999px; background: #181e24; border: 2px solid #2c353f; font-weight: 700; font-size: 34px; }
.cc-chip .ic { width: 38px; height: 38px; color: #f2b441; }
.mp { display: flex; align-items: center; gap: 80px; }
.mp-stage { position: relative; width: ${MAP_BOX.w}px; height: ${MAP_BOX.h}px; flex: none; }
.mp-map { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; }
.mp-shape { fill: rgba(32, 40, 48, 0.55); stroke: #3a4550; stroke-width: 3; }
.mp-dots circle { fill: #3a4550; }
.mp-globe circle, .mp-globe ellipse, .mp-globe line { fill: none; stroke: #3a4550; stroke-width: 3; }
.mp-pin { position: absolute; display: block; width: 96px; height: 96px; margin: -92px 0 0 -48px; color: #f2b441; }
.mp-pin .ic { stroke-width: 2.2; fill: rgba(242, 180, 65, 0.18); }
.mp-ring { position: absolute; display: block; width: 120px; height: 120px; margin: -60px 0 0 -60px; border: 4px solid #f2b441; border-radius: 50%; opacity: 0; }
.mp-card { display: flex; flex-direction: column; gap: 24px; max-width: 760px; }
.mp-city { font-size: 112px; }
.kn { display: flex; flex-direction: column; align-items: center; gap: 18px; width: 1640px; text-align: center; }
.kn-line { font-weight: 900; font-size: 124px; line-height: 1.05; letter-spacing: -0.04em; }
.kn-w { position: relative; display: inline-block; opacity: 0; }
.kn-w.hot { color: #f2b441; }
.kn-ink { position: absolute; left: 0; right: 0; bottom: -4px; height: 10px; border-radius: 5px; background: #f2b441; transform-origin: left center; }
.mx { margin-top: 56px; display: grid; grid-template-columns: 520px repeat(var(--cols), 1fr); gap: 22px 18px; width: 1640px; align-items: center; }
.mx-col { text-align: center; opacity: 0; }
.mx-row { font-weight: 700; font-size: 40px; }
.mx-cell { justify-self: center; display: flex; align-items: center; justify-content: center; width: 86px; height: 86px; border-radius: 22px; border: 3px solid currentColor; padding: 14px; }
.mx-cell .gl { width: 52px; height: 52px; }
`;
