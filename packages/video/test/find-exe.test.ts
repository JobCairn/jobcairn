import { describe, expect, it } from "vitest";
import { exeCandidates, findExecutable, safePathDirs, winExecExts } from "../src/find-exe.js";

describe("find-exe", () => {
  it("POSIX: the bare name in each absolute folder, relative and empty entries skipped", () => {
    expect(safePathDirs("/a::.:rel:/b", "darwin")).toEqual(["/a", "/b"]);
    expect(exeCandidates("/a", "node", "linux")).toEqual(["/a/node"]);
    expect(findExecutable("node", { platform: "darwin", env: { PATH: "/a:/b" }, exists: (p) => p === "/b/node" })).toBe("/b/node");
  });

  it("Windows: drive-letter folders only, quotes stripped, `Path` read when PATH is missing", () => {
    expect(safePathDirs('C:\\a;"C:\\Program Files\\nodejs";\\tools;.;rel;;D:/b', "win32")).toEqual(["C:\\a", "C:\\Program Files\\nodejs", "D:/b"]);
    const env = { Path: '"C:\\Program Files\\nodejs"', PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(findExecutable("node", { platform: "win32", env, exists: (p) => p === "C:\\Program Files\\nodejs\\node.EXE" })).toBe("C:\\Program Files\\nodejs\\node.EXE");
  });

  it("Windows: tries the runnable PATHEXT extensions in order, never a shim or a bare name", () => {
    expect(winExecExts({ PATHEXT: ".CMD;.exe;.BAT;.COM" })).toEqual([".exe", ".COM"]);
    expect(winExecExts({ PATHEXT: "" })).toEqual([".COM", ".EXE"]);
    expect(exeCandidates("C:\\t", "py", "win32", { PATHEXT: ".EXE;.CMD" })).toEqual(["C:\\t\\py.EXE"]);
    expect(exeCandidates("C:\\t", "python.exe", "win32")).toEqual(["C:\\t\\python.exe"]);
    expect(findExecutable("npm", { platform: "win32", env: { PATH: "C:\\n" }, exists: (p) => p === "C:\\n\\npm.CMD" || p === "C:\\n\\npm" })).toBeNull();
  });
});
