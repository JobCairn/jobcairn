import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SEARCH_REPORT_MAX_BYTES, searchReportRel } from "@careeros/contract";
import { parseMcpArgv } from "../../src/claude/mcp/argv.js";
import { handleMcp } from "../../src/claude/mcp/server.js";
import { mcpSession, MCP_CAPS, type McpSession } from "../../src/claude/mcp/tools.js";
import { mcpConfig } from "../../src/claude/args.js";
import { sampleCopy, tmpDir } from "../helpers.js";

/** search_report: the find-jobs report (and the sign-in check's) is written by the app, to one fixed file. */

type Res = { result?: { content: { text: string }[]; isError?: boolean } } | null;
const call = (s: McpSession, args: unknown) => handleMcp(s, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_report", arguments: args } }) as Res;
const text = (r: Res) => r?.result?.content[0]?.text ?? "";
const REL = "knowledge/job-searches/2026-10-11.md";
const session = (root: string, report: string | null = REL): McpSession => ({ ...mcpSession(root, ["search_report"]), report });

describe("search_report", () => {
  it("only report files with a real date are accepted", () => {
    expect(searchReportRel(REL)).toBe(true);
    expect(searchReportRel("knowledge/chrome-checks/2026-10-11.md")).toBe(true);
    for (const bad of ["knowledge/job-searches/2026-02-30.md", "knowledge/job-searches/../x.md", "me/identity/2026-10-11.md", "/abs/knowledge/job-searches/2026-10-11.md", "knowledge/job-searches/2026-10-11.md.sh", "knowledge/job-searches/today.md"]) {
      expect(searchReportRel(bad), bad).toBe(false);
    }
  });

  it("the server takes --report only with the tool, and only a report file", () => {
    const env = { CAREEROS_WORKSPACE: "/w" };
    expect(parseMcpArgv(["--tools", "search_report,request_access", "--report", REL], env).report).toBe(REL);
    expect(() => parseMcpArgv(["--tools", "search_report"], env)).toThrow(/go together/);
    expect(() => parseMcpArgv(["--tools", "request_access", "--report", REL], env)).toThrow(/go together/);
    expect(() => parseMcpArgv(["--tools", "search_report", "--report", "settings/.env"], env)).toThrow(/report file/);
  });

  it("main starts the server with the run's report file, and drops the tool when there is none", () => {
    const place = { root: "/w", mcp: { command: "/apps/node", args: ["/apps/mcp.mjs"] } };
    const a = (JSON.parse(mcpConfig(place, ["search_add", "search_report"], null, null, null, null, REL)) as { mcpServers: { careeros: { args: string[] } } }).mcpServers.careeros.args;
    expect(a).toEqual(["/apps/mcp.mjs", "--tools", "search_add,search_report", "--report", REL]);
    const b = (JSON.parse(mcpConfig(place, ["search_add", "search_report"])) as { mcpServers: { careeros: { args: string[] } } }).mcpServers.careeros.args;
    expect(b).toEqual(["/apps/mcp.mjs", "--tools", "search_add"]);
    // The jobs a find-jobs run aims for go along, so job_new and search_add allow enough calls.
    const c = (JSON.parse(mcpConfig(place, ["search_add", "job_new"], null, null, null, null, null, 150)) as { mcpServers: { careeros: { args: string[] } } }).mcpServers.careeros.args;
    expect(c).toEqual(["/apps/mcp.mjs", "--tools", "search_add,job_new", "--jobs", "150"]);
    const d = (JSON.parse(mcpConfig(place, ["request_access"], null, null, null, null, null, 150)) as { mcpServers: { careeros: { args: string[] } } }).mcpServers.careeros.args;
    expect(d).toEqual(["/apps/mcp.mjs", "--tools", "request_access"]);
  });

  it("writes the Markdown to the run's file (creating the folder), replacing an earlier save", () => {
    const root = sampleCopy();
    const s = session(root);
    expect(JSON.parse(text(call(s, { markdown: "# Search report\r\n\r\nNo matches.\u0007" })))).toEqual({ saved: true, file: REL });
    expect(fs.readFileSync(path.join(root, REL), "utf8")).toBe("# Search report\n\nNo matches.\n");
    call(s, { markdown: "# Search report\n\nOne match." });
    expect(fs.readFileSync(path.join(root, REL), "utf8")).toBe("# Search report\n\nOne match.\n");
  });

  it("refuses a path argument, an empty or oversized report, a run without a report file, and more than its cap", () => {
    const root = sampleCopy();
    expect(call(session(root), { markdown: "x", path: "me/identity/x.md" })!.result!.isError).toBe(true);
    expect(call(session(root), { markdown: "  \n" })!.result!.isError).toBe(true);
    expect(call(session(root), { markdown: "a".repeat(SEARCH_REPORT_MAX_BYTES + 1) })!.result!.isError).toBe(true);
    expect(text(call(session(root, null), { markdown: "x" }))).toMatch(/no report/);
    expect(fs.existsSync(path.join(root, REL))).toBe(false);
    const s = session(root);
    for (let i = 0; i < MCP_CAPS.search_report!; i++) expect(call(s, { markdown: `try ${i}` })!.result!.isError).toBeFalsy();
    expect(call(s, { markdown: "one too many" })!.result!.isError).toBe(true);
  });

  it("never writes through a linked folder or file", () => {
    const root = sampleCopy();
    const outside = tmpDir();
    fs.rmSync(path.join(root, "knowledge", "job-searches"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "knowledge", "job-searches"));
    expect(call(session(root), { markdown: "x" })!.result!.isError).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);

    const root2 = sampleCopy();
    fs.mkdirSync(path.join(root2, "knowledge", "job-searches"), { recursive: true });
    const target = path.join(outside, "victim.md");
    fs.writeFileSync(target, "keep");
    fs.symlinkSync(target, path.join(root2, REL));
    expect(call(session(root2), { markdown: "x" })!.result!.isError).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
  });
});
