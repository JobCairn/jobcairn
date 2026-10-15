import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeMode, claudeSettings, CLAUDE_MD_BEGIN, LOCKED_DIRS, NEVER_READ, NEVER_WRITE, RAW_BROWSER_DENY, setClaudeMode } from "@careeros/core";
import { actionPaths } from "@careeros/contract";
import { claudeArgs, runMode, type ToolPlan } from "../../src/claude/args.js";
import { mcpToolsFor } from "../../src/claude/mcp/tools.js";
import { ensureWorkspaceSetup, SETUP_VERSION, workspaceSetup } from "../../src/claude/workspace-setup.js";
import { openSample } from "../helpers.js";

const MCP = { command: "/apps/JobCairn", args: ["/apps/mcp.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
const EVERY_DENY = [
  ...LOCKED_DIRS.flatMap((d) => [`Read(./${d}/**)`, `Edit(./${d}/**)`]),
  "Read(./settings/.env)", "Edit(./settings/.env)", "Edit(./.claude/**)", "Edit(./.careeros/**)",
  ...NEVER_WRITE.map((d) => `Edit(./${d}/**)`), ...NEVER_READ.map((d) => `Read(./${d}/**)`), ...RAW_BROWSER_DENY,
];

describe("the workspace's .claude/settings.json: auto mode, and deny rules in both modes", () => {
  it("auto mode: defaultMode auto, the whole workspace readable and writable, every deny rule", () => {
    const s = claudeSettings(LOCKED_DIRS, "auto");
    expect(s.permissions.defaultMode).toBe("auto");
    expect(s.permissions.allow).toEqual(["Read(./**)", "Edit(./**)", "Bash(./.careeros/bin/jobcairn-chrome *)", "Bash(./.careeros/bin/jobcairn-chrome)"]);
    for (const d of EVERY_DENY) expect(s.permissions.deny, d).toContain(d);
  });

  it("auto mode off: dontAsk with reading and the browser command only, and the same deny rules", () => {
    const s = claudeSettings(LOCKED_DIRS, "ask");
    expect(s.permissions.defaultMode).toBe("dontAsk");
    expect(s.permissions.allow).toEqual(["Read(./**)", "Bash(./.careeros/bin/jobcairn-chrome *)", "Bash(./.careeros/bin/jobcairn-chrome)"]);
    for (const d of EVERY_DENY) expect(s.permissions.deny, d).toContain(d);
    // Nothing anywhere asks for bypass, and no allow rule reaches outside the workspace.
    for (const m of ["auto", "ask"] as const) {
      const t = JSON.stringify(claudeSettings(LOCKED_DIRS, m));
      expect(t).not.toMatch(/bypassPermissions|"\/\//);
    }
  });

  it("is on by default, turns off and on again, and the file follows", () => {
    const s = openSample();
    const file = path.join(s.root, ".claude", "settings.json");
    const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as { permissions: { defaultMode: string; allow: string[]; deny: string[] } };
    expect(claudeMode(s.root)).toBe("auto");
    ensureWorkspaceSetup(s.root, MCP);
    expect(read().permissions.defaultMode).toBe("auto");
    expect(setClaudeMode(s.root, "ask")).toBe("ask");
    expect(read().permissions).toMatchObject({ defaultMode: "dontAsk" });
    expect(read().permissions.allow).not.toContain("Edit(./**)");
    for (const d of EVERY_DENY) expect(read().permissions.deny).toContain(d);
    expect(setClaudeMode(s.root, "auto")).toBe("auto");
    expect(read().permissions.allow).toContain("Edit(./**)");
    for (const d of EVERY_DENY) expect(read().permissions.deny).toContain(d);
  });
});

describe("runs: auto mode only where Bash isn't involved", () => {
  const PLACE = { root: "/ws", pluginDir: "/apps/plugin", mcp: MCP };
  const career = (): ToolPlan => {
    const out = actionPaths("score_job", { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }, { now: "2026-01-15T09:00:00.000Z" });
    return { action: "score_job", folder: out.folder, files: out.outputs, web: false, mcp: mcpToolsFor("score_job"), job: { company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } };
  };
  const browsing = (): ToolPlan => ({
    action: "find_jobs", folder: "knowledge/job-searches", files: ["knowledge/job-searches/2026-01-15.md"], web: true, mcp: mcpToolsFor("find_jobs"), job: null,
    browser: { run: "abc123def456", boards: ["seek"], dir: "/tmp/x", bin: "/apps/helper/agent-browser", config: "/apps/helper.json", path: "/usr/bin", home: "/Users/alex" },
  });
  const mode = (a: string[]) => a[a.indexOf("--permission-mode") + 1];

  it("career runs use auto in an auto workspace and may write the workspace, minus every deny rule", () => {
    const a = claudeArgs(career(), LOCKED_DIRS, { ...PLACE, mode: "auto" });
    expect(mode(a)).toBe("auto");
    const settings = JSON.parse(a[a.indexOf("--settings") + 1]!) as { permissions: { defaultMode: string; allow: string[]; deny: string[] } };
    expect(settings.permissions.defaultMode).toBe("auto");
    expect(settings.permissions.allow).toContain("Edit(./**)");
    for (const d of ["Edit(./me/**)", "Edit(./.claude/**)", "Read(./me/identity/**)", "Edit(./settings/**)"]) expect(settings.permissions.deny).toContain(d);
  });

  it("browsing runs (Bash) stay on dontAsk even in an auto workspace; with auto off every run is dontAsk", () => {
    expect(mode(claudeArgs(browsing(), LOCKED_DIRS, { ...PLACE, mode: "auto" }))).toBe("dontAsk");
    expect(mode(claudeArgs(career(), LOCKED_DIRS, { ...PLACE, mode: "ask" }))).toBe("dontAsk");
    expect(mode(claudeArgs(career(), LOCKED_DIRS, PLACE))).toBe("dontAsk");
    expect(runMode({ folder: null, web: false, mcp: [], readOnly: [".careeros/tmp/ask-0123abcd/document.pdf"] }, "auto")).toBe("dontAsk");
  });
});

describe("the one-time Claude setup of a workspace", () => {
  it("puts settings, the CLAUDE.md rules and the browser command in place, stamps the version, and is idempotent", () => {
    const s = openSample();
    const md = path.join(s.root, "CLAUDE.md");
    fs.writeFileSync(md, "# My workspace\n\nMy own notes.\n");
    fs.rmSync(path.join(s.root, ".careeros", "bin"), { recursive: true, force: true });
    expect(workspaceSetup(s.root, MCP)).toMatchObject({ current: false, claude_md: false, browser_command: false });
    const done = ensureWorkspaceSetup(s.root, MCP);
    expect(done).toEqual({ version: SETUP_VERSION, current: true, settings: true, claude_md: true, browser_command: true, plugin: true, auto_mode: true });
    const text = fs.readFileSync(md, "utf8");
    expect(text.startsWith("# My workspace\n\nMy own notes.\n")).toBe(true);
    expect(text).toContain(CLAUDE_MD_BEGIN);
    const cli = path.join(s.root, ".careeros", "bin", "jobcairn-chrome");
    expect(fs.statSync(cli).mode & 0o777).toBe(0o700);
    const before = [md, cli, path.join(s.root, ".claude", "settings.json")].map((f) => fs.statSync(f).mtimeMs);
    expect(ensureWorkspaceSetup(s.root, MCP)).toEqual(done);
    expect([md, cli, path.join(s.root, ".claude", "settings.json")].map((f) => fs.statSync(f).mtimeMs)).toEqual(before);
    expect(fs.readFileSync(md, "utf8")).toBe(text);
  });

  it("registers the app's plugin for interactive sessions in the workspace, and every settings rewrite keeps it", () => {
    const s = openSample();
    const pluginDir = path.resolve(import.meta.dirname, "../../../../plugin");
    expect(workspaceSetup(s.root, MCP, pluginDir)).toMatchObject({ plugin: false, current: false });
    const done = ensureWorkspaceSetup(s.root, MCP, undefined, pluginDir);
    expect(done).toMatchObject({ plugin: true, current: true });
    const settingsFile = path.join(s.root, ".claude", "settings.json");
    const read = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    expect(read().extraKnownMarketplaces).toEqual({ jobcairn: { source: { source: "directory", path: pluginDir } } });
    expect(read().enabledPlugins).toEqual({ "careeros@jobcairn": true });
    expect(JSON.parse(fs.readFileSync(path.join(s.root, ".careeros", "claude-plugin.json"), "utf8"))).toEqual({ dir: pluginDir });
    // The marketplace the settings point at lists the plugin from its own folder.
    const market = JSON.parse(fs.readFileSync(path.join(pluginDir, ".claude-plugin", "marketplace.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(market).toMatchObject({ name: "jobcairn", owner: { name: expect.any(String) }, plugins: [{ name: manifest.name, source: "./" }] });
    // Turning auto mode off rewrites the settings and keeps the plugin; the rest of the file is unchanged.
    setClaudeMode(s.root, "ask");
    expect(read().enabledPlugins).toEqual({ "careeros@jobcairn": true });
    // A recorded folder that isn't a plugin marketplace is never declared.
    fs.writeFileSync(path.join(s.root, ".careeros", "claude-plugin.json"), JSON.stringify({ dir: s.root }));
    setClaudeMode(s.root, "auto");
    expect(read().extraKnownMarketplaces).toBeUndefined();
    expect(workspaceSetup(s.root, MCP, pluginDir)).toMatchObject({ plugin: false, current: false });
  });
});
