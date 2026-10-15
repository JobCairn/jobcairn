import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { migrate } from "../src/migrate.js";
import { readRecord, updateRecord, writeFileAtomic } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

/** A workspace at data version 2 whose search settings hold the find-jobs lane's separate places list. */
function oldWorkspace(filters: Record<string, unknown>, locations: unknown[]): string {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  updateRecord("workspace", layout(root).workspaceFile, (w) => { w.data_version = 2; });
  updateRecord("profile", layout(root).profile, (p) => { p.locations = locations as typeof p.locations; });
  const s = JSON.parse(fs.readFileSync(layout(root).search, "utf8"));
  s.filters = { ...s.filters, ...filters };
  writeFileAtomic(layout(root).search, `${JSON.stringify(s, null, 2)}\n`);
  return root;
}

describe("migration 3 (one preferred places list)", () => {
  it("puts the search's places first, keeps existing modes, adds the profile's others, and drops the search list", () => {
    const root = oldWorkspace({ locations: ["Exampleville QLD", "remote australia", "Exampleville QLD", " "], work_modes: ["hybrid"] }, [
      { place: "Sampletown NSW", modes: ["onsite"], will_relocate: true },
      { place: "Remote Australia", modes: ["remote"], will_relocate: false },
    ]);
    expect(migrate(root, undefined, { now: FIXED }).applied).toEqual([3, 4]);
    expect(readRecord("profile", layout(root).profile).locations).toEqual([
      { place: "Exampleville QLD", modes: ["hybrid"], will_relocate: false },
      { place: "Remote Australia", modes: ["remote"], will_relocate: false },
      { place: "Sampletown NSW", modes: ["onsite"], will_relocate: true },
    ]);
    expect(Object.hasOwn(readRecord("search", layout(root).search).filters, "locations")).toBe(false);
  });

  it("leaves the profile alone when the search list is empty, and still removes it", () => {
    const places = [{ place: "Sampletown NSW", modes: ["onsite", "hybrid", "remote"], will_relocate: false }];
    const root = oldWorkspace({ locations: [] }, places);
    migrate(root, undefined, { now: FIXED });
    expect(readRecord("profile", layout(root).profile).locations).toEqual(places);
    expect(Object.hasOwn(readRecord("search", layout(root).search).filters, "locations")).toBe(false);
  });

  it("new places get every work mode when the search had none ticked", () => {
    const root = oldWorkspace({ locations: ["Perth"] }, []);
    migrate(root, undefined, { now: FIXED });
    expect(readRecord("profile", layout(root).profile).locations).toEqual([{ place: "Perth", modes: ["onsite", "hybrid", "remote"], will_relocate: false }]);
  });
});
