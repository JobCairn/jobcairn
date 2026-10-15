import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { migrate, pendingMigrations } from "../src/migrate.js";
import { LATEST_DATA_VERSION } from "../src/migrations/index.js";
import { readRecord, writeFileAtomic } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function oldWorkspace(): string {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  // Rewind to the sub-project 1 shape: no privacy block, data_version 0, old settings file.
  writeFileAtomic(layout(root).workspaceFile, JSON.stringify({ schema: 1, data_version: 0, product_version: "0.1.0", created_at: FIXED.toISOString(), custom: {} }, null, 2) + "\n");
  writeFileAtomic(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(./me/identity/**)"] } }, null, 2) + "\n");
  return root;
}

describe("migration 1 (privacy)", () => {
  it("new workspaces start at the latest data version with the lock list", () => {
    expect(LATEST_DATA_VERSION).toBe(4);
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    expect(readRecord("workspace", layout(root).workspaceFile)).toMatchObject({ data_version: LATEST_DATA_VERSION, privacy: { locked: ["me/identity", "me/employment"], grants: [] } });
  });
  it("adds the lock list to an old workspace, regenerates Claude settings and backs up both files", () => {
    const root = oldWorkspace();
    expect(pendingMigrations(root).map((m) => m.id)).toEqual([1, 2, 3, 4]);
    const r = migrate(root, undefined, { now: FIXED });
    expect(r.applied).toEqual([1, 2, 3, 4]);
    const raw = JSON.parse(fs.readFileSync(layout(root).workspaceFile, "utf8"));
    expect(raw.privacy).toEqual({ locked: ["me/identity", "me/employment"], grants: [] });
    expect(raw.data_version).toBe(LATEST_DATA_VERSION);
    const s = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    expect(s.permissions.deny).toContain("Read(./me/employment/**)");
    expect(fs.existsSync(path.join(r.backup!, "workspace.json"))).toBe(true);
    expect(fs.existsSync(path.join(r.backup!, ".claude", "settings.json"))).toBe(true);
    expect(migrate(root).applied).toEqual([]);
  });
});
