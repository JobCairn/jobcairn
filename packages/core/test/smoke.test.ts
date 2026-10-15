import { describe, expect, it } from "vitest";
import { PRODUCT_VERSION } from "../src/index.js";
describe("package", () => {
  it("exposes a semver version", () => {
    expect(PRODUCT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
