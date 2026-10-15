import path from "node:path";
import { MAX_JOBS, searchOverride, searchReportRel, type SearchOverride } from "@careeros/contract";
import { MCP_TOOL_NAMES, mcpSession, type McpSession, type McpToolName } from "./tools.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

/**
 * The server's start arguments, as main writes them into --mcp-config: `--tools a,b` (required, known names
 * only), `--job <company_slug>/<id>` (optional), `--mode chrome` (a find-jobs run that browses the person's Chrome,
 * with search_add), `--report <file>` (with search_report), `--jobs <n>` (a find-jobs run's target, with job_new: its
 * job_new and search_add caps grow with it), and CAREEROS_WORKSPACE in the environment. Anything else is refused.
 */
export function parseMcpArgv(argv: readonly string[], env: Record<string, string | undefined>): McpSession {
  const root = env.CAREEROS_WORKSPACE ?? "";
  if (!root) throw new Error("needs CAREEROS_WORKSPACE");
  let tools: string[] | null = null;
  let job: McpSession["job"] = null;
  let mode: "chrome" | null = null;
  let ask: string | null = null;
  let search: SearchOverride | null = null;
  let report: string | null = null;
  let jobs: number | null = null;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--tools" && tools === null) tools = value.split(",").filter(Boolean);
    else if (flag === "--job" && job === null) {
      const [company_slug, id, ...rest] = value.split("/");
      if (!company_slug || !id || rest.length || !SLUG.test(company_slug) || !SLUG.test(id)) throw new Error("--job must be <company>/<job>");
      job = { company_slug, id };
    } else if (flag === "--mode" && mode === null) {
      if (value !== "chrome") throw new Error("--mode must be chrome");
      mode = value;
    } else if (flag === "--ask" && ask === null) {
      // Only the run's own answer folder: <workspace>/.careeros/tmp/ask-<hex>.
      const want = path.join(root, ".careeros", "tmp");
      if (!path.isAbsolute(value) || path.dirname(value) !== want || !/^ask-[0-9a-f]{8,32}$/.test(path.basename(value))) throw new Error("--ask must be the run's answer folder");
      ask = value;
    } else if (flag === "--search" && search === null) {
      // Find jobs: the run's own search choices, as base64url JSON, checked like the IPC request.
      if (!/^[A-Za-z0-9_-]{1,32000}$/.test(value)) throw new Error("--search must be base64url");
      let raw: unknown;
      try { raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("--search must be JSON"); }
      search = searchOverride(raw, "--search");
    } else if (flag === "--report" && report === null) {
      // The one report file this run may write (search_report), fixed by main from the run's local date.
      if (!searchReportRel(value)) throw new Error("--report must be a report file");
      report = value;
    } else if (flag === "--jobs" && jobs === null) {
      const n = /^[1-9][0-9]{0,3}$/.test(value) ? Number(value) : 0;
      if (n < MAX_JOBS.min || n > MAX_JOBS.max) throw new Error(`--jobs must be a whole number from ${MAX_JOBS.min} to ${MAX_JOBS.max}`);
      jobs = n;
    } else throw new Error(`unknown or repeated argument ${String(flag).slice(0, 40)}`);
  }
  if (!tools || !tools.length) throw new Error("needs --tools");
  const bad = tools.find((t) => !(MCP_TOOL_NAMES as readonly string[]).includes(t));
  if (bad) throw new Error(`unknown tool ${bad.slice(0, 40)}`);
  if (mode !== null && !tools.includes("search_add")) throw new Error("--mode goes with the search_add tool");
  if ((ask !== null) !== tools.includes("inbox_suggest")) throw new Error("--ask and the inbox_suggest tool go together");
  if (search !== null && !tools.includes("job_new")) throw new Error("--search goes with the job_new tool");
  if (jobs !== null && !tools.includes("job_new")) throw new Error("--jobs goes with the job_new tool");
  if ((report !== null) !== tools.includes("search_report")) throw new Error("--report and the search_report tool go together");
  return { ...mcpSession(root, tools as McpToolName[], job), ask, search, report, jobs, chrome: mode === "chrome" };
}
