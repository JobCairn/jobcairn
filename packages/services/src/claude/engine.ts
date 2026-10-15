import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { claudeMode, layout, lockedOrAll, setClaudeMode, readMeta, readRecord, writeRecord, type LockableDir } from "@careeros/core";
import {
  ACTIONS, CLAUDE_MAX_PARALLEL, CLAUDE_MIN_VERSION, CLAUDE_NOTICE_VERSION, MAX_JOBS, RENDERS, TEMPLATE_ONLY, findBudget,
  actionKey, actionPaths, boardFiltersOf, buildActionPrompt, claudeWrites, isActiveRun, nextVideoFolder, outputNames, ownTarget, prefsMissing, prefsMissingText, searchOverride, withSavedSearchOptions, studioOutputs, validateRequest,
  BOARD_NAMES, SKIPPED_NOT_ALLOWED, type BoardId, type ActionId, type ActionTarget, type ClaudeAuth, type ClaudeEngineState, type ClaudeRefusal, type ClaudeLogin, type ClaudeRunRequest, type ClaudeRunStep, type ClaudeRunView, type RequestChoices,
} from "@careeros/contract";
import { actionStatus, folderProbeFor, promptInfo, writableProblem } from "../actions.js";
import type { ServiceContext } from "../context.js";
import { claudeArgs, inboxSuggestPlan, testArgs, videoScriptPlan, WEB_ACTIONS, type BrowserPlan, type ToolPlan } from "./args.js";
import { browserRequest, checkRequest, chromeFor, SCHEDULED_CONNECT_MS } from "../chrome/service.js";
import { installChromeCli } from "../chrome/cli.js";
import { ensureWorkspaceSetup, workspaceSetup } from "./workspace-setup.js";
import { readSearchPrefs, webContext } from "./context.js";
import { documentSkills } from "../learn-hub.js";
import { savedRequest } from "../request-store.js";
import { studioRequest } from "../resume.js";
import { emailRequest } from "../mail-ai.js";
import { mcpToolsFor } from "./mcp/tools.js";
import { checkAuth, checkCli, isAuthError, type ClaudeHost, type ClaudeLaunch } from "./detect.js";
import { bundledPlugin, type BundledPlugin } from "./plugin.js";
import { cleanEnv } from "./process.js";
import { workspaceSecrets } from "../secrets.js";
import { addCost, listRuns, monthCost, saveRun } from "./runs.js";
import { scrubMessage } from "./scrub.js";
import { parseLine, summarise } from "./stream.js";
import { snapshot, verifyRun, type Snapshot } from "./verify.js";
import { isTransientFailure, retryDelay } from "./retry.js";
import { cleanBoards } from "../chrome/boards.js";

export const CAREER_TIMEOUT_MS = 20 * 60_000;
export const VIDEO_TIMEOUT_MS = 45 * 60_000;

/** The new jobs a find-jobs request aims for (its validated max_jobs, else the default). */
export function findJobsTarget(request: RequestChoices | null): number {
  const n = request?.options.max_jobs;
  return typeof n === "number" && Number.isInteger(n) && n >= MAX_JOBS.min && n <= MAX_JOBS.max ? n : MAX_JOBS.default;
}
export const TEST_TIMEOUT_MS = 2 * 60_000;
const STATE_TTL_MS = 30_000;
const SAVE_EVERY_MS = 500;
const MAX_STEPS = 40;

interface Live {
  view: ClaudeRunView;
  root: string | null;
  /** Web runs: outputs that already exist are moved aside first (they can't be read, so Write could refuse them). */
  web: boolean;
  /** Files moved aside for this run, restored if it doesn't succeed. */
  setAside: { from: string; to: string }[];
  /** Where Claude Code runs: the workspace, or an empty temporary folder for the setup test (removed after). */
  cwd: string;
  tempCwd: boolean;
  prompt: string;
  args: string[];
  folder: string | null;
  /** Career actions: the exact files the run may write. Null: anything in `folder`. */
  files: readonly string[] | null;
  expected: string[];
  timeoutMs: number;
  abort: AbortController;
  startedMs: number;
  before: Snapshot;
  others: Set<string>;
  writes: Map<string, string | null>;
  done: (string | null)[];
  lastText: string;
  /** True once Claude Code reports an API-key login; a subscription run never records a cost. */
  apiKey: boolean;
  result: { ok: boolean; text: string } | null;
  denials: number;
  savedAt: number;
  /** Lane S: a find-jobs run browsing the person's Chrome. Its tabs and control folder are cleaned up at the end. */
  browser: BrowserPlan | null;
  /** Called once when the run ends, however it ends (the drop box reads its answer here). */
  onEnd?: (v: ClaudeRunView) => void;
  /** Find jobs: how to start it again if it fails for a passing reason ("If it fails, try again"). */
  again?: { id: ActionId; t: ActionTarget; req: ClaudeRunRequest; attempt: number; of: number; skip: BoardId[]; o: RunOptions };
}

/** How a run was started: `scheduled` by "Repeat this search" (askAllow says so before Chrome asks "Allow"). */
export interface RunOptions { scheduled?: { askAllow?: () => void } }

/** A scheduled Find jobs search that needs Chrome and couldn't use it: skipped (never a web search instead). */
export class ScheduledSkip extends Error {}

/** What a retry carries into the next start: which try it is and the boards already searched. */
interface RetryInfo { attempt: number; of: number; skip: BoardId[] }

/** " It wasn't allowed to: Bash (agent-browser open …), Write (notes.md)." Names what was refused, never guesses why. */
export function refusedLine(refused: readonly ClaudeRefusal[], count: number): string {
  if (!count && !refused.length) return "";
  if (!refused.length) return ` ${count} of its steps ${count === 1 ? "was" : "were"} refused.`;
  const shown = refused.slice(0, 3).map((r) => (r.what ? `${r.tool} (${r.what.length > 80 ? `${r.what.slice(0, 77)}...` : r.what})` : r.tool));
  const more = Math.max(count, refused.length) - shown.length;
  return ` It wasn't allowed to: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}

const NOT_READY: Record<string, string> = {
  consent: "Set up Claude first: open Settings > Claude and read the short notice.",
  missing: "Claude Code isn't installed on this computer. Open Settings > Claude to set it up.",
  too_old: `Claude Code is too old (${identity.name} needs ${CLAUDE_MIN_VERSION} or newer). Update it, then try again.`,
  broken: "Claude Code is installed but didn't answer. Open Settings > Claude and choose Check again.",
  signed_out: "Claude Code isn't signed in. Open Settings > Claude to sign in.",
  plugin: `This copy of ${identity.name} is missing its Claude add-on. Reinstall ${identity.name}, then try again.`,
};

/** How many times a Find jobs run may start again (the "retries" option; 2 when unset). */
function retriesOf(request: RequestChoices | null): number {
  const n = Number(request?.options.retries ?? 2);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 2;
}

/** The boards a browsing run finished or stopped (done or skipped), from its progress file. */
function doneBoards(dir: string): BoardId[] {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, "progress.json"), "utf8")) as { boards?: { id?: unknown; state?: unknown }[] };
    return cleanBoards((p.boards ?? []).filter((b) => b.state === "done" || b.state === "skipped").map((b) => String(b.id)));
  } catch { return []; }
}

/** Fixed words for a retry's prompt: which try it is, and the boards (by name) not to search again. */
export function retryLine(r: RetryInfo, boards: readonly BoardId[]): string {
  const skip = r.skip.filter((b) => !boards.length || boards.includes(b)).map((b) => BOARD_NAMES[b]);
  return [
    `This is retry ${r.attempt} of ${r.of}: the last try stopped before it finished (a network, Chrome or service problem).`,
    skip.length ? `These boards were already searched: ${skip.join(", ")}. Don't search them again; carry on with the others.` : "Carry on where it stopped.",
    "Jobs it already added are in the workspace: job_new says duplicate for them, so count them as already had. Check search_check before each query, so searches already run aren't repeated.",
  ].join(" ");
}

const newId = (now: Date) => `r-${now.getTime().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;

export class ClaudeEngine {
  private live = new Map<string, Live>();
  /** Failed runs waiting to start again, by the failed run's id. */
  private waiting = new Map<string, { root: string; timer: ReturnType<typeof setTimeout>; view: ClaudeRunView }>();
  /** Starts still being checked, by workspace + action key. Set before the first await, so a double click gets one run. */
  private pending = new Map<string, Promise<ClaudeRunView>>();
  private queue: Live[] = [];
  /** "api_key" once a run reported an API key; used only when Claude Code's status doesn't say. Never "subscription". */
  private runAuth: ClaudeAuth = "unknown";
  private cached: { at: number; state: Omit<ClaudeEngineState, "consent" | "ready" | "active_runs" | "cost">; launch: ClaudeLaunch | null } | null = null;

  constructor(private ctx: ServiceContext) {
    // A workspace switch or app quit stops this workspace's runs.
    ctx.onOpen((root) => () => this.cancelAll(root));
  }

  private get host(): ClaudeHost | null { return this.ctx.host.claude ?? null; }
  private env(): Record<string, string> {
    const h = this.host!;
    const env = cleanEnv({ PATH: h.env.PATH ?? h.env.Path ?? "" }, h.env);
    // The person's own API key (Settings > Connections > Claude), when they chose to pay per use: Claude Code then
    // bills it instead of their Claude plan. Only this workspace's saved key; never one from the app's environment.
    const key = this.apiKey();
    if (key) env.ANTHROPIC_API_KEY = key;
    return env;
  }

  private apiKey(): string | null {
    if (!this.ctx.root) return null;
    try {
      const s = workspaceSecrets(this.ctx);
      return s.available() && s.has("anthropic_api_key") ? s.get("anthropic_api_key") : null;
    } catch { return null; }
  }

  private consent(): ClaudeEngineState["consent"] {
    const root = this.ctx.root;
    if (!root) return { given: false, at: "", notice_version: CLAUDE_NOTICE_VERSION };
    try {
      const c = readRecord("integrations", layout(root).integrations).claude_code;
      const ok = !!c && c.notice_version === CLAUDE_NOTICE_VERSION && /^\d{4}-\d{2}-\d{2}T/.test(c.consent_at);
      return { given: ok, at: ok ? c!.consent_at : "", notice_version: CLAUDE_NOTICE_VERSION };
    } catch { return { given: false, at: "", notice_version: CLAUDE_NOTICE_VERSION }; }
  }

  private activeCount(): number { return [...this.live.values()].filter((l) => isActiveRun(l.view.status)).length; }

  async state(recheck: boolean): Promise<ClaudeEngineState> {
    const h = this.host;
    const now = Date.now();
    if (!this.cached || recheck || now - this.cached.at > STATE_TTL_MS) {
      if (!h) {
        this.cached = { at: now, launch: null, state: { cli: { found: false, version: "", min_version: CLAUDE_MIN_VERSION, problem: "missing" }, login: "unknown", auth: "unknown", plugin: { found: false, version: "" } } };
      } else {
        const env = this.env();
        const cli = await checkCli(h, env);
        let login: ClaudeLogin = "unknown";
        let auth: ClaudeAuth = "unknown";
        const plugin: BundledPlugin = bundledPlugin(h.pluginDir);
        if (cli.launch && !cli.problem) ({ login, auth } = await checkAuth(h, cli.launch, env));
        this.cached = {
          at: now, launch: cli.problem ? null : cli.launch,
          state: { cli: { found: cli.problem !== "missing", version: cli.version, min_version: CLAUDE_MIN_VERSION, problem: cli.problem }, login, auth, plugin },
        };
      }
    }
    const s = this.cached.state;
    const consent = this.consent();
    const ready = !s.cli.problem && s.login !== "signed_out" && s.plugin.found && consent.given;
    // When Claude Code's status doesn't say, the last run's own report (its init line) does.
    const auth = this.authHint();
    const root = this.ctx.root;
    let workspace: ClaudeEngineState["workspace"] = null;
    try { workspace = root ? workspaceSetup(root, h?.mcp ?? null, h?.pluginDir ?? null) : null; } catch { workspace = null; }
    return { ...structuredClone(s), auth, consent, ready, active_runs: this.activeCount(), cost: monthCost(this.ctx.root, this.ctx.now()), workspace };
  }

  /** Auto mode on or off for this workspace: rewrites .claude/settings.json; the next runs use it. */
  async setAutoMode(on: boolean): Promise<ClaudeEngineState> {
    const root = this.ctx.requireRoot();
    setClaudeMode(root, on ? "auto" : "ask", this.ctx.clock());
    return this.state(false);
  }

  /** Puts the workspace's Claude setup in place again (idempotent). */
  async repair(): Promise<ClaudeEngineState> {
    const root = this.ctx.requireRoot();
    ensureWorkspaceSetup(root, this.host?.mcp ?? null, this.ctx.clock(), this.host?.pluginDir ?? null);
    return this.state(true);
  }

  async giveConsent(): Promise<ClaudeEngineState> {
    const root = this.ctx.requireRoot();
    const file = layout(root).integrations;
    const cur = readRecord("integrations", file);
    writeRecord("integrations", file, { ...cur, claude_code: { consent_at: this.ctx.now().toISOString(), notice_version: CLAUDE_NOTICE_VERSION } });
    try { ensureWorkspaceSetup(root, this.host?.mcp ?? null, this.ctx.clock(), this.host?.pluginDir ?? null); } catch { /* Repair in Settings says what's missing */ }
    return this.state(false);
  }

  private async launchOrThrow(): Promise<ClaudeLaunch> {
    const s = await this.state(false);
    if (s.cli.problem || !this.cached?.launch) throw new Error(NOT_READY[s.cli.problem ?? "missing"]);
    return this.cached.launch;
  }

  async openSignIn(): Promise<boolean> {
    const launch = await this.launchOrThrow();
    const ok = await this.host!.openTerminal(launch.cli);
    this.cached = null;
    return ok;
  }

  private async readyOrThrow(needPlugin: boolean): Promise<ClaudeLaunch> {
    const s = await this.state(false);
    if (!s.consent.given) throw new Error(NOT_READY.consent);
    if (s.cli.problem) throw new Error(NOT_READY[s.cli.problem]);
    if (s.login === "signed_out") throw new Error(NOT_READY.signed_out);
    if (needPlugin && !s.plugin.found) throw new Error(NOT_READY.plugin);
    return this.cached!.launch!;
  }

  private emit(): void { this.ctx.emit("claude"); }

  private persist(l: Live, force = false): void {
    const now = Date.now();
    if (!force && now - l.savedAt < SAVE_EVERY_MS) return;
    l.savedAt = now;
    if (l.root) { try { saveRun(l.root, l.view); } catch (e) { console.error(`careeros: couldn't save a Claude run record (${(e as Error).message})`); } }
    this.emit();
  }

  private newLive(over: Partial<Pick<Live, "web">> & Pick<Live, "root" | "cwd" | "tempCwd" | "prompt" | "args" | "folder" | "files" | "expected" | "timeoutMs"> & { action: ClaudeRunView["action"]; target: ActionTarget; key: string }): Live {
    const now = this.ctx.now();
    const view: ClaudeRunView = {
      id: newId(now), action: over.action, target: over.target, key: over.key, status: "queued", started_at: now.toISOString(), ended_at: "",
      elapsed_ms: 0, steps: [], summary: "", files: [], missing: [], stray: [], error: "", cost_usd: null, turns: null,
    };
    return {
      view, root: over.root, web: over.web ?? false, setAside: [], cwd: over.cwd, tempCwd: over.tempCwd, prompt: over.prompt, args: over.args, folder: over.folder, files: over.files, expected: over.expected, timeoutMs: over.timeoutMs,
      abort: new AbortController(), startedMs: Date.now(), before: new Map(), others: new Set(), writes: new Map(), done: [], lastText: "", apiKey: false, result: null, denials: 0, savedAt: 0,
      browser: null,
    };
  }

  private enqueue(l: Live): ClaudeRunView {
    this.live.set(l.view.id, l);
    this.persist(l, true);
    this.queue.push(l);
    this.pump();
    return this.view(l);
  }

  private pump(): void {
    while (this.queue.length && [...this.live.values()].filter((x) => x.view.status === "running").length < CLAUDE_MAX_PARALLEL) {
      const next = this.queue.shift()!;
      void this.execute(next);
    }
  }

  /**
   * Starts `id` on `target`, or returns the run already active (or still starting) for it. Everything up to the
   * reservation is synchronous, so two calls in the same tick share one run (R5).
   */
  run(id: ActionId, target: ActionTarget, req: ClaudeRunRequest, o: RunOptions = {}): Promise<ClaudeRunView> {
    try {
      if (!claudeWrites(id)) throw new Error(TEMPLATE_ONLY);
      const root = this.ctx.requireRoot();
      const t = ownTarget(id, target);
      const key = actionKey(id, t);
      return this.reserve(root, key, () => this.start(id, t, key, root, req, null, o));
    } catch (e) { return Promise.reject(e); }
  }

  /** True while a Find jobs run is queued or running, or a failed one is waiting to try again (the scheduler waits). */
  findJobsBusy(): boolean {
    const root = this.ctx.root;
    return [...this.live.values()].some((l) => l.root === root && l.view.action === "find_jobs" && isActiveRun(l.view.status))
      || [...this.waiting.values()].some((w) => w.root === root && w.view.action === "find_jobs");
  }

  /**
   * "If it fails, try again": a failed Find jobs run whose error looks passing starts again after 30 seconds, then
   * 2 minutes, then 5. The failed run's record shows when (retry); Stop (cancel) on it drops the wait. The next try is
   * told which boards were already searched.
   */
  /** The run just ended and will start again (see scheduleRetry). */
  private willRetry(l: Live): boolean {
    const a = l.again;
    return !!a && !!l.root && l.view.status === "failed" && a.attempt < a.of && isTransientFailure(l.view.error);
  }

  private scheduleRetry(l: Live, done: BoardId[]): void {
    const a = l.again;
    const root = l.root;
    if (!a || !root || !this.willRetry(l)) return;
    const attempt = a.attempt + 1;
    const delay = retryDelay(attempt);
    l.view.retry = { attempt, of: a.of, at: new Date(this.ctx.now().getTime() + delay).toISOString() };
    const skip = [...new Set([...a.skip, ...done])];
    const view = l.view;
    const timer = setTimeout(() => {
      this.waiting.delete(view.id);
      delete view.retry;
      try { saveRun(root, view); } catch { /* shown without the wait anyway */ }
      if (this.ctx.root !== root) return;
      const key = actionKey(a.id, a.t);
      void this.reserve(root, key, () => this.start(a.id, a.t, key, root, a.req, { attempt, of: a.of, skip }, a.o)).catch((e: unknown) => {
        console.error(`careeros: a search's retry didn't start (${(e as Error).message})`);
        void chromeFor(this.ctx).releaseHelper();
      });
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.waiting.set(view.id, { root, timer, view });
  }

  /** Drops a failed run's wait to try again. True when there was one. */
  private stopRetry(id: string): ClaudeRunView | null {
    const w = this.waiting.get(id);
    if (!w) return null;
    clearTimeout(w.timer);
    this.waiting.delete(id);
    // The helper was kept running for the retry: nothing needs it now.
    void chromeFor(this.ctx).releaseHelper();
    delete w.view.retry;
    try { saveRun(w.root, w.view); } catch { /* the record shows the wait until the next save */ }
    this.emit();
    return structuredClone(w.view);
  }

  /** The one place a run key is claimed: an active run, else a start in progress, else a new start. */
  private reserve(root: string, key: string, start: () => Promise<ClaudeRunView>): Promise<ClaudeRunView> {
    const same = [...this.live.values()].find((l) => l.root === root && l.view.key === key && isActiveRun(l.view.status));
    if (same) return Promise.resolve(this.view(same));
    const slot = `${root}\0${key}`;
    const waiting = this.pending.get(slot);
    if (waiting) return waiting;
    const p = start().finally(() => { if (this.pending.get(slot) === p) this.pending.delete(slot); });
    this.pending.set(slot, p);
    return p;
  }

  private async start(id: ActionId, t: ActionTarget, key: string, root: string, req: ClaudeRunRequest, retry: RetryInfo | null = null, o: RunOptions = {}): Promise<ClaudeRunView> {
    await this.readyOrThrow(true);

    const now = this.ctx.now().toISOString();
    const check = (rels: string[], studio: readonly string[]) => {
      for (const rel of rels) {
        const bad = writableProblem(this.ctx, root, rel, studio);
        if (bad !== null) throw new Error(`${bad} isn't a plain folder in the workspace, so Claude can't be asked to write there.`);
      }
    };
    const first = actionPaths(id, t, { now, n: 1 });
    check([first.folder, ...first.outputs, ...first.extras], studioOutputs(id, first.outputs));
    const st = actionStatus(this.ctx, id, t);
    if (st.status === "blocked") throw new Error(`Do "${st.blockedBy.map((r) => ACTIONS[r].label).join('" and "')}" first.`);
    // Find jobs never searches blind: at least one role and one place (the owner's report: jobs from Canada).
    // Find jobs: this run's own search choices (checked at the IPC boundary; checked again here for direct callers).
    const search = id === "find_jobs" && req.search ? searchOverride(req.search, "search") : null;
    if (id === "find_jobs") {
      const missing = prefsMissing(readSearchPrefs(root, search));
      if (missing.length) throw new Error(prefsMissingText(missing));
    }
    const info = { ...promptInfo(root, t), now };
    let n = 1;
    if (ACTIONS[id].group === "video") {
      const next = nextVideoFolder(id, t, info, folderProbeFor(root));
      if (!next) throw new Error("There are too many videos in this folder. Delete some old ones first.");
      n = next.n;
    }
    const paths = actionPaths(id, t, { ...info, n });
    check([paths.folder, ...paths.outputs, ...paths.extras], studioOutputs(id, paths.outputs));
    // The prompt is always rebuilt here from the action, the target and the validated choices (lane G's
    // validateRequest: per-action option allowlist, note rules). Nothing the renderer sends becomes prompt structure.
    // The candidate's work rights decide which options exist; notes may name this action's own files. An empty
    // one-click request uses the options last chosen in the composer (never a note).
    const status = info.work_rights ?? "unknown";
    // Resume Studio sends positions in the saved resume; main maps them to the catalogue's ids (no resume text
    // comes from the renderer).
    // The email composer names its saved draft; main checks it and decides whether it answers a stored email.
    const own = id === "rewrite_resume" ? studioRequest(this.ctx, root, t, req) : id === "draft_email" ? emailRequest(root, t, req) : req;
    // A find-jobs run's own search choices were checked above; the rest is lane G's request.
    const { search: _search, ...rest } = id === "find_jobs" ? own : { ...own, search: undefined };
    const choices = validateRequest(id, id === "find_jobs" ? rest : own, outputNames(id), status);
    const asked = Object.keys(own.options ?? {}).length > 0 || !!choices.note;
    const picked = asked ? choices : savedRequest(root, id, t, status);
    // Find jobs: breadth, sponsorship-only and jobs to find are saved search settings, the same ones Settings › Search shows.
    const saved = id === "find_jobs" ? withSavedSearchOptions(picked, readSearchPrefs(root), status) : picked;
    // "Offers sponsorship" read from Find jobs' description box: this run only, and only for someone offered it.
    const request = id === "find_jobs" && search?.sponsor_only === true && saved && "sponsor_only" in saved.options ? { ...saved, options: { ...saved.options, sponsor_only: true } } : saved;
    // Find jobs: the jobs it aims for set the run's limits (findBudget): the prompt, Claude's time, the MCP caps
    // and the browser's caps all use this one number.
    const jobs = id === "find_jobs" ? findJobsTarget(request) : null;
    const web = WEB_ACTIONS.includes(id);
    // Web runs can't read the workspace (F2), so main puts what they need in front of the request.
    const base = buildActionPrompt(id, t, { ...info, n }, request);
    // Lane S: find_jobs browses the person's Chrome when Search in my Chrome is set up and connected; else web search.
    // A scheduled search waits up to 10 minutes for Allow (after a notification says why Chrome is asking).
    const scheduled = o.scheduled ? { waitMs: SCHEDULED_CONNECT_MS, ...(o.scheduled.askAllow ? { askAllow: o.scheduled.askAllow } : {}) } : undefined;
    const browser = id === "find_jobs" ? await chromeFor(this.ctx).planForRun({ jobs: jobs!, filters: boardFiltersOf(readSearchPrefs(root, search)), ...(scheduled ? { scheduled } : {}) })
      : id === "chrome_check" ? await chromeFor(this.ctx).planForRun({ check: true }) : null;
    // A scheduled search with Search in my Chrome on never falls back to the web (poorer, unexpected results): skipped.
    if (id === "find_jobs" && o.scheduled && !browser && chromeFor(this.ctx).chromeOn()) {
      const why = chromeFor(this.ctx).lastWebReason();
      throw new ScheduledSkip(why === "connect_failed" || why === "remote_off" ? SKIPPED_NOT_ALLOWED : "Skipped: Search in my Chrome wasn't ready");
    }
    // The sign-in check only works in Chrome: it never falls back to web search.
    if (id === "chrome_check" && !browser) throw new Error(chromeFor(this.ctx).checkProblem());
    // The browser command Claude runs (jobcairn-chrome), refreshed in the workspace for every browsing run.
    if (browser) {
      try { installChromeCli(root, this.host!.mcp); } catch (e) { await chromeFor(this.ctx).endRun(browser); throw e; }
    }
    const ctxText = web ? webContext(root, id, t, this.ctx.now(), search, id === "find_jobs" ? { skills: documentSkills(this.ctx, root), browser: !!browser } : {}) : "";
    const lead = `${browser ? `${id === "chrome_check" ? checkRequest(browser.boards) : browserRequest(browser.boards)}\n\n` : ""}${retry ? `${retryLine(retry, browser?.boards ?? [])}\n\n` : ""}`;
    const prompt = web ? `${lead}${ctxText ? `${ctxText}\n\n` : ""}${base}` : base;
    const video = ACTIONS[id].group === "video";
    const plan: ToolPlan = { action: id, folder: paths.folder, files: video ? undefined : [...paths.outputs, ...paths.extras], web, mcp: mcpToolsFor(id),
      job: t.kind === "job" ? { company_slug: t.company_slug, id: t.id } : null, browser, search, jobs,
      // search_report writes the run's own report file: the expected output named with this run's local date.
      report: mcpToolsFor(id).includes("search_report") ? paths.outputs[0] ?? null : null };
    const h = this.host!;
    // The workspace's Claude setup (settings, CLAUDE.md rules, browser command): refreshed before every run, cheaply.
    try { ensureWorkspaceSetup(root, h.mcp, this.ctx.clock(), h.pluginDir); } catch { /* the run's own --settings still carry every rule */ }
    // Claude writes a video's script and plan; the video maker renders it, so renders aren't expected here.
    const expected = video ? paths.outputs.filter((o) => !RENDERS.some((r) => o.endsWith(`/${r}`))) : paths.outputs;
    let l: Live;
    try {
      l = this.newLive({
        action: id, target: t, key, root, prompt, cwd: root, tempCwd: false, web,
        args: claudeArgs(plan, lockedOrAll(root, this.ctx.clock()), { root, pluginDir: h.pluginDir, mcp: h.mcp, mode: claudeMode(root) }), folder: paths.folder, files: plan.files ?? null, expected,
        timeoutMs: video ? VIDEO_TIMEOUT_MS : jobs ? Math.max(CAREER_TIMEOUT_MS, findBudget(jobs).claudeMs) : CAREER_TIMEOUT_MS,
      });
    } catch (e) {
      if (browser) await chromeFor(this.ctx).endRun(browser);
      throw e;
    }
    l.browser = browser;
    if (id === "find_jobs") {
      const of = retry?.of ?? retriesOf(request);
      l.again = { id, t, req, attempt: retry?.attempt ?? 0, of, skip: retry?.skip ?? [], o };
      if (retry) l.view.retry_of = { attempt: retry.attempt, of };
    }
    for (const other of this.live.values()) {
      if (!isActiveRun(other.view.status) || other.root !== root) continue;
      for (const f of other.files ?? (other.folder ? [other.folder] : [])) l.others.add(f);
      for (const f of l.files ?? (l.folder ? [l.folder] : [])) other.others.add(f);
    }
    return this.enqueue(l);
  }

  /** The last known readiness, without a new check: null until `state()` has run once. */
  /** The last known sign-in type, without checking again. */
  authHint(): ClaudeAuth {
    if (!this.cached) return "unknown";
    const s = this.cached.state;
    return s.auth !== "unknown" || s.login === "signed_out" ? s.auth : this.runAuth;
  }

  readyHint(): boolean | null {
    if (!this.cached) return null;
    const s = this.cached.state;
    return !s.cli.problem && s.login !== "signed_out" && s.plugin.found && this.consent().given;
  }

  /** One run, live or recorded. */
  get(id: string): ClaudeRunView | undefined {
    const l = this.live.get(id);
    if (l) return this.view(l);
    const root = this.ctx.root;
    if (!root) return undefined;
    let r: ClaudeRunView | undefined;
    try { r = listRuns(root).find((x) => x.id === id); } catch { return undefined; }
    // Not live but stored as active: its last save failed, or the app closed. Read it as stopped, like runs() does,
    // so nobody waits on it forever (fix round 1, item 3).
    if (r && isActiveRun(r.status)) {
      r.status = "failed";
      r.error = r.error || `Claude stopped, but ${identity.name} couldn't save how the run ended. Try again.`;
      r.ended_at = r.ended_at || r.started_at;
    }
    return r;
  }

  /**
   * The video maker's script writer (video Task 20): a run with the video lane's own prompt that may write only
   * `files`, directly inside one video folder. Same isolation as every workspace run (videoScriptPlan): workspace
   * reads with the locked folders denied, no web tools, no shell, only the request_access tool. Returns at once
   * (the readiness check finishes in the background; a failed check fails the run with the usual plain message).
   * `open` lists the locked folders a live grant opened for this run, so the video can record them as locked facts.
   */
  startVideoScript(o: { title: string; prompt: string; folder: string; files: readonly string[] }): { view: ClaudeRunView; open: LockableDir[] } {
    const root = this.ctx.requireRoot();
    const h = this.host;
    if (!h) throw new Error(NOT_READY.missing);
    if (!o.files.length || o.files.some((f) => !f.startsWith(`${o.folder}/`) || f.slice(o.folder.length + 1).includes("/"))) {
      throw new Error("A video script's files must sit directly in its video folder.");
    }
    for (const rel of [o.folder, ...o.files]) {
      const bad = writableProblem(this.ctx, root, rel);
      if (bad !== null) throw new Error(`${bad} isn't a plain folder in the workspace, so Claude can't be asked to write there.`);
    }
    const locked = lockedOrAll(root, this.ctx.clock());
    let configured: readonly LockableDir[] = [];
    try { configured = readMeta(root).privacy.locked; } catch { configured = []; }
    const open = configured.filter((d) => !locked.includes(d));
    const key = `video_script--${o.folder}`;
    const same = [...this.live.values()].find((l) => l.root === root && l.view.key === key && isActiveRun(l.view.status));
    if (same) return { view: this.view(same), open };
    const l = this.newLive({
      action: "video_script", target: { kind: "workspace" }, key, root, prompt: o.prompt, cwd: root, tempCwd: false,
      args: claudeArgs(videoScriptPlan(o.folder, o.files), locked, { root, pluginDir: h.pluginDir, mcp: h.mcp, mode: claudeMode(root) }),
      folder: o.folder, files: [...o.files], expected: [...o.files], timeoutMs: VIDEO_TIMEOUT_MS,
    });
    l.view.title = o.title;
    // The video maker keeps its own records in the folder while the run works; they are not Claude's.
    for (const own of ["video.json", "request.json"]) l.others.add(`${o.folder}/${own}`);
    for (const other of this.live.values()) {
      if (!isActiveRun(other.view.status) || other.root !== root) continue;
      for (const f of other.files ?? (other.folder ? [other.folder] : [])) l.others.add(f);
      for (const f of l.files ?? []) other.others.add(f);
    }
    this.live.set(l.view.id, l);
    this.persist(l, true);
    const settle = (status: "failed" | "cancelled", error = "") => {
      if (status === "failed") this.fail(l, error);
      else l.view.status = "cancelled";
      l.view.ended_at = this.ctx.now().toISOString();
      this.persist(l, true);
      this.live.delete(l.view.id);
    };
    void this.readyOrThrow(true).then(
      () => {
        if (l.abort.signal.aborted) { settle("cancelled"); return; }
        this.queue.push(l);
        this.pump();
      },
      (e: unknown) => { if (l.abort.signal.aborted) settle("cancelled"); else settle("failed", (e as Error).message); },
    );
    return { view: this.view(l), open };
  }

  /**
   * Claude's look at one drop box file (smart drop box, stage b). The run may read only `file` (a copy main made in
   * `ask`, workspace-relative) and call inbox_suggest, which writes its answer into `ask`. No other workspace file,
   * no web, no writes. Main never makes a copy of a file meant for a locked folder. `onEnd` runs once when it ends.
   */
  startInboxSuggest(o: { key: string; title: string; prompt: string; file: string; ask: string; onEnd: (v: ClaudeRunView) => void }): ClaudeRunView {
    const root = this.ctx.requireRoot();
    const h = this.host;
    if (!h) throw new Error(NOT_READY.missing);
    const same = [...this.live.values()].find((l) => l.root === root && l.view.key === o.key && isActiveRun(l.view.status));
    if (same) return this.view(same);
    const l = this.newLive({
      action: "inbox_suggest", target: { kind: "workspace" }, key: o.key, root, prompt: o.prompt, cwd: root, tempCwd: false,
      args: claudeArgs(inboxSuggestPlan(o.file, o.ask), lockedOrAll(root, this.ctx.clock()), { root, pluginDir: h.pluginDir, mcp: h.mcp, mode: claudeMode(root) }),
      folder: null, files: null, expected: [], timeoutMs: TEST_TIMEOUT_MS * 2,
    });
    l.view.title = o.title;
    l.onEnd = o.onEnd;
    this.live.set(l.view.id, l);
    this.persist(l, true);
    void this.readyOrThrow(true).then(
      () => {
        if (l.abort.signal.aborted) return this.settleEarly(l, "cancelled");
        this.queue.push(l);
        this.pump();
      },
      (e: unknown) => this.settleEarly(l, l.abort.signal.aborted ? "cancelled" : "failed", (e as Error).message),
    );
    return this.view(l);
  }

  private settleEarly(l: Live, status: "failed" | "cancelled", error = ""): void {
    if (status === "failed") this.fail(l, error);
    else l.view.status = "cancelled";
    l.view.ended_at = this.ctx.now().toISOString();
    this.persist(l, true);
    this.live.delete(l.view.id);
    this.ended(l);
  }

  /**
   * A tiny run with no tools, no MCP and no plugin, in an empty temporary folder (never the workspace): proves
   * Claude Code starts and is signed in. Its record is still kept in the workspace so Settings can show it.
   */
  testRun(): Promise<ClaudeRunView> {
    const root = this.ctx.root;
    return this.reserve(root ?? "", "test", async () => {
      await this.readyOrThrow(false);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-claude-test-"));
      const l = this.newLive({
        action: "test", target: { kind: "workspace" }, key: "test", root, cwd, tempCwd: true, prompt: "Reply with the single word OK.",
        args: testArgs(), folder: null, files: null, expected: [], timeoutMs: TEST_TIMEOUT_MS,
      });
      return this.enqueue(l);
    });
  }

  private step(l: Live, label: string): void {
    const steps = l.view.steps;
    const last = steps.at(-1);
    if (last?.label === label && last.state === "active") return;
    if (last?.state === "active") last.state = "done";
    steps.push({ label, state: "active", at: this.ctx.now().toISOString() });
    if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);
  }

  private async execute(l: Live): Promise<void> {
    const h = this.host;
    const v = l.view;
    v.status = "running";
    this.persist(l, true);
    const cwd = l.cwd;
    try {
      if (l.root && l.web) this.setAside(l);
      if (l.root && l.folder !== null) l.before = snapshot(l.root);
      if (!h) throw new Error(NOT_READY.missing);
      const launch = this.cached?.launch ?? (await this.launchOrThrow());
      const res = await h.runner.run(launch.cmd, [...launch.pre, ...l.args], {
        cwd, env: this.env(), signal: l.abort.signal, timeoutMs: l.timeoutMs, input: l.prompt, maxBuffer: 256 * 1024,
        onLine: (line, stream) => {
          if (stream !== "stdout") return;
          for (const e of parseLine(cwd, line)) {
            if (e.kind === "step") this.step(l, e.label);
            else if (e.kind === "write") l.writes.set(e.toolId, e.rel);
            else if (e.kind === "tool_result") { if (e.ok && l.writes.has(e.toolId)) l.done.push(l.writes.get(e.toolId)!); }
            else if (e.kind === "text") l.lastText = e.text;
            // A run can only lower the guess to "api_key": a missing or "none" key source isn't proof of a subscription.
            else if (e.kind === "auth") { l.apiKey = e.apiKey; if (e.apiKey) this.runAuth = "api_key"; }
            else if (e.kind === "result") { l.result = { ok: e.ok, text: e.text }; v.cost_usd = l.apiKey ? e.cost_usd : null; v.turns = e.turns; l.denials = e.denials; v.refused = e.refused; }
          }
          v.elapsed_ms = Date.now() - l.startedMs;
          this.persist(l);
        },
      });
      const lastStep = v.steps.at(-1);
      if (res.cancelled || l.abort.signal.aborted) {
        v.status = "cancelled";
        if (lastStep?.state === "active") lastStep.state = "failed";
      } else if (res.timedOut) {
        this.fail(l, `Claude took longer than ${Math.round(l.timeoutMs / 60_000)} minutes, so ${identity.name} stopped it.`);
      } else if (!l.result) {
        const why = scrubMessage(res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" "), cwd, 200);
        this.fail(l, isAuthError(res.stderr) ? NOT_READY.signed_out : `Claude Code stopped before it finished${why ? `: ${why}` : "."}`);
        if (isAuthError(res.stderr)) this.markSignedOut();
      } else if (!l.result.ok) {
        const auth = isAuthError(l.result.text);
        if (auth) this.markSignedOut();
        this.fail(l, auth ? NOT_READY.signed_out : l.result.text ? `Claude didn't finish: ${l.result.text}` : "Claude didn't finish this request.");
      } else {
        if (lastStep?.state === "active") lastStep.state = "done";
        v.summary = summarise(l.result.text || l.lastText);
        if (v.action === "test") {
          if (!/\bok\b/i.test(l.result.text)) this.fail(l, "Claude answered, but not as expected. Try the test again.");
          else v.status = "succeeded";
        } else if (v.action === "inbox_suggest") v.status = "succeeded"; // it can't write; the drop box reads its answer
        else this.finish(l);
      }
    } catch (e) {
      this.fail(l, scrubMessage((e as Error).message, cwd, 200) || "Claude Code couldn't be started.");
    } finally {
      if (v.status !== "succeeded") this.restore(l);
      v.ended_at = this.ctx.now().toISOString();
      v.elapsed_ms = Date.now() - l.startedMs;
      if (l.root && v.cost_usd !== null) { try { addCost(l.root, this.ctx.now(), v.cost_usd); } catch { /* the run record still has it */ } }
      if (l.tempCwd) { try { fs.rmSync(l.cwd, { recursive: true, force: true }); } catch { /* temp folder; the OS clears it */ } }
      // The boards this run finished, read before endRun removes the run's folder (a retry skips them).
      const done = l.browser ? doneBoards(l.browser.dir) : [];
      // A retry is coming: the helper stays running until it starts (at most 5 minutes), so Chrome doesn't ask
      // "Allow" again; stopping the wait or a retry that doesn't start lets it go.
      const again = this.willRetry(l);
      if (again) chromeFor(this.ctx).holdHelper(retryDelay(l.again!.attempt + 1) + 2 * 60_000);
      if (l.browser) {
        // How each board's tab was opened (the browser the helper drove, the profile seen), for the run's Details.
        const diags = await chromeFor(this.ctx).endRun(l.browser, { keepHelper: again }).catch(() => []);
        if (diags.length) v.browser_diag = diags;
      }
      this.scheduleRetry(l, done);
      this.persist(l, true);
      this.live.delete(v.id);
      this.ended(l);
      this.pump();
    }
  }

  private ended(l: Live): void {
    const cb = l.onEnd;
    l.onEnd = undefined;
    if (cb) { try { cb(this.view(l)); } catch (e) { console.error(`careeros: a Claude run's end handler failed (${(e as Error).message})`); } }
  }

  /**
   * A web run can't read the workspace, and Claude Code's Write tool may refuse to replace a file it hasn't read.
   * So an output that already exists (a research re-run) is moved to `<name>.previous.md` in the same folder first.
   * Only plain files are moved; a link or folder is left alone (the run's checks report it).
   */
  private setAside(l: Live): void {
    for (const rel of l.expected) {
      const abs = path.join(l.root!, ...rel.split("/"));
      let st: fs.Stats;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      const to = rel.replace(/(\.[^./]+)?$/, ".previous$1");
      fs.renameSync(abs, path.join(l.root!, ...to.split("/")));
      l.setAside.push({ from: rel, to });
    }
  }

  /** The run didn't succeed: put the moved files back, replacing anything partial it left. */
  private restore(l: Live): void {
    for (const m of l.setAside.splice(0)) {
      try { fs.renameSync(path.join(l.root!, ...m.to.split("/")), path.join(l.root!, ...m.from.split("/"))); }
      catch (e) { console.error(`careeros: couldn't put back a file set aside for a Claude run (${(e as Error).message})`); }
    }
  }

  private finish(l: Live): void {
    const v = l.view;
    const r = verifyRun({
      root: l.root!, folder: l.folder, files: l.files, expected: l.expected, before: l.before, writes: l.done, others: [...l.others],
      // A video script run has no shell, so its tool events are every change it can make (final review I5).
      strayFrom: l.view.action === "video_script" ? "writes" : "workspace",
    });
    v.files = r.files;
    v.missing = r.missing;
    v.stray = r.stray;
    // A video script may change nothing but its own files (fix round 1, item 1). A write Claude reported outside them
    // stops the video: the run fails and lists it. Changes others made meanwhile don't count (final review I5).
    if (v.action === "video_script" && r.stray.length) {
      this.fail(l, `Claude changed files outside this video: ${r.stray.slice(0, 5).join(", ")}${r.stray.length > 5 ? " and more" : ""}. Check them before you go on. The video stops here.`);
      return;
    }
    if (r.missing.length) {
      this.fail(l, `Claude finished but didn't write ${r.missing.map((m) => m.split("/").pop()).join(", ")}.${refusedLine(v.refused ?? [], l.denials)}`);
      return;
    }
    v.status = "succeeded";
  }

  private fail(l: Live, error: string): void {
    l.view.status = "failed";
    l.view.error = error;
    const last = l.view.steps.at(-1);
    if (last?.state === "active") last.state = "failed";
  }

  private markSignedOut(): void {
    if (this.cached) this.cached.state.login = "signed_out";
  }

  cancel(id: string): ClaudeRunView {
    const stopped = this.stopRetry(id);
    if (stopped) return stopped;
    const l = this.live.get(id);
    if (!l) {
      const old = this.ctx.root ? listRuns(this.ctx.root).find((r) => r.id === id) : undefined;
      if (!old) throw new Error("That Claude run isn't there any more.");
      return old;
    }
    const queued = this.queue.indexOf(l);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      l.view.status = "cancelled";
      l.view.ended_at = this.ctx.now().toISOString();
      if (l.tempCwd) { try { fs.rmSync(l.cwd, { recursive: true, force: true }); } catch { /* temp folder */ } }
      if (l.browser) void chromeFor(this.ctx).endRun(l.browser).catch(() => undefined);
      this.persist(l, true);
      this.live.delete(id);
      this.ended(l);
      return this.view(l);
    }
    l.abort.abort();
    return this.view(l);
  }

  cancelAll(root?: string): void {
    for (const [id, w] of [...this.waiting]) if (!root || w.root === root) this.stopRetry(id);
    for (const l of [...this.live.values()]) if (!root || l.root === root) this.cancel(l.view.id);
  }

  private view(l: Live): ClaudeRunView {
    const v = structuredClone(l.view);
    if (isActiveRun(v.status)) v.elapsed_ms = Date.now() - l.startedMs;
    return v;
  }

  /** Active runs first, then recent. Records left "running" by a closed app are marked stopped. */
  runs(): ClaudeRunView[] {
    const root = this.ctx.root;
    const mine = [...this.live.values()].filter((l) => l.root === root).map((l) => this.view(l));
    const ids = new Set(mine.map((r) => r.id));
    const stored = root ? listRuns(root).filter((r) => !ids.has(r.id)) : [];
    for (const r of stored) {
      if (!isActiveRun(r.status)) continue;
      r.status = "failed";
      r.error = `Stopped when ${identity.name} closed.`;
      r.ended_at = r.ended_at || r.started_at;
      for (const s of r.steps as ClaudeRunStep[]) if (s.state === "active") s.state = "failed";
      try { saveRun(root!, r); } catch { /* shown as stopped anyway */ }
    }
    return [...mine, ...stored].slice(0, 50);
  }
}

const engines = new WeakMap<ServiceContext, ClaudeEngine>();
export function engineFor(ctx: ServiceContext): ClaudeEngine {
  let e = engines.get(ctx);
  if (!e) { e = new ClaudeEngine(ctx); engines.set(ctx, e); }
  return e;
}
