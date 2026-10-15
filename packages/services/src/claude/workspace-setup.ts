import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PLUGIN_REL, claudeMode, claudePluginDir, expectedClaudeSettings, withBrowsingBlock, writeClaudeSettings, writeFileAtomic, type Clock } from "@careeros/core";
import { CLI_REL, installChromeCli } from "../chrome/cli.js";
import type { McpLaunch } from "./args.js";

/**
 * The one-time Claude setup of a workspace, idempotent (Repair runs it again; every run checks it first):
 * - `.claude/settings.json`: the deny rules (locked folders, app folders, secrets, Claude's own settings) and the
 *   allow rules for the workspace's mode (auto, or dontAsk with a short list). Never anything outside the workspace.
 * - CLAUDE.md: the managed Do and Don't block for browsing (core browsing.ts); the rest of the file is the person's.
 * - `.careeros/bin/jobcairn-chrome`: the browser command, pointed at this copy of the app.
 * - `.careeros/claude-plugin.json`: this copy of the app's plugin folder. .claude/settings.json then declares it as
 *   a project marketplace (extraKnownMarketplaces "jobcairn", a directory source) and enables careeros@jobcairn, so
 *   a plain `claude` session opened in the workspace loads the JobCairn skills once the person trusts the folder.
 *   The app's own runs load the plugin with --plugin-dir and don't depend on it.
 * - `.careeros/setup.json`: the version stamp, so a newer app knows to refresh the above.
 * Nothing is written outside the workspace and nothing is installed into the person's own Claude Code settings.
 */
export const SETUP_VERSION = 2;
const STAMP_REL = ".careeros/setup.json";

export interface WorkspaceSetup {
  version: number;
  /** The stamp is this app's version and every part is in place. */
  current: boolean;
  settings: boolean;
  claude_md: boolean;
  browser_command: boolean;
  /** Interactive sessions load the JobCairn skills: the plugin folder is recorded and declared in the settings. */
  plugin: boolean;
  auto_mode: boolean;
}

function readStamp(root: string): number {
  try { const j = JSON.parse(fs.readFileSync(path.join(root, STAMP_REL), "utf8")) as { version?: unknown }; return typeof j.version === "number" ? j.version : 0; } catch { return 0; }
}

function claudeMdOk(root: string): boolean {
  try { const md = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"); return withBrowsingBlock(md) === md; } catch { return false; }
}

/** What's in place now, without changing anything. */
export function workspaceSetup(root: string, mcp: McpLaunch | null, pluginDir: string | null = null): WorkspaceSetup {
  let settings = false;
  try { settings = writeClaudeSettingsDry(root); } catch { settings = false; }
  let browser = false;
  try {
    const have = fs.readFileSync(path.join(root, CLI_REL), "utf8");
    browser = !mcp || have.includes(` chrome --workspace `);
  } catch { browser = false; }
  // With no plugin folder known (tests, a host without Claude) there is nothing to register.
  const plugin = !pluginDir || (claudePluginDir(root) === path.resolve(pluginDir) && settings);
  const parts = { settings, claude_md: claudeMdOk(root), browser_command: browser, plugin };
  const version = readStamp(root);
  return { version, current: version === SETUP_VERSION && parts.settings && parts.claude_md && parts.browser_command && parts.plugin, ...parts, auto_mode: claudeMode(root) === "auto" };
}

/** True when .claude/settings.json already says what it should. */
function writeClaudeSettingsDry(root: string): boolean {
  try { return fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8") === expectedClaudeSettings(root); } catch { return false; }
}

/** Puts every part in place (only what differs is written) and stamps the version. */
export function ensureWorkspaceSetup(root: string, mcp: McpLaunch | null, c?: Clock, pluginDir: string | null = null): WorkspaceSetup {
  if (pluginDir) {
    const want = `${JSON.stringify({ dir: path.resolve(pluginDir) })}\n`;
    let have = "";
    try { have = fs.readFileSync(path.join(root, CLAUDE_PLUGIN_REL), "utf8"); } catch { have = ""; }
    if (have !== want) { fs.mkdirSync(path.join(root, ".careeros"), { recursive: true }); writeFileAtomic(path.join(root, CLAUDE_PLUGIN_REL), want); }
  }
  writeClaudeSettings(root, c);
  const mdFile = path.join(root, "CLAUDE.md");
  let md = "";
  try { md = fs.readFileSync(mdFile, "utf8"); } catch { md = ""; }
  const want = withBrowsingBlock(md);
  if (want !== md) writeFileAtomic(mdFile, want);
  if (mcp) installChromeCli(root, mcp);
  if (readStamp(root) !== SETUP_VERSION) {
    fs.mkdirSync(path.join(root, ".careeros"), { recursive: true });
    writeFileAtomic(path.join(root, STAMP_REL), `${JSON.stringify({ version: SETUP_VERSION })}\n`);
  }
  return workspaceSetup(root, mcp, pluginDir);
}
