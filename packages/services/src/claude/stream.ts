import path from "node:path";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import type { ClaudeRefusal } from "@careeros/contract";
import { oneLine, scrubMessage } from "./scrub.js";

/**
 * Turns Claude Code's `--output-format stream-json --verbose` lines into plain progress. Raw JSON, tool inputs
 * and absolute paths never leave this module: steps are fixed phrases, and any free text is scrubbed.
 */

export type StreamEvent =
  | { kind: "step"; label: string }
  | { kind: "write"; toolId: string; rel: string | null }
  | { kind: "tool_result"; toolId: string; ok: boolean }
  | { kind: "text"; text: string }
  /** How this run is signed in. Only API-key runs are billed per use, so only they show a cost. */
  | { kind: "auth"; apiKey: boolean }
  | { kind: "result"; ok: boolean; text: string; cost_usd: number | null; duration_ms: number | null; turns: number | null; denials: number; refused: ClaudeRefusal[] };

const WRITE_LABELS: [RegExp, string][] = [
  [/(^|\/)resume\.md$/, "Writing your resume"],
  [/(^|\/)cover-letter\.md$/, "Writing your cover letter"],
  [/(^|\/)claims\.json$/, "Checking claims"],
  [/(^|\/)review\.json$/, "Reviewing the drafts"],
  [/(^|\/)answers\.md$/, "Answering the application questions"],
  [/(^|\/)score\.md$/, "Scoring the job"],
  [/(^|\/)research\.md$/, "Writing the company research"],
  [/(^|\/)questions\.md$/, "Writing interview questions"],
  [/(^|\/)script\.txt$/, "Writing the video script"],
  [/(^|\/)spec\.json$/, "Planning the video"],
  [/(^|\/)sources\.md$/, "Listing sources"],
  [/(^|\/)pitch\.md$/, "Writing your pitch"],
  [/(^|\/)notes\.md$/, "Writing notes"],
  [/job-searches\/[^/]+\.md$/, "Writing the search report"],
];
const READ_LABELS: [RegExp, string][] = [
  [/(^|\/)jd\.md$/, "Reading the job ad"],
  [/(^|\/)me\/(history|resumes)(\/|$)/, "Reading your experience"],
  [/(^|\/)research\.md$/, "Reading the company research"],
  [/(^|\/)score\.md$/, "Reading the job score"],
  [/(^|\/)application\//, "Reading your application"],
  [/(^|\/)settings\//, "Reading your settings"],
  [/(^|\/)SKILL\.md$|(^|\/)skills\//, `Reading the ${identity.name} skill`],
];
const BASH_LABELS: [RegExp, string][] = [
  [/jobcairn-chrome\s+skills\b/, "Getting ready to browse"],
  [/jobcairn-chrome\s+get\s+text\b/, "Reading a job ad in Chrome"],
  [/jobcairn-chrome\s+close\b/, "Closing its tabs in Chrome"],
  [/jobcairn-chrome\b/, "Searching your job boards in Chrome"],
  [/^careeros\s+search\b/, "Logging searches"],
  [/^careeros\s+job\s+new\b/, "Adding a job"],
  [/^careeros\s+job\b/, "Updating the job"],
  [/^careeros\s+request\s+access\b/, "Asking you for access"],
  [/^careeros\b/, "Updating your records"],
];

/** A tool path as workspace-relative with forward slashes, or null when it is outside the workspace. */
export function relToRoot(root: string, p: unknown): string | null {
  if (typeof p !== "string" || !p) return null;
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p);
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

const pick = (table: [RegExp, string][], s: string, dflt: string) => table.find(([re]) => re.test(s))?.[1] ?? dflt;

/** The plain step for one tool call. Never includes the tool's input. */
export function toolStep(root: string, name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read": case "NotebookRead": {
      const rel = relToRoot(root, input.file_path);
      return rel ? pick(READ_LABELS, rel, "Reading your files") : "Reading a file";
    }
    case "Glob": case "Grep": case "LS": return "Looking through your files";
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": {
      const rel = relToRoot(root, input.file_path ?? input.notebook_path);
      return rel ? pick(WRITE_LABELS, rel, "Writing a file") : "Writing a file";
    }
    case "WebSearch": return "Searching the web";
    case "WebFetch": {
      try { return `Reading ${new URL(String(input.url)).hostname.replace(/^www\./, "")}`; } catch { return "Reading a web page"; }
    }
    case "Bash": return pick(BASH_LABELS, typeof input.command === "string" ? input.command.trim() : "", "Running a command");
    case "Skill": {
      const s = String(input.skill ?? input.command ?? input.name ?? "").replace(/^careeros:/, "");
      return /^[a-z][a-z-]{0,30}$/.test(s) ? `Using the ${s} skill` : `Using a ${identity.name} skill`;
    }
    case "mcp__careeros__job_new": return "Adding a job";
    case "mcp__careeros__search_report": return "Writing the search report";
    case "TodoWrite": return "Planning the work";
    case "Task": case "Agent": return "Working on a part of it";
    default: return "Working";
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One stream-json line to zero or more events. Lines that aren't JSON objects are ignored. */
/**
 * A result line longer than the runner's 64 KB line cap arrives cut off, so it isn't valid JSON. Read what is
 * there: success when it says so before the cut, with the reply text that made it. Cost and turns, which come
 * after the reply, are unknown.
 */
function truncatedResult(root: string, line: string): StreamEvent[] {
  if (!/^\s*\{\s*"type"\s*:\s*"result"/.test(line)) return [];
  const ok = /"subtype"\s*:\s*"success"/.test(line) && !/"is_error"\s*:\s*true/.test(line);
  const m = /"result"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(line);
  let text = "";
  if (m) {
    const raw = m[1]!.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
    try { text = JSON.parse(`"${raw}"`) as string; } catch { text = ""; }
  }
  return [{ kind: "result", ok, text: scrubMessage(text, root, 600), cost_usd: null, duration_ms: null, turns: null, denials: 0, refused: [] }];
}

export function parseLine(root: string, line: string): StreamEvent[] {
  let j: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    j = v as Record<string, unknown>;
  } catch { return truncatedResult(root, line); }
  const out: StreamEvent[] = [];
  const content = (j.message as { content?: unknown } | undefined)?.content;
  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  switch (j.type) {
    case "system":
      if (j.subtype === "init") {
        out.push({ kind: "step", label: "Starting Claude" });
        // "none" means a Claude subscription login (Pro, Max, Team): runs count against the plan, not a bill.
        out.push({ kind: "auth", apiKey: typeof j.apiKeySource === "string" && j.apiKeySource !== "" && j.apiKeySource !== "none" });
      }
      break;
    case "assistant":
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ kind: "text", text: scrubMessage(b.text, root, 400) });
        if (b?.type === "tool_use" && typeof b.name === "string") {
          const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
          out.push({ kind: "step", label: toolStep(root, b.name, input) });
          if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(b.name)) {
            out.push({ kind: "write", toolId: String(b.id ?? ""), rel: relToRoot(root, input.file_path ?? input.notebook_path) });
          }
        }
      }
      break;
    case "user":
      for (const b of blocks) if (b?.type === "tool_result") out.push({ kind: "tool_result", toolId: String(b.tool_use_id ?? ""), ok: b.is_error !== true });
      break;
    case "result": {
      const ok = j.subtype === "success" && j.is_error !== true;
      const denials = Array.isArray(j.permission_denials) ? j.permission_denials.length : 0;
      const refused = Array.isArray(j.permission_denials) ? (j.permission_denials as unknown[]).slice(0, 20).map((d) => refusal(root, d)) : [];
      const text = typeof j.result === "string" ? j.result : typeof j.error === "string" ? j.error : Array.isArray(j.errors) ? j.errors.map(String).join(" ") : "";
      out.push({ kind: "result", ok, text: scrubMessage(text, root, 600), cost_usd: num(j.total_cost_usd), duration_ms: num(j.duration_ms), turns: num(j.num_turns), denials, refused });
      break;
    }
    default: break;
  }
  return out;
}

/**
 * One permission denial from Claude Code's result (`{ tool_name, tool_use_id, tool_input }`) in plain, safe words:
 * a file tool gives its workspace-relative path (or "a file outside the workspace"), Bash its command, a web tool
 * its address, anything else nothing more than its name. Scrubbed and capped.
 */
export function refusal(root: string, d: unknown): ClaudeRefusal {
  const o = d && typeof d === "object" ? d as { tool_name?: unknown; tool_input?: unknown } : {};
  const tool = typeof o.tool_name === "string" ? oneLine(o.tool_name, 80) : "unknown";
  const input = o.tool_input && typeof o.tool_input === "object" ? o.tool_input as Record<string, unknown> : {};
  let what = "";
  const file = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof file === "string" && file) what = relToRoot(root, file) || "a file outside the workspace";
  else if (typeof input.command === "string") what = input.command;
  else if (typeof input.url === "string") what = input.url;
  else if (typeof input.pattern === "string") what = input.pattern;
  else if (typeof input.skill === "string") what = input.skill;
  return { tool, what: what ? scrubMessage(oneLine(what, 400), root, 200) : "" };
}

/** The last sentence or two of Claude's closing message, as a short plain summary. */
export function summarise(text: string): string {
  const t = oneLine(text.replace(/[#*_`>|]+/g, " "), 400);
  return t.length > 280 ? `${t.slice(0, 277).trimEnd()}...` : t;
}
