#!/usr/bin/env -S npx tsx
// Writes the brand assets from code: assets/mark.svg, wordmark.svg and app-icon.svg (from the mark
// drawing and identity.json), then renders app-icon-512.png and app-icon-1024.png (Dock and window
// icons, gitignored: the Electron build renders them when missing) with the Chromium Playwright brings.
// Run: npm run icons -w @careeros/brand (both), icons:svg or icons:png.
import fs from "node:fs";
import path from "node:path";
import { identity } from "../identity";
import { core } from "../dist/tokens";
import { appIconSvg, markSvg } from "../src/icons/mark";

const assets = path.resolve(import.meta.dirname, "../assets");

export function brandSvgs(): Record<string, string> {
  const mark = markSvg({ size: 64, id: "careeros-mark", label: identity.name });
  const wordmarkMark = markSvg({ size: 48, id: "careeros-wordmark" }).replace("<svg ", '<svg x="0" y="8" ');
  // Instrument Serif at 44 px averages ~0.47 em per glyph: room for any name without clipping.
  const width = Math.ceil(64 + identity.name.length * 44 * 0.5 + 8);
  const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 64" role="img" aria-label="${identity.name}">${wordmarkMark}`
    + `<text x="64" y="46" font-family="Instrument Serif, Georgia, serif" font-size="44" fill="${core["color-ink-100"]}">${identity.name}</text></svg>`;
  return { "mark.svg": mark, "wordmark.svg": wordmark, "app-icon.svg": appIconSvg(identity.name) };
}

async function renderPngs(svg: string) {
  const { chromium } = await import("playwright");
  // Prefer Playwright's own Chromium; fall back to an installed Chrome.
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
  try {
    for (const size of [512, 1024]) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
      fs.writeFileSync(path.join(assets, `app-icon-${size}.png`), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
      await page.close();
    }
  } finally { await browser.close(); }
}

// `--svg` writes only the committed SVGs; `--png` renders only the (gitignored) PNGs, from the drawing
// in memory, so a build never dirties the tree. No flag does both.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const only = process.argv.includes("--svg") ? "svg" : process.argv.includes("--png") ? "png" : "all";
  const files = brandSvgs();
  if (only !== "png") for (const [name, svg] of Object.entries(files)) fs.writeFileSync(path.join(assets, name), `${svg}\n`);
  if (only !== "svg") await renderPngs(files["app-icon.svg"]!);
  const wrote = [...(only !== "png" ? Object.keys(files) : []), ...(only !== "svg" ? ["app-icon-512.png", "app-icon-1024.png"] : [])];
  console.log(`wrote ${wrote.join(", ")} in packages/brand/assets`);
}
