import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { e2eHome } from "../src/e2e.js";
import { accountFullName, sampleDirFor } from "../src/onboarding-host.js";

describe("onboarding host", () => {
  it("bundles the example from the repo in development and from resources when packaged", () => {
    const here = "/fictional/repo/packages/app-electron/dist";
    expect(sampleDirFor({ packaged: false, resourcesPath: "/fictional/res", here })).toBe(path.join("/fictional/repo", "samples", "alex-example"));
    expect(sampleDirFor({ packaged: true, resourcesPath: "/fictional/res", here })).toBe(path.join("/fictional/res", "careeros-example"));
  });

  it("reads the macOS account's full name with `id -F`, and gives up quietly", async () => {
    const run = vi.fn(async () => "Alex Example\n");
    expect(await accountFullName("darwin", run)).toBe("Alex Example");
    expect(run).toHaveBeenCalledWith("id", ["-F"]);
    expect(await accountFullName("darwin", async () => { throw new Error("no"); })).toBe("");
    expect(await accountFullName("darwin", async () => "x".repeat(500))).toBe("");
  });

  it("doesn't look up a name on other systems", async () => {
    const run = vi.fn(async () => "Alex Example");
    expect(await accountFullName("linux", run)).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("an unpackaged end-to-end run can use a temporary home folder", () => {
    expect(e2eHome({ CAREEROS_HOME_OVERRIDE: "/fictional/home" }, false)).toBe("/fictional/home");
    expect(e2eHome({ CAREEROS_HOME_OVERRIDE: "/fictional/home" }, true)).toBeNull();
    expect(e2eHome({ CAREEROS_HOME_OVERRIDE: "relative" }, false)).toBeNull();
    expect(e2eHome({}, false)).toBeNull();
  });
});
