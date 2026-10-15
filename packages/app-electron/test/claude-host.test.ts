import path from "node:path";
import { describe, expect, it } from "vitest";
import { electronClaudeHost, mcpLaunch, terminalCommand } from "../src/claude-host.js";

describe("Claude Code host", () => {
  it("loads the plugin from the app, never from the person's Claude setup", () => {
    const dev = electronClaudeHost({ packaged: false, resourcesPath: "/r", here: "/repo/packages/app-electron/dist", execPath: "/e/Electron" });
    expect(dev.pluginDir).toBe(path.join("/repo", "plugin"));
    expect(dev.mcp).toEqual({ command: "/e/Electron", args: [path.join("/repo/packages/app-electron/dist", "mcp.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } });
    const app = electronClaudeHost({ packaged: true, resourcesPath: "/A/Resources", here: "/A/Resources/app.asar/dist", execPath: "/A/CareerOS" });
    expect(app.pluginDir).toBe(path.join("/A/Resources", "careeros-plugin"));
    expect(app.mcp.args[0]).toBe(path.join("/A/Resources/app.asar.unpacked/dist", "mcp.mjs"));
    expect(mcpLaunch("/x/node", "/d").env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("opens a terminal without a shell on macOS and Linux", () => {
    expect(terminalCommand("darwin", "/opt/homebrew/bin/claude")).toEqual({ cmd: "open", args: ["-a", "Terminal", "/opt/homebrew/bin/claude"], verbatim: false });
    expect(terminalCommand("linux", "/usr/local/bin/claude")).toEqual({ cmd: "x-terminal-emulator", args: ["-e", "/usr/local/bin/claude"], verbatim: false });
    expect(terminalCommand("darwin", "claude")).toBeNull();
  });

  it("on Windows quotes the path once and refuses anything cmd.exe would read as syntax", () => {
    const ok = terminalCommand("win32", "C:\\Users\\Alex Example\\AppData\\Roaming\\npm\\claude.cmd");
    expect(ok).toEqual({ cmd: "cmd.exe", args: ["/d", "/s", "/c", '"start "" "C:\\Users\\Alex Example\\AppData\\Roaming\\npm\\claude.cmd""'], verbatim: true });
    for (const bad of ['C:\\a&calc\\claude.exe', "C:\\a%PATH%\\claude.exe", 'C:\\a"b\\claude.exe', "C:\\a^b\\claude.exe", "C:\\a|b\\claude.exe", "C:\\a!b!\\claude.exe"]) {
      expect(terminalCommand("win32", bad), bad).toBeNull();
    }
  });
});

describe("Claude Code host and the app identity", () => {
  it("never renames the app or moves userData: no electron import, no setName or setPath", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/claude-host.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "electron"/);
    expect(src).not.toMatch(/setName|setPath|getPath\("userData"\)/);
  });
});
