import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { layout, readRecord, updateRecord } from "@careeros/core";
import {
  BOARD_NAMES, DEFAULT_BOARDS, RECRUITER_BOARDS,
  type BoardFilters, type BoardId, type BoardRunDiag, type BoardSignIn, type ChromeRunProgress, type ChromeSearchSettings, type ChromeSearchState, type FindJobsMode, type SignInDiag, type SignInWhy,
  type TerminalFix, type WebReason,
} from "@careeros/contract";
import type { ServiceContext } from "../context.js";
import { classifyInstall, installFailedText, shellPath, terminalFix } from "../install-error.js";
import { findNpm, NODE, toolPath, type VersionProbe } from "../toolchain.js";
import type { ProcessRunner } from "../claude/process.js";
import type { BrowserPlan } from "../claude/args.js";
import { BOARDS, canonicalAddress, cleanBoards, directAddress, hasControls, landingPage, pageKind } from "./boards.js";
import { needsPerson, parseSnapshot } from "./guard.js";
import {
  BrowserHelper, checkAttached, HELPER_MIN_VERSION, HELPER_SIZE_MB, HELPER_VERSION, REMOTE_PORT, SESSION, fileLock, helperCandidates, helperEnv, helperVersion, sessionLockDir,
  supportedVersion, versionAtLeast, writeHelperConfig, type Attachment, type HelperRun,
} from "./helper.js";
import { clean, dropPrivate, RUN_ID } from "./session.js";
import { contactLine, readAdExtras } from "./ad-extra.js";
import { CHROME_CONFIG_REL, CHROME_RUN_REL, readRunDiags, readSignInReports } from "./cli.js";
import { bringChromeForward, MAC_OPEN, openOwnTab, profileDirShape, readChromeProfiles, validProfileDir, type ChromeProfiles, type Launch, type OwnTab, type VerifyDeps } from "./profile.js";

/** What main gives "Search in my Chrome". The renderer never sees any of it. */
export interface ChromeHost {
  runner: ProcessRunner;
  platform: NodeJS.Platform;
  /** Only PATH, HOME and npm_config_prefix are read, to find the helper and npm. */
  env: NodeJS.ProcessEnv;
  home: string;
  /** A folder the app owns: the helper's own install, our empty config file, its working folder. */
  dataDir: string;
  /** Is Google Chrome installed? */
  chromeInstalled(): boolean;
  /** Opens chrome://inspect/#remote-debugging in Chrome. */
  openRemotePage(): Promise<boolean>;
  /** Is something listening on 127.0.0.1:<port>? */
  portOpen(port: number): Promise<boolean>;
  /** A native "are you sure" before installing or removing the helper; `ok` names the button (default "Install"). Absent: the click is the consent. */
  confirm?(message: string, detail: string, ok?: string): Promise<boolean>;
  /** Test seam: is this a runnable file? */
  isExecutable?(p: string): boolean;
  /** Test seams for the toolchain: does a folder exist (Homebrew's), and a program's version. */
  exists?(p: string): boolean;
  probe?: VersionProbe;
  /** Test seam: where run folders go. Defaults to the system temp folder. */
  tmpDir?: string;
  /**
   * Runs a command and waits for it, for the last moment of the app's life (process exit), when nothing async
   * runs any more. Absent: no last-moment detach (the next launch closes a left-over session instead).
   */
  runSync?(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number }): void;
  /**
   * Chrome's `Local State` file (its profile list; only profile names are read from it). Absent or null: the app
   * can't place its tabs in a chosen profile and opens them in the window used last.
   */
  localStateFile?: string | null;
  /** Starts a program without waiting (array arguments, no shell): Chrome's own command line, to open a tab in a profile. */
  launch?: Launch;
  /** Chrome's binary, for the command line on Windows and Linux (macOS uses `open -a "Google Chrome"`). */
  chromeBin?(): string | null;
  /** Test seams for waiting on a new tab. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const CHECK_TTL_MS = 30_000;
const VERSION_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 120_000;
/** A scheduled search waits this long for the person to press Allow in Chrome (nobody may be at the computer yet). */
export const SCHEDULED_CONNECT_MS = 10 * 60_000;
/**
 * Memory (owner, 2026-10-15: the helper must not stay running; it makes the Mac feel slow). With no search running
 * and no helper command for IDLE_MS, the app closes its setup tabs and stops the helper. During a search, if
 * jobcairn-chrome hasn't been used for RUN_IDLE_MS (Claude stuck or gone), the search's tabs are closed and the
 * helper stopped too. The next step that needs Chrome connects again (Chrome may ask "Allow" again).
 */
export const IDLE_MS = 2 * 60_000;
export const RUN_IDLE_MS = 10 * 60_000;
const IDLE_CHECK_MS = 30_000;
/** After bringing Chrome forward, how long a Chrome that was just started gets to open its remote control port. */
const PORT_RECHECK_MS = 3_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const SETUP_TAB = (b: BoardId) => `cos-setup-${b}`;
const NOT_CHECKED: SignInWhy = { page: "", matched: "" };
/**
 * Reading an ad (Add a job) waits for the page: a look every LOAD_STEP_MS, at most LOAD_LOOKS looks (about
 * 10 s), until the tab shows the board (after any redirect, e.g. seek.com.au to au.seek.com) and has controls.
 */
const LOAD_STEP_MS = 1_250;
const LOAD_LOOKS = 8;

/**
 * The install and remove confirms (native dialogs in main). They name the helper on purpose: the person is about
 * to put a program on their computer, so they're told what it is, what it does here, its size, where it goes and
 * how to take it off again.
 */
export const HELPER_CONFIRM = {
  install: {
    message: "Install the browser helper?",
    // The first paragraph matches the short "Why your Chrome?" line in Settings and the tour (app-ui chrome/state.ts).
    detail: `Job sites block scrapers and hide details until you sign in. So Claude browses in your own Chrome, signed in as you, slowly and read-only, while you watch.\n\n`
      + `The helper is agent-browser, a small open-source tool from Vercel that lets an app control Chrome tabs.\n\n`
      + `${identity.name} uses it to open job boards in new tabs it owns, read the listings, and close them. It never types passwords, applies, messages or saves anything.\n\n`
      + `It takes about ${HELPER_SIZE_MB} MB and goes in ${identity.name}'s own folder; nothing else on your Mac changes. `
      + `You can remove it any time from Settings › Connections › Search in my Chrome.`,
  },
  remove: {
    message: "Remove the browser helper?",
    detail: `This deletes the helper from ${identity.name}'s own folder (about ${HELPER_SIZE_MB} MB) and turns Search in my Chrome off. Claude will search the web instead. You can install it again later.`,
  },
} as const;

/** Plain words for the UI. Never "CDP", "MCP" or "workspace". */
export const COPY = {
  noHost: `Search in my Chrome isn't available in this copy of ${identity.name}.`,
  noChrome: "Google Chrome isn't installed on this computer.",
  noHelper: "The browser helper isn't installed yet.",
  installing: "The browser helper is installing. Try again when it finishes.",
  installFailed: "The browser helper didn't install. Check your internet connection and try again.",
  noNpm: `The browser helper needs ${NODE.label}. Install Node.js above, then try again.`,
  remoteOff: "Chrome's remote control is off. Turn it on in Chrome, then come back.",
  remotePageFailed: "Chrome didn't open the page. Paste chrome://inspect/#remote-debugging into Chrome's address bar and press Return.",
  connectFailed: "Chrome didn't let us connect. Click Allow when Chrome asks, then try again.",
  notConnected: "Connect to Chrome first.",
  /** The helper was driving a browser of its own, not the person's Chrome, and reconnecting didn't fix it. */
  notAttached: "Chrome isn't connected. Open Settings › Search in my Chrome and press Connect.",
  notOurs: `This browser helper was installed outside ${identity.name}, so ${identity.name} leaves it alone. Remove it the way you installed it.`,
  busy: "A search is running in Chrome. Stop it or let it finish first.",
  turnOffHint: "You can turn off remote control in Chrome any time.",
} as const;

interface HelperFound { bin: string; version: string }

/** Writes `.careeros/chrome.json` (helper and profile) and `.careeros/chrome-run.json` (this run) for jobcairn-chrome. */
function writeCliFiles(root: string, plan: BrowserPlan, profileName: string): void {
  const dir = path.join(root, ".careeros");
  fs.mkdirSync(dir, { recursive: true });
  const put = (rel: string, data: unknown) => {
    const f = path.join(root, rel);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, f);
  };
  put(CHROME_CONFIG_REL, {
    bin: plan.bin, config: plan.config, path: plan.path, home: plan.home,
    profile: plan.profile ? { dir: plan.profile.dir, name: profileName, local_state: plan.profile.localState, chrome_bin: plan.profile.chromeBin } : null,
  });
  put(CHROME_RUN_REL, { run: plan.run, boards: [...plan.boards], dir: plan.dir, reconnected: plan.reconnected === true, ...(plan.jobs ? { jobs: plan.jobs } : {}), ...(plan.filters ? { filters: plan.filters } : {}), ...(plan.purpose ? { purpose: plan.purpose, agencies: plan.agencies } : {}) });
}

/** The run is over: jobcairn-chrome refuses to browse until the next one (only this run's file is removed). */
function clearCliRun(root: string, run: string): void {
  const f = path.join(root, CHROME_RUN_REL);
  try { if ((JSON.parse(fs.readFileSync(f, "utf8")) as { run?: unknown }).run === run) fs.rmSync(f, { force: true }); } catch { /* none */ }
}

/** The words when a tab couldn't be opened in the chosen profile. Nothing was opened anywhere else. */
export function profileTabProblem(profile: string, then = "press Check again with Claude"): string {
  return `Couldn't open a tab in ${profile}, even after switching Chrome to it. In Chrome, open a ${profile} window (click the profile picture at the top right and pick ${profile}), then ${then}.`;
}

/** "Add a job" reads at most this much of an ad's text from Chrome. */
const READ_AD_CHARS = 200_000;
export type ReadAdNeed = "connect_chrome" | "set_up_chrome" | "sign_in" | "check" | "busy" | "not_found" | "failed";
/**
 * A read ad: its text (with a "Contact links in this ad" line when it has mailto: or tel: links), its address, and
 * the page's extras for filling in the job (title, JobPosting JSON-LD, the contact links). Data only.
 */
export type ReadAdResult = { ok: true; text: string; url: string; meta?: { pageTitle?: string; jsonLd?: unknown }; contacts?: string[] } | { ok: false; need: ReadAdNeed; text: string };

/** True when the person has touched setup at all (ticked boards or said they're signed in): a chrome record exists. */
function hasRecord(root: string): boolean {
  try { return !!readRecord("search", layout(root).search).chrome; } catch { return false; }
}

function settingsOf(root: string): ChromeSearchSettings {
  try {
    const c = readRecord("search", layout(root).search).chrome;
    if (c) {
      const confirmed: Partial<Record<BoardId, string>> = {};
      for (const [id, at] of Object.entries(c.confirmed ?? {})) if (cleanBoards([id]).length && typeof at === "string") confirmed[id as BoardId] = at;
      return { enabled: c.enabled === true, boards: cleanBoards(c.boards ?? []), set_up_at: c.set_up_at ?? "", confirmed, ...(profileDirShape(c.profile_dir) ? { profile_dir: c.profile_dir } : {}) };
    }
  } catch { /* defaults */ }
  return { enabled: false, boards: [...DEFAULT_BOARDS], set_up_at: "" };
}

function defaultExecutable(p: string): boolean {
  try { const st = fs.statSync(p); return st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0); } catch { return false; }
}

export class ChromeSearch {
  private connected = false;
  private installing = false;
  private problem = "";
  /** The last install failed: the commands to run in Terminal instead. */
  private installFix: TerminalFix | null = null;
  private found: { at: number; helper: HelperFound | null; tooOld: boolean } | null = null;
  private signIn = new Map<BoardId, { state: BoardSignIn; why: SignInWhy }>();
  /** Setup tabs the app opened, by board: their CDP target ids. */
  private setupTabs = new Map<BoardId, string>();
  private nextBoards: BoardId[] | null = null;
  private active: BrowserPlan | null = null;
  /** How the last find-jobs run searched (Chrome or the web, and why). Shown by the composer and the run strip. */
  private lastRun: FindJobsMode | null = null;
  /** The last check couldn't open a tab in the chosen profile for at least one board (that board wasn't read). */
  private profileFailed = false;
  /** Why the last sign-in check couldn't browse (for its error message). */
  private checkWhy: WebReason | "" = "";
  /** How each board's last check tab was opened (internal, for the Details disclosure). */
  private diag = new Map<BoardId, SignInDiag>();
  /** What the last attachment check saw (for Details): the browser's host:port and whether a reconnect was needed. */
  private attach: Attachment | null = null;
  /** Chrome was just brought forward (it may still be starting): the port gets one more look. */
  private focused = false;
  /** When the app last used the helper (ms), for the idle check. */
  private lastUse = 0;
  /** The idle check stopped the helper: the next step that needs Chrome connects again by itself. */
  private idleStopped = false;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** holdHelper: no idle stop (and no stop at a run's end) before this time (ms). */
  private heldUntil = 0;

  constructor(private ctx: ServiceContext) {}

  private get host(): ChromeHost | null { return this.ctx.host.chrome ?? null; }
  private ownDir(h: ChromeHost): string { return path.join(h.dataDir, "browser-helper"); }
  /**
   * The helper's config file: Chrome's address in `cdp`, so the session always attaches to the person's Chrome and
   * can never fall back to launching a browser of its own (helper.ts HELPER_CONFIG_TEXT). Written or repaired every
   * time (an older `{}` from an earlier version is replaced). jobcairn-chrome uses the same file.
   */
  private configFile(h: ChromeHost): string {
    return writeHelperConfig(path.join(h.dataDir, "browser-helper.json"));
  }
  private pathVar(h: ChromeHost): string { return toolPath(h.env.PATH ?? h.env.Path, h.platform, { exists: h.exists }); }

  private async findHelper(recheck: boolean): Promise<{ helper: HelperFound | null; tooOld: boolean }> {
    const h = this.host;
    if (!h) return { helper: null, tooOld: false };
    if (this.found && !recheck && Date.now() - this.found.at < CHECK_TTL_MS) return this.found;
    const isExec = h.isExecutable ?? defaultExecutable;
    let best: { helper: HelperFound | null; tooOld: boolean } = { helper: null, tooOld: false };
    for (const bin of helperCandidates({ ownDir: this.ownDir(h), env: h.env, platform: h.platform, home: h.home })) {
      if (!isExec(bin)) continue;
      let out = "";
      try {
        const r = await h.runner.run(bin, ["--version"], { cwd: h.dataDir, env: helperEnv({ path: this.pathVar(h), home: h.home }, h.env), timeoutMs: VERSION_TIMEOUT_MS });
        if (r.code === 0) out = r.stdout;
      } catch { continue; }
      const version = helperVersion(out);
      if (!version) continue;
      // Only the minor line the commands were checked on (0.38.x); a newer copy elsewhere on the computer is skipped.
      if (supportedVersion(version)) { best = { helper: { bin, version }, tooOld: false }; break; }
      if (!versionAtLeast(version, HELPER_MIN_VERSION) && !best.helper) best = { helper: { bin, version }, tooOld: true };
    }
    this.found = { at: Date.now(), ...best };
    return best;
  }

  /** The helper on the app's session, sharing one lock (a folder next to the config file) with jobcairn-chrome. */
  private helper(h: ChromeHost, bin: string): BrowserHelper {
    this.lastUse = this.nowMs();
    fs.mkdirSync(h.dataDir, { recursive: true });
    const config = this.configFile(h);
    return new BrowserHelper(h.runner, { bin, config, cwd: h.dataDir, path: this.pathVar(h), home: h.home }, fileLock(sessionLockDir(config)));
  }

  /** While a find-jobs run browses Chrome, the run owns the session: setup steps wait for it to end. */
  private notBusy(): void {
    if (this.active) throw new Error(COPY.busy);
  }

  private async usable(): Promise<{ h: ChromeHost; helper: BrowserHelper }> {
    const h = this.host;
    if (!h) throw new Error(COPY.noHost);
    const f = await this.findHelper(false);
    if (!f.helper || f.tooOld) throw new Error(COPY.noHelper);
    return { h, helper: this.helper(h, f.helper.bin) };
  }

  async state(recheck: boolean): Promise<ChromeSearchState> {
    const h = this.host;
    const root = this.ctx.root;
    const settings = root ? settingsOf(root) : { enabled: false, boards: [...DEFAULT_BOARDS], set_up_at: "" };
    const f = await this.findHelper(recheck);
    const remoteOn = h ? await h.portOpen(REMOTE_PORT).catch(() => false) : false;
    if (!remoteOn) this.connected = false;
    const helperOk = !!f.helper && !f.tooOld;
    const p = this.profiles();
    return {
      available: !!h,
      chrome: { found: !!h && h.chromeInstalled() },
      helper: {
        found: helperOk, version: f.helper?.version ?? "", min_version: HELPER_MIN_VERSION, too_old: f.tooOld, installing: this.installing, can_install: !!h, fix: this.installFix,
        size_mb: HELPER_SIZE_MB, can_remove: !!h && !!f.helper && this.isOwnCopy(h, f.helper.bin),
      },
      remote: { on: remoteOn },
      connected: this.connected,
      boards: settings.boards.map((id) => {
        const d = this.diag.get(id);
        return { id, name: BOARD_NAMES[id], signed_in: this.signIn.get(id)?.state ?? "unchecked", confirmed_at: settings.confirmed?.[id] ?? "", why: this.signIn.get(id)?.why ?? NOT_CHECKED, ...(d ? { diag: { ...d } } : {}) };
      }),
      settings,
      profiles: p.profiles.map((x) => ({ dir: x.dir, name: x.name })),
      last_used_profile: p.lastUsed,
      profile_failed: this.profileFailed,
      ready: settings.enabled && helperOk && remoteOn && this.connected,
      problem: this.problem,
      // Workspaces set up before setup turned itself on: boards ticked, helper installed, never turned on.
      offer_turn_on: !settings.enabled && !settings.set_up_at && helperOk && settings.boards.length > 0 && !!root && hasRecord(root),
      last_run: this.lastRun,
    };
  }

  /**
   * Installs the pinned helper into the app's own folder with npm: a user click (and a native confirm when the
   * shell has one), array arguments, no shell, a clean environment, one install at a time.
   */
  async install(): Promise<ChromeSearchState> {
    const h = this.host;
    if (!h) throw new Error(COPY.noHost);
    if (this.installing) throw new Error(COPY.installing);
    this.installing = true;
    this.problem = "";
    this.installFix = null;
    try {
      await this.installWith(h);
    } catch (e) {
      this.problem = (e as Error).message;
      throw e;
    } finally {
      this.installing = false;
    }
    return this.state(false);
  }

  private async installWith(h: ChromeHost): Promise<void> {
    if (h.confirm && !(await h.confirm(HELPER_CONFIRM.install.message, HELPER_CONFIRM.install.detail))) return;
    const npm = this.findNpm(h);
    if (!npm) throw new Error(COPY.noNpm);
    const dir = this.ownDir(h);
    fs.mkdirSync(dir, { recursive: true });
    // npm runs `#!/usr/bin/env node`, so the folder of the node that was picked leads PATH.
    const env = helperEnv({ path: toolPath(h.env.PATH ?? h.env.Path, h.platform, { first: [path.dirname(npm)], exists: h.exists }), home: h.home }, h.env);
    // No install scripts (the package ships its binaries; its launcher marks them runnable) and npm's own registry.
    const pkg = `agent-browser@${HELPER_VERSION}`;
    const flags = ["--no-audit", "--no-fund", "--ignore-scripts", "--registry=https://registry.npmjs.org/"];
    // npm's own words decide what went wrong (install-error.ts), so the card can say why, not just "try again".
    const npmInstall = async (more: string[]) => {
      const r = await h.runner.run(npm, ["install", "--prefix", dir, ...flags, "--loglevel=error", ...more, pkg], { cwd: dir, env, timeoutMs: INSTALL_TIMEOUT_MS });
      return r.code !== 0 || r.timedOut ? classifyInstall(`${r.stdout}\n${r.stderr}`, { timedOut: r.timedOut }) : null;
    };
    let failure = await npmInstall([]);
    // Usually npm's own cache (~/.npm) belongs to someone else after an old `sudo npm`: once more with a cache in
    // the app's own folder, deleted afterwards.
    if (failure?.problem === "permission") {
      const cache = path.join(dir, ".npm-cache");
      try { failure = await npmInstall([`--cache=${cache}`]); } finally { fs.rmSync(cache, { recursive: true, force: true }); }
    }
    if (failure) {
      // The one place a folder reaches the renderer: quoted, with the home folder as $HOME, for the person to paste.
      const folder = shellPath(dir, h.home);
      this.installFix = terminalFix({ problem: failure.problem, via: "npm", command: ["npm install --prefix", folder, ...flags, pkg].join(" "), folder, pkg });
      throw new Error(installFailedText("The browser helper", failure));
    }
    this.found = null;
    const f = await this.findHelper(true);
    if (!f.helper || f.tooOld) throw new Error(COPY.installFailed);
  }

  /** macOS and Linux: npm next to the first node that is new enough (toolchain). Windows: the first npm.cmd on PATH. */
  private findNpm(h: ChromeHost): string | null {
    const isExec = h.isExecutable ?? defaultExecutable;
    if (h.platform !== "win32") return findNpm(h.env, { platform: h.platform, exists: h.exists, isExec, probe: h.probe })?.npm ?? null;
    const name = h.platform === "win32" ? "npm.cmd" : "npm";
    const sep = h.platform === "win32" ? ";" : ":";
    const dirs = [...this.pathVar(h).split(sep)].filter((d) => d && path.isAbsolute(d));
    for (const d of dirs) { const c = path.join(d, name); if (isExec(c)) return c; }
    return null;
  }

  async openRemote(): Promise<ChromeSearchState> {
    const h = this.host;
    if (!h) throw new Error(COPY.noHost);
    if (!h.chromeInstalled()) throw new Error(COPY.noChrome);
    const ok = await h.openRemotePage();
    if (!ok) throw new Error(COPY.remotePageFailed);
    return this.state(false);
  }

  /** The app's one connection to Chrome. Chrome asks once ("Allow"); every later command reuses this session. */
  async connect(): Promise<ChromeSearchState> { return this.connectOnce(true); }

  /** `focus`: bring Chrome forward first (planForRun already did, so it passes false). */
  private async connectOnce(focus: boolean, waitMs = CONNECT_TIMEOUT_MS): Promise<ChromeSearchState> {
    this.notBusy();
    const { h, helper } = await this.usable();
    if (focus && !this.connected) await this.bringForward(h);
    if (!(await this.portOpenAfterFocus(h))) throw new Error(COPY.remoteOff);
    if (!this.connected) {
      this.problem = "";
      const label = `cos-hello-${crypto.randomBytes(3).toString("hex")}`;
      this.idleStopped = false;
      await helper.session(async (run) => {
        const r = await run(["tab", "new", "--label", label, "about:blank"], { connect: true, timeoutMs: waitMs });
        if (!r.ok) { this.problem = COPY.connectFailed; throw new Error(COPY.connectFailed); }
        const target = typeof r.data?.targetId === "string" ? r.data.targetId : label;
        await run(["tab", "close", target]);
        // Connected to the person's Chrome, not a browser the helper launched: checked, reconnecting once at most.
        const a = await checkAttached(run, { reconnect: true });
        this.attach = a;
        if (!a.ok) { this.problem = COPY.notAttached; throw new Error(COPY.notAttached); }
      });
      this.connected = true;
      this.turnOnFirstTime();
    }
    return this.state(false);
  }

  /**
   * Setup turns Search in my Chrome on as soon as the required steps pass (Chrome, helper, remote control,
   * connected); signing in to boards is optional. Only the first time: a person who turned it off stays off.
   */
  private turnOnFirstTime(): void {
    const root = this.ctx.root;
    if (!root) return;
    const cur = settingsOf(root);
    if (cur.enabled || cur.set_up_at || !cur.boards.length) return;
    this.save((c) => ({ ...c, enabled: true, set_up_at: this.ctx.now().toISOString() }));
  }

  /**
   * Chrome to the front, in the chosen profile, before anything may make it ask "Allow remote debugging?" (profile.ts
   * bringChromeForward). Starts Chrome when it isn't running. Never connects and never fails the caller.
   */
  private async bringForward(h: ChromeHost): Promise<void> {
    if (!h.launch) return;
    const chosen = this.chosenDir();
    const dir = chosen && validProfileDir(chosen, this.profiles().profiles) ? chosen : "";
    this.focused = true;
    try {
      await bringChromeForward({ launch: h.launch, platform: h.platform, chromeBin: h.chromeBin?.() ?? null, dir, sleep: h.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) });
    } catch { /* Chrome stays where it is; connecting still works */ }
  }

  /**
   * Is Chrome's remote control port open? Right after bringForward a Chrome that was just started may still be
   * opening it: one more look after a short wait, never a loop.
   */
  private async portOpenAfterFocus(h: ChromeHost): Promise<boolean> {
    const open = () => h.portOpen(REMOTE_PORT).catch(() => false);
    const focused = this.focused;
    this.focused = false;
    if (await open()) return true;
    if (!focused) return false;
    await (h.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(PORT_RECHECK_MS);
    return open();
  }

  private async connectedHelper(): Promise<{ h: ChromeHost; helper: BrowserHelper }> {
    // Stopped for being idle (not by the person): connect again for this step.
    if (!this.connected && this.idleStopped) await this.connectOnce(false);
    const u = await this.usable();
    if (!this.connected) throw new Error(COPY.notConnected);
    if (!(await this.attached(u.helper)).ok) throw new Error(COPY.notAttached);
    return u;
  }

  /**
   * Before any browsing: is the app's session driving the person's own Chrome? If not (the helper's daemon had
   * restarted and launched a browser of its own), that browser is stopped and the session reconnects once (Chrome
   * may ask "Allow" once). Still not: the app counts as not connected, and nothing browses.
   */
  private async attached(helper: BrowserHelper): Promise<Attachment> {
    const a = await helper.session((run) => checkAttached(run, { reconnect: true })).catch((): Attachment => ({ ok: false, cdp: "", reconnected: false }));
    this.attach = a;
    if (!a.ok) { this.connected = false; this.problem = COPY.notAttached; }
    return a;
  }

  /** The Details fields every board's diag carries: the browser the helper drove and whether it reconnected. */
  private attachDiag(): Pick<SignInDiag, "cdp" | "reconnected"> {
    return this.attach ? { cdp: this.attach.cdp, reconnected: this.attach.reconnected } : {};
  }

  /**
   * Switches the session to the setup tab for a board (by its target id) and checks it really did. With the tab
   * pin, a tab the person closed fails instead of falling back to one of theirs. False: the tab is gone.
   */
  private async toSetupTab(run: HelperRun, id: BoardId): Promise<boolean> {
    const target = this.setupTabs.get(id);
    if (!target) return false;
    const r = await run(["tab", target]);
    if (r.ok && (typeof r.data?.targetId !== "string" || r.data.targetId === target)) return true;
    this.setupTabs.delete(id);
    return false;
  }

  /** Chrome's profile list (names only), from the host's Local State file. Empty when there's none. */
  private profiles(): ChromeProfiles {
    const h = this.host;
    return h?.localStateFile ? readChromeProfiles(h.localStateFile) : { profiles: [], lastUsed: "" };
  }

  /** The chosen profile folder, or "" for "the window used last" (no profile chosen). */
  private chosenDir(): string {
    return this.ctx.root ? settingsOf(this.ctx.root).profile_dir ?? "" : "";
  }

  /** The chosen profile's name as Chrome shows it ("Job search"), or a plain stand-in. */
  private profileName(dir: string): string {
    return this.profiles().profiles.find((p) => p.dir === dir)?.name || "your job-search profile";
  }

  /** What proving a tab's profile needs from this computer, or null when it can't be done (no Local State or launcher). */
  private verifyDeps(): VerifyDeps | null {
    const h = this.host;
    if (!h || !h.launch || !h.localStateFile) return null;
    return { launch: h.launch, platform: h.platform, chromeBin: h.chromeBin?.() ?? null, sleep: h.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), now: h.now ?? Date.now, home: h.home };
  }

  /**
   * The app's own tab on `url`, through the same opener as everything else (profile.ts openOwnTab): with a profile
   * chosen, proven on chrome://version or not opened at all. Every call tries afresh: one board's miss never decides
   * the next board's.
   */
  private ownTab(run: HelperRun, url: string, label: string): Promise<OwnTab> {
    return openOwnTab(run, url, { dir: this.chosenDir(), profiles: this.profiles().profiles, label, deps: this.verifyDeps() });
  }

  /** A fresh setup tab for a board on its home page (Show tab). "profile": a profile is chosen and the tab couldn't be proven there. */
  private async newSetupTab(run: HelperRun, id: BoardId): Promise<"ok" | "profile" | "failed"> {
    const t = await this.ownTab(run, BOARDS[id].home, SETUP_TAB(id));
    this.diag.set(id, { ...t.diag, ...this.attachDiag() });
    if (!t.target) return t.failed === "profile" ? "profile" : "failed";
    this.setupTabs.set(id, t.target);
    return "ok";
  }

  /**
   * Opens a board's home page in the chosen profile with Chrome's own program (profile.ts bringChromeForward), for a
   * board a run stopped: a security check to finish, or a profile window that wasn't open. Never uses the remote
   * control connection, so it works whatever the helper's state and never makes Chrome ask "Allow". With no profile
   * chosen, macOS opens the page in the window used last; elsewhere it can't, and says so.
   */
  async openHome(board: BoardId): Promise<void> {
    const id = cleanBoards([board])[0];
    if (!id) throw new Error("That job board isn't one Search in my Chrome knows.");
    const name = BOARD_NAMES[id];
    const h = this.host;
    const manual = new Error(`Chrome didn't open. Open ${name} in Chrome yourself.`);
    if (!h?.launch) throw manual;
    const chosen = this.chosenDir();
    const dir = chosen && validProfileDir(chosen, this.profiles().profiles) ? chosen : "";
    const url = BOARDS[id].home;
    let started = false;
    try {
      if (dir) started = await bringChromeForward({ launch: h.launch, platform: h.platform, chromeBin: h.chromeBin?.() ?? null, dir, sleep: h.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), startUrl: () => url });
      else if (h.platform === "darwin") started = await h.launch(MAC_OPEN, ["-a", "Google Chrome", url]);
    } catch { started = false; }
    if (!started) throw manual;
  }

  /** Brings the board's tab to the front so the person can sign in themselves. */
  async showBoard(board: BoardId): Promise<ChromeSearchState> {
    this.notBusy();
    const { helper } = await this.connectedHelper();
    const opened = await helper.session(async (run) => ((await this.toSetupTab(run, board)) ? "ok" as const : this.newSetupTab(run, board)));
    this.profileFailed = opened === "profile";
    if (opened === "profile") throw new Error(profileTabProblem(this.profileName(this.chosenDir()), "try again"));
    if (opened !== "ok") throw new Error(`${BOARD_NAMES[board]} didn't open in Chrome. Try again.`);
    return this.state(false);
  }

  /**
   * The person says they're signed in to a board, whatever the check saw: their word wins. Kept with the date;
   * never blocks Finish. The last check's answer is cleared, so only a later check that sees a sign-in page shows
   * as "you said signed in; the tab shows the sign-in page".
   */
  async confirmSignIn(board: BoardId): Promise<ChromeSearchState> {
    const id = cleanBoards([board])[0];
    if (!id) throw new Error("That job board isn't one Search in my Chrome knows.");
    const at = this.ctx.now().toISOString();
    this.save((cur) => ({ ...cur, confirmed: { ...(cur.confirmed ?? {}), [id]: at } }));
    this.signIn.delete(id);
    return this.state(false);
  }

  /**
   * The Chrome profile to open the app's tabs in: a folder from Chrome's own list, or "" for the window used last.
   * Only the folder name is kept. A folder Chrome doesn't list is refused.
   */
  async setProfile(dir: string): Promise<ChromeSearchState> {
    if (dir !== "" && !validProfileDir(dir, this.profiles().profiles)) throw new Error("That Chrome profile isn't one Chrome lists. Choose one from the list.");
    this.save((cur) => ({ ...cur, profile_dir: dir }));
    this.profileFailed = false;
    return this.state(false);
  }

  /** True when this helper is the app's own copy (inside its folder), so removing it touches nothing else. */
  private isOwnCopy(h: ChromeHost, bin: string): boolean {
    const own = path.resolve(this.ownDir(h)) + path.sep;
    return path.resolve(bin).startsWith(own);
  }

  /**
   * Deletes the app's own helper folder after a native confirm: disconnects first, turns Search in my Chrome off
   * (find-jobs falls back to web search), and never touches a helper installed anywhere else.
   */
  async removeHelper(): Promise<ChromeSearchState> {
    const h = this.host;
    if (!h) throw new Error(COPY.noHost);
    this.notBusy();
    if (this.installing) throw new Error(COPY.installing);
    const f = await this.findHelper(true);
    if (f.helper && !this.isOwnCopy(h, f.helper.bin)) throw new Error(COPY.notOurs);
    if (h.confirm && !(await h.confirm(HELPER_CONFIRM.remove.message, HELPER_CONFIRM.remove.detail, "Remove"))) return this.state(false);
    await this.shutdown().catch(() => undefined);
    fs.rmSync(this.ownDir(h), { recursive: true, force: true });
    this.found = null;
    this.signIn.clear();
    if (this.ctx.root) this.save((cur) => ({ ...cur, enabled: false }));
    return this.state(true);
  }

  private async closeSetupTabs(): Promise<void> {
    const h = this.host;
    const f = this.found?.helper;
    if (!h || !f || !this.connected) { this.setupTabs.clear(); return; }
    const helper = this.helper(h, f.bin);
    await helper.session(async (run) => {
      for (const [id, target] of [...this.setupTabs]) { await run(["tab", "close", target]); this.setupTabs.delete(id); }
    });
  }

  private save(change: (cur: ChromeSearchSettings) => ChromeSearchSettings): ChromeSearchSettings {
    const root = this.ctx.requireRoot();
    const next = change(settingsOf(root));
    updateRecord("search", layout(root).search, (cur) => {
      cur.chrome = {
        enabled: next.enabled, boards: [...next.boards], set_up_at: next.set_up_at,
        ...(next.confirmed && Object.keys(next.confirmed).length ? { confirmed: { ...next.confirmed } as Record<string, string> } : {}),
        ...(next.profile_dir && profileDirShape(next.profile_dir) ? { profile_dir: next.profile_dir } : {}),
      };
    });
    this.ctx.emit("settings");
    return next;
  }

  /**
   * Turn on (was Finish): saves the boards and switches Search in my Chrome on. It needs no live connection: a run
   * that starts while Chrome isn't connected reconnects once (Chrome may ask to Allow). The helper must be there.
   */
  async finish(boards: BoardId[]): Promise<ChromeSearchState> {
    this.notBusy();
    await this.usable();
    const list = cleanBoards(boards);
    if (!list.length) throw new Error("Tick at least one job board.");
    await this.closeSetupTabs().catch(() => undefined);
    const prev = this.ctx.root ? settingsOf(this.ctx.root) : null;
    this.save((cur) => ({ ...cur, enabled: true, boards: list, set_up_at: prev?.set_up_at || this.ctx.now().toISOString() }));
    return this.state(false);
  }

  async setBoards(boards: BoardId[]): Promise<ChromeSearchState> {
    const list = cleanBoards(boards);
    this.save((cur) => ({ ...cur, boards: list, enabled: cur.enabled && list.length > 0 }));
    return this.state(false);
  }

  async turnOff(): Promise<ChromeSearchState> {
    this.notBusy();
    await this.closeSetupTabs();
    this.save((cur) => ({ ...cur, enabled: false }));
    return this.state(false);
  }

  /**
   * "Add a job" from a board link: reads that one ad in a new tab of the person's Chrome (their chosen profile when
   * set), read-only, and closes the tab again. Only a board's own job-ad page is opened (the same allow-list a
   * search run uses). It stops at a sign-in page or a security check and says so; nothing is clicked or typed.
   * Needs Search in my Chrome to be connected; it never connects by itself (Chrome would ask to Allow out of the blue).
   */
  async readAd(board: BoardId, url: string): Promise<ReadAdResult> {
    const name = BOARD_NAMES[board];
    const h = this.host;
    const no = (need: ReadAdNeed, text: string): ReadAdResult => ({ ok: false, need, text });
    if (!h) return no("set_up_chrome", `${name} ads are read in your own Chrome, which this copy of ${identity.name} can't use. Paste the ad's text instead.`);
    if (this.active) return no("busy", `A search is running in your Chrome. Paste the ad's text, or try again when it finishes.`);
    const f = await this.findHelper(false);
    if (!f.helper || f.tooOld) return no("set_up_chrome", `${name} blocks apps that read its pages, so ${identity.name} reads ${name} ads in your own Chrome. Set up Search in my Chrome, or paste the ad's text.`);
    const addr = canonicalAddress(directAddress(url, board), board);
    if (!addr || pageKind(addr, board) !== "ad") return no("not_found", `This ${name} link isn't one job ad. Open the ad itself and copy its link, or paste the ad's text.`);
    if (!(await h.portOpen(REMOTE_PORT).catch(() => false))) { this.connected = false; return no("connect_chrome", `${name} ads are read in your own Chrome. Turn on Chrome's remote control and connect, or paste the ad's text.`); }
    // Never connects by itself (that is the person's Connect, with its Allow prompt).
    if (!this.connected) return no("connect_chrome", `${name} ads are read in your own Chrome. Connect to Chrome, or paste the ad's text.`);
    // Like a search: Chrome comes to the front in the chosen profile first, and the tab below is switched to that
    // profile whatever window the person clicked last (profile.ts openVerifiedTab: one switch, one retry).
    await this.bringForward(h);
    if (!(await this.attached(this.helper(h, f.helper.bin))).ok) return no("connect_chrome", `${COPY.notAttached} Or paste the ad's text.`);
    const helper = this.helper(h, f.helper.bin);
    const dir = this.chosenDir();
    return helper.session(async (run): Promise<ReadAdResult> => {
      let target = "";
      try {
        const t = await this.ownTab(run, addr, `cos-add-${crypto.randomBytes(3).toString("hex")}`);
        if (t.failed === "profile") return no("failed", `${profileTabProblem(this.profileName(dir), "try again")} Or paste the ad's text.`);
        if (!t.target) return no("failed", `${name} didn't open in Chrome. Try again, or paste the ad's text.`);
        target = t.target;
        let other = false;
        for (let look = 0; look < LOAD_LOOKS; look++) {
          await run(["wait", String(LOAD_STEP_MS)]);
          const snap = await run(["snapshot", "-i", "-c"]);
          if (!snap.ok || typeof snap.data?.snapshot !== "string") continue;
          const origin = typeof snap.data.origin === "string" ? snap.data.origin : String((await run(["get", "url"])).data?.url ?? "");
          const land = landingPage(origin, board);
          if (land === "login" || land === "authwall") return no("sign_in", `${name} showed its sign-in page, so nothing was read. Sign in to ${name} in Chrome, then try again. Or paste the ad's text.`);
          if (land === "checkpoint") return no("check", `${name} showed a security check, so nothing was read. Finish it in Chrome, then try again. Or paste the ad's text.`);
          const kind = pageKind(origin, board);
          if (kind !== "ad") { other = land !== "elsewhere"; continue; }
          const seen = parseSnapshot(snap.data);
          const person = seen ? needsPerson(kind, seen) : null;
          if (person === "captcha") return no("check", `${name} showed a security check, so nothing was read. Finish it in Chrome, then try again. Or paste the ad's text.`);
          if (person === "login") return no("sign_in", `${name} asked you to sign in, so nothing was read. Sign in to ${name} in Chrome, then try again. Or paste the ad's text.`);
          if (!hasControls(snap.data.snapshot)) continue;
          for (const scope of BOARDS[board].readScope) {
            const d = await run(["get", "text", scope]);
            if (!d.ok) continue;
            // The address in the same answer: a page that moved itself away is never read.
            if (typeof d.data?.origin === "string" && pageKind(d.data.origin, board) !== "ad") break;
            const text = dropPrivate(clean(String(d.data?.text ?? ""))).trim();
            if (!text) continue;
            const x = await readAdExtras(run, board, scope);
            const line = contactLine(x.contacts, text);
            return {
              ok: true, text: `${text.slice(0, READ_AD_CHARS)}${line ? `\n\n${line}` : ""}`, url: addr,
              meta: { ...(x.pageTitle ? { pageTitle: x.pageTitle } : {}), ...(x.jsonLd !== undefined ? { jsonLd: x.jsonLd } : {}) }, contacts: x.contacts,
            };
          }
          return no("failed", `The ad's text wasn't found on that ${name} page. Paste the ad's text instead.`);
        }
        return other
          ? no("not_found", `${name} didn't show that ad. It may have closed. Paste the ad's text if you still have it.`)
          : no("failed", `${name} didn't load in time. Try again, or paste the ad's text.`);
      } finally {
        if (target) await run(["tab", "close", target]).catch(() => undefined);
      }
    });
  }

  /** Plain words for why a sign-in check couldn't browse (after planForRun({ check: true }) returned null). */
  checkProblem(): string {
    switch (this.checkWhy) {
      case "remote_off": return COPY.remoteOff;
      case "connect_failed": return COPY.connectFailed;
      case "no_helper": return COPY.noHelper;
      case "busy": return COPY.busy;
      case "no_boards": return "Tick at least one job board first.";
      default: return "Search in my Chrome isn't set up yet. Finish its steps in Settings, then check again.";
    }
  }

  /** The composer's chips: the boards for the next find-jobs run only. */
  runBoards(boards: BoardId[]): void { this.nextBoards = cleanBoards(boards); }

  /**
   * Called by the engine when a find-jobs run starts: a browser plan when Search in my Chrome is set up, on and
   * connected, else null (the run uses web search as before). Makes the run's private control folder. `jobs`: the new
   * jobs the search aims for, which the run's browsing limits scale with.
   * `recruiters`: a Find recruiters run (the agencies it aims for). It browses in recruiters mode (no page text goes
   * to Claude), only SEEK, Indeed and LinkedIn among the ticked boards, and only with Search in my Chrome on. It never
   * changes Find jobs' state (its board chips, what the composer says about its last search, the scheduled-skip
   * reason): null just means the run uses the web tools only.
   */
  async planForRun(o: { check?: boolean; jobs?: number; recruiters?: number; filters?: BoardFilters | null; scheduled?: { waitMs: number; askAllow?: () => void } } = {}): Promise<BrowserPlan | null> {
    const own = !o.check && !o.recruiters;
    const next = own ? this.nextBoards : null;
    if (own) this.nextBoards = null;
    const at = this.ctx.now().toISOString();
    // A sign-in check (or a recruiters run) never changes what the composer says about the last search.
    const web = (reason: WebReason): null => { if (own) this.lastRun = { mode: "web", reason, boards: [], at }; else if (o.check) this.checkWhy = reason; return null; };
    const h = this.host;
    const root = this.ctx.root;
    if (!h || !root) return web("unavailable");
    if (this.active) return web("busy");
    const s = settingsOf(root);
    // The sign-in check is part of setup: it runs before Search in my Chrome is turned on.
    if (!s.enabled && !o.check) return web(s.set_up_at ? "off" : "not_set_up");
    const f = await this.findHelper(false);
    if (!f.helper || f.tooOld) return web("no_helper");
    const boards = next ? s.boards.filter((b) => next.includes(b)) : o.recruiters ? s.boards.filter((b) => RECRUITER_BOARDS.includes(b)) : s.boards;
    if (!boards.length) return web("no_boards");
    // Chrome comes to the front in the chosen profile before anything below may make it ask "Allow remote
    // debugging?", so the person sees the prompt. It also starts a Chrome that isn't running.
    await this.bringForward(h);
    if (!(await this.portOpenAfterFocus(h))) { this.connected = false; return web("remote_off"); }
    // The connection lives in memory only, so after a restart it's gone: reconnect once (Chrome may ask to Allow).
    if (!this.connected) {
      // A scheduled search: say so first (nobody pressed Find jobs), then wait longer for Allow.
      if (o.scheduled?.askAllow) { try { o.scheduled.askAllow(); } catch { /* best effort */ } }
      try { await this.connectOnce(false, o.scheduled?.waitMs ?? CONNECT_TIMEOUT_MS); } catch { return web("connect_failed"); }
      if (!this.connected) return web("connect_failed");
    } else if (!(await this.attached(this.helper(h, f.helper.bin))).ok) {
      // Connected earlier, but the helper now drives a browser of its own: stopped, reconnected once, still not.
      return web("connect_failed");
    }
    if (own) this.lastRun = { mode: "chrome", reason: "", boards: [...boards], at };
    const dir = fs.mkdtempSync(path.join(h.tmpDir ?? os.tmpdir(), "careeros-chrome-"));
    fs.chmodSync(dir, 0o700);
    const run = crypto.randomBytes(6).toString("hex");
    // With a profile chosen, the run's tabs go to that profile or nowhere: the run checks the folder again against
    // Chrome's list and refuses to open a board when it can't (it never falls back to the window used last).
    const profile = s.profile_dir ? { profile: { dir: s.profile_dir, localState: h.localStateFile ?? "", chromeBin: h.chromeBin?.() ?? "" } } : {};
    this.active = { run, boards, dir, bin: f.helper.bin, config: this.configFile(h), path: this.pathVar(h), home: h.home, ...profile, reconnected: this.attach?.reconnected === true, ...(o.jobs ? { jobs: o.jobs } : {}), ...(o.filters && own ? { filters: o.filters } : {}), ...(o.recruiters ? { purpose: "recruiters" as const, agencies: o.recruiters } : {}) };
    // What jobcairn-chrome (the browser command Claude runs) reads: the app's helper and profile, and this run.
    writeCliFiles(root, this.active, s.profile_dir ? this.profileName(s.profile_dir) : "");
    return this.active;
  }

  /**
   * The run ended (or never started): close any tab it left open and remove its control folder. Returns each board's
   * Details (how its tab was opened), read before the folder goes, for the run record.
   */
  async endRun(plan: BrowserPlan, o: { keepHelper?: boolean } = {}): Promise<BoardRunDiag[]> {
    if (this.active?.run === plan.run) this.active = null;
    if (this.ctx.root) clearCliRun(this.ctx.root, plan.run);
    let diags: BoardRunDiag[] = [];
    try { diags = readRunDiags(plan.dir, plan.boards); } catch { diags = []; }
    // A sign-in check's answers (Claude's word per board, with the app's own reading of the page). A board whose
    // tab couldn't be proven in the chosen profile has only its Details: it reads "unknown" for that reason.
    const reports = readSignInReports(plan.dir, plan.boards);
    if (reports.length) this.profileFailed = reports.some((r) => !r.state && r.diag?.mode === "profile" && r.diag.outcome !== "ok");
    for (const r of reports) {
      if (r.diag) this.diag.set(r.board, r.diag);
      if (!r.state) {
        if (r.diag?.mode === "profile" && r.diag.outcome !== "ok") this.signIn.set(r.board, { state: "unknown", why: { page: "profile_tab", matched: "" } });
        continue;
      }
      const state: BoardSignIn = r.state === "unclear" ? "unknown" : r.state;
      const page = (["feed", "login", "authwall", "checkpoint", "board", "elsewhere"] as const).find((p) => p === r.hint?.page) ?? "board";
      const matched = (["account", "hint", "sign_in", "none", "no_controls"] as const).find((m) => m === r.hint?.matched) ?? "";
      this.signIn.set(r.board, { state, why: { page, matched } });
    }
    const h = this.host;
    let tabs: unknown = [], targets: unknown = [];
    try { ({ tabs = [], targets = [] } = JSON.parse(fs.readFileSync(path.join(plan.dir, "progress.json"), "utf8")) as { tabs?: unknown; targets?: unknown }); } catch { tabs = []; targets = []; }
    const mine = (Array.isArray(tabs) ? tabs : []).filter((t): t is string => typeof t === "string" && RUN_ID.test(plan.run) && t.startsWith(`cos-${plan.run}-`));
    // Tabs the run opened in the chosen profile have no label: the run recorded their target ids (at most one per board).
    const adopted = (Array.isArray(targets) ? targets : []).filter((t): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(t)).slice(0, plan.boards.length);
    if (h && (mine.length || adopted.length)) {
      const helper = this.helper(h, plan.bin);
      for (const t of [...mine, ...adopted]) await helper.run(["tab", "close", t]).catch(() => undefined);
    }
    try { fs.rmSync(plan.dir, { recursive: true, force: true }); } catch { /* temp folder; the OS clears it */ }
    // Memory: the helper doesn't stay running after a search (done, failed or stopped); it lets go of Chrome, and
    // Chrome and the person's tabs stay. Not while setup tabs are open (the person is mid-setup, e.g. a sign-in
    // check run): the idle check stops it once setup goes quiet.
    if (h && !this.active && !this.setupTabs.size && o.keepHelper !== true) await this.stopHelper(plan.bin).catch(() => undefined);
    return diags;
  }

  private nowMs(): number { return this.host?.now?.() ?? Date.now(); }

  /** Why the last Find jobs plan wasn't a Chrome one ("" when it was, or there was none). */
  lastWebReason(): WebReason | "" { return this.lastRun?.mode === "web" ? this.lastRun.reason as WebReason : ""; }

  /** Search in my Chrome is turned on in the open workspace (a scheduled search then never uses the web instead). */
  chromeOn(): boolean { return !!this.ctx.root && settingsOf(this.ctx.root).enabled; }

  /**
   * Keeps the helper running for up to `ms` with no search (a failed search waiting to try again), so the retry
   * doesn't make Chrome ask "Allow" again. releaseHelper ends it early and stops the helper if nothing needs it.
   */
  holdHelper(ms: number): void { this.heldUntil = Math.max(this.heldUntil, this.nowMs() + ms); }

  async releaseHelper(): Promise<void> {
    if (!this.heldUntil) return;
    this.heldUntil = 0;
    if (!this.active && !this.setupTabs.size && this.connected) await this.stopHelper().catch(() => undefined);
  }

  /**
   * Stops the helper's background process (`close`): with Chrome attached it only lets go (Chrome and the person's
   * tabs stay open). The app counts as not connected until a step connects again.
   */
  private async stopHelper(bin?: string): Promise<void> {
    const h = this.host;
    const b = bin ?? this.found?.helper?.bin;
    if (!h || !b) return;
    await this.helper(h, b).run(["close"], { timeoutMs: 5_000 }).catch(() => undefined);
    if (this.connected) this.idleStopped = true;
    this.connected = false;
  }

  /**
   * The idle check (every 30 seconds while the app runs). No search: after IDLE_MS without a helper command, the
   * setup tabs close and the helper stops. A search whose browser command hasn't run for RUN_IDLE_MS: its tabs
   * close and the helper stops, so the run's next command says Chrome isn't connected and the run finishes.
   */
  async idleCheck(): Promise<void> {
    const now = this.nowMs();
    const a = this.active;
    if (a) {
      let last = this.lastUse;
      try { for (const f of fs.readdirSync(a.dir)) last = Math.max(last, fs.statSync(path.join(a.dir, f)).mtimeMs); } catch { /* folder gone: the run is ending */ }
      if (now - last < RUN_IDLE_MS) return;
      await this.closeRunTabs(a).catch(() => undefined);
      await this.stopHelper(a.bin);
      return;
    }
    if (!this.connected || now - this.lastUse < IDLE_MS || now < this.heldUntil) return;
    await this.closeSetupTabs().catch(() => undefined);
    await this.stopHelper();
  }

  /** Closes a run's own tabs (labels and adopted target ids, from its progress file), never any other tab. */
  private async closeRunTabs(plan: BrowserPlan): Promise<void> {
    const h = this.host;
    if (!h) return;
    let tabs: unknown = [], targets: unknown = [];
    try { ({ tabs = [], targets = [] } = JSON.parse(fs.readFileSync(path.join(plan.dir, "progress.json"), "utf8")) as { tabs?: unknown; targets?: unknown }); } catch { return; }
    const mine = (Array.isArray(tabs) ? tabs : []).filter((t): t is string => typeof t === "string" && RUN_ID.test(plan.run) && t.startsWith(`cos-${plan.run}-`));
    const adopted = (Array.isArray(targets) ? targets : []).filter((t): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(t)).slice(0, plan.boards.length);
    if (!mine.length && !adopted.length) return;
    const helper = this.helper(h, plan.bin);
    for (const t of [...mine, ...adopted]) await helper.run(["tab", "close", t]).catch(() => undefined);
  }

  /** Starts the idle check (main, at launch). Returns the stop function. */
  startIdleCheck(every = IDLE_CHECK_MS): () => void {
    if (this.idleTimer) return () => undefined;
    const t = setInterval(() => { void this.idleCheck().catch(() => undefined); }, every);
    (t as { unref?: () => void }).unref?.();
    this.idleTimer = t;
    return () => { clearInterval(t); this.idleTimer = null; };
  }

  progress(): ChromeRunProgress | null {
    const a = this.active;
    if (!a) return null;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(a.dir, "progress.json"), "utf8")) as ChromeRunProgress;
      return {
        run_id: a.run, paused: !!p.paused,
        boards: (p.boards ?? []).filter((b) => a.boards.includes(b.id)).map((b) => ({ id: b.id, name: b.name, state: b.state, pages: b.pages, ads_read: b.ads_read, reason: b.reason })),
      };
    } catch {
      return { run_id: a.run, boards: a.boards.map((id) => ({ id, name: BOARD_NAMES[id], state: "waiting", pages: 0, ads_read: 0, reason: "" })), paused: false };
    }
  }

  answer(board: BoardId, answer: "continue" | "skip"): ChromeRunProgress | null {
    const a = this.active;
    if (!a) throw new Error("No search is running in Chrome.");
    if (!a.boards.includes(board)) throw new Error(`${BOARD_NAMES[board]} isn't part of this search.`);
    const tmp = path.join(a.dir, `.answer-${board}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ answer }), { mode: 0o600 });
    fs.renameSync(tmp, path.join(a.dir, `answer-${board}.json`));
    return this.progress();
  }

  /**
   * App quit: close a running search's tabs and the setup tabs, then drop the connection to Chrome (Chrome itself
   * and the person's tabs stay open; an attached browser isn't the helper's to close). Awaited by main, with a limit.
   */
  async shutdown(): Promise<void> {
    const h = this.host;
    const f = this.found?.helper;
    if (!h || !f) return;
    if (this.active) await this.endRun(this.active).catch(() => undefined);
    if (!this.connected) return;
    await this.closeSetupTabs().catch(() => undefined);
    await this.helper(h, f.bin).run(["close"], { timeoutMs: 5_000 }).catch(() => undefined);
    this.connected = false;
  }

  /** The app's last moment (process exit, also after a crash in main): detach without waiting on anything async. */
  shutdownSync(): void {
    const h = this.host;
    const f = this.found?.helper;
    if (!h?.runSync || !f || !this.connected) return;
    try {
      h.runSync(f.bin, ["--session", SESSION, "--config", this.configFile(h), "--no-webmcp", "close"], { cwd: h.dataDir, env: helperEnv({ path: this.pathVar(h), home: h.home }, h.env), timeoutMs: 3_000 });
    } catch { /* best effort; the next launch closes a left-over session */ }
    this.connected = false;
  }

  /**
   * App start: a session left from a crash or a forced quit would keep the person's Chrome under remote control
   * (the helper never times out an attached browser). If the app's session is still alive, close it.
   */
  async startup(): Promise<void> {
    const h = this.host;
    if (!h) return;
    const f = await this.findHelper(false).catch(() => ({ helper: null, tooOld: false }));
    if (!f.helper || f.tooOld) return;
    let out = "";
    try {
      const r = await h.runner.run(f.helper.bin, ["session", "list"], { cwd: h.dataDir, env: helperEnv({ path: this.pathVar(h), home: h.home }, h.env), timeoutMs: VERSION_TIMEOUT_MS });
      out = r.code === 0 ? r.stdout : "";
    } catch { return; }
    if (!new RegExp(`^\\s*${SESSION}\\s*$`, "m").test(out)) return;
    await this.helper(h, f.helper.bin).run(["close"], { timeoutMs: 5_000 }).catch(() => undefined);
    this.connected = false;
  }
}

const services = new WeakMap<ServiceContext, ChromeSearch>();
export function chromeFor(ctx: ServiceContext): ChromeSearch {
  let s = services.get(ctx);
  if (!s) { s = new ChromeSearch(ctx); services.set(ctx, s); }
  return s;
}

/** The text a browser run gets in front of the find-jobs request (fixed words plus board names, no person's input). */
export function browserRequest(boards: readonly BoardId[]): string {
  const names = boards.map((b) => BOARD_NAMES[b]).join(", ");
  const cmd = "./.careeros/bin/jobcairn-chrome";
  return [
    `Search in my Chrome is on for this run. Search these job boards in the person's own Chrome, in their chosen profile, with ${cmd}: ${names}.`,
    `Start with \`${cmd} skills get core\`. Then \`${cmd} search <board> "<words>" "<place>"\` with the search words and places below, \`snapshot\`, \`click @eN\` to open ads that look like a match, and \`get text\` to read each one. Finish with \`${cmd} close\`.`,
    `Save each match with job_new: source "browser", site the board's name, url the ad's address on the board, jd_text the ad's text. Log each search with search_add, with the board's name as the site.`,
    "Web search isn't available in this run; use only these boards. Follow the search rules below: preferred locations first, widen only as they say, allowed countries only.",
  ].join(" ");
}

/**
 * The text a Find recruiters run gets in front of its request when it may look at the boards in Chrome (recruiters
 * mode; fixed words plus board names, no person's input).
 */
export function recruiterBrowserRequest(boards: readonly BoardId[]): string {
  const names = boards.map((b) => BOARD_NAMES[b]).join(", ");
  const cmd = "./.careeros/bin/jobcairn-chrome";
  return [
    `Chrome is on for this run: for source (b), search these job boards in the person's own Chrome with ${cmd}: ${names}.`,
    `Run \`${cmd} search <board> "<role>" "<city>"\` for each target role and city: it lists the job ads found. Then \`${cmd} open <ad address>\` for ads that may be from an agency: it gives the advertiser, whether the ad says it recruits for a client, and the contact links in the ad. \`${cmd} open <results page>\` or \`${cmd} more\` lists more ads. Finish with \`${cmd} close\`.`,
    "Check each advertiser on its own site with web search before you save it, and give the ad's address as its source with the board's name. Use web search and web pages for every other source, but never fetch these boards' pages directly.",
  ].join(" ");
}

/** The note a Find recruiters run gets when Chrome isn't used (not set up, off, not connected, or busy). */
export const RECRUITER_WEB_ONLY = "Chrome isn't used for this run: for source (b), find the agencies advertising on the job boards with web search.";

/** The text a sign-in check gets in front of its request (fixed words plus board names). */
export function checkRequest(boards: readonly BoardId[]): string {
  const cmd = "./.careeros/bin/jobcairn-chrome";
  return [
    `This is a sign-in check in the person's own Chrome, in their chosen profile, with ${cmd}. Boards: ${boards.map((b) => `${BOARD_NAMES[b]} (${b})`).join(", ")}.`,
    `For each board run \`${cmd} signin <board>\`, then \`${cmd} report <board> signed_in|signed_out|unclear\`. Finish with \`${cmd} close\`.`,
    "Don't search, open ads, sign in or type anything.",
  ].join(" ");
}
