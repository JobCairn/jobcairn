import { describe, expect, it } from "vitest";
import { expandWinVars, findGitBash, parseRegPath, readMachinePath, REG_PATH_KEYS } from "../src/win-paths.js";

// Windows (simulated): registry output and files are injected; nothing here runs reg.exe.
const ENV = { USERPROFILE: "C:\\Users\\alex", LOCALAPPDATA: "C:\\Users\\alex\\AppData\\Local", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" };

const regOut = (type: string, value: string) => `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ${type}    ${value}\r\n\r\n`;

describe("Windows' saved PATH (simulated)", () => {
  it("expands %variables% without case, and drops a folder whose variable isn't set", () => {
    expect(expandWinVars("%userprofile%\\bin", ENV)).toBe("C:\\Users\\alex\\bin");
    expect(expandWinVars("%NOT_SET%\\bin", ENV)).toBeNull();
  });

  it("reads reg query's Path value: expanded, quotes stripped, relative and unknown folders left out", () => {
    const out = regOut("REG_EXPAND_SZ", '%SystemRoot%\\system32;%LOCALAPPDATA%\\Microsoft\\WinGet\\Links;"C:\\Program Files\\Git\\cmd";relative;%NOPE%\\x;;');
    expect(parseRegPath(out, ENV)).toEqual(["C:\\Windows\\system32", "C:\\Users\\alex\\AppData\\Local\\Microsoft\\WinGet\\Links", "C:\\Program Files\\Git\\cmd"]);
    expect(parseRegPath(regOut("REG_SZ", "D:\\Tools"), ENV)).toEqual(["D:\\Tools"]);
    expect(parseRegPath("ERROR: The system was unable to find the specified registry key or value.", ENV)).toEqual([]);
  });

  it("asks the machine's key, then the person's, once each, and lists each folder once", () => {
    const asked: string[] = [];
    const query = (key: string) => {
      asked.push(key);
      return key.startsWith("HKLM") ? regOut("REG_EXPAND_SZ", "%SystemRoot%\\system32;C:\\Program Files\\nodejs\\") : key.startsWith("HKCU") ? regOut("REG_EXPAND_SZ", "c:\\windows\\SYSTEM32;%LOCALAPPDATA%\\Programs\\Python\\Python312\\") : null;
    };
    expect(readMachinePath(ENV, query)).toEqual(["C:\\Windows\\system32", "C:\\Program Files\\nodejs\\", "C:\\Users\\alex\\AppData\\Local\\Programs\\Python\\Python312\\"]);
    expect(asked).toEqual([...REG_PATH_KEYS]);
    expect(readMachinePath(ENV, () => null)).toEqual([]);
  });
});

describe("findGitBash (simulated Windows)", () => {
  const has = (...files: string[]) => (p: string) => files.includes(p);

  it("finds Git's usual folders, all users first, then one person's", () => {
    expect(findGitBash({ env: ENV, exists: has("C:\\Program Files\\Git\\bin\\bash.exe"), machinePath: () => [] })).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    const mine = "C:\\Users\\alex\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    expect(findGitBash({ env: ENV, exists: has(mine), machinePath: () => [] })).toBe(mine);
    expect(findGitBash({ env: ENV, exists: () => false, machinePath: () => [] })).toBeNull();
  });

  it("uses the person's own CLAUDE_CODE_GIT_BASH_PATH first, when that file is there", () => {
    const own = "D:\\PortableGit\\bin\\bash.exe";
    const env = { ...ENV, CLAUDE_CODE_GIT_BASH_PATH: own };
    expect(findGitBash({ env, exists: has(own, "C:\\Program Files\\Git\\bin\\bash.exe"), machinePath: () => [] })).toBe(own);
    expect(findGitBash({ env, exists: has("C:\\Program Files\\Git\\bin\\bash.exe"), machinePath: () => [] })).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("works out bash.exe from a git.exe on PATH or on the saved PATH, and needs bash.exe to be there", () => {
    const env = { ...ENV, PATH: "E:\\Git\\cmd" };
    expect(findGitBash({ env, exists: has("E:\\Git\\cmd\\git.exe", "E:\\Git\\bin\\bash.exe"), machinePath: () => [] })).toBe("E:\\Git\\bin\\bash.exe");
    expect(findGitBash({ env, exists: has("E:\\Git\\cmd\\git.exe"), machinePath: () => [] })).toBeNull();
    expect(findGitBash({ env: ENV, exists: has("F:\\Git\\mingw64\\bin\\git.exe", "F:\\Git\\bin\\bash.exe"), machinePath: () => ["F:\\Git\\mingw64\\bin"] })).toBe("F:\\Git\\bin\\bash.exe");
  });
});
