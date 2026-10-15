import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../helpers.js";
import { checkAuth, checkCli, checkLogin, claudeCandidates, findClaude, isAuthError, launchFor, type ClaudeHost } from "../../src/claude/detect.js";
import { bundledPlugin } from "../../src/claude/plugin.js";
import { CLI, fakeClaude, PLUGIN_DIR } from "./fake-claude.js";

const ENV = { PATH: "/usr/bin" };

describe("finding Claude Code", () => {
  it("looks on PATH first, then the installers' usual folders", () => {
    const c = claudeCandidates({ platform: "darwin", env: { PATH: "/custom/bin:relative/bin", npm_config_prefix: "/n" }, home: "/Users/alex" });
    expect(c[0]).toBe("/custom/bin/claude");
    expect(c).not.toContain("relative/bin/claude");
    expect(c).toEqual(expect.arrayContaining([
      "/Users/alex/.claude/local/claude", "/Users/alex/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/n/bin/claude",
    ]));
  });

  it("on Windows looks for claude.exe and the npm claude.cmd shim", () => {
    const c = claudeCandidates({ platform: "win32", env: { PATH: "C:\\Tools", APPDATA: "C:\\Users\\alex\\AppData\\Roaming" }, home: "C:\\Users\\alex" });
    expect(c[0]).toBe("C:\\Tools\\claude.exe");
    expect(c).toContain("C:\\Users\\alex\\AppData\\Roaming\\npm\\claude.cmd");
    expect(c.every((p) => !p.endsWith("\\claude"))).toBe(true);
  });

  it("runs a Windows .cmd shim through node, never through a shell", () => {
    const shim = "C:\\Users\\alex\\AppData\\Roaming\\npm\\claude.cmd";
    const script = "C:\\Users\\alex\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const h = { ...fakeClaude().host, platform: "win32" as const, env: { PATH: "C:\\Program Files\\nodejs" }, isExecutable: (p: string) => [shim, script, "C:\\Program Files\\nodejs\\node.exe"].includes(p) };
    expect(launchFor(shim, h)).toEqual({ cli: shim, cmd: "C:\\Program Files\\nodejs\\node.exe", pre: [script] });
    expect(launchFor(shim, { ...h, isExecutable: (p) => p === shim })).toBeNull();
  });

  it("reports a missing CLI", async () => {
    const f = fakeClaude();
    const h: ClaudeHost = { ...f.host, isExecutable: () => false };
    expect(findClaude(h)).toBeNull();
    expect(await checkCli(h, ENV)).toEqual({ launch: null, version: "", problem: "missing" });
    expect(f.runner.calls).toEqual([]);
  });

  it("reads the version and pins a minimum", async () => {
    expect(await checkCli(fakeClaude().host, ENV)).toMatchObject({ version: "2.1.280", problem: null, launch: { cmd: CLI } });
    expect(await checkCli(fakeClaude({ version: "1.0.99" }).host, ENV)).toMatchObject({ version: "1.0.99", problem: "too_old" });
    expect(await checkCli(fakeClaude({ version: null }).host, ENV)).toMatchObject({ problem: "broken" });
  });

  it("asks for --version with a timeout, an argument list and no shell", async () => {
    const f = fakeClaude();
    await checkCli(f.host, ENV);
    expect(f.runner.calls[0]).toMatchObject({ cmd: CLI, args: ["--version"] });
  });

  it("reads only the logged-in flag", async () => {
    const launch = { cli: CLI, cmd: CLI, pre: [] };
    expect(await checkLogin(fakeClaude().host, launch, ENV)).toBe("signed_in");
    expect(await checkLogin(fakeClaude({ login: "out" }).host, launch, ENV)).toBe("signed_out");
    expect(await checkLogin(fakeClaude({ login: "garbled" }).host, launch, ENV)).toBe("unknown");
  });

  it("tells a Claude subscription from an API key, and says unknown when it can't tell", async () => {
    const launch = { cli: CLI, cmd: CLI, pre: [] };
    const auth = async (a?: Record<string, unknown>, login?: "out" | "garbled") => (await checkAuth(fakeClaude({ ...(a ? { auth: a } : {}), ...(login ? { login } : {}) }).host, launch, ENV)).auth;
    expect(await auth()).toBe("subscription");
    expect(await auth({ authMethod: "claude.ai", subscriptionType: "max" })).toBe("subscription");
    expect(await auth({ subscriptionType: "pro" })).toBe("subscription");
    expect(await auth({ authMethod: "api_key" })).toBe("api_key");
    expect(await auth({ authMethod: "console" })).toBe("api_key");
    expect(await auth({ apiKeySource: "ANTHROPIC_API_KEY" })).toBe("api_key");
    // A cloud provider bills the cloud account, so it counts as paid per run.
    expect(await auth({ authMethod: "claude.ai", apiProvider: "bedrock" })).toBe("api_key");
    // An API-key sign shown next to a subscription wins: Claude Code then bills the key.
    expect(await auth({ authMethod: "claude.ai", apiKeySource: "ANTHROPIC_API_KEY" })).toBe("api_key");
    expect(await auth({})).toBe("unknown");
    expect(await auth({ authMethod: 42 })).toBe("unknown");
    expect(await auth(undefined, "garbled")).toBe("unknown");
    expect(await checkAuth(fakeClaude({ login: "out" }).host, launch, ENV)).toEqual({ login: "signed_out", auth: "unknown" });
  });

  it("recognises sign-in errors", () => {
    expect(isAuthError("Invalid API key · Please run /login")).toBe(true);
    expect(isAuthError("You are not logged in.")).toBe(true);
    expect(isAuthError("The file was too big")).toBe(false);
  });
});

describe("CareerOS plugin (bundled, loaded per run)", () => {
  it("reads the bundled plugin's manifest", () => {
    const b = bundledPlugin(PLUGIN_DIR); expect(b.found).toBe(true); expect(b.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("is not found when the folder is missing or isn't ours", () => {
    expect(bundledPlugin(path.join(tmpDir(), "nope")).found).toBe(false);
    const other = tmpDir();
    fs.mkdirSync(path.join(other, ".claude-plugin"));
    fs.writeFileSync(path.join(other, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "someone-else", version: "1.0.0" }));
    expect(bundledPlugin(other).found).toBe(false);
  });
});
