import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { initWorkspace } from "../src/workspace.js";
import { migrate, pendingMigrations } from "../src/migrate.js";
import type { Migration } from "../src/migrations/index.js";
import { readRecord, updateRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); updateRecord("workspace", layout(root).workspaceFile, (w) => { w.data_version = 0; }); return root; }

const renameCity: Migration = {
  id: 1, name: "move contact.city to contact.location",
  files: (root) => [layout(root).profile],
  run: (root) => updateRecord("profile", layout(root).profile, (p) => { p.contact.location = p.contact.city; p.contact.city = ""; }),
};
const boom: Migration = { id: 2, name: "fails", files: () => [], run: () => { throw new Error("bad data"); } };

describe("migrate", () => {
  it("runs pending migrations once, backs up files and bumps data_version", () => {
    const root = ws();
    updateRecord("profile", layout(root).profile, (p) => { p.contact.city = "Sampletown"; });
    expect(pendingMigrations(root, [renameCity]).map((m) => m.id)).toEqual([1]);
    const r = migrate(root, [renameCity], { now: FIXED });
    expect(r.applied).toEqual([1]);
    expect(readRecord("profile", layout(root).profile).contact.location).toBe("Sampletown");
    const backedUp = JSON.parse(fs.readFileSync(path.join(r.backup!, "settings", "profile.json"), "utf8"));
    expect(backedUp.contact.city).toBe("Sampletown");
    expect(readRecord("workspace", layout(root).workspaceFile).data_version).toBe(1);
    expect(migrate(root, [renameCity]).applied).toEqual([]);
  });
  it("stops at a failing migration, keeps the earlier version and names the backup", () => {
    const root = ws();
    expect(() => migrate(root, [renameCity, boom], { now: FIXED })).toThrow(/migration 2 \(fails\) failed: bad data\. Files backed up in/);
    expect(readRecord("workspace", layout(root).workspaceFile).data_version).toBe(1);
  });
  it("new workspaces start at the latest version", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    expect(pendingMigrations(root)).toEqual([]);
  });
  it("keeps the true original when two migrations touch the same file, and keeps its permissions", () => {
    const root = ws();
    const P = layout(root).profile;
    updateRecord("profile", P, (p) => { p.contact.city = "Sampletown"; });
    fs.chmodSync(P, 0o600);
    const original = fs.readFileSync(P, "utf8");
    const second: Migration = { id: 2, name: "touch again", files: (r) => [layout(r).profile], run: (r) => updateRecord("profile", layout(r).profile, (p) => { p.contact.city = "Other"; }) };
    const r = migrate(root, [renameCity, second], { now: FIXED });
    const copy = path.join(r.backup!, path.relative(root, P));
    expect(fs.readFileSync(copy, "utf8")).toBe(original);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
  });
  it("refuses a workspace saved by a newer version of the app", () => {
    const root = ws();
    updateRecord("workspace", layout(root).workspaceFile, (w) => { w.data_version = 99; });
    expect(() => pendingMigrations(root, [renameCity])).toThrow(new RegExp(`newer ${identity.name}`));
    expect(() => migrate(root, [renameCity])).toThrow(new RegExp(`newer ${identity.name}`));
  });
  it("refuses to back up a symlink that points outside the workspace and changes nothing", () => {
    const root = ws();
    const outside = path.join(tmpDir(), "outside.json");
    fs.writeFileSync(outside, "{}");
    const link = path.join(root, "knowledge", "linked.json");
    fs.symlinkSync(outside, link);
    let ran = false;
    const m: Migration = { id: 1, name: "linked", files: () => [link], run: () => { ran = true; } };
    expect(() => migrate(root, [m])).toThrow(/not a regular file inside the workspace/);
    expect(ran).toBe(false);
    expect(readRecord("workspace", layout(root).workspaceFile).data_version).toBe(0);
  });
});
