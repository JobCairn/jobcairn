import { searchOverride, type SearchOverride } from "./find-prefs.js";
import type { ActionId, ActionTarget } from "./actions.js";
import type { BoardRunDiag } from "./chrome.js";
import type { OptionValue } from "./request.js";
import { ArgError, str, type V } from "./validate.js";

/**
 * The Claude Code engine (spec 2026-10-10): the app runs the person's own Claude Code CLI headless, with the
 * CareerOS plugin loaded for that run only (--plugin-dir), to do every generation action. These are the shapes the renderer sees. Nothing here carries
 * an absolute path, raw CLI output or a credential.
 */

/**
 * Oldest Claude Code we drive: the version the run flags were tested against (--restricted,
 * --permission-prompts none, --plugin-dir, --strict-mcp-config, `auth status --json`).
 */
export const CLAUDE_MIN_VERSION = "2.1.280";
/** Bump when the consent notice text changes; people are asked again. 3: fix round 2 (web runs read no files, locks, CLAUDE.md). */
export const CLAUDE_NOTICE_VERSION = 3;
/** `{product}` stands for the product name (brand identity); the renderer fills it in. */
export const CLAUDE_NOTICE = [
  "{product} starts Anthropic's Claude Code program on this computer, signed in to your own Claude account. What Claude reads for a run is sent to Anthropic under your account's terms.",
  "{product} never reads, copies or stores your Claude login.",
  "Each run gets only what its job needs. Most runs read this workspace and write their own result files. Job search and company research use web search instead and can't read your files. Claude gets no command line, only a few {product} record tools.",
  "A run can ask to open a locked folder. It opens only if you allow it in {product}.",
  "Runs ignore your own Claude Code settings, hooks, add-ons and connected tools, and change nothing in your Claude setup. Claude Code may still read your own CLAUDE.md notes.",
  "With a Claude subscription, runs count against your plan's limits. If you sign in with an API key, {product} shows Claude Code's cost estimate for each run.",
] as const;
/** The product owner confirmed Claude's terms allow this use (fix round 2), so the Experimental tag is off. */
export const CLAUDE_EXPERIMENTAL = false;
export const CLAUDE_INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/setup";
/** At most this many runs at once. */
export const CLAUDE_MAX_PARALLEL = 2;

/**
 * What the renderer may send with a run: lane G's composer choices (request.ts `RequestChoices`), both optional.
 * There is no prompt field: main rebuilds the prompt from the action, the target and these choices with
 * `validateRequest` and `buildActionPrompt`, and the tool permissions come from the action and target only.
 */
/** `search`: find jobs only, this run's own search choices (find-prefs SearchOverride), not saved as the default. */
export interface ClaudeRunRequest { options?: Record<string, OptionValue>; note?: string; search?: SearchOverride }

export type ClaudeRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface ClaudeRunStep { label: string; state: "active" | "done" | "failed"; at: string }
export interface ClaudeRunFile { path: string; label: string; expected: boolean }
export interface ClaudeRunView {
  id: string;
  /** "inbox_suggest": Claude's look at one drop box file (reads only a copy of that file, writes nothing). */
  /** "video_script": the video maker's script writer (a run with its own prompt, writing only into one video folder). */
  action: ActionId | "test" | "video_script" | "inbox_suggest";
  /** A plain title for runs that aren't one of the actions (video scripts). */
  title?: string;
  target: ActionTarget;
  key: string;
  status: ClaudeRunStatus;
  started_at: string;
  ended_at: string;
  elapsed_ms: number;
  steps: ClaudeRunStep[];
  summary: string;
  files: ClaudeRunFile[];
  missing: string[];
  stray: string[];
  error: string;
  cost_usd: number | null;
  turns: number | null;
  /**
   * Steps Claude Code refused (its permission rules said no): the tool and a short, scrubbed description of what
   * it tried (a workspace-relative path, a command, an address). Empty or absent when nothing was refused.
   */
  refused?: ClaudeRefusal[];
  /**
   * A run that searched in the person's Chrome: how each board's tab was opened (the browser the helper drove, the
   * profile seen, reconnects, Chrome command-line calls), for the run's Details disclosure. Absent otherwise.
   */
  browser_diag?: BoardRunDiag[];
  /** A failed run that will start again on its own: try `attempt` of `of` retries, at `at` (ISO). Absent otherwise. */
  retry?: { attempt: number; of: number; at: string };
  /** This run is a retry: which one, of how many. */
  retry_of?: { attempt: number; of: number };
  /** A finished Find jobs run: the results each board showed (board-health.ts boardCounts), for later runs to compare. */
  board_counts?: Record<string, number>;
  /** A finished Find jobs run: boards that returned nothing where they usually find some, or mostly junk. Absent when all were fine. */
  board_health?: import("./board-health.js").BoardHealthWarning[];
}

/** One refused step. `what` never holds an absolute path outside the workspace or a secret; at most 200 characters. */
export interface ClaudeRefusal { tool: string; what: string }

export type ClaudeCliProblem = "missing" | "too_old" | "broken";
export type ClaudeLogin = "signed_in" | "signed_out" | "unknown";
/**
 * How Claude Code is paid for: a Claude subscription (runs count against the plan), an API key or cloud account
 * (each run costs credit), or unknown. Only "subscription" lets the app start a run on its own.
 */
export type ClaudeAuth = "subscription" | "api_key" | "unknown";
export interface ClaudeEngineState {
  cli: { found: boolean; version: string; min_version: string; problem: ClaudeCliProblem | null };
  login: ClaudeLogin;
  auth: ClaudeAuth;
  /** The CareerOS plugin that ships with the app and is loaded per run. Nothing is installed into Claude Code. */
  plugin: { found: boolean; version: string };
  consent: { given: boolean; at: string; notice_version: number };
  /** Claude Code's own cost estimates for this calendar month's runs (local time), from the run records. */
  cost: ClaudeCostTotal;
  ready: boolean;
  active_runs: number;
  /** This workspace's Claude setup (null with no workspace open). */
  workspace?: ClaudeWorkspaceSetup | null;
}

/**
 * The one-time Claude setup of the open workspace: its .claude/settings.json, the CLAUDE.md browsing rules, the
 * browser command, and the version stamp. `auto_mode`: Claude Code's auto mode for this workspace (runs that browse
 * with Bash use dontAsk either way).
 */
export interface ClaudeWorkspaceSetup {
  version: number; current: boolean; settings: boolean; claude_md: boolean; browser_command: boolean; plugin: boolean; auto_mode: boolean;
}

export interface ClaudeCostTotal { month: string; usd: number; runs: number }

export const isActiveRun = (s: ClaudeRunStatus): boolean => s === "queued" || s === "running";

/** "2.1.280 (Claude Code)" -> [2, 1, 280]; null when there is no x.y.z. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** Negative when a < b, 0 when equal, positive when a > b. Unreadable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

const MAX_NOTE_CHARS = 4000;
const MAX_OPTIONS = 20;
const OPTION_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * IPC shape check for a run request: only `options` (short text, numbers, true/false, or short lists of text) and
 * `note` (text). The per-action allowlist and the note rules are applied in main by `validateRequest`.
 */
export const claudeRunRequest: V<ClaudeRunRequest> = (v, at) => {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new ArgError(`${at} must be an object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "note" && k !== "options" && k !== "search") throw new ArgError(`${at}.${k.slice(0, 40)} is not allowed`);
  const out: ClaudeRunRequest = {};
  if (o.search !== undefined) out.search = searchOverride(o.search, `${at}.search`);
  if (o.note !== undefined) out.note = str({ max: MAX_NOTE_CHARS, multiline: true })(o.note, `${at}.note`);
  if (o.options !== undefined) {
    if (typeof o.options !== "object" || o.options === null || Array.isArray(o.options) || Object.getPrototypeOf(o.options) !== Object.prototype) throw new ArgError(`${at}.options must be an object`);
    const entries = Object.entries(o.options as Record<string, unknown>);
    if (entries.length > MAX_OPTIONS) throw new ArgError(`${at}.options has too many entries`);
    const opts: Record<string, OptionValue> = {};
    for (const [k, val] of entries) {
      if (!OPTION_KEY.test(k)) throw new ArgError(`${at}.options has a bad key`);
      if (typeof val === "string") opts[k] = str({ max: 200 })(val, `${at}.options.${k}`);
      else if ((typeof val === "number" && Number.isFinite(val)) || typeof val === "boolean") opts[k] = val;
      else if (Array.isArray(val) && val.length <= 12) opts[k] = val.map((x, i) => str({ max: 60 })(x, `${at}.options.${k}[${i}]`));
      else throw new ArgError(`${at}.options.${k} must be short text, a number, true/false or a short list`);
    }
    out.options = opts;
  }
  return out;
};

/** Run ids are made by main: "r-" + time + random hex. */
export const runId: V<string> = (v, at) => {
  if (typeof v !== "string" || !/^r-[0-9a-z]{6,20}-[0-9a-f]{8}$/.test(v)) throw new ArgError(`${at} must be a run id`);
  return v;
};
