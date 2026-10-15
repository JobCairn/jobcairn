import fs from "node:fs";
import path from "node:path";
import type { ClaudeHost } from "../../src/claude/detect.js";
import { fakeRunner, untilAborted, type FakeRunner, type RunOptions, type RunResult } from "../../src/claude/process.js";

export const CLI = "/opt/homebrew/bin/claude";
export const PLUGIN_DIR = path.resolve(import.meta.dirname, "../../../../plugin");

/** Recorded stream-json lines, shaped like Claude Code 2.1's `-p --output-format stream-json --verbose`. */
export const S = {
  /** `apiKeySource` is "none" for a Claude subscription login; anything else is an API key. */
  init: (apiKeySource = "ANTHROPIC_API_KEY") => JSON.stringify({ type: "system", subtype: "init", cwd: "/somewhere", session_id: "s", tools: ["Read", "Write"], model: "claude", apiKeySource }),
  tool: (id: string, name: string, input: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }),
  text: (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
  ok: (id: string, isError = false) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "done" }] } }),
  result: (over: Record<string, unknown> = {}) => JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "I wrote the files.", duration_ms: 61_000, num_turns: 7, total_cost_usd: 0.42,
    permission_denials: [], ...over,
  }),
};

export interface FakeOpts {
  version?: string | null;
  login?: "in" | "out" | "garbled";
  /** What `auth status --json` says about the login when signed in. Default: a Claude subscription ({ authMethod: "claude.ai" }). */
  auth?: Record<string, unknown>;
  /** The bundled plugin folder. Default: the repo's real ./plugin. */
  pluginDir?: string;
  /** What a `-p` run does. Default: succeed with no files. */
  run?: (opts: RunOptions, args: string[]) => Partial<RunResult> | Promise<Partial<RunResult>>;
  /** Fail these subcommands (joined by spaces, e.g. "auth status"). */
  failing?: string[];
}

export interface FakeClaude { host: ClaudeHost; runner: FakeRunner; opened: string[] }

export const MCP_LAUNCH = { command: "/apps/careeros/CareerOS", args: ["/apps/careeros/mcp.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };

/**
 * A fake Claude Code: answers --version, auth status and -p runs. Nothing is started. Any `plugin` or
 * `mcp` subcommand fails loudly: the engine must never change the person's Claude Code setup.
 */
export function fakeClaude(o: FakeOpts = {}): FakeClaude {
  const opened: string[] = [];
  const runner = fakeRunner(async (_cmd, args, opts) => {
    const sub = args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ");
    if (o.failing?.some((f) => sub.startsWith(f))) return { code: 1, stderr: `error: ${sub} failed at /Users/alex/secret/place` };
    if (args[0] === "--version") return o.version === null ? { code: 127, stdout: "" } : { stdout: `${o.version ?? "2.1.280"} (Claude Code)\n` };
    if (args[0] === "auth") {
      if (o.login === "garbled") return { stdout: "Logged in as someone" };
      return o.login === "out" ? { code: 1, stdout: JSON.stringify({ loggedIn: false }) } : { stdout: JSON.stringify({ loggedIn: true, ...(o.auth ?? { authMethod: "claude.ai" }) }) };
    }
    if (args[0] === "plugin" || args[0] === "mcp" || args[0] === "install" || args[0] === "update") throw new Error(`the engine must not run "claude ${sub}"`);
    if (args[0] === "-p") return o.run ? o.run(opts, args) : { stdout: [S.init(), S.result()].join("\n") };
    return { code: 2, stderr: "unknown" };
  });
  const host: ClaudeHost = {
    runner, platform: "darwin",
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/alex", ANTHROPIC_API_KEY: "sk-must-not-leak", HTTPS_PROXY: "http://proxy.example:8080", NODE_EXTRA_CA_CERTS: "/etc/example-ca.pem", CLAUDE_CONFIG_DIR: "/Users/alex/.claude-work" },
    home: "/Users/alex", pluginDir: o.pluginDir ?? PLUGIN_DIR, mcp: MCP_LAUNCH,
    isExecutable: (p) => p === CLI,
    openTerminal: async (cli) => { opened.push(cli); return true; },
  };
  return { host, runner, opened };
}

/** A run that writes `files` (workspace-relative) into the run's cwd and streams matching events. */
export function writes(files: Record<string, string>, extra: string[] = [], apiKeySource?: string): FakeOpts["run"] {
  return (opts) => {
    const lines = [S.init(apiKeySource)];
    let i = 0;
    for (const [rel, text] of Object.entries(files)) {
      const id = `t${i++}`;
      const abs = path.join(opts.cwd, ...rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
      lines.push(S.tool(id, "Write", { file_path: abs, content: text }), S.ok(id));
    }
    lines.push(...extra, S.result());
    return { stdout: lines.join("\n") };
  };
}

/** A run that streams one step and then waits until cancelled. */
export function hangs(): FakeOpts["run"] {
  return (opts) => {
    opts.onLine?.(S.init(), "stdout");
    opts.onLine?.(S.tool("t1", "Read", { file_path: path.join(opts.cwd, "companies/x/jobs/y/jd.md") }), "stdout");
    return untilAborted(opts);
  };
}
