import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFixture } from "../scripts/make-fixture";

describe("mock fixture", () => {
  it("matches the sample workspace (run `npm run fixture -w @careeros/app-ui` after changing samples)", () => {
    const committed = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../src/mock/alex-fixture.json"), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildFixture())));
  });
  it("holds only fictional details", () => {
    const f = buildFixture();
    expect((f.profile.contact as { email: string }).email).toBe("alex" + "@" + "example.com");
    expect(f.workspace.root.startsWith("/fictional/")).toBe(true);
  });
});
