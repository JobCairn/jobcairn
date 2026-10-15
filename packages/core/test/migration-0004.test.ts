import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { migrate } from "../src/migrate.js";
import { readRecord, updateRecord, writeFileAtomic } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function at3(workModes: unknown, locations: unknown[]): string {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  updateRecord("workspace", layout(root).workspaceFile, (w) => { w.data_version = 3; });
  updateRecord("profile", layout(root).profile, (p) => { p.locations = locations as typeof p.locations; });
  const s = JSON.parse(fs.readFileSync(layout(root).search, "utf8"));
  s.filters = { ...s.filters, work_modes: workModes };
  writeFileAtomic(layout(root).search, `${JSON.stringify(s, null, 2)}\n`);
  return root;
}

describe("migration 4 (work modes per place)", () => {
  it("puts the global work modes into places that take any mode, keeps narrower ones, and drops the global value", () => {
    const root = at3(["remote", "hybrid"], [
      { place: "Sampletown NSW", modes: ["onsite", "hybrid", "remote"], will_relocate: false },
      { place: "Exampleville QLD", modes: ["onsite"], will_relocate: true },
    ]);
    expect(migrate(root, undefined, { now: FIXED }).applied).toEqual([4]);
    expect(readRecord("profile", layout(root).profile).locations).toEqual([
      { place: "Sampletown NSW", modes: ["hybrid", "remote"], will_relocate: false },
      { place: "Exampleville QLD", modes: ["onsite"], will_relocate: true },
    ]);
    expect(Object.hasOwn(readRecord("search", layout(root).search).filters, "work_modes")).toBe(false);
  });
  it("an empty or all-modes global value changes no place", () => {
    for (const modes of [[], ["onsite", "hybrid", "remote"]]) {
      const places = [{ place: "Perth", modes: ["onsite", "hybrid", "remote"], will_relocate: false }];
      const root = at3(modes, places);
      migrate(root, undefined, { now: FIXED });
      expect(readRecord("profile", layout(root).profile).locations).toEqual(places);
      expect(Object.hasOwn(readRecord("search", layout(root).search).filters, "work_modes")).toBe(false);
    }
  });
});
