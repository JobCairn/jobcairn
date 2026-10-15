import fs from "node:fs";
import path from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AI_CANDIDATES, AI_GLYPH, Button, GLYPHS, Glyphs, glyphSvg, Icon, Icons, type GlyphName } from "../src";

const REPO = path.resolve(import.meta.dirname, "../../..");
function sources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith("dist")) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.(tsx?|mts)$/.test(e.name) ? [p] : [];
  });
}

describe("brand icons", () => {
  it("draws every glyph on a 24px grid in currentColor, with round joins and no fill", () => {
    for (const name of Object.keys(GLYPHS) as GlyphName[]) {
      const { container, unmount } = render(<Icon icon={Glyphs[name]} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("fill")).toBe("none");
      expect(svg.getAttribute("stroke-width")).toBe("1.75");
      expect(svg.getAttribute("stroke-linejoin")).toBe("round");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.children.length).toBeGreaterThan(0);
      unmount();
      expect(glyphSvg(name)).toContain('viewBox="0 0 24 24"');
    }
  });
  it("uses the brand AI glyph for AI actions, never a sparkle", () => {
    expect(AI_CANDIDATES).toContain(AI_GLYPH);
    const { container } = render(<Button icon={Icons.ai}>Research company</Button>);
    expect(container.querySelector("svg")).toHaveAttribute("data-glyph", AI_GLYPH);
    expect(container.innerHTML).not.toMatch(/sparkles/i);
  });
  it("gives the app's own ideas brand glyphs", () => {
    for (const [key, glyph] of [["dropBox", "dropBox"], ["sponsors", "sponsor"], ["apply", "apply"], ["learn", "learn"]] as const) {
      const { container, unmount } = render(<Icon icon={Icons[key]} />);
      expect(container.querySelector("svg")).toHaveAttribute("data-glyph", glyph);
      unmount();
    }
  });
  it("imports lucide-react in one file only, so any icon is swapped in one place", () => {
    const offenders = ["packages/app-ui/src", "packages/app-ui/test", "packages/brand/src", "packages/brand/guide", "packages/brand/test"]
      .flatMap((d) => sources(path.join(REPO, d)))
      .filter((f) => !f.endsWith(path.join("brand", "src", "icons", "index.ts")) && /from\s+["']lucide-react["']/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});

describe("brand assets", () => {
  it("are what the icons script writes (mark, wordmark and app icon from one drawing and identity.json; the PNGs are rendered at build time)", async () => {
    const { brandSvgs } = await import("../scripts/build-icons");
    for (const [name, svg] of Object.entries(brandSvgs())) {
      expect(fs.readFileSync(path.join(REPO, "packages/brand/assets", name), "utf8"), `${name} is stale: run npm run icons -w @careeros/brand`).toBe(`${svg}\n`);
    }
  });
});
