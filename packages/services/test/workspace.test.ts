import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { addGrant, readActivity, readMeta } from "@careeros/core";
import {
  closeWorkspace, createWorkspace, importLegacyAndOpen, openWorkspace, previewLegacy, restoreLast, shutdownWorkspace,
  workspaceHandlers,
} from "../src/workspace.js";
import { FIXED, makeCtx, minutes, sampleCopy, tmpDir } from "./helpers.js";

describe("workspace lifecycle", () => {
  it("creates a workspace in a new folder and remembers it", () => {
    const { ctx, host } = makeCtx();
    const dir = path.join(tmpDir(), "CareerOS");
    const s = createWorkspace(ctx, dir, "Alex Example");
    expect(s).toMatchObject({ root: dir, name: "Alex Example", migrated: [], indexSkipped: 0 });
    expect(s.dataVersion).toBeGreaterThanOrEqual(1);
    const deny = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")).permissions.deny as string[];
    expect(deny).toContain("Read(./me/identity/**)");
    expect(host.state.value).toMatchObject({ lastWorkspace: dir, recent: [dir] });
    expect(workspaceHandlers["workspace.current"](ctx)).toMatchObject({ root: dir });
  });

  it("refuses a folder with files in it, and folders that aren't workspaces", () => {
    const { ctx } = makeCtx();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    expect(() => createWorkspace(ctx, dir, "Alex Example")).toThrow(/isn't empty/);
    expect(() => openWorkspace(ctx, dir)).toThrow(new RegExp(`isn't a ${identity.name} workspace`));
    expect(ctx.root).toBeNull();
  });

  it("re-locks grants left over from the last session when it opens (Review Focus 2)", () => {
    const root = sampleCopy();
    addGrant(root, "me/identity", 60, "20260115t085500-aaaaaa", { now: FIXED });
    const { ctx } = makeCtx({ now: minutes(5) });
    openWorkspace(ctx, root);
    expect(readMeta(root).privacy.grants).toEqual([]);
    const deny = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")).permissions.deny as string[];
    expect(deny).toContain("Read(./me/identity/**)");
    expect(readActivity(root)[0]).toMatchObject({ event: "Re-locked", detail: "me/identity (app opened)" });
  });

  it("re-locks grants when it closes", () => {
    const root = sampleCopy();
    const { ctx } = makeCtx();
    openWorkspace(ctx, root);
    addGrant(root, "me/employment", 30, "20260115t090000-bbbbbb", ctx.clock());
    closeWorkspace(ctx);
    expect(readMeta(root).privacy.grants).toEqual([]);
    expect(ctx.root).toBeNull();
    expect(workspaceHandlers["workspace.current"](ctx)).toBeNull();
  });

  it("runs open hooks for each workspace and their cleanups on switch", () => {
    const { ctx } = makeCtx();
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    ctx.onOpen(start);
    openWorkspace(ctx, sampleCopy());
    expect(start).toHaveBeenCalledTimes(1);
    closeWorkspace(ctx);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("forgets a last workspace that no longer exists", () => {
    const { ctx, host } = makeCtx();
    host.state.write({ lastWorkspace: path.join(tmpDir(), "gone"), recent: [] });
    expect(restoreLast(ctx)).toBeNull();
    expect(host.state.value.lastWorkspace).toBeNull();
  });

  it("previews a legacy import without writing anything", () => {
    const { ctx } = makeCtx();
    const src = tmpDir();
    fs.mkdirSync(path.join(src, "Notes"));
    const dest = path.join(tmpDir(), "CareerOS");
    expect(previewLegacy(ctx, src, dest)).toMatchObject({ unmapped: ["Notes"] });
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("refuses a relative path when creating a workspace, and writes nothing", () => {
    const { ctx } = makeCtx();
    const cwd = process.cwd();
    const base = tmpDir();
    process.chdir(base);
    try {
      expect(() => createWorkspace(ctx, "CareerOS", "Alex Example")).toThrow(/full folder path/);
      expect(fs.readdirSync(base)).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("refuses a relative source or destination for legacy import, and writes nothing", () => {
    const { ctx } = makeCtx();
    const cwd = process.cwd();
    const base = tmpDir();
    process.chdir(base);
    try {
      fs.mkdirSync(path.join(base, "LegacySrc"));
      expect(() => importLegacyAndOpen(ctx, "LegacySrc", path.join(tmpDir(), "CareerOS"))).toThrow(/full folder path/);
      expect(() => importLegacyAndOpen(ctx, path.join(base, "LegacySrc"), "CareerOS")).toThrow(/full folder path/);
      expect(fs.readdirSync(base)).toEqual(["LegacySrc"]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("shuts down by re-locking grants but keeps the remembered workspace for next launch", () => {
    const root = sampleCopy();
    const { ctx, host } = makeCtx();
    openWorkspace(ctx, root);
    addGrant(root, "me/employment", 30, "20260115t090500-cccccc", ctx.clock());
    shutdownWorkspace(ctx);
    expect(readMeta(root).privacy.grants).toEqual([]);
    expect(readActivity(root)[0]).toMatchObject({ event: "Re-locked", detail: "me/employment (app closed)" });
    expect(ctx.root).toBeNull();
    expect(host.state.value.lastWorkspace).toBe(root);
  });

  it("opening a second workspace closes the first: re-locks A's grants, logs the close, and remembers B", () => {
    const rootA = sampleCopy();
    const { ctx, host } = makeCtx();
    openWorkspace(ctx, rootA);
    addGrant(rootA, "me/identity", 30, "20260115t090600-dddddd", ctx.clock());
    const rootB = sampleCopy();
    openWorkspace(ctx, rootB);
    expect(ctx.root).toBe(rootB);
    expect(readMeta(rootA).privacy.grants).toEqual([]);
    expect(readActivity(rootA)[0]).toMatchObject({ event: "Re-locked", detail: "me/identity (app closed)" });
    expect(host.state.value.lastWorkspace).toBe(rootB);
  });
});
