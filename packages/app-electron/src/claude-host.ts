import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { nodeProcessRunner, type ClaudeHost, type McpLaunch } from "@careeros/services";

/**
 * Main-process access for the Claude Code engine (spec 2026-10-10). The renderer never sees these paths.
 * Nothing here installs anything into Claude Code: the plugin folder is passed per run with --plugin-dir, and
 * the `careeros mcp` server is this app's own runtime running the bundled mcp.mjs.
 * Development: <repo>/plugin and packages/app-electron/dist/mcp.mjs. Packaged (installer carry):
 * resources/careeros-plugin, and mcp.mjs unpacked next to main.js (asarUnpack).
 */
export function electronClaudeHost(opts: { packaged: boolean; resourcesPath: string; here: string; execPath?: string }): ClaudeHost {
  const pluginDir = bundledPluginDir(opts);
  const here = opts.packaged ? opts.here.replace(/app\.asar(?=[\\/]|$)/, "app.asar.unpacked") : opts.here;
  return {
    runner: nodeProcessRunner(), platform: process.platform, env: process.env, home: os.homedir(), pluginDir,
    mcp: mcpLaunch(opts.execPath ?? process.execPath, here),
    openTerminal: (cli) => openTerminal(process.platform, cli),
  };
}

/** The CareerOS plugin folder: <repo>/plugin in development, resources/careeros-plugin when packaged. */
export function bundledPluginDir(opts: { packaged: boolean; resourcesPath: string; here: string }): string {
  return opts.packaged ? path.join(opts.resourcesPath, "careeros-plugin") : path.join(path.resolve(opts.here, "..", "..", ".."), "plugin");
}

/**
 * A packaged app has no repo above it, so services' plugin lookups (the narrator script) can't walk up to
 * plugin/. Point them at the bundled copy unless the person set CAREEROS_PLUGIN_ROOT themselves.
 */
export function pluginRootEnv(env: NodeJS.ProcessEnv, opts: { packaged: boolean; resourcesPath: string; here: string }): string | null {
  if (!opts.packaged || env.CAREEROS_PLUGIN_ROOT) return null;
  return bundledPluginDir(opts);
}

/** Electron's own binary run as plain Node (ELECTRON_RUN_AS_NODE), so the MCP server needs no separate Node install. */
export function mcpLaunch(execPath: string, here: string): McpLaunch {
  return { command: execPath, args: [path.join(here, "mcp.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** Characters cmd.exe would still act on inside quotes. A CLI path with any of them isn't opened on Windows. */
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

/**
 * The command that opens a terminal window running Claude Code. No shell string is built from the path except
 * on Windows, where a new console window needs `start`: the path is quoted once and refused if cmd.exe could
 * read anything in it as syntax. Null: don't try.
 */
export function terminalCommand(platform: NodeJS.Platform, cli: string): { cmd: string; args: string[]; verbatim: boolean } | null {
  if (!(platform === "win32" ? path.win32 : path.posix).isAbsolute(cli)) return null;
  if (platform === "darwin") return { cmd: "open", args: ["-a", "Terminal", cli], verbatim: false };
  if (platform === "win32") {
    if (CMD_UNSAFE.test(cli)) return null;
    // cmd /s strips the outer quotes, leaving: start "" "C:\path\claude.exe"
    return { cmd: "cmd.exe", args: ["/d", "/s", "/c", `"start "" "${cli}""`], verbatim: true };
  }
  return { cmd: "x-terminal-emulator", args: ["-e", cli], verbatim: false };
}

/** Opens a terminal window running Claude Code so the person signs in there. */
export function openTerminal(platform: NodeJS.Platform, cli: string): Promise<boolean> {
  const c = terminalCommand(platform, cli);
  if (!c) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore", windowsHide: false, shell: false, windowsVerbatimArguments: c.verbatim });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
