import fs from "node:fs";
import path from "node:path";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { BOARD_IDS, BOARD_NAMES, cleanBoardFilters, findBudget, MAX_AGENCIES, MAX_JOBS, recruiterBudget, type BoardFilters, type BoardId, type SignInDiag } from "@careeros/contract";
import { nodeProcessRunner, type ProcessRunner } from "../claude/process.js";
import { boardForUrl, canonicalAddress, directAddress, landingPage, pageKind, readControls } from "./boards.js";
import { BrowserHelper, checkAttached, fileLock, helperEnv, isOwnChrome, SESSION, sessionLockDir, type HelperRun } from "./helper.js";
import { openVerifiedTab, profileDirShape, readChromeProfiles, spawnLaunch, validProfileDir, type Launch, type OpenBudget } from "./profile.js";
import { BoardStopped, BrowseRefused, BrowserRun, fileControl, RUN_ID, type BrowserRunState, type Caps } from "./session.js";

/**
 * `jobcairn-chrome`: the one browser command Claude may run (through Bash) in a JobCairn workspace. It is a thin
 * front for BrowserRun (session.ts), so every rule the app's browsing keeps applies here too:
 * - one connection: it uses the app's own helper session (same session name, config file and lock as the app) and
 *   never connects by itself, so Chrome asks "Allow remote debugging?" only when the app connects;
 * - the chosen profile only: each board's tab is opened with `tab new` and proven on chrome://version before any
 *   board page loads (profile.ts openVerifiedTab); a tab in another profile is closed, never used;
 * - own tabs only, ticked boards only, search results and job ads only, read-only (guard.ts on every click and
 *   fill), caps on pages, actions and time, and a pause for the person at a CAPTCHA or sign-in wall.
 * Commands are agent-browser-like, so its skill reads naturally. Anything else is refused.
 *
 * Files (written by the app, never by Claude: `.careeros/` is denied to Claude's edit tools):
 * - `.careeros/chrome.json`: the helper (bin, config, PATH, HOME) and the chosen profile;
 * - `.careeros/chrome-run.json`: the running search (run id, boards, its private control folder, the jobs it aims
 *   for). No run: refused.
 */

export const CLI_NAME = "jobcairn-chrome";
/** Where the app installs the command in a workspace. */
export const CLI_REL = ".careeros/bin/jobcairn-chrome";
export const CHROME_CONFIG_REL = ".careeros/chrome.json";
export const CHROME_RUN_REL = ".careeros/chrome-run.json";

export interface ChromeCliConfig {
  bin: string; config: string; path: string; home: string;
  /** The chosen profile: its folder, its name as Chrome shows it, Chrome's Local State file, Chrome's binary (not macOS). */
  profile?: { dir: string; name: string; local_state: string; chrome_bin: string } | null;
}
/**
 * `reconnected`: main had to reconnect the helper to Chrome when the run started (for Details). `jobs`: the new jobs
 * a find-jobs run aims for, which its limits scale with (runCaps); null for a sign-in check (fixed limits).
 */
export interface ChromeCliRun {
  run: string; boards: BoardId[]; dir: string; reconnected?: boolean; jobs: number | null;
  /** The boards' own search filters for this run (written by main from the person's settings, never by Claude). */
  filters?: BoardFilters | null;
  /**
   * "recruiters": a Find recruiters run, which also has WebFetch, so the command answers only what the app reads off
   * a page (RECRUITER_HELP), never the page. `agencies` is its target, which its limits scale with (recruiterBudget).
   */
  purpose?: "recruiters" | null;
  agencies?: number | null;
}

export const HELP = [
  `${CLI_NAME}: browse the person's job boards in their own Chrome, in the chosen profile, read-only. One command per call.`,
  "  status                          Is Chrome connected?",
  "  skills get core [--full]        The browser helper's own guide (read-only commands only work here)",
  "  search <board> <words> [place] [--it]  Open the board's search results in its own tab (boards: the ticked ones); --it searches only IT jobs where the board has that category (SEEK)",
  "  open <url>                      Open a search results page or a job ad of a ticked board (tab new <url> works too)",
  "  snapshot                        The page's controls with refs (@e1, @e2...)",
  "  click @eN                       Click a link, tab or filter. Apply, save, message, sign in and the like are refused",
  "  fill @eN <text> [--submit]      Type search words or a place into a search box",
  "  scroll down|up                  Load more results",
  "  get text [@eN]                  Read the page (a whole job ad) or one element",
  "  back                            Go back one page",
  "  tab close                       Close the current board's tab",
  "  close                           Close all of this search's tabs (do this when you're done)",
  "  signin <board>                  Sign-in check: open the board and say what the page shows",
  "  report <board> signed_in|signed_out|unclear   Sign-in check: record your answer for the board",
].join("\n");

const NOT_CONNECTED = `Chrome isn't connected. Ask the person to open ${identity.name}, Settings › Search in my Chrome, and press Connect. Don't try to connect another way.`;
const NO_RUN = `No Chrome search is running for this workspace, so nothing was opened. Browsing works only inside a ${identity.name} run that searches in Chrome.`;

export interface CliDeps {
  runner: ProcessRunner;
  launch: Launch;
  platform: NodeJS.Platform;
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  /** Test seam: a ready-made helper (else one on the app's session, with the shared lock). */
  helper?: BrowserHelper;
}

export const realCliDeps = (): CliDeps => ({
  runner: nodeProcessRunner(), launch: spawnLaunch, platform: process.platform, now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: () => Math.random(),
});

function readJson(file: string, max = 64 * 1024): unknown {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > max) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

const abs = (v: unknown): v is string => typeof v === "string" && path.isAbsolute(v);

export function readCliConfig(root: string): ChromeCliConfig | null {
  const j = readJson(path.join(root, CHROME_CONFIG_REL)) as Partial<ChromeCliConfig> | null;
  if (!j || !abs(j.bin) || !abs(j.config) || !abs(j.home) || typeof j.path !== "string") return null;
  const p = j.profile && typeof j.profile === "object" ? j.profile : null;
  const profile = p && typeof p.dir === "string" && p.dir
    ? { dir: p.dir, name: typeof p.name === "string" ? p.name : "", local_state: abs(p.local_state) ? p.local_state : "", chrome_bin: abs(p.chrome_bin) ? p.chrome_bin : "" }
    : null;
  return { bin: j.bin, config: j.config, path: j.path, home: j.home, profile };
}

export function readCliRun(root: string): ChromeCliRun | null {
  const j = readJson(path.join(root, CHROME_RUN_REL)) as Partial<ChromeCliRun> | null;
  if (!j || typeof j.run !== "string" || !RUN_ID.test(j.run) || !abs(j.dir) || !Array.isArray(j.boards)) return null;
  const boards = BOARD_IDS.filter((b) => (j.boards as unknown[]).includes(b));
  if (!boards.length) return null;
  try { const st = fs.lstatSync(j.dir); if (!st.isDirectory() || st.isSymbolicLink()) return null; } catch { return null; }
  const jobs = typeof j.jobs === "number" && Number.isInteger(j.jobs) && j.jobs >= MAX_JOBS.min && j.jobs <= MAX_JOBS.max ? j.jobs : null;
  const recruiters = j.purpose === "recruiters";
  const agencies = recruiters && typeof j.agencies === "number" && Number.isInteger(j.agencies) && j.agencies >= MAX_AGENCIES.min && j.agencies <= MAX_AGENCIES.max ? j.agencies : null;
  return { run: j.run, boards, dir: j.dir, reconnected: j.reconnected === true, jobs, filters: cleanBoardFilters(j.filters), ...(recruiters ? { purpose: "recruiters" as const, agencies } : {}) };
}

/**
 * The run's limits: pages per board, steps and browsing time grow with the jobs a find-jobs run aims for
 * (findBudget), so 100 is reachable; with none (a sign-in check) they stay session.ts's CAPS. A Bash call has about
 * two minutes, so a pause for the person waits less than that, then the board is skipped.
 */
export function runCaps(jobs: number | null, recruiters: { agencies: number | null } | null = null): Partial<Caps> {
  if (recruiters) {
    const r = recruiterBudget(recruiters.agencies ?? MAX_AGENCIES.default);
    return { pagesPerBoard: r.pagesPerBoard, actions: r.actions, browseMs: r.browseMs, pauseWaitMs: 90_000 };
  }
  if (!jobs) return { pauseWaitMs: 90_000 };
  const b = findBudget(jobs);
  return { pagesPerBoard: b.pagesPerBoard, actions: b.actions, browseMs: b.browseMs, pauseWaitMs: 90_000 };
}

/** A board by id ("seek") or by the name the person sees ("SEEK", "Indeed"), among this run's boards. */
function boardArg(raw: string | undefined, boards: readonly BoardId[]): BoardId | null {
  const k = (raw ?? "").trim().toLowerCase();
  return boards.find((b) => b === k || BOARD_NAMES[b].toLowerCase() === k) ?? null;
}

/** Is the app's helper session running (connected by the app)? Never starts one. */
async function sessionAlive(cfg: ChromeCliConfig, d: CliDeps): Promise<boolean> {
  try {
    const r = await d.runner.run(cfg.bin, ["session", "list"], { cwd: path.dirname(cfg.config), env: helperEnv({ path: cfg.path, home: cfg.home }), timeoutMs: 15_000 });
    return r.code === 0 && new RegExp(`^\\s*${SESSION}\\s*$`, "m").test(r.stdout);
  } catch { return false; }
}

export interface CliResult { code: number; out: string }

/**
 * Runs one command. `root` is the workspace (from the installed command, not from Claude). Exit 0 with the page
 * text, or 1 with plain words Claude can act on or pass on.
 */
export async function chromeCli(root: string, argv: readonly string[], d: CliDeps): Promise<CliResult> {
  const [cmd = "", ...rest] = argv;
  const ok = (out: string): CliResult => ({ code: 0, out });
  const no = (out: string): CliResult => ({ code: 1, out });
  // Recruiters mode (a Find recruiters run) has its own, smaller set of commands and no helper guide.
  const recruiters = readCliRun(root)?.purpose === "recruiters";
  if (cmd === "" || cmd === "help" || cmd === "--help" || cmd === "-h") return ok(recruiters ? RECRUITER_HELP : HELP);
  const cfg = readCliConfig(root);
  if (!cfg) return no(`Search in my Chrome isn't set up in this workspace. ${NOT_CONNECTED}`);

  if (cmd === "skills" && recruiters) return no(`The helper's guide isn't available in recruiters mode. Commands:\n${RECRUITER_HELP}`);
  if (cmd === "skills") {
    // The helper's own guide: only `skills get core` (and --full), which reads nothing from Chrome.
    if (rest[0] !== "get" || rest[1] !== "core" || rest.length > 3 || (rest[2] !== undefined && rest[2] !== "--full")) return no(`Only "${CLI_NAME} skills get core" (or with --full) is available.`);
    try {
      const r = await d.runner.run(cfg.bin, ["skills", "get", "core", ...(rest[2] ? ["--full"] : [])], { cwd: path.dirname(cfg.config), env: helperEnv({ path: cfg.path, home: cfg.home }), timeoutMs: 30_000 });
      const guide = r.code === 0 ? r.stdout : "";
      return guide ? ok(`${guide}\n\nIn this workspace, run every browser command as ${CLI_NAME} <command> (never agent-browser itself). Commands:\n${HELP}`) : no("The browser helper's guide isn't available.");
    } catch { return no("The browser helper's guide isn't available."); }
  }

  if (!(await sessionAlive(cfg, d))) return no(NOT_CONNECTED);
  const run = cmd === "status" ? null : readCliRun(root);
  if (cmd !== "status" && !run) return no(NO_RUN);

  const helper = d.helper ?? new BrowserHelper(d.runner, { bin: cfg.bin, config: cfg.config, cwd: run?.dir ?? path.dirname(cfg.config), path: cfg.path, home: cfg.home }, fileLock(sessionLockDir(cfg.config)));
  // The session must drive the person's own Chrome, never a browser the helper launched. This command only checks:
  // it never reconnects (Chrome would ask "Allow" in the middle of Claude's run). A browser the helper launched for
  // this session is stopped, and the run is told Chrome isn't connected.
  const att = await helper.session(async (r) => {
    const a = await checkAttached(r, { reconnect: false });
    if (!a.ok && a.cdp && !isOwnChrome(a.cdp)) await r(["close"], { timeoutMs: 10_000 });
    return a;
  });
  if (!att.ok) return no(NOT_CONNECTED);
  if (cmd === "status") return ok("Chrome is connected.");
  if (!run) return no(NO_RUN);

  // With a profile chosen, tabs open there or nowhere. A profile that doesn't check out opens nothing.
  let profileTab: ((r: HelperRun, label: string) => Promise<string | null>) | undefined;
  let profileName: string | undefined;
  const base = { cdp: att.cdp, reconnected: run.reconnected === true };
  // How the last tab was opened, for Details (kept per board). `fresh`: this command opened a tab.
  let lastDiag: SignInDiag | null = cfg.profile ? null : { mode: "last_window", profile_dir: "", outcome: "ok", launched: false, tries: 1, ms: 0, ...base, opens: 0 };
  let fresh = false;
  if (cfg.profile) {
    const { profiles } = cfg.profile.local_state ? readChromeProfiles(cfg.profile.local_state) : { profiles: [] };
    const dir = cfg.profile.dir;
    profileName = cfg.profile.name || profiles.find((p) => p.dir === dir)?.name || undefined;
    profileTab = validProfileDir(dir, profiles)
      ? async (r, label) => {
        const v = await openVerifiedTab(r, dir, profiles, label, { launch: d.launch, platform: d.platform, chromeBin: cfg.profile!.chrome_bin || null, sleep: d.sleep, now: d.now, opens: fileBudget(run.dir), home: cfg.home });
        lastDiag = { mode: "profile", ...v.diag, ...base };
        fresh = true;
        return v.target;
      }
      : async () => { lastDiag = { mode: "profile", profile_dir: "", outcome: "bad_profile", launched: false, tries: 0, ms: 0, ...base, opens: 0 }; fresh = true; return null; };
  }
  const b = new BrowserRun(run.run, run.boards, {
    helper, control: fileControl(run.dir), now: d.now, sleep: d.sleep, random: d.random, profileTab, ...(profileName ? { profileName } : {}),
    caps: runCaps(run.jobs, run.purpose === "recruiters" ? { agencies: run.agencies ?? null } : null),
  });

  // One command at a time per run: load the run's state, act, save it. Boards aren't browsed in parallel on purpose
  // (owner asked for up to 3 at once, 2026-10-15): the one helper session has one current tab and each step is
  // focus-then-act under the session lock, so steps would only interleave, never overlap; two processes saving this
  // one state file would lose each other's tab records (the 11 Oct reopen loop); and a session per board is a new
  // Chrome connection each, so an "Allow remote debugging?" prompt per board on every run. Real parallel boards
  // would need one Claude process per board, each with its own state file, and the reports merged.
  const lock = fileLock(path.join(run.dir, "cli.lock"));
  const release = await lock.acquire();
  let saved = false;
  try {
    const st = loadRunState(run.dir);
    if (st === "unreadable") return no(run.purpose === "recruiters" ? `${LOST_STATE}\n${RECRUITER_CARRY_ON}` : LOST_STATE);
    b.restoreState(st);
    saved = true;
    return ok(run.purpose === "recruiters" ? await dispatchRecruiters(b, run, cmd, rest, () => lastDiag, () => fresh) : await dispatchCmd(b, run, cmd, rest, () => lastDiag, () => fresh));
  } catch (e) {
    if (e instanceof BoardStopped) keepStopDiag(run.dir, e, lastDiag, cfg);
    // Recruiters mode: Chrome is one source among several, so a refusal (time or steps used up, a board stopped) never
    // ends the run, whatever the words above say about jobs.
    const more = run.purpose === "recruiters" ? `\n${RECRUITER_CARRY_ON}` : "";
    if (e instanceof BrowseRefused) return no(`${e.message}${more}`);
    return no(`The browser couldn't do that: ${(e as Error).message.split("\n")[0]!.slice(0, 200)}${more}`);
  } finally {
    try { if (saved) saveRunState(run.dir, b.saveState()); } catch { /* the next command starts from what was saved before */ }
    release();
  }
}

const LOST_STATE = "This search's record of its own tabs couldn't be read, so nothing was opened or reloaded. Stop browsing, save the jobs you found and finish.";

/**
 * The run's state between commands, in two files so a big page can never cost the run its tabs (11 Oct: a SEEK
 * results page made the one state file larger than the 64 KB read limit, every later command started with no tab,
 * "No tab is open in this run", and each reopen loaded SEEK again until Cloudflare stepped in):
 * - `cli-state.json`: tabs, current board, counts, board states. Small; a file that is there but can't be read
 *   stops the command (never a silent fresh start, which would reopen and reload the board);
 * - `cli-seen.json`: each board's last snapshot (for checking clicks). Up to 8 MB; if it can't be read, Claude
 *   just takes a new snapshot.
 * Both are the app's own files (0600, in the run's 0700 folder).
 */
const STATE_FILE = "cli-state.json";
const SEEN_FILE = "cli-seen.json";
export const STATE_MAX_BYTES = 1024 * 1024;
export const SEEN_MAX_BYTES = 8 * 1024 * 1024;

export function loadRunState(dir: string): BrowserRunState | null | "unreadable" {
  const file = path.join(dir, STATE_FILE);
  if (!fs.existsSync(file)) return null;
  const core = readJson(file, STATE_MAX_BYTES) as BrowserRunState | null;
  if (!core || typeof core !== "object") return "unreadable";
  const seen = readJson(path.join(dir, SEEN_FILE), SEEN_MAX_BYTES) as { seen?: unknown } | null;
  return { ...core, seen: Array.isArray(seen?.seen) ? (seen.seen as BrowserRunState["seen"]) : [] };
}

export function saveRunState(dir: string, st: BrowserRunState): void {
  writeRunFile(dir, SEEN_FILE, { v: 1, seen: st.seen });
  writeRunFile(dir, STATE_FILE, { ...st, seen: [] });
}

/** A stopped board's Details: how its tab was opened (kept), with why it stopped. */
function keepStopDiag(dir: string, e: BoardStopped, last: SignInDiag | null, cfg: ChromeCliConfig): void {
  const had = readDiag(readJson(path.join(dir, `diag-${e.board}.json`))) ?? last;
  const base: SignInDiag = had ?? { mode: cfg.profile ? "profile" : "last_window", profile_dir: cfg.profile?.dir ?? "", outcome: "ok", launched: false, tries: 0, ms: 0 };
  try { writeRunFile(dir, `diag-${e.board}.json`, { ...base, outcome: e.outcome }); } catch { /* Details only */ }
}

async function dispatchCmd(b: BrowserRun, run: ChromeCliRun, cmd: string, rest: readonly string[], diag: () => SignInDiag | null = () => null, fresh: () => boolean = () => false): Promise<string> {
  const usage = (u: string) => new BrowseRefused(`Use: ${CLI_NAME} ${u}`);
  /**
   * Keeps how this board's tab was opened (diag-<board>.json, read into the run record's Details): every time this
   * command opened a tab, and once for a board with no record yet (no profile chosen: the window used last).
   */
  const keepDiag = (board: BoardId) => {
    const dg = diag();
    if (!dg) return;
    if (fresh() || !fs.existsSync(path.join(run.dir, `diag-${board}.json`))) writeRunFile(run.dir, `diag-${board}.json`, dg);
  };
  switch (cmd) {
    case "search": {
      const it = rest.includes("--it");
      const args = rest.filter((x) => x !== "--it");
      const board = boardArg(args[0], run.boards);
      if (!board) throw new BrowseRefused(`Name one of this search's boards: ${run.boards.map((x) => BOARD_NAMES[x]).join(", ")}.`);
      if (!args[1]) throw usage("search <board> <words> [place] [--it]");
      try { return await b.open(board, { query: args[1].slice(0, 200), location: (args[2] ?? "").slice(0, 120), it, filters: run.filters ?? null }); } finally { keepDiag(board); }
    }
    case "open": case "tab": {
      if (cmd === "tab" && rest[0] === "close" && rest.length === 1) return b.closeTab();
      if (cmd === "tab" && rest[0] !== "new") throw new BrowseRefused(`Only "tab new <url>" and "tab close" are available. Other tabs are the person's and are never listed, read or switched to.`);
      const url = cmd === "tab" ? rest[1] : rest[0];
      if (!url || (cmd === "tab" ? rest.length !== 2 : rest.length !== 1)) throw usage("open <url>");
      const board = boardForUrl(url, run.boards);
      if (!board) throw new BrowseRefused(`That address isn't on one of this search's boards (${run.boards.map((x) => BOARD_NAMES[x]).join(", ")}). Only their search results and job ads open.`);
      try { return await b.open(board, { url }); } finally { keepDiag(board); }
    }
    case "snapshot": return b.snapshot();
    case "click": if (!rest[0] || rest.length !== 1) throw usage("click @eN"); return b.click(rest[0]);
    case "fill": {
      const submit = rest.includes("--submit");
      const args = rest.filter((a) => a !== "--submit");
      if (args.length !== 2) throw usage("fill @eN <text> [--submit]");
      return b.fill(args[0]!, args[1]!.slice(0, 200), submit);
    }
    case "scroll": if (rest[0] !== "down" && rest[0] !== "up") throw usage("scroll down|up"); return b.scroll(rest[0]);
    case "get":
      if (rest[0] !== "text" || rest.length > 2) throw usage("get text [@eN]");
      return b.read(rest[1]);
    case "back": return b.back();
    case "close": await b.closeAll(); return "All of this search's tabs are closed.";
    case "signin": {
      const board = boardArg(rest[0], run.boards);
      if (!board || rest.length !== 1) throw new BrowseRefused(`Use: ${CLI_NAME} signin <board>, one of: ${run.boards.map((x) => BOARD_NAMES[x]).join(", ")}.`);
      let page: string;
      try { page = await b.open(board, { check: true }); } finally { keepDiag(board); }
      const hint = signInHint(board, b.seenPage(board), page);
      writeRunFile(run.dir, `hint-${board}.json`, hint);
      return `${page}\n\nWhat the app's own reading says: ${hintText(board, hint)}\nNow record your answer: ${CLI_NAME} report ${board} signed_in|signed_out|unclear`;
    }
    case "report": {
      const board = boardArg(rest[0], run.boards);
      const state = rest[1] === "signed_in" || rest[1] === "signed_out" || rest[1] === "unclear" ? rest[1] : null;
      if (!board || !state || rest.length !== 2) throw usage("report <board> signed_in|signed_out|unclear");
      writeRunFile(run.dir, `signin-${board}.json`, { state });
      return `Recorded: ${BOARD_NAMES[board]} ${state.replace("_", " ")}.`;
    }
    default: throw new BrowseRefused(`"${cmd.slice(0, 40)}" isn't available here: this command only searches and reads job boards.\n${HELP}`);
  }
}

/**
 * Recruiters mode (a Find recruiters run, which also has WebFetch): only commands whose answers the app builds itself
 * from a page (session.ts adList, adFacts), never a page's text, tree or controls. Nothing is clicked or typed.
 */
export const RECRUITER_HELP = [
  `${CLI_NAME} (recruiters mode): find the agencies that advertise on the person's job boards, in their own Chrome, read-only. One command per call.`,
  "  search <board> <words> [place]  Search a board (boards: the ticked ones of SEEK, Indeed, LinkedIn) and list the job ads found: title and address",
  "  open <url>                      A results page from a list: list its ads. A job ad: its title, advertiser, place, whether it says it recruits for a client, and its contact links",
  "  more                            Scroll the current results page and list its ads again",
  "  tab close                       Close the current board's tab",
  "  close                           Close all of this run's tabs (do this when you're done)",
  "Page text, snapshots, clicks and typing aren't available in this mode.",
].join("\n");

/** Said after anything the browser refuses in recruiters mode. */
export const RECRUITER_CARRY_ON = "This only ends Chrome for this run (or this board): carry on finding agencies with web search and the other sources until you reach the number asked for.";

async function dispatchRecruiters(b: BrowserRun, run: ChromeCliRun, cmd: string, rest: readonly string[], diag: () => SignInDiag | null, fresh: () => boolean): Promise<string> {
  const usage = (u: string) => new BrowseRefused(`Use: ${CLI_NAME} ${u}`);
  const keepDiag = (board: BoardId) => {
    const dg = diag();
    if (dg && (fresh() || !fs.existsSync(path.join(run.dir, `diag-${board}.json`)))) writeRunFile(run.dir, `diag-${board}.json`, dg);
  };
  switch (cmd) {
    case "search": {
      const board = boardArg(rest[0], run.boards);
      if (!board) throw new BrowseRefused(`Name one of this run's boards: ${run.boards.map((x) => BOARD_NAMES[x]).join(", ")}.`);
      if (!rest[1] || rest.length > 3) throw usage("search <board> <words> [place]");
      try { await b.open(board, { query: rest[1].slice(0, 200), location: (rest[2] ?? "").slice(0, 120), filters: run.filters ?? null }); } finally { keepDiag(board); }
      return b.adList();
    }
    case "open": {
      const url = rest[0];
      if (!url || rest.length !== 1) throw usage("open <url>");
      const board = boardForUrl(url, run.boards);
      if (!board) throw new BrowseRefused(`That address isn't on one of this run's boards (${run.boards.map((x) => BOARD_NAMES[x]).join(", ")}). Only their search results and job ads open.`);
      try { await b.open(board, { url }); } finally { keepDiag(board); }
      return pageKind(canonicalAddress(directAddress(url, board), board) ?? "", board) === "ad" ? b.adFacts() : b.adList();
    }
    case "more": if (rest.length) throw usage("more"); await b.scroll("down"); return b.adList();
    case "tab": if (rest[0] !== "close" || rest.length !== 1) throw usage("tab close"); return b.closeTab();
    case "close": await b.closeAll(); return "All of this run's tabs are closed.";
    default: throw new BrowseRefused(`"${cmd.slice(0, 40)}" isn't available in recruiters mode: this command only lists job ads and reads an ad's advertiser.\n${RECRUITER_HELP}`);
  }
}

/** What the app's own rules read off a sign-in check's page: the kind of page and the kind of control (never names). */
export interface SignInHint { page: string; matched: string; state: string }

function signInHint(board: BoardId, seen: { url: string; text: string } | null, answer: string): SignInHint {
  if (!seen) return { page: /security check/.test(answer) ? "checkpoint" : "login", matched: "", state: /security check/.test(answer) ? "unknown" : "signed_out" };
  const page = landingPage(seen.url, board);
  if (page === "login" || page === "authwall") return { page, matched: "", state: "signed_out" };
  if (page === "checkpoint") return { page, matched: "", state: "unknown" };
  const c = readControls(board, seen.text);
  return { page, matched: c.matched, state: c.state };
}

function hintText(board: BoardId, h: SignInHint): string {
  const name = BOARD_NAMES[board];
  if (h.page === "login" || h.page === "authwall") return `${name} showed its sign-in page (looks signed out).`;
  if (h.page === "checkpoint") return `${name} showed a security check (can't tell; the person finishes it in Chrome).`;
  if (h.matched === "account") return `${name} showed an account menu (looks signed in).`;
  if (h.matched === "hint") return `${name} showed links usually seen only when signed in (probably signed in).`;
  if (h.matched === "sign_in") return `${name} showed a Sign in button (looks signed out).`;
  return `${name} showed nothing that says either way.`;
}

function writeRunFile(dir: string, name: string, data: unknown): void {
  const f = path.join(dir, name);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** The sign-in check's answers a run left in its control folder: Claude's word per board, with the app's own reading. */
export interface SignInReport { board: BoardId; state: "signed_in" | "signed_out" | "unclear" | null; hint: SignInHint | null; diag: SignInDiag | null }

/**
 * The sign-in check's answers a run left in its control folder: Claude's word per board, with the app's own reading
 * and how the tab was opened. A board with only a diag (the tab never opened, so Claude had nothing to report) still
 * comes back, with state null, so Details can say why.
 */
export function readSignInReports(dir: string, boards: readonly BoardId[]): SignInReport[] {
  const out: SignInReport[] = [];
  for (const board of boards) {
    const r = readJson(path.join(dir, `signin-${board}.json`)) as { state?: unknown } | null;
    const state = r?.state === "signed_in" || r?.state === "signed_out" || r?.state === "unclear" ? r.state : null;
    const diag = readDiag(readJson(path.join(dir, `diag-${board}.json`)));
    if (!state && !diag) continue;
    const h = readJson(path.join(dir, `hint-${board}.json`)) as Partial<SignInHint> | null;
    out.push({ board, state, hint: h && typeof h.page === "string" && typeof h.matched === "string" && typeof h.state === "string" ? { page: h.page, matched: h.matched, state: h.state } : null, diag });
  }
  return out;
}

const OUTCOMES = ["ok", "bad_profile", "no_tab", "wrong_profile", "no_launch", "not_attached", "bot_check", "tab_lost"] as const;

/** A short plain text from a diag file: control characters dropped, capped. */
const diagText = (v: unknown, max: number): string | undefined =>
  // eslint-disable-next-line no-control-regex
  typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "").slice(0, max) : undefined;

/** A diag file read back with every field checked (the run folder is the app's, but Claude can run commands near it). */
export function readDiag(j: unknown): SignInDiag | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const outcome = OUTCOMES.find((x) => x === o.outcome);
  const mode = o.mode === "profile" || o.mode === "last_window" ? o.mode : null;
  if (!outcome || !mode) return null;
  const dir = profileDirShape(o.profile_dir) ? o.profile_dir : "";
  const n = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
  const cdp = diagText(o.cdp, 80);
  const seen = diagText(o.profile_seen, 160);
  return {
    mode, profile_dir: dir, outcome, launched: o.launched === true, tries: n(o.tries, 9), ms: n(o.ms, 600_000),
    // host:port only (never a browser id or a path).
    ...(cdp !== undefined && /^[A-Za-z0-9.[\]:-]{0,80}$/.test(cdp) ? { cdp } : {}),
    // The masked profile path: a home folder never shows (a path that still starts with "/Users/" or a drive's Users folder is dropped).
    ...(seen !== undefined && !/^\/(Users|home)\/|^[A-Za-z]:\\Users\\/i.test(seen) ? { profile_seen: seen } : {}),
    ...(typeof o.reconnected === "boolean" ? { reconnected: o.reconnected } : {}),
    ...(o.opens !== undefined ? { opens: n(o.opens, 9) } : {}),
  };
}

/** Every board's Details a run left in its control folder (a find-jobs run's record keeps them). */
export function readRunDiags(dir: string, boards: readonly BoardId[]): { board: BoardId; diag: SignInDiag }[] {
  const out: { board: BoardId; diag: SignInDiag }[] = [];
  for (const board of boards) {
    const dg = readDiag(readJson(path.join(dir, `diag-${board}.json`)));
    if (dg) out.push({ board, diag: dg });
  }
  return out;
}

/**
 * The run's budget of Chrome command-line calls, kept in its own folder: every jobcairn-chrome call is its own
 * process, so a count in memory would reset each time. Read and written under the run's command lock.
 */
export function fileBudget(dir: string): OpenBudget {
  const f = path.join(dir, "opens.json");
  const used = () => { const j = readJson(f) as { n?: unknown } | null; return typeof j?.n === "number" && Number.isFinite(j.n) ? Math.max(0, Math.min(99, Math.round(j.n))) : 0; };
  return { used, use: () => writeRunFile(dir, "opens.json", { n: used() + 1 }) };
}

/**
 * The installed command: a tiny shell script that runs JobCairn's own bundled code with the workspace fixed in
 * it (Claude can't point it elsewhere). `node` is the runtime (Electron run as Node), `entry` the bundled file.
 */
export function cliScript(o: { node: string; entry: string; env?: Record<string, string>; root: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const env = Object.entries(o.env ?? {}).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k)).map(([k, v]) => `${k}=${q(v)} `).join("");
  return `#!/bin/sh\n# ${CLI_NAME}: ${identity.name}'s browser command for Claude (installed by ${identity.name}; changes are overwritten).\nexec env ${env}${q(o.node)} ${q(o.entry)} chrome --workspace ${q(o.root)} "$@"\n`;
}

/** Installs (or refreshes) the command in a workspace: `.careeros/bin/jobcairn-chrome`, owner-run only. Idempotent. */
export function installChromeCli(root: string, launch: { command: string; args: readonly string[]; env?: Record<string, string> }): string {
  const entry = launch.args[0];
  if (!entry || !path.isAbsolute(launch.command) || !path.isAbsolute(entry)) throw new Error("The browser command can't be installed: the app's runtime wasn't found.");
  const file = path.join(root, CLI_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const want = cliScript({ node: launch.command, entry, env: launch.env, root });
  let have = "";
  try { have = fs.readFileSync(file, "utf8"); } catch { have = ""; }
  if (have !== want) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, want, { mode: 0o700 });
    fs.renameSync(tmp, file);
  }
  fs.chmodSync(file, 0o700);
  return file;
}
