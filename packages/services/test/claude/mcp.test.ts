import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { layout, readRecord, readSearches } from "@careeros/core";
import { IMPORT_SPONSOR_REASON } from "@careeros/contract";
import { readHandlers as R } from "../../src/read.js";
import { parseMcpArgv } from "../../src/claude/mcp/argv.js";
import { handleMcp, noAbsPaths, serveMcp } from "../../src/claude/mcp/server.js";
import { MCP_CAPS, MCP_TOOL_NAMES, MCP_TOOLS, mcpCap, mcpSession, mcpToolsFor, type McpSession, type McpToolName } from "../../src/claude/mcp/tools.js";
import { findBudget } from "@careeros/contract";
import { makeCtx, sampleCopy, tmpDir } from "../helpers.js";
import { openWorkspace } from "../../src/workspace.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const ALL: McpToolName[] = [...MCP_TOOL_NAMES];
const ACME_JOB = { company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
type Res = { result?: { content: { text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: { code: number; message: string } } | null;
const call = (s: McpSession, name: string, args: unknown) => handleMcp(s, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as Res;
const textOf = (r: Res) => r?.result?.content[0]?.text ?? r?.error?.message ?? "";
const all = (root: string, job: McpSession["job"] = ACME_JOB) => mcpSession(root, ALL, job);

describe("careeros MCP server", () => {
  it("speaks MCP: initialize, list only the allowed tools, ping", () => {
    const s = mcpSession(sampleCopy(), ["job_event", "request_access"]);
    const init = handleMcp(s, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }) as { result: { capabilities: unknown } };
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(handleMcp(s, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = handleMcp(s, { jsonrpc: "2.0", id: 2, method: "tools/list" }) as Res;
    expect(list!.result!.tools!.map((t) => t.name)).toEqual(["job_event", "request_access"]);
    expect(handleMcp(s, { jsonrpc: "2.0", id: 3, method: "shell/exec" })).toMatchObject({ error: { code: -32601 } });
  });

  it("each action gets only the tools it needs; there is no init, import, migrate or workspace tool", () => {
    expect(mcpToolsFor("find_jobs")).toEqual(["search_check", "search_add", "job_new", "search_report", "request_access"]);
    expect(mcpToolsFor("chrome_check")).toEqual(["search_report", "request_access"]);
    expect(mcpToolsFor("score_job")).toEqual(["job_event", "score_record", "request_access"]);
    expect(mcpToolsFor("tailor_application")).toEqual(["request_access"]);
    expect(mcpToolsFor("research_company")).toEqual(["request_access"]);
    const s = all(sampleCopy());
    for (const bad of ["init", "import_legacy", "migrate", "index"]) expect(call(s, bad, {})!.error?.message).toMatch(/isn't available/);
    expect(call(mcpSession(s.root, ["request_access"]), "job_new", { company: "Acme Corp", title: "X" })!.error?.message).toMatch(/isn't available/);
  });

  it("no tool takes a file path (F1): no path-like property in any schema, and path keys are refused", () => {
    for (const t of Object.values(MCP_TOOLS)) {
      const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties);
      expect(props.filter((p) => /file|path|dir|folder_path|src|source_file/i.test(p)), t.name).toEqual([]);
      expect((t.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    }
    const s = all(sampleCopy());
    for (const key of ["jd_file", "file", "path"]) {
      const r = call(s, "job_new", { company: "Example Labs", title: "Engineer", [key]: "me/identity/visa.txt" });
      expect(r!.result?.isError, key).toBe(true);
    }
  });

  it("job_new saves jd_text as the job's ad; a path in jd_text is just text, never read", () => {
    const root = sampleCopy();
    fs.mkdirSync(path.join(root, "me", "identity"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "identity", "visa.txt"), "SECRET visa grant for Alex Example (fictional)");
    const s = all(root);
    const out = JSON.parse(textOf(call(s, "job_new", { company: "Example Labs", title: "Engineer", jd_text: "me/identity/visa.txt" }))) as { company_slug: string; id: string; created: boolean };
    expect(out.created).toBe(true);
    const jd = fs.readFileSync(path.join(layout(root).companyDir(out.company_slug), "jobs", out.id, "jd.md"), "utf8");
    expect(jd).toContain("me/identity/visa.txt");
    expect(jd).not.toContain("SECRET");
  });

  it("jd_text is capped at 200 KB and loses control characters", () => {
    const root = sampleCopy();
    const s = all(root);
    expect(textOf(call(s, "job_new", { company: "Example Labs", title: "Too long", jd_text: "x".repeat(200 * 1024 + 1) }))).toMatch(/200 KB/);
    const out = JSON.parse(textOf(call(s, "job_new", { company: "Example Labs", title: "Clean ad", jd_text: "Line one\r\nBell\u0007 and\u001b[31m red\u0000" }))) as { company_slug: string; id: string };
    const jd = fs.readFileSync(path.join(layout(root).companyDir(out.company_slug), "jobs", out.id, "jd.md"), "utf8");
    expect(jd).toContain("Line one\nBell and[31m red");
    expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(jd)).toBe(false);
  });

  it("score_record saves the structured score on the run's own job, in plain words, and refuses bad input", () => {
    const root = sampleCopy();
    const args = {
      fit: 52, interview_odds: 40, tier: "Meh", recommendation: "Apply only if you have time.",
      must_haves: [{ text: "Kubernetes", status: "partial", evidence: "me/history/profile.md lists basics" }],
      changes: ["Production Kubernetes work"], summary: "Mixed fit (Workflow 2).",
    };
    const ok = call(all(root), "score_record", args);
    expect(ok!.result?.isError).toBeUndefined();
    expect(JSON.parse(textOf(ok))).toEqual({ saved: true, fit: 52, tier: "Meh" });
    const dir = path.join(layout(root).companyDir(ACME_JOB.company_slug), "jobs", ACME_JOB.id);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "score.json"), "utf8"));
    expect(saved).toMatchObject({ fit: 52, interview_odds: 40, tier: "Meh", summary: "Mixed fit." });
    expect(saved.must_haves[0].evidence).toBe("your profile lists basics");
    const job = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
    expect(job.scores.fit.value).toBe(52);
    expect(job.timeline.at(-1).event).toBe("Scored");

    expect(textOf(call(all(root), "score_record", { ...args, fit: 120 }))).toMatch(/whole number from 0 to 100/);
    expect(textOf(call(all(root), "score_record", { ...args, tier: "Amazing" }))).toMatch(/tier must be one of/);
    expect(textOf(call(all(root), "score_record", { ...args, file: "me/identity/visa.txt" }))).toMatch(/file is not allowed/);
    expect(textOf(call(all(root, null), "score_record", args))).toMatch(/only score the job it is about/);
  });

  it("score_record may run at most twice in one request", () => {
    const s = all(sampleCopy());
    const args = { fit: 70, interview_odds: 60, tier: "Good Fit", recommendation: "Apply.", must_haves: [] };
    expect(MCP_CAPS.score_record).toBe(2);
    expect(call(s, "score_record", args)!.result?.isError).toBeUndefined();
    expect(call(s, "score_record", args)!.result?.isError).toBeUndefined();
    expect(textOf(call(s, "score_record", args))).toMatch(/used score_record 2 times/);
  });

  it("job_event only touches the job the run is about (F3)", () => {
    const root = sampleCopy();
    const ok = call(all(root), "job_event", { ...ACME_JOB, event: "Scored" });
    expect(ok!.result?.isError).toBeUndefined();
    const other = call(all(root), "job_event", { company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm", event: "Offer" });
    expect(textOf(other)).toMatch(/only add events to the job it is about/);
    expect(call(all(root, null), "job_event", { ...ACME_JOB, event: "Scored" })!.result?.isError).toBe(true);
  });

  it("validates arguments with the contract validators", () => {
    const s = all(sampleCopy());
    expect(call(s, "job_event", { company_slug: "../x", id: "y", event: "Scored" })!.result?.isError).toBe(true);
    expect(call(s, "job_event", { ...ACME_JOB, event: "Scored", ws: "/tmp" })!.result?.isError).toBe(true);
    expect(textOf(call(s, "job_new", { company: "Acme Corp", title: "X", url: "javascript:alert(1)" }))).toMatch(/url/);
    expect(textOf(call(s, "request_access", { folder: "me/identity", why: "x" }))).toMatch(/folder/);
  });

  it("caps how much one run can add (F10)", () => {
    const s = all(sampleCopy());
    for (let i = 0; i < MCP_CAPS.request_access!; i++) expect(call(s, "request_access", { folder: "identity", why: `Reason ${i}` })!.result?.isError).toBeUndefined();
    expect(textOf(call(s, "request_access", { folder: "identity", why: "One more" }))).toMatch(/the most one request may/);
  });

  it("logs and checks searches, and asks for access with the short folder names", () => {
    const s = all(sampleCopy());
    const k = { site: "Greenhouse", query: "ai engineer", location: "Sampletown" };
    expect(JSON.parse(textOf(call(s, "search_check", k))).ran_recently).toBe(false);
    call(s, "search_add", { ...k, results: 4, kept: 1 });
    expect(JSON.parse(textOf(call(s, "search_check", k))).ran_recently).toBe(true);
    // A run without browsing logs its searches as web searches; Claude can't say otherwise.
    expect(readSearches(s.root).entries.at(-1)).toMatchObject({ site: "Greenhouse", mode: "web" });
    expect(textOf(call(s, "search_add", { ...k, mode: "chrome" }))).toMatch(/mode/);
    expect(JSON.parse(textOf(call(s, "request_access", { folder: "identity", why: "Need the visa expiry date" }))).requested).toBe(true);
  });

  it("job_new refuses a job clearly in another country and flags one it can't place (the owner's report: jobs from Canada)", () => {
    const s = all(sampleCopy());
    const refused = call(s, "job_new", { company: "Acme Corp", title: "AI Engineer", url: "https://example.com/jobs/1", location: "Toronto, ON", work_mode: "Hybrid" });
    expect(refused!.result?.isError).toBe(true);
    expect(textOf(refused)).toBe("Not saved: This job is in Canada, and your search is limited to Australia. Skip it unless it's remote and the ad says people in Australia can apply.");
    expect(textOf(call(s, "job_new", { company: "Acme Corp", title: "Junior AI Engineer", location: "Sampletown NSW", salary: "$70k - $85k" }))).toMatch(/^Not saved: The ad's pay tops out at 85,000/);
    const ok = JSON.parse(textOf(call(s, "job_new", { company: "Acme Corp", title: "Applied AI Engineer", location: "Sampletown NSW", salary: "$120k - $140k" })));
    expect(ok.check).toBeUndefined();
    const flagged = JSON.parse(textOf(call(s, "job_new", { company: "Example Labs", title: "LLM Engineer", location: "Remote" }))) as { company_slug: string; id: string; check: string };
    expect(flagged.check).toMatch(/doesn't say which countries/);
    const job = readRecord("job", layout(s.root).jobFile(flagged.company_slug, flagged.id));
    expect(job.timeline.at(-1)).toMatchObject({ event: "Check the location", note: flagged.check });
    // A search in the wrong country is still logged (so it isn't repeated), with a warning back.
    expect(JSON.parse(textOf(call(s, "search_add", { site: "SEEK", query: "ai engineer", location: "Vancouver, BC" }))).warning).toMatch(/This place is in Canada/);
  });

  it("a new job gets its employer's sponsor score at import, the same as the Sponsors screen", () => {
    const x = makeCtx();
    openWorkspace(x.ctx, sampleCopy());
    const s = all(x.ctx.requireRoot());
    const out = JSON.parse(textOf(call(s, "job_new", { company: "Acme Corp", title: "Platform AI Engineer", location: "Sampletown NSW" }))) as { company_slug: string; id: string };
    const job = readRecord("job", layout(s.root).jobFile(out.company_slug, out.id));
    const row = R["sponsors.list"](x.ctx).find((x) => x.slug === out.company_slug)!;
    expect(job.scores.sponsor).toMatchObject({ value: row.score, tier: row.score_tier });
    expect(job.scores.sponsor.reasons[0]).toBe(IMPORT_SPONSOR_REASON);
    // A new employer nobody has checked: nothing known yet, scored like the Sponsors screen (20), never left Unknown.
    const fresh = JSON.parse(textOf(call(s, "job_new", { company: "Example Startup", title: "AI Engineer", location: "Sampletown NSW" }))) as { company_slug: string; id: string };
    expect(readRecord("job", layout(s.root).jobFile(fresh.company_slug, fresh.id)).scores.sponsor.value).toBe(20);
  });

  it("errors drop absolute paths but keep workspace words readable (F8)", () => {
    expect(noAbsPaths("refusing to read me/identity: it is locked")).toBe("refusing to read me/identity: it is locked");
    expect(noAbsPaths("ENOENT: open '/Users/alex/CareerOS/x.md'")).toBe("ENOENT: open 'a file'");
    expect(noAbsPaths("at C:\\Users\\alex\\x.md and ~/secret/y")).toBe("at a file and a file");
  });

  it("serves newline-delimited JSON-RPC over streams", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c) => chunks.push(String(c)));
    const done = serveMcp(mcpSession(sampleCopy(), ["request_access"]), input, output);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    input.write("not json\n");
    input.end();
    await done;
    const lines = chunks.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].result.tools).toHaveLength(1);
    expect(lines[1].error.code).toBe(-32700);
  });

  it("refuses to start outside a workspace", () => {
    expect(() => serveMcp(mcpSession(tmpDir(), ["request_access"]), new PassThrough(), new PassThrough())).toThrow(new RegExp(String.raw`not a ${brand.name} workspace`));
  });

  it("start arguments: known tools only, a well-formed job, a workspace, nothing else (F7)", () => {
    const env = { CAREEROS_WORKSPACE: "/w" };
    expect(parseMcpArgv(["--tools", "job_event,request_access", "--job", "acme-corp/2026-01-12-ai-engineer"], env)).toMatchObject({ root: "/w", tools: ["job_event", "request_access"], job: ACME_JOB });
    expect(() => parseMcpArgv(["--tools", "job_event"], {})).toThrow(/CAREEROS_WORKSPACE/);
    expect(() => parseMcpArgv(["--tools", "job_event,shell"], env)).toThrow(/unknown tool/);
    expect(() => parseMcpArgv([], env)).toThrow(/needs --tools/);
    expect(() => parseMcpArgv(["--tools", "job_event", "--job", "../x/y"], env)).toThrow(/--job/);
    expect(() => parseMcpArgv(["--tools", "job_event", "--ws", "/other"], env)).toThrow(/unknown or repeated/);
    expect(() => parseMcpArgv(["--tools", "job_event", "--tools", "job_new"], env)).toThrow(/unknown or repeated/);
  });

  it("--jobs: a find-jobs run's job_new and search_add limits grow with the jobs it aims for", () => {
    const env = { CAREEROS_WORKSPACE: "/w" };
    expect(parseMcpArgv(["--tools", "search_add,job_new", "--jobs", "100"], env).jobs).toBe(100);
    for (const bad of ["0", "201", "1.5", "lots", "1e2"]) expect(() => parseMcpArgv(["--tools", "job_new", "--jobs", bad], env), bad).toThrow(/--jobs must be/);
    expect(() => parseMcpArgv(["--tools", "request_access", "--jobs", "10"], env)).toThrow(/--jobs goes with/);
    const s = { ...mcpSession("/w", ["search_add", "job_new"]), jobs: 100 };
    expect(mcpCap(s, "job_new")).toBe(findBudget(100).jobNew);
    expect(mcpCap(s, "job_new")).toBeGreaterThan(MCP_CAPS.job_new!);
    expect(mcpCap(s, "search_add")).toBe(findBudget(100).searchAdd);
    expect(mcpCap(s, "score_record")).toBe(MCP_CAPS.score_record);
    expect(mcpCap(mcpSession("/w", ["job_new"]), "job_new")).toBe(MCP_CAPS.job_new);
  });

  it("--search carries the run's own search choices, checked like the IPC request", () => {
    const env = { CAREEROS_WORKSPACE: "/w" };
    const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    expect(parseMcpArgv(["--tools", "job_new", "--search", enc({ countries: ["Canada"], salary_min: null })], env).search).toEqual({ countries: ["Canada"], salary_min: null });
    expect(() => parseMcpArgv(["--tools", "job_new", "--search", enc({ shell: "rm" })], env)).toThrow(/not allowed/);
    expect(() => parseMcpArgv(["--tools", "job_new", "--search", "not json!"], env)).toThrow(/base64url/);
    expect(() => parseMcpArgv(["--tools", "request_access", "--search", enc({})], env)).toThrow(/goes with the job_new tool/);
    // The largest override the IPC check allows still starts the server.
    const w = (n: number, len = 80) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(len, "x"));
    const big = { roles: w(20), locations: w(20), fallback_locations: w(20), countries: w(10), work_modes: ["onsite", "hybrid", "remote"], salary_min: 9_999_999, salary_max: 9_999_999,
      job_types: ["full_time", "contract", "part_time", "casual", "internship"], posted_days: 365, exclude_companies: w(40), exclude_keywords: w(30) };
    expect(parseMcpArgv(["--tools", "job_new", "--search", enc(big)], env).search).toEqual(big);
  });

  it("job_new checks places and pay against the run's own choices when it has them", () => {
    const s = { ...all(sampleCopy()), search: { countries: ["Canada"], salary_min: 50000 } };
    const ok = JSON.parse(textOf(call(s, "job_new", { company: "Acme Corp", title: "AI Engineer", location: "Toronto, ON", salary: "$70k - $85k" })));
    expect(ok.created).toBe(true);
    expect(textOf(call(s, "job_new", { company: "Acme Corp", title: "AI Engineer 2", location: "Sampletown NSW" }))).toMatch(/^Not saved: This job is in Australia/);
  });

  it("job_new returns the job already there instead of adding it again, with an empty link or a new link shape", () => {
    const root = sampleCopy();
    const s = all(root);
    const first = JSON.parse(textOf(call(s, "job_new", { company: "Example Labs", title: "AI Automation & Integrations Specialist", url: "https://www.seek.com.au/job/90000011", location: "Sampletown NSW" }))) as { company_slug: string; id: string; created: boolean };
    expect(first.created).toBe(true);
    const jobsThen = fs.readdirSync(layout(root).jobsDir(first.company_slug));
    const noLink = JSON.parse(textOf(call(s, "job_new", { company: "Example Labs Pty Ltd", title: "AI automation and integrations specialist", location: "Sampletown NSW", salary: "$120k - $140k" })));
    expect(noLink).toMatchObject({ duplicate: true, company_slug: first.company_slug, id: first.id, filled: ["pay"] });
    expect(noLink.note).toMatch(/already had/);
    const otherShape = JSON.parse(textOf(call(s, "job_new", { company: "Example Labs", title: "Something renamed", url: "https://www.seek.com.au/ai-jobs?jobId=90000011&type=standard" })));
    expect(otherShape).toMatchObject({ duplicate: true, id: first.id });
    expect(fs.readdirSync(layout(root).jobsDir(first.company_slug))).toEqual(jobsThen);
  });

  it("job_new on a Chrome run needs the ad's link for a board with ad pages, unless Claude says why it can't", () => {
    const root = sampleCopy();
    const s = { ...all(root), chrome: true };
    expect(textOf(call(s, "job_new", { company: "Example Labs", title: "LLM Engineer", site: "SEEK", location: "Sampletown NSW" }))).toMatch(/pass the ad's own link/);
    expect(textOf(call(all(root), "job_new", { company: "Example Labs", title: "LLM Engineer", site: "SEEK", source: "browser", location: "Sampletown NSW" }))).toMatch(/pass the ad's own link/);
    const made = JSON.parse(textOf(call(s, "job_new", { company: "Example Labs", title: "LLM Engineer", site: "SEEK", location: "Sampletown NSW", no_link_reason: "The ad opened in a pop-up with no address." })));
    expect(made.created).toBe(true);
    expect(readRecord("job", layout(root).jobFile(made.company_slug, made.id)).timeline.map((e) => e.event)).toContain("No link to the ad");
    // A web run, or a manual find, may still add a job without a link.
    expect(JSON.parse(textOf(call(all(root), "job_new", { company: "Example Labs", title: "Agent Engineer", location: "Sampletown NSW" }))).created).toBe(true);
  });
});
