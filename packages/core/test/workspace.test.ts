import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { initWorkspace, isWorkspace } from "../src/workspace.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

describe("initWorkspace", () => {
  it("creates the full layout with valid records", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { name: "Alex Example", now: FIXED });
    const L = layout(root);
    for (const d of ["settings", "inbox", "companies", "learning", "knowledge", ".index", "me/resumes", "me/history", "me/identity", "me/employment", "me/education", "me/projects"]) {
      expect(fs.statSync(path.join(root, d)).isDirectory()).toBe(true);
    }
    expect(readRecord("workspace", L.workspaceFile).created_at).toBe("2026-01-15T09:30:00.000Z");
    expect(readRecord("profile", L.profile).contact.name).toBe("Alex Example");
    expect(readRecord("integrations", L.integrations).voice).toMatchObject({ engine: "supertonic", voice: "F4", lang: "en", expressions: true, per_type: { guide: "" } });
    expect(readRecord("sponsors", L.sponsors).employers).toEqual([]);
    expect(fs.readFileSync(L.searchLog, "utf8")).toBe("");
    expect(fs.statSync(L.env).mode & 0o777).toBe(0o600);
    expect(isWorkspace(root)).toBe(true);
  });
  it("locks identity and employment folders and loads no third-party plugins", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    const s = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    expect(s.permissions.deny).toContain("Read(./me/identity/**)");
    expect(s.permissions.deny).toContain("Read(./me/employment/**)");
    expect(s.permissions.deny).toContain("Read(./settings/.env)");
    expect(s.permissions.deny).toContain("Edit(./me/identity/**)");
    expect(s.permissions.deny).toContain("Edit(./me/employment/**)");
    expect(s.permissions.deny.some((r: string) => r.startsWith("Write("))).toBe(false);
    for (const d of ["me/identity", "me/employment"]) {
      expect(fs.statSync(path.join(root, d)).mode & 0o777).toBe(0o700);
    }
    expect(s.enabledPlugins).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("me/identity");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("me/identity/");
  });
  it("refuses an existing workspace or a non-empty folder", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    expect(() => initWorkspace(root)).toThrow(new RegExp(`already a ${identity.name} workspace`));
    const other = tmpDir();
    fs.writeFileSync(path.join(other, "notes.txt"), "x");
    expect(() => initWorkspace(other)).toThrow(/not empty/);
  });
});
