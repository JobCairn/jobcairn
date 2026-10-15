import { describe, expect, it } from "vitest";
import { findBrew, findNpm, findTool, NODE, PYTHON, readVersion, toolPath, whichTool } from "../src/toolchain.js";
import { toolEnv } from "../src/tts-runner.js";

const BREW = (p: string) => p === "/opt/homebrew/bin" || p === "/opt/homebrew/sbin";

describe("toolPath", () => {
  it("puts the Homebrew folders that exist first, then the person's PATH, then system folders, each once", () => {
    expect(toolPath("/usr/bin:/bin:/opt/homebrew/bin", "darwin", { exists: BREW })).toBe("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(toolPath("/usr/bin", "darwin", { exists: (p) => p === "/usr/local/bin" })).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(toolPath(undefined, "darwin", { exists: () => false })).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("puts a picked tool's folder before everything", () => {
    expect(toolPath("/usr/bin", "darwin", { first: ["/fictional/nvm/v22/bin"], exists: BREW }).split(":").slice(0, 3)).toEqual(["/fictional/nvm/v22/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin"]);
  });

  it("leaves other systems' PATH order alone", () => {
    expect(toolPath("/a:/b", "linux", { exists: () => true })).toBe("/a:/b:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(toolPath("C:\\bin", "win32", { exists: () => true })).toBe("C:\\bin");
  });

  it("toolEnv (read aloud) is the same toolPath", () => {
    expect(toolEnv({ PATH: "/a" }, "linux").PATH).toBe("/a:/usr/bin:/bin:/usr/sbin:/sbin");
  });
});

describe("findTool", () => {
  const env = { PATH: "/usr/bin:/fictional/old/bin:/fictional/new/bin" };

  it("picks the first new-enough node, not just the first found", () => {
    const versions: Record<string, string> = { "/opt/homebrew/bin/node": "18.20.1", "/fictional/old/bin/node": "20.11.0", "/fictional/new/bin/node": "22.13.0" };
    const r = findTool(NODE, env, { platform: "darwin", exists: BREW, isExec: (p) => p in versions, probe: (p) => versions[p] ?? null });
    expect(r.tool).toEqual({ path: "/fictional/new/bin/node", version: "22.13.0", ok: true });
    expect(r.seen.map((s) => s.version)).toEqual(["22.13.0", "18.20.1", "20.11.0"]);
  });

  it("reports too-old ones when nothing is new enough", () => {
    const r = findTool(NODE, env, { platform: "darwin", exists: BREW, isExec: (p) => p === "/fictional/old/bin/node", probe: () => "20.11.0" });
    expect(r.tool).toBeNull();
    expect(r.seen).toEqual([{ path: "/fictional/old/bin/node", version: "20.11.0", ok: false }]);
  });

  it("never runs Apple's /usr/bin/python3, and finds Homebrew's versioned python3.12", () => {
    const probed: string[] = [];
    const versions: Record<string, string> = { "/usr/bin/python3": "3.9.6", "/opt/homebrew/bin/python3.12": "3.12.15" };
    const r = findTool(PYTHON, { PATH: "/usr/bin:/bin" }, { platform: "darwin", exists: BREW, isExec: (p) => p in versions, probe: (p) => { probed.push(p); return versions[p] ?? null; } });
    expect(r.tool?.path).toBe("/opt/homebrew/bin/python3.12");
    expect(probed).not.toContain("/usr/bin/python3");
  });

  it("passes over a Python the voice can't use yet (3.15) for a supported one", () => {
    const versions: Record<string, string> = { "/opt/homebrew/bin/python3": "3.15.0", "/opt/homebrew/bin/python3.14": "3.14.8" };
    const r = findTool(PYTHON, { PATH: "" }, { platform: "darwin", exists: BREW, isExec: (p) => p in versions, probe: (p) => versions[p] ?? null });
    expect(r.tool?.path).toBe("/opt/homebrew/bin/python3.14");
  });

  it("skips a program whose version can't be read", () => {
    const r = findTool(NODE, { PATH: "/a:/b" }, { platform: "linux", isExec: () => true, probe: (p) => (p === "/b/node" ? "22.1.0" : null) });
    expect(r.tool?.path).toBe("/b/node");
  });
});

describe("findNpm, whichTool, findBrew", () => {
  it("takes npm from the folder of the node that was picked", () => {
    const exec = new Set(["/opt/homebrew/bin/node", "/opt/homebrew/bin/npm", "/fictional/new/bin/node", "/fictional/new/bin/npm"]);
    const versions: Record<string, string> = { "/opt/homebrew/bin/node": "18.0.0", "/fictional/new/bin/node": "24.1.0" };
    const r = findNpm({ PATH: "/fictional/new/bin" }, { platform: "darwin", exists: BREW, isExec: (p) => exec.has(p), probe: (p) => versions[p] ?? null });
    expect(r?.npm).toBe("/fictional/new/bin/npm");
    expect(findNpm({ PATH: "" }, { platform: "darwin", exists: BREW, isExec: (p) => p.endsWith("/node"), probe: () => "22.0.0" })).toBeNull();
  });

  it("finds ffmpeg in Homebrew before /usr/local or PATH, and Homebrew itself by file", () => {
    expect(whichTool("ffmpeg", { PATH: "/fictional/bin" }, { platform: "darwin", exists: BREW, isExec: (p) => p.endsWith("/ffmpeg") })).toBe("/opt/homebrew/bin/ffmpeg");
    expect(findBrew((p) => p === "/usr/local/bin/brew")).toBe("/usr/local/bin/brew");
    expect(findBrew(() => false)).toBeNull();
  });

  it("reads versions from --version output", () => {
    expect(readVersion("v22.13.0\n")).toBe("22.13.0");
    expect(readVersion("Python 3.12.15")).toBe("3.12.15");
    expect(readVersion("ffmpeg version 7.1")).toBe("7.1.0");
    expect(readVersion("nothing")).toBeNull();
  });
});
