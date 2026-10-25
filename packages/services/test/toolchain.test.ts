import { describe, expect, it } from "vitest";
import { findBrew, findNpm, findTool, NODE, probeEnv, PYTHON, readVersion, STORE_PROBE_MS, supportedMinors, toolPath, whichTool } from "../src/toolchain.js";
import { WIN_PYTHON_FOLDERS, winExtraDirs } from "../src/win-paths.js";
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

describe("Windows (simulated)", () => {
  const env = { Path: "C:\\Windows\\system32;\"C:\\Program Files\\nodejs\";C:\\Python312;C:\\ffmpeg\\bin;relative;\\rooted", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("finds node.exe and python.exe through PATHEXT, reading `Path`, never a shim", () => {
    const versions: Record<string, string> = { "C:\\Program Files\\nodejs\\node.EXE": "22.13.0", "C:\\Python312\\python.EXE": "3.12.4", "C:\\Windows\\system32\\node.CMD": "22.0.0" };
    const o = { platform: "win32" as const, isExec: (p: string) => p in versions, probe: (p: string) => versions[p] ?? null };
    expect(findTool(NODE, env, o).tool?.path).toBe("C:\\Program Files\\nodejs\\node.EXE");
    expect(findTool(PYTHON, env, o).tool).toEqual({ path: "C:\\Python312\\python.EXE", version: "3.12.4", ok: true });
  });

  it("falls back to the py launcher with each supported version, newest first, and runs the python.exe it names", () => {
    const py = "C:\\Windows\\system32\\py.EXE";
    const p312 = "C:\\Users\\alex\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";
    const asked: string[] = [];
    // The launcher's default is a 3.15 (too new); asked for 3.12 by name it names a real 3.12.
    const pyPython = (l: string, v: string) => { asked.push(`${l} -${v}`); return v === "3.12" ? p312 : null; };
    const r = findTool(PYTHON, env, { platform: "win32", extra: [], isExec: (p) => p === py || p === p312, probe: (p) => (p === p312 ? "3.12.7" : "3.15.0"), pyPython });
    expect(r.tool).toEqual({ path: p312, version: "3.12.7", ok: true });
    expect(asked).toEqual([`${py} -3.14`, `${py} -3.13`, `${py} -3.12`]);
    expect(supportedMinors(PYTHON)).toEqual(["3.14", "3.13", "3.12", "3.11"]);
    // python.org's folders searched on Windows follow the same range.
    expect([...WIN_PYTHON_FOLDERS]).toEqual(supportedMinors(PYTHON).map((v) => `Python${v.replace(".", "")}`));
  });

  describe("a tool installed after the app started (its PATH is older)", () => {
    const LOCAL = "C:\\Users\\alex\\AppData\\Local";
    const winEnv = { Path: "C:\\Windows\\system32", LOCALAPPDATA: LOCAL, ProgramFiles: "C:\\Program Files", PATHEXT: ".COM;.EXE" };
    const known = (readdir: (d: string) => string[] = () => []) => winExtraDirs(winEnv, { machinePath: () => [], readdir });

    it("finds Node.js in Program Files\\nodejs and in the person's Programs\\nodejs", () => {
      for (const node of ["C:\\Program Files\\nodejs\\node.EXE", `${LOCAL}\\Programs\\nodejs\\node.EXE`]) {
        const r = findTool(NODE, winEnv, { platform: "win32", extra: known(), isExec: (p) => p === node, probe: () => "22.13.0" });
        expect(r.tool?.path).toBe(node);
      }
    });

    it("finds python.org's per-person Python, newest supported first, and never a 3.15 there", () => {
      const has: Record<string, string> = { [`${LOCAL}\\Programs\\Python\\Python315\\python.EXE`]: "3.15.0", [`${LOCAL}\\Programs\\Python\\Python312\\python.EXE`]: "3.12.7", [`${LOCAL}\\Programs\\Python\\Python311\\python.EXE`]: "3.11.9" };
      const r = findTool(PYTHON, winEnv, { platform: "win32", extra: known(), isExec: (p) => p in has, probe: (p) => has[p] ?? null, pyPython: () => null });
      expect(r.tool?.path).toBe(`${LOCAL}\\Programs\\Python\\Python312\\python.EXE`);
    });

    it("finds winget's ffmpeg in its Links folder, else in Gyan.FFmpeg's newest bin folder", () => {
      const pkgs = `${LOCAL}\\Microsoft\\WinGet\\Packages`;
      const readdir = (d: string) => (d === pkgs ? ["Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "Other.Tool"] : d.startsWith(`${pkgs}\\Gyan.FFmpeg`) ? ["ffmpeg-7.0-full_build", "ffmpeg-7.1-full_build"] : []);
      const linked = `${LOCAL}\\Microsoft\\WinGet\\Links\\ffmpeg.EXE`;
      expect(whichTool("ffmpeg", winEnv, { platform: "win32", extra: known(readdir), isExec: (p) => p === linked })).toBe(linked);
      const newest = `${pkgs}\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-7.1-full_build\\bin\\ffmpeg.EXE`;
      const older = newest.replace("7.1", "7.0");
      expect(whichTool("ffmpeg", winEnv, { platform: "win32", extra: known(readdir), isExec: (p) => p === newest || p === older })).toBe(newest);
    });

    it("finds a tool on Windows' saved PATH, after the app's own PATH", () => {
      const extra = winExtraDirs(winEnv, { machinePath: () => ["D:\\Tools\\ffmpeg\\bin"], readdir: () => [] });
      expect(extra[0]).toBe("D:\\Tools\\ffmpeg\\bin");
      expect(whichTool("ffmpeg", winEnv, { platform: "win32", extra, isExec: (p) => p === "D:\\Tools\\ffmpeg\\bin\\ffmpeg.EXE" })).toBe("D:\\Tools\\ffmpeg\\bin\\ffmpeg.EXE");
      expect(toolPath("C:\\Windows\\system32;d:\\tools\\ffmpeg\\bin", "win32", { extra })).toBe("C:\\Windows\\system32;d:\\tools\\ffmpeg\\bin;" + extra.slice(1).join(";"));
    });

    it("tries the Microsoft Store's python.exe last, with a short limit, and passes over the stand-in that gives no version", () => {
      const store = `${LOCAL}\\Microsoft\\WindowsApps`;
      const env2 = { ...winEnv, Path: `${store};C:\\Python312` };
      const limits: (number | undefined)[] = [];
      const versions: Record<string, string | null> = { [`${store}\\python.EXE`]: null, "C:\\Python312\\python.EXE": "3.12.4" };
      const probe = (p: string, o?: { timeoutMs?: number }) => { if (p.startsWith(store)) limits.push(o?.timeoutMs); return versions[p] ?? null; };
      const isExec = (p: string) => p in versions;
      expect(findTool(PYTHON, env2, { platform: "win32", extra: [], isExec, probe, pyPython: () => null }).tool?.path).toBe("C:\\Python312\\python.EXE");
      expect(limits).toEqual([]);
      // Only the stand-in: asked quickly, and it doesn't count.
      versions["C:\\Python312\\python.EXE"] = null;
      expect(findTool(PYTHON, env2, { platform: "win32", extra: [], isExec, probe, pyPython: () => null }).tool).toBeNull();
      expect(limits).toEqual([STORE_PROBE_MS]);
      // A real Store Python answers with a version, so it counts.
      versions[`${store}\\python.EXE`] = "3.12.10";
      expect(findTool(PYTHON, env2, { platform: "win32", extra: [], isExec, probe, pyPython: () => null }).tool?.path).toBe(`${store}\\python.EXE`);
    });
  });

  it("whichTool returns ffmpeg.exe, never ffmpeg.cmd or a bare name", () => {
    expect(whichTool("ffmpeg", env, { platform: "win32", isExec: (p) => p === "C:\\ffmpeg\\bin\\ffmpeg.EXE" })).toBe("C:\\ffmpeg\\bin\\ffmpeg.EXE");
    expect(whichTool("ffmpeg", env, { platform: "win32", isExec: (p) => /ffmpeg(\.CMD|\.BAT)?$/.test(p) })).toBeNull();
  });

  it("runs npm as node.exe <node folder>\\node_modules\\npm\\bin\\npm-cli.js, never npm.cmd", () => {
    const node = "C:\\Program Files\\nodejs\\node.EXE";
    const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const o = { platform: "win32" as const, isExec: (p: string) => p === node || p === cli, probe: () => "22.13.0" };
    expect(findNpm(env, o)).toEqual({ npm: cli, node: { path: node, version: "22.13.0", ok: true }, cmd: node, pre: [cli] });
    expect(findNpm(env, { ...o, isExec: (p: string) => p === node || p.endsWith("npm.cmd") })).toBeNull();
  });

  it("macOS npm runs as itself", () => {
    const exec = new Set(["/opt/homebrew/bin/node", "/opt/homebrew/bin/npm"]);
    expect(findNpm({ PATH: "" }, { platform: "darwin", exists: BREW, isExec: (p) => exec.has(p), probe: () => "22.13.0" })).toMatchObject({ npm: "/opt/homebrew/bin/npm", cmd: "/opt/homebrew/bin/npm", pre: [] });
  });

  it("a version probe gets the Windows system variables, and nothing else beyond PATH and HOME", () => {
    const source = { HOME: "/h", SystemRoot: "C:\\Windows", windir: "C:\\Windows", TEMP: "C:\\t", PATHEXT: ".EXE", USERPROFILE: "C:\\Users\\alex", ANTHROPIC_API_KEY: "sk-must-not-leak" };
    expect(probeEnv("C:\\Python312\\python.exe", "win32", source)).toEqual({ PATH: "C:\\Python312", HOME: "/h", SystemRoot: "C:\\Windows", windir: "C:\\Windows", TEMP: "C:\\t", PATHEXT: ".EXE", USERPROFILE: "C:\\Users\\alex" });
    expect(probeEnv("/opt/homebrew/bin/node", "darwin", source)).toEqual({ PATH: "/opt/homebrew/bin", HOME: "/h" });
  });
});
