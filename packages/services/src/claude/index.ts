import type { ActionId, ActionTarget, ClaudeRunRequest } from "@careeros/contract";
import type { ServiceContext } from "../context.js";
import type { HandlerTable } from "../handlers.js";
import { engineFor } from "./engine.js";

export type { ClaudeHost, ClaudeLaunch } from "./detect.js";
export { claudeCandidates, findClaude, launchFor, checkCli, checkLogin, isAuthError } from "./detect.js";
export { claudeArgs, testArgs, toolArgs, videoScriptPlan, mcpConfig, WEB_ACTIONS, NEVER_WRITE, NON_INTERACTIVE, RUN_SETTINGS, type ToolPlan, type McpLaunch } from "./args.js";
export { parseLine, toolStep, relToRoot, summarise, type StreamEvent } from "./stream.js";
export { verifyRun, fileLabel, snapshot, type Snapshot } from "./verify.js";
export { listRuns, saveRun, KEEP_RUNS } from "./runs.js";
export { bundledPlugin, type BundledPlugin } from "./plugin.js";
export { MCP_TOOLS, MCP_TOOL_NAMES, mcpToolsFor, mcpToolId, type McpToolName } from "./mcp/tools.js";
export { handleMcp, serveMcp, MCP_PROTOCOL } from "./mcp/server.js";
export { monthCost, addCost } from "./runs.js";
export { nodeProcessRunner, fakeRunner, untilAborted, cleanEnv, killTree, type ProcessRunner, type RunOptions, type RunResult, type FakeRunner } from "./process.js";
export { scrubMessage } from "./scrub.js";
export { ClaudeEngine, engineFor, CAREER_TIMEOUT_MS, VIDEO_TIMEOUT_MS } from "./engine.js";

export const claudeEngineHandlers = {
  "claude.engine": (ctx: ServiceContext, recheck: boolean) => engineFor(ctx).state(recheck),
  "claude.consent": (ctx: ServiceContext) => engineFor(ctx).giveConsent(),
  "claude.setAutoMode": (ctx: ServiceContext, on: boolean) => engineFor(ctx).setAutoMode(on),
  "claude.repair": (ctx: ServiceContext) => engineFor(ctx).repair(),
  "claude.openSignIn": (ctx: ServiceContext) => engineFor(ctx).openSignIn(),
  "claude.testRun": (ctx: ServiceContext) => engineFor(ctx).testRun(),
  "claude.run": (ctx: ServiceContext, id: ActionId, target: ActionTarget, req: ClaudeRunRequest) => engineFor(ctx).run(id, target, req),
  "claude.runs": (ctx: ServiceContext) => engineFor(ctx).runs(),
  "claude.cancel": (ctx: ServiceContext, id: string) => engineFor(ctx).cancel(id),
} satisfies Partial<HandlerTable>;
