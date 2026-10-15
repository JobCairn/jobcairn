import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTokens } from "../scripts/build-tokens.mjs";
import { core, graphite, paper } from "../dist/tokens.ts";

const dist = path.resolve(import.meta.dirname, "../dist");

describe("brand tokens", () => {
  it("committed dist/ matches the DTCG sources (run `npm run tokens` after editing tokens/)", async () => {
    const { css, ts } = await buildTokens();
    expect(fs.readFileSync(path.join(dist, "tokens.css"), "utf8")).toBe(css);
    expect(fs.readFileSync(path.join(dist, "tokens.ts"), "utf8")).toBe(ts);
  });
  it("defines every semantic role in both themes", () => {
    for (const name of ["color-bg", "color-bg-raised", "color-surface", "color-border", "color-text", "color-text-muted", "color-accent", "color-success", "color-warning", "color-danger", "color-focus"]) {
      expect(graphite).toHaveProperty(name);
      expect(paper).toHaveProperty(name);
    }
    expect(Object.keys(graphite).sort()).toEqual(Object.keys(paper).sort());
  });
  it("defines component tokens", () => {
    for (const name of ["button-primary-bg", "button-height-md", "pill-height", "card-radius", "input-height", "nav-item-icon-box", "nav-item-badge-min-width", "kpi-spark-width"]) {
      expect(graphite).toHaveProperty(name);
    }
    expect(graphite["nav-item-icon-box"]).toBe("18px");
  });
  it("keeps spacing on the 4px grid and exposes font roles", () => {
    for (const [k, v] of Object.entries(core)) if (k.startsWith("space-")) expect(parseInt(v, 10) % 4).toBe(0);
    expect(core["font-family-display"]).toContain("Instrument Serif");
    expect(core["font-family-sans"]).toContain("Geist");
    expect(core["font-family-mono"]).toContain("Geist Mono");
  });
  it("writes theme blocks with the right selectors", async () => {
    const { css } = await buildTokens();
    expect(css).toContain(':root, [data-theme="graphite"] {');
    expect(css).toContain('[data-theme="paper"] {');
    expect(css).toMatch(/--color-bg: #0d0e11;/);
  });
});
