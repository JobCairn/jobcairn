import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeChmod } from "../src/perm.js";
import { initWorkspace } from "../src/workspace.js";
import { writeFileAtomic } from "../src/store.js";
import { FIXED, tmpDir } from "./helpers.js";

const realPlatform = process.platform;
afterEach(() => { Object.defineProperty(process, "platform", { value: realPlatform }); vi.restoreAllMocks(); });

describe("safeChmod", () => {
  it("is a no-op on Windows", () => {
    const spy = vi.spyOn(fs, "chmodSync");
    expect(safeChmod(path.join(tmpDir(), "x"), 0o600, "win32")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
  it("chmods elsewhere", () => {
    if (realPlatform === "win32") return;
    const f = path.join(tmpDir(), "x");
    fs.writeFileSync(f, "x");
    expect(safeChmod(f, 0o600)).toBe(true);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
  it("lets init and atomic writes run without chmod on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const spy = vi.spyOn(fs, "chmodSync");
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    writeFileAtomic(path.join(root, "settings", ".env"), "# fictional\n", 0o600);
    expect(spy).not.toHaveBeenCalled();
  });
});
