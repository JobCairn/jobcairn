import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeRunner, findOnPath } from "@careeros/video";
import { electronVideoHost, gsapPath, withBrewPath } from "../src/video-host.js";

const BASE = {
  pluginRoot: "/fictional/repo/plugin", distDir: "/fictional/repo/packages/app-electron/dist", resourcesPath: "/fictional/Resources",
  platform: "darwin" as const, home: "/fictional/home", env: { PATH: "/fictional/bin" }, exists: () => true,
};

/** A Homebrew node 22 with npm beside it. */
const NODE_OK = { isExec: (p: string) => p === "/opt/homebrew/bin/node" || p === "/opt/homebrew/bin/npm", probe: () => "22.13.0" };

describe("gsapPath", () => {
  it("prefers the copy next to the bundle and falls back to the package", () => {
    expect(gsapPath("/d", (p) => p === "/d/vendor/gsap.min.js")).toBe("/d/vendor/gsap.min.js");
    expect(gsapPath("/d", () => false)).toMatch(/gsap[\\/]dist[\\/]gsap\.min\.js$/);
  });
});

describe("install hand-off", () => {
  it("puts Homebrew's folders first in the render PATH on macOS only, so Finder's /usr/bin can't shadow them", () => {
    const has = (p: string) => p === "/opt/homebrew/bin" || p === "/opt/homebrew/bin/ffmpeg";
    const mac = electronVideoHost({ ...BASE, packaged: true, exists: has, confirm: async () => false });
    expect(mac.env.PATH).toBe("/opt/homebrew/bin:/fictional/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    const toolsEnv = { runner: fakeRunner(() => ({})), platform: "darwin" as const, env: mac.env, home: "/fictional/home", pluginDir: "/p", exists: has, isFile: has, readFile: () => "", now: () => new Date(0) };
    expect(findOnPath("ffmpeg", toolsEnv)).toBe("/opt/homebrew/bin/ffmpeg");
    expect(electronVideoHost({ ...BASE, packaged: true, platform: "linux", exists: has, confirm: async () => false }).env.PATH).toBe("/fictional/bin");
    expect(withBrewPath("/usr/bin:/opt/homebrew/bin", "darwin", () => true)).toBe("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("asks first, then runs the shipped setup runner, in development and packaged alike", async () => {
    const runner = fakeRunner(() => ({ stdout: '{"ok":true,"message":"done"}' }));
    let asked = "";
    const dev = electronVideoHost({ ...BASE, packaged: false, runner, ...NODE_OK, confirm: async (m) => { asked = m; return false; } });
    expect(await dev.install!("ffmpeg")).toEqual({ ok: false, message: "Install cancelled." });
    expect(asked).toBe("Install ffmpeg for videos?");
    expect(runner.calls).toHaveLength(0);
    const yes = electronVideoHost({ ...BASE, packaged: false, runner, ...NODE_OK, confirm: async () => true });
    expect(await yes.install!("hyperframes")).toEqual({ ok: true, message: "done" });
    expect(runner.calls[0]!.args).toEqual(["/fictional/repo/scripts/setup/run.mjs", "install", "--only", "hyperframes", "--json", "--components", "/fictional/repo/setup/components"]);
    const packaged = electronVideoHost({ ...BASE, packaged: true, runner, ...NODE_OK, confirm: async () => true });
    expect(await packaged.install!("ffmpeg")).toEqual({ ok: true, message: "done" });
    expect(runner.calls[1]!.args).toEqual(["/fictional/Resources/careeros-setup/run.mjs", "install", "--only", "ffmpeg", "--json", "--components", "/fictional/Resources/careeros-setup/components"]);
  });

  it("offers no install when the runner isn't there (the card then links the install guide)", () => {
    expect(electronVideoHost({ ...BASE, packaged: true, exists: () => false, confirm: async () => true }).install).toBeUndefined();
  });

  it("says which tool to install first, without asking", async () => {
    const runner = fakeRunner(() => ({ stdout: '{"ok":true,"message":"done"}' }));
    let asks = 0;
    const confirm = async () => { asks++; return true; };
    const noBrew = electronVideoHost({ ...BASE, packaged: true, runner, confirm, exists: (p) => !p.endsWith("/brew") });
    expect((await noBrew.install!("ffmpeg")).message).toMatch(/^Homebrew is needed first/);
    const noNode = electronVideoHost({ ...BASE, packaged: true, runner, confirm, isExec: () => false });
    expect((await noNode.install!("hyperframes")).message).toBe("HyperFrames needs Node.js 22 or newer. Install Node.js above first.");
    const oldPython = electronVideoHost({ ...BASE, packaged: true, runner, confirm, isExec: (p) => p.endsWith("/python3"), probe: () => "3.9.6" });
    expect((await oldPython.install!("supertonic")).message).toBe("The Supertonic voice needs Python 3.11 to 3.14. Install Python above first.");
    expect(await noBrew.install!("claude-code")).toEqual({ ok: false, message: "That tool can't be installed from here." });
    expect(asks).toBe(0);
    expect(runner.calls).toHaveLength(0);
  });

  it("uses the fake host only for unpackaged end-to-end runs", () => {
    const fake = electronVideoHost({ ...BASE, packaged: false, env: { CAREEROS_E2E_FAKE_VIDEO: "1" }, confirm: async () => false });
    expect(fake.home).toBe("/fake/home");
    const real = electronVideoHost({ ...BASE, packaged: true, env: { CAREEROS_E2E_FAKE_VIDEO: "1" }, confirm: async () => false });
    expect(real.home).toBe("/fictional/home");
  });

  it("leaves the script writer, narrator and tool check to the services defaults (Claude Code engine, narrate.py, checkTools)", () => {
    const real = electronVideoHost({ ...BASE, packaged: false, confirm: async () => false });
    expect(real.writer).toBeUndefined();
    expect(real.narrator).toBeUndefined();
    expect(real.tools).toBeUndefined();
    expect(real.pluginDir).toBe("/fictional/repo/plugin");
  });
});
