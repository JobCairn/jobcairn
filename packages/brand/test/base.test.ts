import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// jsdom doesn't run layout, so this can't check that a hidden element is actually invisible on
// screen. What it can check is that the real stylesheet - the one `@careeros/brand/styles.css`
// (src/styles/index.css) actually `@import`s, and that main.tsx actually loads - carries a
// `[hidden]` rule strong enough to beat any author `display` rule on the same element (e.g. a
// `.stack` class put on a hidden tab panel), regardless of that rule's selector specificity.
describe("brand base styles", () => {
  it("forces [hidden] to win over any other display rule on the same element", () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, "../src/styles/base.css"), "utf8");
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });
});
