import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import type { SignInDiag } from "@careeros/contract";
import type { HelperRun } from "./helper.js";

/**
 * Opening the app's tabs in the Chrome profile the person job-searches in, and proving it.
 *
 * Facts from the person's real Chrome (agent-browser 0.38.2, Chrome's "Allow remote debugging for this browser
 * instance" mode, 2026-10-11): the helper's session must be attached to that Chrome (helper.ts checkAttached; a
 * session that isn't silently drives a browser the helper launched, in a temporary profile). The helper sees and drives only tabs its own session opened, and its `tab new`
 * lands in the Chrome window used last, whatever its profile. A tab opened any other way (Chrome's command line)
 * can't be adopted, and Chrome's HTTP target list isn't served in this mode. So the app:
 *  1. opens its own tab with `tab new` on chrome://version, which names the profile folder the tab belongs to;
 *  2. reads that page and checks the folder is the chosen one (by the path's last part, never the translated
 *     "Profile Path" label). Only the profile path is kept for Details, masked (home as "~"); the command line
 *     and the rest of the page are never kept, logged or returned;
 *  3. on a mismatch closes that tab, brings the chosen profile's window to the front with Chrome's own command
 *     program (`--profile-directory=<dir>` plus a self-closing local page, see chromeLaunch), waits, and tries
 *     once more. Every tab open may switch once: the window the person clicked last never decides where a later
 *     search lands (on 11 Oct a run's second search failed because its one switch was spent on the first);
 *  4. only a tab that passed is used: the caller sends it to the board. Nothing ever falls back to another
 *     window or profile.
 *
 * The profile list comes from Chrome's `Local State` file, and only `profile.info_cache[<dir>].name` and
 * `profile.last_used` are read from it. Nothing else in it, and no other file in Chrome's folder (cookies,
 * history, preferences), is ever read.
 */

export interface ChromeProfile { dir: string; name: string }
export interface ChromeProfiles { profiles: ChromeProfile[]; lastUsed: string }

/** The page that names a tab's profile folder. */
export const VERSION_PAGE = "chrome://version";
/** How long Chrome gets to bring the chosen profile's window to the front before the second try. */
export const FOCUS_WAIT_MS = 1_500;
const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A profile folder name as Chrome makes them ("Default", "Profile 2", "Guest Profile"): letters, digits, spaces,
 * dots, dashes, underscores and brackets only, never a path, never starting with "-" or ".", at most 64 characters.
 */
const PROFILE_DIR = /^[A-Za-z0-9_()][A-Za-z0-9 _.()-]{0,63}$/;
export function profileDirShape(dir: unknown): dir is string {
  return typeof dir === "string" && PROFILE_DIR.test(dir) && !dir.includes("..") && dir.trim() === dir;
}

/** A chosen folder is used only when it is shaped like one and Chrome's own list has it. */
export function validProfileDir(dir: unknown, profiles: readonly ChromeProfile[]): dir is string {
  return profileDirShape(dir) && profiles.some((p) => p.dir === dir);
}

/** Where Chrome keeps its `Local State` file (its profile list), per platform. Null when unknown. */
export function localStatePath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string | null {
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "Google", "Chrome", "Local State");
  if (platform === "win32") return env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "Google", "Chrome", "User Data", "Local State") : null;
  if (platform === "linux") return path.posix.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, ".config"), "google-chrome", "Local State");
  return null;
}

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * The profile list from Local State's text: each `profile.info_cache` key (the folder) with its `name` (what Chrome
 * shows), plus `profile.last_used`. Every other field (emails, avatars, account ids) is left alone.
 */
export function parseLocalState(raw: string): ChromeProfiles {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return { profiles: [], lastUsed: "" }; }
  const profile = j && typeof j === "object" ? (j as { profile?: unknown }).profile : null;
  if (!profile || typeof profile !== "object") return { profiles: [], lastUsed: "" };
  const cache = (profile as { info_cache?: unknown }).info_cache;
  const profiles: ChromeProfile[] = [];
  if (cache && typeof cache === "object" && !Array.isArray(cache)) {
    for (const [dir, entry] of Object.entries(cache as Record<string, unknown>)) {
      if (!profileDirShape(dir) || !entry || typeof entry !== "object") continue;
      const raw = (entry as { name?: unknown }).name;
      const name = typeof raw === "string" ? raw.replace(CTRL, "").trim().slice(0, 80) : "";
      profiles.push({ dir, name: name || dir });
    }
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
  const lu = (profile as { last_used?: unknown }).last_used;
  const lastUsed = typeof lu === "string" && profiles.some((p) => p.dir === lu) ? lu : "";
  return { profiles: profiles.slice(0, 50), lastUsed };
}

/** Reads that one file (capped at 4 MB). A missing or unreadable file is an empty list. */
export function readChromeProfiles(file: string | null | undefined, read: (f: string) => string = (f) => {
  const st = fs.statSync(f);
  if (!st.isFile() || st.size > 4 * 1024 * 1024) throw new Error("not a Local State file");
  return fs.readFileSync(f, "utf8");
}): ChromeProfiles {
  if (!file || !path.isAbsolute(file) || path.basename(file) !== "Local State") return { profiles: [], lastUsed: "" };
  try { return parseLocalState(read(file)); } catch { return { profiles: [], lastUsed: "" }; }
}

/**
 * How long the switch page stays open. It must outlive the wait before the retry (FOCUS_WAIT_MS) with room to spare:
 * when the profile has no window open, the page's window is the only one, and if it closed first the window used
 * last would be the other profile again and the retry's tab would land there too.
 */
export const FOCUS_PAGE_CLOSE_MS = 15_000;
/**
 * A small, self-contained page Chrome shows while the app brings it forward: the app's colours (light or dark, as
 * the system is), no scripts or fonts from anywhere else, and it closes itself after `closeMs`.
 * PRIVACY: fixed text only, never the person's data.
 */
export function infoPage(o: { title: string; heading: string; lead: string; steps: string[]; foot: string; closeMs: number }): string {
  const css = [
    ":root{color-scheme:light dark;--bg:#f6f2ea;--card:#fffdf8;--text:#1d1b18;--muted:#6b665d;--line:#e5dfd3;--accent:#c2552d;--soft:#f3e1d6}",
    "@media (prefers-color-scheme:dark){:root{--bg:#0e0f11;--card:#17181b;--text:#ecebe7;--muted:#9a978f;--line:#2a2b2f;--accent:#e8a35c;--soft:#2d2219}}",
    "*{box-sizing:border-box}html,body{height:100%;margin:0}",
    "body{display:grid;place-items:center;padding:32px;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}",
    "main{width:min(560px,100%);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 36px;box-shadow:0 10px 30px rgba(0,0,0,.08)}",
    ".brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.01em;color:var(--muted)}",
    ".mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#f2c46d,#e07a4f 55%,#7fb59a)}",
    "h1{font:500 26px/1.2 Georgia,'Times New Roman',serif;margin:20px 0 8px}",
    ".lead{margin:0 0 20px;color:var(--muted)}",
    "ol{list-style:none;margin:0;padding:0;display:grid;gap:12px}",
    "li{display:grid;grid-template-columns:28px 1fr;gap:12px;align-items:start}",
    ".n{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--soft);color:var(--accent);font-weight:600;font-size:13px}",
    "b{color:var(--text)}",
    "footer{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}",
  ].join("");
  const steps = o.steps.map((t, i) => `<li><span class="n">${i + 1}</span><span>${t}</span></li>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${o.title}</title><style>${css}</style>` +
    `<main><div class="brand"><span class="mark" aria-hidden="true"></span>${identity.name}</div><h1>${o.heading}</h1><p class="lead">${o.lead}</p><ol>${steps}</ol><footer>${o.foot}</footer></main>` +
    `<script>setTimeout(function(){window.close()},${o.closeMs})</script></html>\n`;
}

/**
 * A tiny local page that closes itself: the address handed to Chrome's own program so it switches profile.
 * PRIVACY: fixed text, no person's data; written to the temp folder each time (cheap, and survives temp cleanups).
 */
export const FOCUS_PAGE_HTML = infoPage({
  title: "Switching profile", heading: "Switching to your job-search profile", lead: `${identity.name} is bringing your job-search Chrome profile to the front.`,
  steps: ["Nothing to do here. Chrome switches by itself."], foot: "This tab closes itself.", closeMs: FOCUS_PAGE_CLOSE_MS,
});
export function focusPageUrl(dir = os.tmpdir()): string {
  const file = path.join(dir, "jobcairn-switch-profile.html");
  try { fs.writeFileSync(file, FOCUS_PAGE_HTML, { mode: 0o644 }); } catch { /* an old copy still works */ }
  return pathToFileURL(file).href;
}

/**
 * Chrome's own command line for "switch to that profile": Chrome's program with `--profile-directory=<dir>` and a
 * local page that closes itself (focusPageUrl). With Chrome already running, the program hands the address to it,
 * which opens it in a window of that profile and makes that window the active one, so the helper's next tab lands
 * there. No new browser starts and, when the profile has a window, no window is added; the page closes itself.
 *
 * Proven on the owner's Chrome (2026-10-11): after this call with "Default" the helper's new tab showed the
 * Default profile in chrome://version, and after it with "Profile 6" it showed Profile 6. What didn't work:
 * `open -na ... --profile-directory=<dir>` with no address (a new empty window every call), and
 * `open -a "Google Chrome" --args ...` without -n (open(1) drops the flag for a running Chrome: the tab stayed in
 * the other profile). Null when the folder isn't valid or there is no absolute program path.
 */
/** Chrome's program where macOS installs it, used when the profile setup didn't record one. */
export const MAC_CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function chromeLaunch(o: { platform: NodeJS.Platform; chromeBin: string | null; dir: string; focusUrl?: string }): { cmd: string; args: string[] } | null {
  if (!profileDirShape(o.dir)) return null;
  const bin = o.chromeBin || (o.platform === "darwin" ? MAC_CHROME_BIN : null);
  if (!bin || (!path.isAbsolute(bin) && !path.win32.isAbsolute(bin))) return null;
  return { cmd: bin, args: [`--profile-directory=${o.dir}`, ...(o.focusUrl ? [o.focusUrl] : [])] };
}

/** Starts a program and doesn't wait for it: array arguments, no shell. True once it started. */
export type Launch = (cmd: string, args: string[]) => Promise<boolean>;

/** The real launcher: detached, no shell, no output kept, the person's environment untouched. */
export const spawnLaunch: Launch = (cmd, args) => new Promise((resolve) => {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: false, windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  } catch { resolve(false); }
});

/**
 * The page Chrome shows in the chosen profile when a search starts, so the person sees that window and Chrome's
 * "Allow remote debugging?" prompt over it. It closes itself after two minutes (the app's connect waits as long).
 * PRIVACY: fixed text, no person's data.
 */
export const START_PAGE_HTML = infoPage({
  title: `${identity.name} search`, heading: "Starting your job search in Chrome", lead: `${identity.name} is about to open job sites in this Chrome profile, where you're already signed in.`,
  steps: [
    "If Chrome asks <b>“Allow remote debugging?”</b>, click <b>Allow</b>. That lets " + identity.name + " open and read job ads in tabs it opens.",
    "Job sites open in new tabs. You can keep using Chrome; please leave those tabs open until the search finishes.",
    identity.name + " only reads job ads. It never applies, posts or messages anyone, and you can stop the search in " + identity.name + " at any time.",
  ],
  foot: "This tab closes itself in two minutes.", closeMs: 120000,
});
export function startPageUrl(dir = os.tmpdir()): string {
  const file = path.join(dir, "jobcairn-search-start.html");
  try { fs.writeFileSync(file, START_PAGE_HTML, { mode: 0o644 }); } catch { /* an old copy still works */ }
  return pathToFileURL(file).href;
}

/** macOS's program that brings an app to the front (and starts it when it isn't running). */
export const MAC_OPEN = "/usr/bin/open";

/**
 * Brings Chrome to the front, in the chosen profile, before the app connects: Chrome's "Allow remote debugging?"
 * prompt then shows where the person is looking, not behind other windows. Starts Chrome when it isn't running.
 * - a profile folder (already checked against Chrome's list): Chrome's own program with `--profile-directory` and
 *   the start page (startPageUrl), which opens it in a window of that profile and makes that the active window;
 * - on macOS, then `open -a "Google Chrome"` (no arguments; open(1) drops `--args` for a running Chrome), after a
 *   short wait so a Chrome that is still starting isn't started twice. Running the program alone may not make Chrome
 *   the front app.
 * - no profile: only that `open -a` on macOS; elsewhere nothing (the program alone would add a window).
 * Never connects to Chrome and never touches a tab. True when anything was started.
 */
export async function bringChromeForward(o: { launch: Launch; platform: NodeJS.Platform; chromeBin: string | null; dir: string; sleep(ms: number): Promise<void>; waitMs?: number; startUrl?: () => string }): Promise<boolean> {
  let started = false;
  const how = o.dir ? chromeLaunch({ platform: o.platform, chromeBin: o.chromeBin, dir: o.dir, focusUrl: (o.startUrl ?? startPageUrl)() }) : null;
  if (how) {
    try { started = await o.launch(how.cmd, how.args); } catch { started = false; }
  }
  if (o.platform === "darwin") {
    if (started) await o.sleep(o.waitMs ?? FOCUS_WAIT_MS);
    try { started = (await o.launch(MAC_OPEN, ["-a", "Google Chrome"])) || started; } catch { /* the profile's window still came forward, or nothing did */ }
  }
  return started;
}

/**
 * A count of the times a run (or one sign-in check) called Chrome's command line, for Details only: it never stops
 * a switch. `used` reads the count so far, `use` adds one. The browser command keeps it in the run's own folder,
 * because every command is its own process. What bounds the calls is one switch per tab open, and a run's caps on
 * pages and actions bound the tab opens (session.ts).
 */
export interface OpenBudget { used(): number; use(): void }

/** An in-memory budget (one sign-in check, one "Add a job"). */
export function memoryBudget(): OpenBudget { let n = 0; return { used: () => n, use: () => { n++; } }; }

export interface VerifyDeps {
  launch: Launch;
  platform: NodeJS.Platform;
  chromeBin: string | null;
  sleep(ms: number): Promise<void>;
  now(): number;
  focusWaitMs?: number;
  /** The self-closing page's address (default: written to the temp folder). */
  focusUrl?: () => string;
  /** The run's count of Chrome command-line calls, for Details (default: a fresh one). */
  opens?: OpenBudget;
  /** The person's home folder, masked as "~" in the profile path kept for Details. */
  home?: string;
}

/**
 * What happened: "ok"; "bad_profile" the folder isn't in Chrome's list (nothing opened); "no_tab" the helper
 * couldn't open a tab; "wrong_profile" the tab was in another profile (closed each time); "no_launch" it was
 * in another profile and Chrome's command line didn't start; "not_attached" the helper isn't driving the person's Chrome.
 */
export type VerifyOutcome = "ok" | "bad_profile" | "no_tab" | "wrong_profile" | "no_launch" | "not_attached";
/**
 * Internal facts about one attempt, for the "Details" disclosure. `profile_seen`: the profile path chrome://version
 * showed for the app's tab, with the home folder as "~" and temporary folders as "<temp>" (so a tab in a browser the
 * helper launched shows as such). `opens`: Chrome command-line calls this attempt made. Never an address, a title or
 * another tab's id.
 */
export interface VerifyDiag { profile_dir: string; outcome: VerifyOutcome; launched: boolean; tries: number; ms: number; profile_seen: string; opens: number }
export interface VerifyResult { target: string | null; diag: VerifyDiag }

/**
 * True when chrome://version's text names this profile folder: one line ends with `/<dir>` (or `\<dir>` on
 * Windows), the "Profile Path" value. A folder name is matched whole ("Profile 2" never matches "Profile 21").
 * PRIVACY: the text holds the person's home folder and Chrome's command line; only this yes or no leaves here.
 */
export function profileMatches(text: unknown, dir: string): boolean {
  if (typeof text !== "string" || !profileDirShape(dir)) return false;
  return text.split(/\r?\n/).some((l) => { const t = l.trim(); return t.endsWith(`/${dir}`) || t.endsWith(`\\${dir}`); });
}

// eslint-disable-next-line no-control-regex
const CTRL_ALL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * The profile path chrome://version shows, masked for Details: the home folder becomes "~", a temporary folder
 * (macOS /var/folders/.../T, /tmp, Windows Temp) becomes "<temp>". "" when no line looks like one. Only the
 * "Profile Path" value is taken (by its label, else the last plain folder path that isn't Chrome's own program);
 * the command line and executable are never kept.
 */
export function seenProfilePath(text: unknown, home = ""): string {
  if (typeof text !== "string") return "";
  const rows = text.split(/\r?\n/).map((l) => { const i = l.indexOf("\t"); return i < 0 ? null : { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() }; })
    .filter((r): r is { label: string; value: string } => !!r && (r.value.startsWith("/") || /^[A-Za-z]:\\/.test(r.value)));
  const plain = rows.filter((r) => !/\s--?[a-z]/i.test(r.value) && !/\/MacOS\/[^/]+$|\.exe$|\/(google-)?chrome(-stable)?$/i.test(r.value));
  const pick = plain.find((r) => /profile/i.test(r.label)) ?? plain.at(-1);
  if (!pick) return "";
  let v = pick.value.replace(CTRL_ALL, "");
  const h = home.replace(/[\\/]+$/, "");
  if (h && (v === h || v.startsWith(`${h}/`) || v.startsWith(`${h}\\`))) v = `~${v.slice(h.length)}`;
  v = v.replace(/^(\/private)?\/var\/folders\/[^/]+\/[^/]+\/T(?=\/|$)/, "<temp>").replace(/^\/tmp(?=\/|$)/, "<temp>")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp(?=\\|$)/i, "<temp>");
  // Any other home folder too (the person's name is in it): /Users/<name>, /home/<name>, C:\\Users\\<name>.
  v = v.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, "~");
  return v.length > 160 ? `…${v.slice(-159)}` : v;
}

/**
 * Opens the app's own tab (labelled `label`) in the chosen profile and checks it really is there (see the top of
 * this file). Run inside `helper.session` (the caller holds the lock and has checked the session is attached to the
 * person's Chrome). On "ok" the session is bound to the tab, which still shows chrome://version: the caller opens the
 * board in it. Any other outcome leaves no tab behind and never opens one anywhere else. Chrome's command line is
 * used at most once per call, with a page that closes itself, so a run never piles up windows.
 */
/** The helper's answer when a tab label is still in use. */
const LABEL_TAKEN = /label .* is already used|labels must be unique/i;

export async function openVerifiedTab(run: HelperRun, dir: string, profiles: readonly ChromeProfile[], label: string, d: VerifyDeps): Promise<VerifyResult> {
  const t0 = d.now();
  const opens = d.opens ?? memoryBudget();
  const diag: VerifyDiag = { profile_dir: profileDirShape(dir) ? dir : "", outcome: "bad_profile", launched: false, tries: 0, ms: 0, profile_seen: "", opens: 0 };
  const done = (target: string | null, outcome: VerifyOutcome): VerifyResult => ({ target, diag: { ...diag, outcome, ms: Math.max(0, d.now() - t0) } });
  if (!validProfileDir(dir, profiles)) return done(null, "bad_profile");
  for (let attempt = 0; attempt < 2; attempt++) {
    diag.tries++;
    let r = await run(["tab", "new", "--label", label, VERSION_PAGE]);
    // A tab left over under this label (an earlier command of the run that lost track of it) makes the helper refuse
    // a new one ("labels must be unique"): close that tab, which is only ever the app's own, and open it again.
    if (!r.ok && LABEL_TAKEN.test(String(r.err ?? ""))) {
      await run(["tab", "close", label]);
      r = await run(["tab", "new", "--label", label, VERSION_PAGE]);
    }
    if (r.code === "launched" || r.code === "not_attached") return done(null, "not_attached");
    const target = typeof r.data?.targetId === "string" && TARGET_ID.test(r.data.targetId) ? r.data.targetId : "";
    if (!r.ok || !target) return done(null, "no_tab");
    const page = await run(["get", "text", "body"]);
    diag.profile_seen = page.ok ? seenProfilePath(page.data?.text, d.home) : "";
    if (page.ok && profileMatches(page.data?.text, dir)) return done(target, "ok");
    await run(["tab", "close", target]);
    if (attempt === 1) break;
    // The tab landed in another profile's window (the person clicked a window of another profile since the last
    // tab). Bring the chosen profile's window to the front with the self-closing page, then try once more.
    const how = chromeLaunch({ platform: d.platform, chromeBin: d.chromeBin, dir, focusUrl: (d.focusUrl ?? focusPageUrl)() });
    let started = false;
    if (how) {
      opens.use();
      diag.opens++;
      try { started = await d.launch(how.cmd, how.args); } catch { started = false; }
    }
    if (!started) return done(null, "no_launch");
    diag.launched = true;
    await d.sleep(d.focusWaitMs ?? FOCUS_WAIT_MS);
  }
  return done(null, "wrong_profile");
}

/** How `openOwnTab` went: the tab's target id, how it was opened (for Details), and why not when it wasn't. */
export interface OwnTab { target: string | null; diag: SignInDiag; failed: "" | "profile" | "tab" | "open" }

/**
 * The app's one way to open its own tab on a board page, for Show tab, Add a job's ad reading and the
 * jobcairn-chrome runs alike (the runs reach the same openVerifiedTab through BrowserRun's profileTab):
 * - a profile chosen: a tab proven on chrome://version to be in that profile (openVerifiedTab), then the page
 *   opened in it. If it can't be proven ("profile"), nothing opens anywhere: never the window used last. `deps`
 *   null (no Local State or launcher on this computer) counts as "can't be proven";
 * - no profile chosen: `tab new` with the page, in the window used last, which is what "no profile" means.
 * Run inside `helper.session` (the caller holds the lock). The caller closes the tab when it's done with it.
 */
export async function openOwnTab(run: HelperRun, url: string, o: { dir: string; profiles: readonly ChromeProfile[]; label: string; deps: VerifyDeps | null }): Promise<OwnTab> {
  if (o.dir) {
    const v: VerifyResult = o.deps
      ? await openVerifiedTab(run, o.dir, o.profiles, o.label, o.deps)
      : { target: null, diag: { profile_dir: profileDirShape(o.dir) ? o.dir : "", outcome: "bad_profile", launched: false, tries: 0, ms: 0, profile_seen: "", opens: 0 } };
    const diag: SignInDiag = { mode: "profile", ...v.diag };
    if (!v.target) return { target: null, diag, failed: "profile" };
    if (!(await run(["open", url])).ok) { await run(["tab", "close", v.target]); return { target: null, diag, failed: "open" }; }
    return { target: v.target, diag, failed: "" };
  }
  const diag: SignInDiag = { mode: "last_window", profile_dir: "", outcome: "ok", launched: false, tries: 1, ms: 0, opens: 0 };
  const r = await run(["tab", "new", "--label", o.label, url]);
  const target = typeof r.data?.targetId === "string" && TARGET_ID.test(r.data.targetId) ? r.data.targetId : "";
  if (!r.ok || !target) return { target: null, diag, failed: "tab" };
  return { target, diag, failed: "" };
}
