import { describe, expect, it } from "vitest";
import { LOCKED_DIRS } from "@careeros/core";
import { actionPaths } from "@careeros/contract";
import { claudeArgs, type BrowserPlan, type ToolPlan } from "../../src/claude/args.js";
import { mcpToolsFor } from "../../src/claude/mcp/tools.js";

/**
 * Walks a whole find-jobs run that searches in Chrome through the run's own permission rules, call by call, so a
 * run can't end with "some of its steps were refused" again. The matcher follows Claude Code's rule forms as used
 * here: `Tool` (any input), `Bash(<glob>)` on the whole command, `Edit(./<glob>)` / `Read(./<glob>)` on the
 * workspace-relative path, `Read(//abs/<glob>)` on the absolute path, `Skill(<name>)`. Deny wins; dontAsk refuses
 * anything not allowed.
 */

const ROOT = "/Users/alex/JobCairn";
const PLACE = { root: ROOT, pluginDir: "/apps/plugin", mcp: { command: "/apps/JobCairn", args: ["/apps/mcp.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } } };
const BROWSER: BrowserPlan = { run: "abc123def456", boards: ["seek", "linkedin"], dir: "/tmp/careeros-chrome-x", bin: "/apps/helper/agent-browser", config: "/apps/helper.json", path: "/usr/bin", home: "/Users/alex" };

const glob = (pat: string) => new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, ".*").replace(/\u0000/g, ".*")}$`, "s");

interface Call { tool: string; command?: string; file?: string; skill?: string }

function matches(rule: string, c: Call): boolean {
  const m = /^([A-Za-z_]+(?:__[A-Za-z_]+)*)(?:\((.*)\))?$/s.exec(rule);
  if (!m) return false;
  const [, tool, pat] = m;
  const t = tool === "Write" ? "Edit" : tool;
  const ct = c.tool === "Write" ? "Edit" : c.tool;
  if (t !== ct) return false;
  if (pat === undefined) return true;
  if (ct === "Bash") return glob(pat).test(c.command ?? "");
  if (ct === "Skill") return pat === c.skill;
  if (ct === "Edit" || ct === "Read") {
    const file = c.file ?? "";
    if (pat.startsWith("//")) return glob(pat.slice(1)).test(file);
    const rel = file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : null;
    return rel !== null && glob(pat.replace(/^\.\//, "")).test(rel);
  }
  return false;
}

function decide(args: string[], c: Call): "allowed" | "denied" | "refused" {
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as { permissions: { allow: string[]; deny: string[]; defaultMode: string } };
  const tools = args[args.indexOf("--tools") + 1]!.split(",");
  const builtin = ["Bash", "Edit", "Write", "Read", "Skill", "Grep", "Glob", "WebSearch", "WebFetch"];
  if (builtin.includes(c.tool) && !tools.includes(c.tool) && !(c.tool === "Write" && tools.includes("Edit"))) return "refused";
  if (settings.permissions.deny.some((r) => matches(r, c))) return "denied";
  if (settings.permissions.allow.some((r) => matches(r, c))) return "allowed";
  return "refused";
}

function findJobsArgs(locked: readonly string[] = LOCKED_DIRS) {
  const out = actionPaths("find_jobs", { kind: "workspace" }, { now: "2026-10-10T19:07:00.000Z" });
  const plan: ToolPlan = { action: "find_jobs", folder: out.folder, files: [...out.outputs, ...out.extras], web: true, mcp: mcpToolsFor("find_jobs"), job: null, browser: BROWSER, report: out.outputs[0]! };
  return { args: claudeArgs(plan, locked, PLACE), report: `${ROOT}/${out.outputs[0]}`, rel: out.outputs[0]! };
}

const CMD = "./.careeros/bin/jobcairn-chrome";

describe("a find-jobs run in Chrome: every step it needs is allowed", () => {
  it("allows the whole run, call by call, under dontAsk", () => {
    const { args, report } = findJobsArgs();
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    const run: Call[] = [
      { tool: "Skill", skill: "careeros:career" },
      { tool: "Read", file: "/apps/plugin/skills/career/references/job-search-browsing.md" },
      { tool: "Bash", command: `${CMD} skills get core` },
      { tool: "Bash", command: `${CMD} status` },
      { tool: "mcp__careeros__search_check" },
      { tool: "Bash", command: `${CMD} search seek "AI Engineer" "Brisbane QLD"` },
      { tool: "Bash", command: `${CMD} search linkedin "Machine Learning Engineer visa sponsorship" "Remote"` },
      { tool: "Bash", command: `${CMD} search seek "LLM engineer (GenAI)" "Sydney NSW 2000"` },
      { tool: "Bash", command: `${CMD} search seek "Medical imaging AI developer" "Melbourne"` },
      { tool: "mcp__careeros__search_add" },
      { tool: "Bash", command: `${CMD} snapshot` },
      { tool: "Bash", command: `${CMD} click @e14` },
      { tool: "Bash", command: `${CMD} fill @e2 "Gold Coast" --submit` },
      { tool: "Bash", command: `${CMD} scroll down` },
      { tool: "Bash", command: `${CMD} get text` },
      { tool: "Bash", command: `${CMD} open https://www.seek.com.au/job/100001` },
      { tool: "Bash", command: `${CMD} back` },
      { tool: "mcp__careeros__job_new" },
      { tool: "mcp__careeros__search_report" },
      { tool: "Write", file: report },
      { tool: "Edit", file: report },
      { tool: "Bash", command: `${CMD} close` },
    ];
    for (const c of run) expect(decide(args, c), JSON.stringify(c)).toBe("allowed");
    // The report is named by the local day (Brisbane runs at 5 am write today's file), so the walk names it the same way.
    expect(report).toMatch(/knowledge\/job-searches\/\d{4}-\d{2}-\d{2}\.md$/);
  });

  it("search_report writes the run's own report file: the server is started with exactly that file", () => {
    const { args, rel } = findJobsArgs();
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as { mcpServers: { careeros: { args: string[] } } };
    const a = cfg.mcpServers.careeros.args;
    expect(a[a.indexOf("--tools") + 1]!.split(",")).toContain("search_report");
    expect(a[a.indexOf("--report") + 1]).toBe(rel);
    // 19:07 UTC on 10 Oct is 5:07 am on 11 Oct in Brisbane: the file carries the local day of the run.
    const local = new Date("2026-10-10T19:07:00.000Z");
    expect(rel).toBe(`knowledge/job-searches/${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}.md`);
  });

  it("refuses or denies everything outside the browser command and the run's records", () => {
    const { args } = findJobsArgs();
    const out: Call[] = [
      { tool: "Bash", command: "agent-browser --cdp ws://127.0.0.1:9222/devtools/browser tab list" },
      { tool: "Bash", command: "agent-browser tab list" },
      { tool: "Bash", command: "npx agent-browser open https://www.seek.com.au/" },
      { tool: "Bash", command: "curl https://www.seek.com.au/" },
      { tool: "Bash", command: "cat me/identity/passport.md" },
      { tool: "Bash", command: `cd /tmp && ${CMD} snapshot` },
      { tool: "Bash", command: `${CMD} snapshot; cat settings/.env` },
      { tool: "Bash", command: `${CMD} get text > .careeros/chrome.json` },
      { tool: "Read", file: `${ROOT}/me/history/resume.md` },
      { tool: "Read", file: `${ROOT}/me/identity/passport.md` },
      { tool: "Edit", file: `${ROOT}/me/identity/passport.md` },
      { tool: "Edit", file: `${ROOT}/.claude/settings.json` },
      { tool: "Edit", file: `${ROOT}/.careeros/chrome-run.json` },
      { tool: "Edit", file: `${ROOT}/settings/.env` },
      { tool: "WebFetch" },
      { tool: "WebSearch" },
      { tool: "mcp__careeros__browser_open" },
    ];
    for (const c of out) expect(decide(args, c), JSON.stringify(c)).not.toBe("allowed");
  });

  it("allows the browser command with or without a profile name in the query, whatever is locked", () => {
    for (const locked of [LOCKED_DIRS, [] as string[]]) {
      const { args } = findJobsArgs(locked);
      expect(decide(args, { tool: "Bash", command: `${CMD} search seek "AI engineer" "Remote"` })).toBe("allowed");
    }
  });

  it("allows a whole sign-in check run (chrome_check), call by call", () => {
    const out = actionPaths("chrome_check", { kind: "workspace" }, { now: "2026-10-10T19:07:00.000Z" });
    const plan: ToolPlan = { action: "chrome_check", folder: out.folder, files: [...out.outputs], web: true, mcp: mcpToolsFor("chrome_check"), job: null, browser: BROWSER, report: out.outputs[0]! };
    const args = claudeArgs(plan, LOCKED_DIRS, PLACE);
    const calls: Call[] = [
      { tool: "Skill", skill: "careeros:career" },
      { tool: "Bash", command: `${CMD} skills get core` },
      { tool: "Bash", command: `${CMD} signin seek` },
      { tool: "Bash", command: `${CMD} report seek signed_in` },
      { tool: "Bash", command: `${CMD} signin linkedin` },
      { tool: "Bash", command: `${CMD} snapshot` },
      { tool: "Bash", command: `${CMD} report linkedin unclear` },
      { tool: "Bash", command: `${CMD} close` },
      { tool: "mcp__careeros__search_report" },
      { tool: "Write", file: `${ROOT}/${out.outputs[0]}` },
    ];
    for (const c of calls) expect(decide(args, c), JSON.stringify(c)).toBe("allowed");
  });
});
