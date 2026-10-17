import { core, graphite, paper } from "@careeros/brand/tokens";
import type { ResearchReport, ResearchSource } from "./research.js";

/**
 * Export HTML for a research report (spec 2026-10-17-research-any-topic): one self-contained file. Inline styles only,
 * no scripts, no remote fonts or images, a Content-Security-Policy that allows nothing but inline styles, every value
 * escaped, and only https links (report.json's sources are already checked to be https). Light, with dark following
 * the reader's system setting on screen; print is always light.
 */

/** Escapes text for HTML text and attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** An https URL safe to put in href, else null. */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}

export const RESEARCH_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'";
export const RESEARCH_DISCLAIMER = "General information only, not legal, migration, tax or financial advice. Rules and numbers change: check the sources before you rely on them.";

const e = escapeHtml;
const theme = (t: Record<string, string>) => [
  `--bg: ${t["color-bg"]}`, `--surface: ${t["color-bg-raised"]}`, `--text: ${t["color-text"]}`, `--muted: ${t["color-text-muted"]}`,
  `--border: ${t["color-border"]}`, `--accent: ${t["color-accent"]}`, `--accent-soft: ${t["color-accent-soft"]}`,
  `--warn: ${t["color-warning"]}`, `--warn-soft: ${t["color-warning-soft"]}`, `--ok: ${t["color-success"]}`,
].join("; ");

function styles(): string {
  return [
    `:root { ${theme(paper)}; color-scheme: light dark; }`,
    `@media screen and (prefers-color-scheme: dark) { :root { ${theme(graphite)}; } }`,
    `* { box-sizing: border-box; }`,
    `body { margin: 0; background: var(--bg); color: var(--text); font-family: ${core["font-family-sans"]}; font-size: 15px; line-height: 1.55; }`,
    `main { max-width: 860px; margin: 0 auto; padding: 40px 24px 56px; }`,
    `h1 { font-family: ${core["font-family-display"]}; font-weight: 400; font-size: 40px; line-height: 1.1; margin: 0 0 8px; }`,
    `h2 { font-size: 19px; margin: 36px 0 12px; }`,
    `h3 { font-size: 15px; margin: 0 0 4px; }`,
    `p { margin: 0 0 10px; }`,
    `a { color: var(--accent); }`,
    `.meta { color: var(--muted); font-size: 13px; margin: 0 0 20px; }`,
    `.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; }`,
    `.note { background: var(--warn-soft); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin: 12px 0 0; font-size: 14px; }`,
    `.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }`,
    `.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; }`,
    `.tile .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }`,
    `.tile .value { font-size: 22px; font-weight: 600; margin: 4px 0; }`,
    `.tile .detail { color: var(--muted); font-size: 13px; }`,
    `ol.steps { list-style: none; padding: 0; margin: 0; counter-reset: step; }`,
    `ol.steps li { position: relative; padding: 0 0 18px 44px; counter-increment: step; }`,
    `ol.steps li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 600; font-size: 13px; display: flex; align-items: center; justify-content: center; }`,
    `ol.steps li::after { content: ""; position: absolute; left: 13px; top: 32px; bottom: 4px; width: 2px; background: var(--border); }`,
    `ol.steps li:last-child::after { display: none; }`,
    `.duration { color: var(--muted); font-size: 13px; }`,
    `table { width: 100%; border-collapse: collapse; font-size: 14px; }`,
    `th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--border); }`,
    `th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }`,
    `caption { text-align: left; font-weight: 600; padding: 0 0 8px; }`,
    `.bar { display: grid; grid-template-columns: minmax(120px, 30%) 1fr auto; gap: 10px; align-items: center; margin: 6px 0; font-size: 14px; }`,
    `.bar .track { background: var(--accent-soft); border-radius: 6px; height: 12px; overflow: hidden; }`,
    `.bar .fill { background: var(--accent); height: 100%; border-radius: 6px; }`,
    `.small { color: var(--muted); font-size: 13px; }`,
    `sup a { text-decoration: none; font-size: 11px; }`,
    `ol.sources li { margin: 0 0 8px; }`,
    `.badge { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; font-size: 11px; color: var(--ok); margin-left: 6px; }`,
    `footer { margin-top: 40px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--border); padding-top: 12px; }`,
    `@media print { body { font-size: 11pt; } main { padding: 0; } .card, .tile { break-inside: avoid; } }`,
  ].join("\n");
}

const sup = (ids: number[] | undefined, known: Set<number>) =>
  (ids ?? []).filter((n) => known.has(n)).map((n) => `<sup><a href="#source-${n}">[${n}]</a></sup>`).join("");

function sourceItem(s: ResearchSource): string {
  const href = safeHref(s.url);
  const title = href ? `<a href="${e(href)}" rel="noreferrer noopener">${e(s.title)}</a>` : e(s.title);
  return `<li id="source-${s.id}">${title}${s.official ? '<span class="badge">Official</span>' : ""}<br><span class="small">${e([s.publisher, `read ${s.accessed}`].filter(Boolean).join(" · "))}${href ? ` · ${e(new URL(href).hostname)}` : ""}</span></li>`;
}

/** The whole report as one HTML document. `madeAt` is a plain date for the footer; `product` the app's name. */
export function researchHtml(r: ResearchReport, o: { madeAt: string; product: string }): string {
  const ids = new Set(r.sources.map((s) => s.id));
  const out: string[] = [];
  out.push(`<h1>${e(r.title)}</h1>`);
  out.push(`<p class="meta">As of ${e(r.as_of)}${r.confidence ? ` · ${e(r.confidence)} confidence` : ""} · ${r.sources.length} sources</p>`);
  out.push(`<section class="card"><p>${e(r.summary)}</p>${r.changes_often ? `<p class="note">${e(r.changes_often)}</p>` : ""}</section>`);
  if (r.key_facts?.length) {
    out.push(`<h2>Key figures</h2><div class="tiles">${r.key_facts.map((f) =>
      `<div class="tile"><div class="label">${e(f.label)}</div><div class="value">${e(f.value)}${sup(f.sources, ids)}</div>${f.detail ? `<div class="detail">${e(f.detail)}</div>` : ""}</div>`).join("")}</div>`);
  }
  for (const s of r.sections ?? []) {
    out.push(`<h2>${e(s.heading)}${sup(s.sources, ids)}</h2>`);
    for (const p of s.paragraphs ?? []) out.push(`<p>${e(p)}</p>`);
    if (s.bullets?.length) out.push(`<ul>${s.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>`);
  }
  if (r.steps?.length) {
    out.push(`<h2>Steps</h2><ol class="steps">${r.steps.map((s) =>
      `<li><h3>${e(s.title)}${sup(s.sources, ids)}</h3>${s.duration ? `<div class="duration">${e(s.duration)}</div>` : ""}${s.detail ? `<p>${e(s.detail)}</p>` : ""}</li>`).join("")}</ol>`);
  }
  for (const t of r.tables ?? []) {
    out.push(`<h2>${e(t.title)}${sup(t.sources, ids)}</h2><div class="card"><table><thead><tr>${t.columns.map((c) => `<th scope="col">${e(c)}</th>`).join("")}</tr></thead><tbody>${
      t.rows.map((row) => `<tr>${row.map((c, i) => (i === 0 ? `<th scope="row">${e(c)}</th>` : `<td>${e(c)}</td>`)).join("")}</tr>`).join("")}</tbody></table>${t.note ? `<p class="small">${e(t.note)}</p>` : ""}</div>`);
  }
  for (const c of r.charts ?? []) {
    const max = Math.max(...c.bars.map((b) => b.value), 0);
    out.push(`<h2>${e(c.title)}${sup(c.sources, ids)}</h2><div class="card">${c.bars.map((b) => {
      const pct = max > 0 ? Math.round((b.value / max) * 1000) / 10 : 0;
      return `<div class="bar"><span>${e(b.label)}</span><span class="track"><span class="fill" style="width: ${pct}%; display: block"></span></span><span>${e(b.value.toLocaleString("en-AU"))}${c.unit ? ` ${e(c.unit)}` : ""}</span></div>`;
    }).join("")}${c.note ? `<p class="small">${e(c.note)}</p>` : ""}</div>`);
  }
  if (r.uncertain?.length) out.push(`<h2>What we couldn't confirm</h2><div class="note"><ul>${r.uncertain.map((u) => `<li>${e(u)}</li>`).join("")}</ul></div>`);
  out.push(`<h2>Sources</h2><ol class="sources">${r.sources.map(sourceItem).join("")}</ol>`);
  out.push(`<footer>${e(RESEARCH_DISCLAIMER)}<br>Exported from ${e(o.product)} on ${e(o.madeAt)}.</footer>`);
  return page(r.title, out.join("\n"));
}

/** report.md when report.json can't be used: the text as it is, escaped, in a readable block. */
export function researchTextHtml(title: string, markdown: string, o: { madeAt: string; product: string }): string {
  return page(title, `<h1>${e(title)}</h1>\n<div class="card" style="white-space: pre-wrap">${e(markdown)}</div>\n<footer>${e(RESEARCH_DISCLAIMER)}<br>Exported from ${e(o.product)} on ${e(o.madeAt)}.</footer>`);
}

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en-AU">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${RESEARCH_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${e(title)}</title>`,
    `<style>\n${styles()}\n</style>`,
    "</head>",
    "<body><main>",
    body,
    "</main></body>",
    "</html>",
    "",
  ].join("\n");
}
