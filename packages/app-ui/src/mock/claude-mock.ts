import { PRODUCT_NAME } from "@careeros/brand/identity";
import {
  actionKey, outputNames, searchOverride, validateRequest, type WorkRightsStatus, CLAUDE_MAX_PARALLEL, CLAUDE_MIN_VERSION, CLAUDE_NOTICE_VERSION, isActiveRun, ownTarget,
  type ActionId, type ActionTarget, type ClaudeAuth, type ClaudeEngineState, type ClaudeRunRequest, type ClaudeRunView,
} from "@careeros/contract";

/** How the mock's Claude Code looks. Default: everything set up. */
export interface MockClaudeOptions {
  cli?: "ok" | "missing" | "too_old";
  login?: "signed_in" | "signed_out";
  /** How Claude is paid for. Default: a subscription. */
  auth?: ClaudeAuth;
  /** "missing": this copy of the app lacks its bundled plugin folder. */
  plugin?: "bundled" | "missing";
  consent?: boolean;
  /** Claude Code's auto mode for the workspace (default on). */
  autoMode?: boolean;
  /** The workspace's Claude setup is stale (shows Repair). */
  setupStale?: boolean;
  /** Preview only: runs step through on timers and finish by themselves. Tests drive runs by hand. */
  autoRun?: boolean;
}

interface Deps {
  rec<T>(method: string, args: unknown[], fn: () => T): Promise<T>;
  emit(): void;
  now(): Date;
  /** Expected output paths for an action, from the shared status logic. */
  outputs(id: ActionId, t: ActionTarget): string[];
  /** Pretend the files exist (so the action shows "ready"). */
  writeOutputs(id: ActionId, t: ActionTarget): void;
  /** The candidate's work-rights status (decides which options a request may carry). */
  workRights?(): WorkRightsStatus;
  /** What main does to a request before checking it (Resume Studio's positions become rewrite_resume's ids). */
  mapRequest?(id: ActionId, t: ActionTarget, request: ClaudeRunRequest): ClaudeRunRequest;
}

const LABEL: [RegExp, string][] = [
  [/resume\.suggested\.md$/, "Suggested resume"], [/resume\.md$/, "Resume"], [/cover-letter\.md$/, "Cover letter"], [/claims\.json$/, "Claim sources"], [/review\.json$/, "Second-pass review"], [/score\.md$/, "Job score"],
  [/research\.md$/, "Company research"], [/questions\.md$/, "Interview questions"], [/script\.txt$/, "Video script"], [/sources\.md$/, "Sources"],
  [/notes\.md$/, "Notes"], [/suggested\/(draft|recruiter)\.json$/, "Suggested email"], [/pitch\.md$/, "Pitch"], [/job-searches\//, "Search report"], [/\.mp4$/, "Video"],
];
const label = (p: string) => LABEL.find(([re]) => re.test(p))?.[1] ?? p.split("/").pop()!;

/** Plain steps the preview plays through, per action group. */
const DEMO_STEPS: Partial<Record<ActionId, string[]>> = {
  tailor_application: ["Starting Claude", "Using the career skill", "Reading the job ad", "Reading your experience", "Writing your resume", "Writing your cover letter", "Checking claims", "Reviewing the drafts"],
  draft_email: ["Starting Claude", "Using the career skill", "Reading the job ad", "Reading your experience", "Writing the email"],
  recruiter_email: ["Starting Claude", "Using the career skill", "Reading about the agency", "Reading your experience", "Writing the email"],
  recruiter_job_email: ["Starting Claude", "Using the career skill", "Reading the job ad", "Reading about the agency", "Reading your experience", "Writing the email"],
  score_job: ["Starting Claude", "Using the career skill", "Reading the job ad", "Reading your experience", "Scoring the job"],
  // Real runs repeat labels (the stream reports each tool call), so the preview does too.
  research_company: ["Starting Claude", "Looking through your files", "Reading your experience", "Looking through your files", "Reading your experience", "Searching the web", "Reading acme.example", "Searching the web", "Writing the company research"],
};
const DEFAULT_STEPS = ["Starting Claude", "Reading your files", "Writing a file"];

/**
 * The Claude Code engine, as MockBridge plays it: same validation and shapes as the services, no processes.
 * Tests call `advance`, `finish` and `fail`; the preview sets `autoRun`.
 */
export class MockClaude {
  runs: ClaudeRunView[] = [];
  /** Requests as main received them (prompt text is never built here). */
  requests: { id: string; action: ActionId; target: ActionTarget; request: ClaudeRunRequest }[] = [];
  private seq = 0;
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private d: Deps, public opts: MockClaudeOptions = {}) {}

  /** Switching workspace stops every run still going (main cancels the old workspace's runs the same way). */
  cancelActive(): void {
    for (const r of this.runs) {
      if (!isActiveRun(r.status)) continue;
      const last = r.steps.at(-1);
      if (last?.state === "active") last.state = "failed";
      Object.assign(r, { status: "cancelled", ended_at: this.d.now().toISOString() });
      this.stop(r.id);
    }
  }

  state(): ClaudeEngineState {
    const o = this.opts;
    const cli = o.cli ?? "ok";
    const plugin = o.plugin ?? "bundled";
    const consent = o.consent ?? true;
    const login = o.login ?? "signed_in";
    const found = plugin !== "missing";
    const month = `${this.d.now().getFullYear()}-${String(this.d.now().getMonth() + 1).padStart(2, "0")}`;
    const costed = this.runs.filter((r) => r.cost_usd !== null && r.ended_at.slice(0, 7) === month);
    return {
      cli: { found: cli !== "missing", version: cli === "missing" ? "" : cli === "too_old" ? "1.0.40" : "2.1.280", min_version: CLAUDE_MIN_VERSION, problem: cli === "ok" ? null : cli },
      login: cli === "ok" ? login : "unknown",
      auth: cli === "ok" && login !== "signed_out" ? o.auth ?? "subscription" : "unknown",
      plugin: { found, version: found ? "0.1.0" : "" },
      consent: { given: consent, at: consent ? "2026-01-15T09:00:00.000Z" : "", notice_version: CLAUDE_NOTICE_VERSION },
      ready: cli === "ok" && login !== "signed_out" && found && consent,
      active_runs: this.runs.filter((r) => isActiveRun(r.status)).length,
      cost: { month, usd: Math.round(costed.reduce((n, r) => n + (r.cost_usd ?? 0), 0) * 100) / 100, runs: costed.length },
      workspace: { version: o.setupStale ? 0 : 1, current: !o.setupStale, settings: true, claude_md: !o.setupStale, browser_command: !o.setupStale, plugin: !o.setupStale, auto_mode: o.autoMode ?? true },
    };
  }

  private notReady(s: ClaudeEngineState): string | null {
    if (!s.consent.given) return "Set up Claude first: open Settings > Claude and read the short notice.";
    if (s.cli.problem === "missing") return "Claude Code isn't installed on this computer. Open Settings > Claude to set it up.";
    if (s.cli.problem) return `Claude Code is too old (${PRODUCT_NAME} needs ${CLAUDE_MIN_VERSION} or newer). Update it, then try again.`;
    if (s.login === "signed_out") return "Claude Code isn't signed in. Open Settings > Claude to sign in.";
    if (!s.plugin.found) return `This copy of ${PRODUCT_NAME} is missing its Claude add-on. Reinstall ${PRODUCT_NAME}, then try again.`;
    return null;
  }

  private newRun(action: ClaudeRunView["action"], target: ActionTarget, key: string): ClaudeRunView {
    const now = this.d.now().toISOString();
    this.seq += 1;
    return {
      id: `r-mock${String(this.seq).padStart(4, "0")}-${(0x10000000 + this.seq).toString(16)}`, action, target, key,
      status: this.runs.filter((r) => r.status === "running").length >= CLAUDE_MAX_PARALLEL ? "queued" : "running",
      started_at: now, ended_at: "", elapsed_ms: 0, steps: [], summary: "", files: [], missing: [], stray: [], error: "", cost_usd: null, turns: null,
    };
  }

  private find(id: string): ClaudeRunView {
    const r = this.runs.find((x) => x.id === id);
    if (!r) throw new Error("That Claude run isn't there any more.");
    return r;
  }

  /** Adds a step (the previous one turns done). */
  advance(id: string, step: string): void {
    const r = this.find(id);
    const last = r.steps.at(-1);
    if (last?.state === "active") last.state = "done";
    r.steps.push({ label: step, state: "active", at: this.d.now().toISOString() });
    r.elapsed_ms += 4_000;
    this.d.emit();
  }

  finish(id: string, over: Partial<ClaudeRunView> = {}): void {
    const r = this.find(id);
    // The mock never starts video script runs (the video mock writes its own scripts).
    if (r.action !== "test" && r.action !== "video_script" && r.action !== "inbox_suggest") {
      const t = r.target;
      const outs = this.d.outputs(r.action, t);
      this.d.writeOutputs(r.action, t);
      r.files = outs.filter((p) => !/renders\//.test(p)).map((p) => ({ path: p, label: label(p), expected: true }));
    }
    for (const s of r.steps) s.state = "done";
    Object.assign(r, { status: "succeeded", ended_at: this.d.now().toISOString(), summary: "All done. The files are saved in this job's folder.", turns: 9, cost_usd: r.action === "test" ? 0.01 : 0.18 }, over);
    this.stop(id);
    this.d.emit();
  }

  fail(id: string, error: string): void {
    const r = this.find(id);
    const last = r.steps.at(-1);
    if (last?.state === "active") last.state = "failed";
    Object.assign(r, { status: "failed", error, ended_at: this.d.now().toISOString() });
    this.stop(id);
    this.d.emit();
  }

  private stop(id: string): void {
    const t = this.timers.get(id);
    if (t) { clearInterval(t); this.timers.delete(id); }
    const queued = this.runs.find((r) => r.status === "queued");
    if (queued && this.runs.filter((r) => r.status === "running").length < CLAUDE_MAX_PARALLEL) { queued.status = "running"; this.play(queued); }
  }

  private play(r: ClaudeRunView): void {
    if (!this.opts.autoRun || r.status !== "running") return;
    const steps = r.action === "test" ? ["Starting Claude"] : r.action === "video_script" || r.action === "inbox_suggest" ? DEFAULT_STEPS : DEMO_STEPS[r.action] ?? DEFAULT_STEPS;
    let i = 0;
    const timer = setInterval(() => {
      if (i < steps.length) this.advance(r.id, steps[i++]!);
      else this.finish(r.id, r.action === "test" ? { summary: "OK" } : {});
    }, 1_100);
    this.timers.set(r.id, timer);
  }

  methods() {
    const rec = this.d.rec.bind(this.d);
    return {
      engine: (recheck: boolean) => rec("claude.engine", [recheck], () => this.state()),
      consent: () => rec("claude.consent", [], () => { this.opts.consent = true; this.d.emit(); return this.state(); }),
      setAutoMode: (on: boolean) => rec("claude.setAutoMode", [on], () => { this.opts.autoMode = on; this.d.emit(); return this.state(); }),
      repair: () => rec("claude.repair", [], () => { this.opts.setupStale = false; this.d.emit(); return this.state(); }),
      openSignIn: () => rec("claude.openSignIn", [], () => { if (this.state().cli.problem) throw new Error(this.notReady(this.state())!); return true; }),
      testRun: () => rec("claude.testRun", [], () => {
        const s = this.state();
        const why = s.consent.given && !s.cli.problem && s.login !== "signed_out" ? null : this.notReady(s);
        if (why) throw new Error(why);
        const r = this.newRun("test", { kind: "workspace" }, "test");
        this.runs.unshift(r);
        this.play(r);
        this.d.emit();
        return r;
      }),
      run: (action: ActionId, target: ActionTarget, request: ClaudeRunRequest) => rec("claude.run", [action, target, request], () => {
        const t = ownTarget(action, target);
        const key = actionKey(action, t);
        const same = this.runs.find((r) => r.key === key && isActiveRun(r.status));
        if (same) return same;
        const why = this.notReady(this.state());
        if (why) throw new Error(why);
        // Same per-action allowlist and note rules as main.
        const mapped = this.d.mapRequest ? this.d.mapRequest(action, t, request) : request;
        // A find-jobs run's own search choices are checked like main does; the rest is lane G's request.
        const { search, ...rest } = mapped as ClaudeRunRequest;
        if (search !== undefined && action !== "find_jobs") throw new Error(`"search" isn't part of a request.`);
        if (search !== undefined) searchOverride(search, "search");
        validateRequest(action, rest, outputNames(action), this.d.workRights?.() ?? "unknown");
        const r = this.newRun(action, t, key);
        this.runs.unshift(r);
        this.requests.push({ id: r.id, action, target: t, request: mapped });
        this.play(r);
        this.d.emit();
        return r;
      }),
      runs: () => rec("claude.runs", [], () => this.runs.slice(0, 50)),
      cancel: (id: string) => rec("claude.cancel", [id], () => {
        const r = this.find(id);
        if (isActiveRun(r.status)) {
          const last = r.steps.at(-1);
          if (last?.state === "active") last.state = "failed";
          Object.assign(r, { status: "cancelled", ended_at: this.d.now().toISOString() });
          this.stop(id);
          this.d.emit();
        }
        return r;
      }),
    };
  }
}
