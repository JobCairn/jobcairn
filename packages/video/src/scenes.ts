import { diffLines, highlightLine, typeLine } from "./code.js";
import { esc, jsJson, n2, pad2, trimTrailingNewlines } from "./html.js";
import { clampDur, clampNum, clampT, head, headJs, item, MarkSet, num, step, type BuildCtx, type Builder, type SceneOut } from "./scene-kit.js";
import type { Scene, SceneType } from "./types.js";
import { boardChip, VISUAL_BUILDERS, VISUAL_STAGE_CLASS } from "./visuals.js";
export type { BuildCtx, MediaRefs, SceneOut } from "./scene-kit.js";

/** Splits code into display lines: tabs become two spaces, trailing newlines are dropped (via
 * `trimTrailingNewlines`, not a `/\n+$/` regex replace - see that function's comment for why). */
export const codeLines = (code: string) => trimTrailingNewlines(code.replace(/\t/g, "  ")).split("\n");

const title: Builder<Extract<Scene, { type: "title" }>> = (s, c, m) => {
  const id = c.t.id;
  const hasUnderline = !!s.underline && s.title.includes(s.underline);
  let titleHtml: string;
  if (hasUnderline) {
    // Marks are looked for in the text *around* the underlined substring, not across the whole
    // title first-and-discarded: that used to both throw away any mark span inside the title and
    // (worse) leave the mark's `used` flag set from the discarded call, so its selector would
    // never exist in the DOM yet the script still tried to animate it. A mark whose target
    // actually overlaps the underlined substring itself still isn't found by either half, which
    // correctly reports as "not in the on-screen text" via `warnings()`, same as any other miss.
    const at = s.title.indexOf(s.underline!);
    const before = s.title.slice(0, at), after = s.title.slice(at + s.underline!.length);
    titleHtml = `${m.text(before)}<span id="${id}-ul" class="mk mk-underline">${esc(s.underline!)}<i class="mk-ink"></i></span>${m.text(after)}`;
  } else {
    titleHtml = m.text(s.title);
  }
  const T = c.t.start;
  const logo = c.media?.logo, board = c.media?.board;
  const text = [
    `<p id="${id}-kicker" class="kicker">${m.text(s.kicker)}</p>`, `<span id="${id}-rule" class="rule"></span>`,
    `<h1 id="${id}-title" class="hero">${titleHtml}</h1>`, s.subtitle ? `<p id="${id}-sub" class="lede sub">${m.text(s.subtitle)}</p>` : "",
    board ? `<div id="${id}-board" class="title-board">${boardChip(board)}</div>` : "",
  ].filter(Boolean).join("\n");
  return {
    html: logo
      ? [`<div class="title-row">`, `<div class="title-text">`, text, `</div>`, `<div id="${id}-logo" class="title-logo"><img id="${id}-img" class="cc-img" src="${esc(logo.src)}" alt="" /></div>`, `</div>`].join("\n")
      : text,
    js: [
      ...(logo ? [`K.reveal(tl, "#${id}-logo", ${clampT(c, T + 0.6)}, { scale: 0.9, y: 0 }, 0.8);`, `K.kenBurns(tl, "#${id}-img", ${n2(c.t.start)}, ${n2(c.t.end)});`] : []),
      ...(board ? [`K.fade(tl, "#${id}-board", ${clampT(c, T + 1.9)}, 0.4);`] : []),
      `K.reveal(tl, "#${id}-kicker", ${clampT(c, T + 0.2)}, { y: 0, x: -30 }, 0.5);`, `K.draw(tl, "#${id}-rule", ${clampT(c, T + 0.35)}, 0.6);`,
      `K.reveal(tl, "#${id}-title", ${clampT(c, T + 0.45)}, { y: 44 }, 0.8);`,
      ...(s.subtitle ? [`K.reveal(tl, "#${id}-sub", ${clampT(c, T + 1.6)}, { y: 20 });`] : []),
      ...(hasUnderline ? [`K.draw(tl, "#${id}-ul .mk-ink", ${clampT(c, T + 1.3)}, 0.5);`] : []),
    ],
  };
};

const bullets: Builder<Extract<Scene, { type: "bullet-build" }>> = (s, c, m) => {
  const id = c.t.id;
  return {
    html: [step(c), head(id, m, s.headline), `<div class="bullets">`,
      ...s.items.map((it, k) => `<div id="${id}-i${k}" class="bullet"><span class="label">${s.numbered === false ? "&#9679;" : pad2(k + 1)}</span><p class="body">${m.text(it.text)}</p></div>`),
      `</div>`].join("\n"),
    js: [...headJs(id, c, s.headline), ...s.items.map((_, k) => `K.reveal(tl, "#${id}-i${k}", ${clampT(c, item(c, `items.${k}`, c.t.start + 1 + k))}, { x: -40, y: 0 });`)],
  };
};

const recap: Builder<Extract<Scene, { type: "recap-card" }>> = (s, c, m) => {
  const id = c.t.id;
  const lastItem = item(c, `items.${s.items.length - 1}`, c.t.start + 3);
  return {
    html: [step(c), head(id, m, s.headline), `<div class="trio">`,
      ...s.items.map((it, k) => `<div id="${id}-c${k}" class="card"><p class="kicker">${pad2(k + 1)}</p><p class="body">${m.text(it.text)}</p></div>`),
      `</div>`, `<p id="${id}-close" class="lede close">${m.text(s.closing)}</p>`].join("\n"),
    js: [...headJs(id, c, s.headline),
      ...s.items.map((_, k) => `K.reveal(tl, "#${id}-c${k}", ${clampT(c, item(c, `items.${k}`, c.t.start + 1 + k))}, { y: 36 });`),
      `K.reveal(tl, "#${id}-close", ${clampT(c, Math.min(lastItem + 2.4, c.t.end - 1.2))}, { y: 16 });`],
  };
};

const comparison: Builder<Extract<Scene, { type: "comparison" }>> = (s, c, m) => {
  const id = c.t.id;
  const col = (side: "l" | "r", o: { label: string; items: string[] }, extra: string) =>
    `<div id="${id}-${side}" class="col card${extra}"><p class="kicker">${m.text(o.label)}</p>${o.items.map((x) => `<p class="body">${m.text(x)}</p>`).join("")}</div>`;
  const tr = item(c, "cue_right", c.t.start + 3);
  return {
    html: [step(c), head(id, m, s.headline), `<div class="cols">`, col("l", s.left, ""), col("r", s.right, " good"), `</div>`,
      s.verdict ? `<p id="${id}-v" class="lede verdict">${m.text(s.verdict)}</p>` : ""].filter(Boolean).join("\n"),
    js: [...headJs(id, c, s.headline),
      `K.reveal(tl, "#${id}-l", ${clampT(c, item(c, "cue_left", c.t.start + 1))}, { x: -40, y: 0 });`,
      `K.reveal(tl, "#${id}-r", ${clampT(c, tr)}, { x: 40, y: 0 });`,
      ...(s.verdict ? [`K.reveal(tl, "#${id}-v", ${clampT(c, tr + 2)}, { y: 16 });`] : [])],
  };
};

const stat: Builder<Extract<Scene, { type: "stat" }>> = (s, c, m) => {
  const id = c.t.id, T = c.t.start;
  const d = Math.min(2, Math.max(0, Math.round(num(s.decimals ?? 0))));
  const value = num(s.value);
  return {
    html: [step(c), `<p id="${id}-num" class="big num accent">${esc(s.prefix ?? "")}${(0).toFixed(d)}${esc(s.suffix ?? "")}</p>`,
      `<p id="${id}-label" class="lede">${m.text(s.label)}</p>`, `<p id="${id}-src" class="label foot">Source: ${esc(s.source)}</p>`].join("\n"),
    js: [`K.reveal(tl, "#${id}-num", ${clampT(c, T + 0.4)}, { scale: 0.9, y: 0 }, 0.5);`,
      `K.count(tl, "#${id}-num", 0, ${value}, ${clampT(c, T + 0.5)}, 1.4, { prefix: ${jsJson(s.prefix ?? "")}, suffix: ${jsJson(s.suffix ?? "")}, decimals: ${d} });`,
      `K.reveal(tl, "#${id}-label", ${clampT(c, T + 1.2)}, { y: 20 });`, `K.reveal(tl, "#${id}-src", ${clampT(c, T + 1.8)}, { y: 12 });`],
  };
};

const KIND_LABEL = { behavioural: "Behavioural question", technical: "Technical question", "system-design": "System design question" } as const;

const quiz: Builder<Extract<Scene, { type: "quiz" }>> = (s, c, m) => {
  const id = c.t.id, T = c.t.start, think = c.t.think;
  const tA = Math.max(T + 0.6, item(c, "beats.0", T + 3) - 0.6);
  const tR = Math.max(tA + 1, item(c, "cue_review", tA + 4));
  const thinkSeconds = Math.max(0, Math.round(num(s.think_seconds)));
  // The measured silence (`think.end - think.start`) comes from the timeline, which can span
  // longer than this scene ended up being once its neighbours squeezed it - the fill bar's tween
  // must never be asked to run past `end`, however long the silence was.
  const thinkDur = think ? clampDur(Math.min(think.end - think.start, c.t.end - clampNum(c, think.start))) : 0;
  return {
    html: [
      `<div id="${id}-q" class="pane center">`, `<p id="${id}-qk" class="kicker">${esc(KIND_LABEL[s.kind])}</p>`, `<p id="${id}-qt" class="q">${m.text(s.question)}</p>`,
      think ? `<div id="${id}-timer" class="timer"><p class="label">Answer out loud. ${thinkSeconds} seconds.</p><span class="track"><span id="${id}-fill" class="fill"></span></span></div>` : "",
      `</div>`,
      `<div id="${id}-a" class="pane later">`, `<p class="step">A strong answer</p>`, `<div class="beats">`,
      ...s.beats.map((b, k) => `<div id="${id}-b${k}" class="beat card"><p class="kicker">${esc(b.label)}</p><p class="body">${m.text(b.text)}</p></div>`),
      `</div>`, `</div>`,
      `<div id="${id}-r" class="pane later">`, `<p class="step">What they listen for</p>`, `<div class="cols">`,
      `<div id="${id}-good" class="col good card"><p class="kicker">Lands well</p>${s.strong.map((x) => `<p class="body">${m.text(x)}</p>`).join("")}</div>`,
      `<div id="${id}-bad" class="col bad card"><p class="kicker">Falls flat</p>${s.weak.map((x) => `<p class="body">${m.text(x)}</p>`).join("")}</div>`,
      `</div>`, `<p id="${id}-turn" class="turn">${m.text(s.prompt)}</p>`, `</div>`,
    ].filter(Boolean).join("\n"),
    js: [
      `K.reveal(tl, "#${id}-qk", ${clampT(c, T + 0.2)}, { y: 0, x: -30 }, 0.5);`, `K.reveal(tl, "#${id}-qt", ${clampT(c, T + 0.4)}, { y: 30 }, 0.7);`,
      ...(think ? [`K.reveal(tl, "#${id}-timer", ${clampT(c, think.start)}, { y: 16 }, 0.4);`,
        `tl.fromTo("#${id}-fill", { scaleX: 0 }, { scaleX: 1, duration: ${n2(thinkDur)}, ease: "none" }, ${clampT(c, think.start)});`] : []),
      `tl.to("#${id}-q", { opacity: 0, y: -24, duration: 0.35, ease: "power2.in" }, ${clampT(c, tA - 0.35)});`,
      `tl.fromTo("#${id}-a", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, ${clampT(c, tA)});`,
      ...s.beats.map((_, k) => `K.reveal(tl, "#${id}-b${k}", ${clampT(c, item(c, `beats.${k}`, tA + 0.5 + k))}, { y: 30 });`),
      `tl.to("#${id}-a", { opacity: 0, y: -24, duration: 0.35, ease: "power2.in" }, ${clampT(c, tR - 0.35)});`,
      `tl.fromTo("#${id}-r", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, ${clampT(c, tR)});`,
      `K.reveal(tl, "#${id}-good", ${clampT(c, tR + 0.2)}, { x: -30, y: 0 });`, `K.reveal(tl, "#${id}-bad", ${clampT(c, tR + 0.5)}, { x: 30, y: 0 });`,
      `K.reveal(tl, "#${id}-turn", ${clampT(c, tR + 2)}, { y: 16 });`,
    ],
  };
};

const flowchart: Builder<Extract<Scene, { type: "flowchart" }>> = (s, c, m) => {
  const id = c.t.id, tb = s.direction === "tb";
  const linked = (k: number) => s.edges.find((e) => (e[0] === s.nodes[k]!.id && e[1] === s.nodes[k + 1]!.id) || (e[1] === s.nodes[k]!.id && e[0] === s.nodes[k + 1]!.id));
  const parts: string[] = [];
  s.nodes.forEach((nd, k) => {
    if (k > 0) {
      const e = linked(k - 1);
      parts.push(e ? `<div class="edge-wrap"><span id="${id}-e${k - 1}" class="edge"></span>${e[2] ? `<p class="label edge-label">${m.text(e[2])}</p>` : ""}</div>` : `<div class="edge-wrap"></div>`);
    }
    parts.push(`<div id="${id}-n${k}" class="card node"><p class="label">${pad2(k + 1)}</p><p class="h">${m.text(nd.label)}</p>${nd.sub ? `<p class="body">${m.text(nd.sub)}</p>` : ""}</div>`);
  });
  const js = [...headJs(id, c, s.headline)];
  s.nodes.forEach((_, k) => {
    const t = item(c, `nodes.${k}`, c.t.start + 1 + k);
    if (k > 0 && linked(k - 1)) {
      js.push(tb
        ? `tl.fromTo("#${id}-e${k - 1}", { scaleY: 0 }, { scaleY: 1, duration: 0.4, ease: "power3.inOut" }, ${clampT(c, t - 0.3)});`
        : `K.draw(tl, "#${id}-e${k - 1}", ${clampT(c, t - 0.3)}, 0.4);`);
    }
    js.push(`K.reveal(tl, "#${id}-n${k}", ${clampT(c, t)}, ${k === 0 ? "{ scale: 0.92, y: 0 }" : tb ? "{ y: -30, x: 0 }" : "{ x: -30, y: 0 }"});`);
  });
  return { html: [step(c), head(id, m, s.headline), `<div class="flow${tb ? " tb" : ""}">`, ...parts, `</div>`].join("\n"), js };
};

const sequence: Builder<Extract<Scene, { type: "sequence" }>> = (s, c, m) => {
  const id = c.t.id, n = s.actors.length;
  return {
    html: [step(c), head(id, m, s.headline), `<div class="seq" style="--cols: ${n}">`,
      ...s.actors.map((a, k) => `<div id="${id}-a${k}" class="actor card" style="grid-row: 1; grid-column: ${k + 1}"><p class="h">${esc(a)}</p></div>`),
      ...s.messages.map((msg, k) => {
        const a = s.actors.indexOf(msg.from), b = s.actors.indexOf(msg.to);
        return `<div id="${id}-m${k}" class="msg${a > b ? " rev" : ""}" style="grid-row: ${k + 2}; grid-column: ${Math.min(a, b) + 1} / ${Math.max(a, b) + 2}"><p class="label">${m.text(msg.label)}</p><span id="${id}-ar${k}" class="arrow"></span></div>`;
      }),
      `</div>`].join("\n"),
    js: [...headJs(id, c, s.headline),
      ...s.actors.map((_, k) => `K.reveal(tl, "#${id}-a${k}", ${clampT(c, c.t.start + 0.4 + 0.15 * k)}, { y: 20 }, 0.5);`),
      ...s.messages.flatMap((_, k) => {
        const t = item(c, `messages.${k}`, c.t.start + 1.5 + k);
        return [`K.reveal(tl, "#${id}-m${k}", ${clampT(c, t)}, { y: 12 }, 0.4);`, `K.draw(tl, "#${id}-ar${k}", ${clampT(c, t + 0.05)}, 0.45);`];
      })],
  };
};

const codeTyping: Builder<Extract<Scene, { type: "code-typing" }>> = (s, c, m) => {
  const id = c.t.id, lines = codeLines(s.code);
  const chars = lines.reduce((a, l) => a + [...l].length, 0);
  const denom = Math.max(1, chars);
  const t0 = clampNum(c, c.t.start + 0.8);
  // The per-character step must be finite and must never let the last character land after
  // `end - 0.4`, however hostile or malformed `cue_done` is, and however short the scene is:
  // `hardCap` is the largest step that keeps `t0 + chars * hardCap` inside that bound (collapsing
  // to a tiny floor rather than 0 or negative for a scene too short to type in at all), and every
  // candidate step is clamped under it before the usual 0.01-0.06s typing-speed window applies.
  const hardCap = Math.max(0, (c.t.end - 0.4 - t0) / denom);
  const cueDt = (clampNum(c, item(c, "cue_done", c.t.end - 1)) - t0) / denom;
  const dt = Math.max(0.001, Math.min(0.06, hardCap, Number.isFinite(cueDt) && cueDt > 0 ? cueDt : 0.01));
  return {
    html: [step(c), head(id, m, s.headline), `<div class="code-wrap">`, s.label ? `<p id="${id}-label" class="label">${m.text(s.label)}</p>` : "",
      `<div id="${id}-code" class="code">${lines.map((l) => `<span class="ln">${l ? typeLine(l, s.lang) : " "}</span>`).join("")}</div>`, `</div>`].filter(Boolean).join("\n"),
    js: [...headJs(id, c, s.headline), ...(s.label ? [`K.reveal(tl, "#${id}-label", ${clampT(c, c.t.start + 0.4)}, { y: 12 });`] : []),
      `document.querySelectorAll("#${id}-code .ch").forEach((el, i) => tl.set(el, { opacity: 1 }, ${n2(t0)} + i * ${dt.toFixed(3)}));`],
  };
};

const codeHighlight: Builder<Extract<Scene, { type: "code-highlight" }>> = (s, c, m) => {
  const id = c.t.id, lines = codeLines(s.code), LINE = 54;
  // Every `[first, last]` line pair is clamped into `1..lines.length` and rounded *before* it's
  // used anywhere - in the pixel offsets below and in the on-screen "line N"/"lines N to M" text -
  // so a non-finite, out-of-range or out-of-order pair from a hostile/malformed spec can never
  // write a raw NaN/huge/negative number into either the page or the script.
  const clampLine = (x: number) => Math.min(lines.length, Math.max(1, Math.round(num(x, 1))));
  const js = [...headJs(id, c, s.headline), `K.reveal(tl, "#${id}-code", ${clampT(c, c.t.start + 0.5)}, { y: 24 }, 0.5);`];
  s.steps.forEach((st, k) => {
    const t = item(c, `steps.${k}`, c.t.start + 1.5 + 2 * k);
    const l0 = clampLine(st.lines[0]), l1 = Math.max(l0, clampLine(st.lines[1]));
    const y = (l0 - 1) * LINE, sy = l1 - l0 + 1;
    js.push(k === 0
      ? `tl.fromTo("#${id}-hl", { opacity: 0, y: ${y}, scaleY: ${sy} }, { opacity: 1, y: ${y}, scaleY: ${sy}, duration: 0.3, ease: "power2.out" }, ${clampT(c, t)});`
      : `tl.to("#${id}-hl", { y: ${y}, scaleY: ${sy}, duration: 0.45, ease: "power3.inOut" }, ${clampT(c, t)});`);
    if (k > 0) js.push(`tl.to("#${id}-n${k - 1}", { opacity: 0, y: -16, duration: 0.25, ease: "power2.in" }, ${clampT(c, t - 0.05)});`);
    js.push(`K.reveal(tl, "#${id}-n${k}", ${clampT(c, t + (k ? 0.15 : 0))}, { x: 30, y: 0 }, 0.5);`);
  });
  const ref = (l: [number, number]) => {
    const a = clampLine(l[0]), b = Math.max(a, clampLine(l[1]));
    return a === b ? `line ${a}` : `lines ${a} to ${b}`;
  };
  return {
    html: [step(c), head(id, m, s.headline), `<div class="split">`,
      `<div id="${id}-code" class="code"><div id="${id}-hl" class="code-hl"></div>${lines.map((l) => `<span class="ln">${l ? highlightLine(l, s.lang) : " "}</span>`).join("")}</div>`,
      `<div class="notes">`, ...s.steps.map((st, k) => `<div id="${id}-n${k}" class="note card"><p class="label">${ref(st.lines)}</p><p class="body">${m.text(st.note)}</p></div>`), `</div>`,
      `</div>`].join("\n"),
    js,
  };
};

const codeMorph: Builder<Extract<Scene, { type: "code-morph" }>> = (s, c, m) => {
  const id = c.t.id, t = item(c, "cue_morph", c.t.start + 3);
  const block = (code: string, el: string, cls: string) => `<div id="${id}-${el}" class="code${cls}">${codeLines(code).map((l) => `<span class="ln">${l ? highlightLine(l, s.lang) : " "}</span>`).join("")}</div>`;
  return {
    html: [step(c), head(id, m, s.headline), `<div class="morph">`, block(s.from, "from", ""), block(s.to, "to", " later"), `</div>`].join("\n"),
    js: [...headJs(id, c, s.headline), `K.reveal(tl, "#${id}-from", ${clampT(c, c.t.start + 0.5)}, { y: 24 }, 0.5);`,
      `tl.to("#${id}-from", { opacity: 0, y: -16, duration: 0.4, ease: "power2.in" }, ${clampT(c, t)});`,
      `tl.fromTo("#${id}-to", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${clampT(c, t + 0.15)});`],
  };
};

const codeDiff: Builder<Extract<Scene, { type: "code-diff" }>> = (s, c, m) => {
  const id = c.t.id, rows = diffLines(codeLines(s.before), codeLines(s.after)), T = c.t.start;
  const js = [...headJs(id, c, s.headline), `K.reveal(tl, "#${id}-code", ${clampT(c, T + 0.5)}, { y: 24 }, 0.5);`];
  let dels = 0, adds = 0;
  rows.forEach((r, k) => {
    if (r.op === "del") js.push(`K.draw(tl, "#${id}-d${k} .bar", ${clampT(c, T + 1.4 + 0.15 * dels++)}, 0.4);`);
    if (r.op === "add") js.push(`tl.fromTo("#${id}-d${k}", { opacity: 0, x: -16 }, { opacity: 1, x: 0, duration: 0.4, ease: "power3.out" }, ${clampT(c, T + 2.4 + 0.2 * adds++)});`);
  });
  js.push(`K.reveal(tl, "#${id}-note", ${clampT(c, T + 3.6)}, { y: 16 });`);
  const sign = { same: " ", add: "+", del: "-" } as const;
  return {
    html: [step(c), head(id, m, s.headline),
      `<div id="${id}-code" class="code diff">${rows.map((r, k) => `<span id="${id}-d${k}" class="ln ${r.op}">${r.op === "del" ? `<i class="bar"></i>` : ""}<span class="sign">${sign[r.op]}</span>${r.text ? highlightLine(r.text, s.lang) : " "}</span>`).join("")}</div>`,
      `<p id="${id}-note" class="lede verdict">${m.text(s.note)}</p>`].join("\n"),
    js,
  };
};

export const BUILDERS = {
  title, "bullet-build": bullets, "code-typing": codeTyping, "code-highlight": codeHighlight, "code-morph": codeMorph, "code-diff": codeDiff,
  flowchart, sequence, comparison, stat, quiz, "recap-card": recap, ...VISUAL_BUILDERS,
} satisfies Record<SceneType, Builder<never>> as unknown as Record<SceneType, Builder>;

const STAGE_CLASS: Partial<Record<SceneType, string>> = { title: " center", stat: " center", ...VISUAL_STAGE_CLASS };

export function buildScene(scene: Scene, c: BuildCtx): SceneOut {
  const id = c.t.id;
  const marks = new MarkSet(scene.marks ?? [], id, c);
  const { html, js } = BUILDERS[scene.type](scene, c, marks);
  const section = [
    `<section id="${id}" class="clip scene" data-start="${n2(c.t.start)}" data-duration="${n2(c.t.end - c.t.start)}" data-track-index="1">`,
    `<div id="${id}-stage" class="stage${STAGE_CLASS[scene.type] ?? ""}">`, html, `</div>`, `</section>`,
  ].join("\n");
  return { html: section, js: [...js, ...marks.js()], warnings: marks.warnings(c.index) };
}
