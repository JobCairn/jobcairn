import { describe, expect, it } from "vitest";
import { themes } from "../dist/tokens.ts";

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** An rgba() colour composited over an opaque hex background, as hex. */
function over(rgba: string, bg: string): string {
  const m = rgba.match(/rgba?\(([^)]+)\)/);
  if (!m) return rgba;
  const [r, g, b, a = "1"] = m[1]!.split(",").map((x) => x.trim());
  const base = [0, 2, 4].map((i) => parseInt(bg.replace("#", "").slice(i, i + 2), 16));
  return `#${[r, g, b].map((c, i) => Math.round(Number(c) * Number(a) + base[i]! * (1 - Number(a))).toString(16).padStart(2, "0")).join("")}`;
}

describe("WCAG AA contrast", () => {
  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: text roles reach 4.5:1 on bg and bg-raised`, () => {
      for (const fg of ["color-text", "color-text-muted", "color-accent", "color-success", "color-warning", "color-danger", "color-info"] as const) {
        for (const bg of ["color-bg", "color-bg-raised"] as const) {
          expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
    it(`${name}: disabled controls and helper text stay legible (4.5:1 on bg, bg-raised and surface)`, () => {
      const surface = over(t["color-surface"], t["color-bg"]);
      for (const fg of ["color-text-disabled", "color-text-muted"] as const) {
        for (const bg of [t["color-bg"], t["color-bg-raised"], surface]) expect(contrast(t[fg], bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: primary button text reaches 4.5:1`, () => {
      expect(contrast(t["button-primary-fg"], t["button-primary-bg"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["button-primary-fg"], t["button-primary-bg-hover"])).toBeGreaterThanOrEqual(4.5);
    });
  }
});
