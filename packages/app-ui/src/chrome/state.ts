import { PRODUCT_NAME } from "@careeros/brand";
import { BOARD_NAMES, sortBoardIds, type BoardId, type BoardRunProgress, type ChromeSearchState, type WebReason } from "@careeros/contract";

/**
 * "Search in my Chrome" setup, as plain steps (lane S). Pure, so the card's state machine is tested without a
 * browser. Copy rule: friendly words ("browser helper", "Chrome's remote control"); the helper's own name appears
 * once, where the person decides to install it, so they know exactly what goes on their computer.
 */
export type ChromeStep = "unavailable" | "chrome" | "helper" | "remote" | "connect" | "boards";
export const STEP_ORDER: readonly ChromeStep[] = ["chrome", "helper", "remote", "connect", "boards"];

/** The first step that isn't done. "boards" means everything before it is done. */
export function chromeSetupStep(s: ChromeSearchState): ChromeStep {
  if (!s.available) return "unavailable";
  if (!s.chrome.found) return "chrome";
  if (!s.helper.found) return "helper";
  if (!s.remote.on) return "remote";
  if (!s.connected) return "connect";
  return "boards";
}

export type StepState = "done" | "current" | "blocked";

export function stepState(step: ChromeStep, next: ChromeStep): StepState {
  if (next === "unavailable") return "blocked";
  const a = STEP_ORDER.indexOf(step), b = STEP_ORDER.indexOf(next);
  return a < b ? "done" : a === b ? "current" : "blocked";
}

/**
 * Why Turn on is disabled, or "" when it can be pressed. Setup turns itself on when it connects (step 4), so Turn
 * on is for a workspace that was set up before, or turned off: it needs the helper and a ticked board, not a live
 * connection (a run reconnects when it starts).
 */
export function finishBlocked(s: ChromeSearchState, ticked: readonly BoardId[]): string {
  if (!s.available) return COPY.unavailable;
  if (!s.chrome.found || !s.helper.found) return "Finish steps 1 and 2 above first.";
  if (!ticked.length) return "Tick at least one job board above.";
  return "";
}

/** Plain words for why a find-jobs run searches the web instead of the person's Chrome. */
export function webReasonText(r: WebReason | ""): string {
  switch (r) {
    case "unavailable": return "Search in my Chrome isn't available in this copy of the app";
    case "off": return "Search in my Chrome is off";
    case "no_helper": return "the browser helper isn't installed";
    case "remote_off": return "Chrome's remote control is off";
    case "connect_failed": return "Chrome didn't let the app connect";
    case "busy": return "another search is using your Chrome";
    case "no_boards": return "no job boards are ticked";
    default: return "Search in my Chrome isn't set up";
  }
}

/** What the person can do about it, from the composer or the run strip. */
export type ModeFix = "turn_on" | "connect" | "remote" | "set_up" | null;
const FIX_FOR: Record<WebReason, ModeFix> = {
  unavailable: null, not_set_up: "set_up", off: "turn_on", no_helper: "set_up", remote_off: "remote", connect_failed: "connect", busy: null, no_boards: "set_up",
};
export const FIX_LABEL: Record<Exclude<ModeFix, null>, string> = {
  turn_on: "Turn on", connect: "Connect Chrome", remote: "Remote control", set_up: "Chrome setup",
};

export interface SearchModeLine {
  mode: "chrome" | "web";
  /** One sentence for the composer ("Searching in your Chrome: LinkedIn, SEEK" or "Searching the web (…)"). */
  text: string;
  /** A second line, or "" ("Chrome may ask you to Allow"). */
  hint: string;
  reason: WebReason | "";
  fix: ModeFix;
  /** The boards a Chrome run would search, in the one board order. */
  boards: BoardId[];
}

const names = (ids: readonly BoardId[]) => sortBoardIds(ids).map((b) => BOARD_NAMES[b]).join(", ");

/** "Searching the web (Chrome's remote control is off)." */
export const webLine = (r: WebReason | "") => `Searching the web (${webReasonText(r)}).`;

/**
 * Which way the next find-jobs run will search, before it starts, so it's never a surprise. Turned on but not
 * connected (after a restart) still means Chrome: the run reconnects when it starts, and Chrome may ask to Allow.
 */
export function searchModeLine(s: ChromeSearchState): SearchModeLine {
  const boards = sortBoardIds(s.settings.boards);
  const web = (reason: WebReason, hint = ""): SearchModeLine => ({ mode: "web", text: webLine(reason), hint, reason, fix: FIX_FOR[reason], boards: [] });
  if (!s.available) return web("unavailable");
  if (!s.settings.enabled) {
    if (s.offer_turn_on || (s.settings.set_up_at && s.helper.found)) return web("off", s.offer_turn_on ? "You set it up earlier but it was never turned on. Turn it on to search your signed-in job boards." : "");
    return web("not_set_up", "Job boards show more when you're signed in. Set it up once to search them in your own Chrome.");
  }
  if (!s.helper.found) return web("no_helper");
  if (!s.remote.on) return web("remote_off", "Turn it on in Chrome, then come back.");
  if (!boards.length) return web("no_boards");
  const text = `Searching in your Chrome: ${names(boards)}.`;
  if (!s.ready) return { mode: "chrome", text, hint: "Chrome isn't connected yet, so the app connects when you start. Chrome may ask you to Allow.", reason: "", fix: null, boards };
  return { mode: "chrome", text, hint: "", reason: "", fix: null, boards };
}

/** The short "why your Chrome" line; the same words open the helper's install confirm and the tour step. */
export const WHY_CHROME_SHORT = "Job sites block scrapers and hide details until you sign in. So Claude browses in your own Chrome, signed in as you, slowly and read-only, while you watch.";

export const COPY = {
  title: "Search in my Chrome",
  whyTitle: "Why your Chrome?",
  why: [
    "Job sites block automated scrapers, and many hide jobs, salaries and details until you sign in.",
    `So instead of scraping like a bot, ${PRODUCT_NAME} asks Claude to browse the way you would: in your own Chrome, signed in as you, one page at a time, slowly. You can watch every tab it opens.`,
  ],
  can: ["Open job boards in new tabs", "Search them", "Read the listings", "Close its own tabs"],
  never: ["Touch your other tabs", "Sign in for you or type passwords", "Apply, save or message anyone", "Read your messages"],
  tos: `Job sites limit automated browsing. ${PRODUCT_NAME} searches slowly and only reads. Heavy use could still get an account checked.`,
  unavailable: `Search in my Chrome isn't available in this copy of ${PRODUCT_NAME}.`,
  turnOffHint: "You can turn off remote control in Chrome any time.",
  remoteHow: "Turn on 'Allow remote debugging for this browser instance', then come back.",
  remoteWaiting: "Waiting for Chrome's remote control…",
  /** Step 3 by hand, always shown: Chrome doesn't always open its own pages when another app asks. */
  remotePage: "chrome://inspect/#remote-debugging",
  remoteManualTitle: "Page didn't open? Do it yourself:",
  remoteManual: ["Paste this into Chrome's address bar and press Return.", "Tick 'Allow remote debugging for this browser instance'."],
  copyFailed: "Copying didn't work here. Select the address and copy it yourself.",
  connectHow: "Chrome will ask once. Click Allow.",
  /** Shown while a search starts in Chrome: the app brings Chrome to the front, and Chrome may ask to allow it. */
  allowHint: `Click Allow in Chrome to let ${PRODUCT_NAME} search.`,
  signInHow: `Sign in yourself in the tabs ${PRODUCT_NAME} opens. ${PRODUCT_NAME} never types your passwords.`,
  helperWhat: "The browser helper is agent-browser, a small open-source tool from Vercel that lets an app control Chrome tabs.",
  helperDoes: `${PRODUCT_NAME} uses it to open job boards in new tabs it owns, read the listings, and close them. It never types passwords, applies, messages or saves anything.`,
  helperWhere: (mb: number) => `About ${mb} MB, in ${PRODUCT_NAME}'s own folder; nothing else on your Mac changes. You can remove it here any time.`,
  signInWhy: "Searching works without signing in, but results are better when you are.",
  connectProfiles: "Use more than one Chrome profile? Click a window of the one you job-search in before you connect.",
  profileTitle: "Signed in, but it says you're not?",
  profileHow: `${PRODUCT_NAME} opens its tabs in the Chrome window you used last, which may be a different Chrome profile. Click a window of the profile you job-search in, then press Check again.`,
  profileLabel: "Which Chrome profile do you job-search in?",
  profileHelp: `${PRODUCT_NAME} opens its tabs in this profile's window, for this check and for every search.`,
  /** Who does the browsing, in plain words (the owner asked "does Claude do this?"). */
  whoBrowses: (profile: string) => `Claude does both the sign-in check and your job searches, using ${PRODUCT_NAME}'s browser tools, in your ${profile} Chrome profile. It only reads.`,
  checkWithClaude: "Check boards",
  checkHow: "Claude opens each ticked board in its own tab, looks at whether you're signed in, and closes the tab.",
  profileFailed: (name: string) => `Couldn't open a tab in ${name}, even after switching Chrome to it. Nothing was opened in any other profile. In Chrome, open a ${name} window (click the profile picture at the top right and pick ${name}), then press Check again.`,
  boardsLabel: "Where should we look?",
  boardsHelp: "Claude searches only the boards you tick, and never applies, saves or messages anyone.",
  fallback: "Claude will search the web. For better results, set up Search in my Chrome.",
  done: "Search in my Chrome is on.",
} as const;

/** "SEEK: 18 ads read" (or why it's waiting). */
export function boardLine(b: BoardRunProgress): string {
  const counts = `${b.ads_read} ${b.ads_read === 1 ? "ad" : "ads"} read`;
  switch (b.state) {
    case "waiting": return `${b.name}: waiting`;
    case "paused": return `${b.name}: needs you`;
    case "skipped": return `${b.name}: skipped`;
    case "done": return `${b.name}: done, ${counts}`;
    default: return `${b.name}: ${counts}`;
  }
}

/** The pause banner for one board. */
export function pauseText(b: BoardRunProgress): string {
  return b.reason === "login"
    ? `${b.name} needs you: sign in in Chrome, then press Continue.`
    : `${b.name} needs you: sign in or finish the check in Chrome, then press Continue.`;
}

export const boardName = (id: BoardId) => BOARD_NAMES[id];

type BoardRow = ChromeSearchState["boards"][number];

/** Plain words for what a board's last check saw. Never the page's address or its controls' names. */
export function signInReason(b: BoardRow): string {
  const { page, matched } = b.why;
  if (b.signed_in === "unchecked") return "";
  if (page === "no_tab") return "The tab didn't open in Chrome.";
  if (page === "profile_tab") return "Couldn't open a tab in your job-search profile, so nothing was read.";
  if (page === "elsewhere") return `The tab ${PRODUCT_NAME} opened didn't show ${b.name}.`;
  if (page === "login" || page === "authwall") return `${b.name} showed its sign-in page in the tab ${PRODUCT_NAME} opened.`;
  if (page === "checkpoint") return `${b.name} showed a security check. Finish it in Chrome, then check again.`;
  switch (matched) {
    case "account": return `${b.name} showed your account menu.`;
    case "hint": return `${b.name} showed links that usually appear only when you're signed in.`;
    case "sign_in": return `${b.name} showed a Sign in button in the tab ${PRODUCT_NAME} opened.`;
    case "none": return "The page loaded, but nothing on it showed whether you're signed in.";
    case "no_controls": return "Couldn't see the page's controls.";
    default: return "";
  }
}

export interface SignInRow {
  /** The short status. */
  label: string;
  tone: "success" | "warning" | "neutral";
  /** Why, in a sentence (may be ""). */
  reason: string;
  /** The person said signed in, and a later check saw them signed out. */
  contradicted: boolean;
  /** Show "I'm signed in": the check didn't see it and the person hasn't said so. */
  canConfirm: boolean;
}

/** One board's row in step 5. The person's word wins; a check that disagrees later is shown, never a silent flip. */
export function signInRow(b: BoardRow): SignInRow {
  const reason = signInReason(b);
  // Not read at all (no tab in the chosen profile): said even when the person confirmed, so it never hides.
  if (b.why.page === "profile_tab") return { label: "Not checked", tone: "warning", reason, contradicted: false, canConfirm: !b.confirmed_at };
  if (b.confirmed_at) {
    if (b.signed_in === "signed_out") {
      const what = b.why.page === "login" || b.why.page === "authwall" ? "the sign-in page" : "a Sign in button";
      return { label: "Check disagrees", tone: "warning", reason: `You said signed in; the tab shows ${what}.`, contradicted: true, canConfirm: false };
    }
    return { label: "Signed in (you said so)", tone: "success", reason: b.signed_in === "signed_in" ? reason : "", contradicted: false, canConfirm: false };
  }
  switch (b.signed_in) {
    case "signed_in": return { label: "Signed in", tone: "success", reason, contradicted: false, canConfirm: false };
    case "signed_out": return { label: "Not signed in", tone: "neutral", reason, contradicted: false, canConfirm: true };
    case "unknown": return { label: "Couldn't tell", tone: "neutral", reason, contradicted: false, canConfirm: true };
    case "not_loaded": return { label: "Couldn't check", tone: "neutral", reason: reason || "The page didn't finish loading.", contradicted: false, canConfirm: true };
    default: return { label: "Not checked yet", tone: "neutral", reason: "", contradicted: false, canConfirm: true };
  }
}

/**
 * The Details lines under a board: how its last tab was opened (from `diag`), in plain words. Shown under each board
 * in Settings and in a find-jobs run's Details. Only the browser's host and port, and the profile path with the home
 * folder as "~", ever show. Empty when the board has no diag yet.
 */
export function diagLines(d: BoardRow["diag"], profileName = ""): string[] {
  if (!d) return [];
  const out: string[] = [];
  if (d.cdp !== undefined) {
    out.push(d.cdp === "127.0.0.1:9222" || d.cdp === "localhost:9222"
      ? "Browser: your own Chrome (127.0.0.1:9222)."
      : `Browser: not your Chrome${d.cdp ? ` (${d.cdp})` : ""}. The helper was driving a browser of its own.`);
  }
  if (d.reconnected) out.push("The app had to reconnect to Chrome first.");
  if (d.mode === "last_window") out.push("No profile chosen, so the tab opened in the Chrome window used last.");
  else out.push(`Profile: ${profileName ? `${profileName} (folder "${d.profile_dir}")` : d.profile_dir ? `folder "${d.profile_dir}"` : "not in Chrome's list"}.`);
  if (d.profile_seen) out.push(`Profile the tab was in: ${d.profile_seen}`);
  switch (d.outcome) {
    case "ok": if (d.mode === "profile") out.push("The tab opened in that profile. The app checked chrome://version before the board loaded."); break;
    case "bad_profile": out.push("Chrome's list doesn't have that profile, so no tab opened. Pick the profile again."); break;
    case "no_tab": out.push("Chrome didn't open a tab."); break;
    case "wrong_profile": out.push("The tab opened in another profile, even after the app switched Chrome to this one. It was closed unread. Nothing was read in another profile."); break;
    case "no_launch": out.push("Chrome couldn't bring that profile's window forward."); break;
    case "not_attached": out.push("The helper wasn't connected to your Chrome, so no tab opened."); break;
    case "bot_check": out.push("The site asked for a security check, so this board stopped at once. Nothing reloaded the page."); break;
    case "tab_lost": out.push("The board's tab was lost twice, so this board stopped. Nothing reloaded the page."); break;
  }
  if (d.launched) out.push("The app brought the profile's window to the front for this tab.");
  if (d.opens !== undefined) out.push(`Window calls to Chrome: ${d.opens}.`);
  out.push(`Tries: ${d.tries}. Took ${(d.ms / 1000).toFixed(1)} s.`);
  return out;
}

/**
 * A board a find-jobs run stopped early, in plain words for the run card (not hidden in Chrome details): a security
 * check, a tab lost twice, or a tab that couldn't open in the chosen profile. Null for any other outcome. `profileName`
 * is the chosen profile as Chrome shows it ("" when unknown).
 */
export function stopLine(board: BoardId, d: BoardRow["diag"], profileName = ""): string | null {
  if (!d) return null;
  const name = BOARD_NAMES[board];
  const where = profileName ? `your ${profileName} window` : "Chrome";
  switch (d.outcome) {
    case "bot_check": return `${name} asked for a security check. Finish it in ${where}, then run again.`;
    case "tab_lost": return `${name} stopped early because its tab was lost. Check ${name} in ${where}, then run again.`;
    case "wrong_profile": return profileName
      ? `${name} couldn't open in your ${profileName} profile. Open a ${profileName} window in Chrome, then run again.`
      : `${name} couldn't open in the chosen Chrome profile. Open a window of that profile, then run again.`;
    default: return null;
  }
}

/** The profile the select shows: the chosen one, else the one Chrome used last, else the first. "" when none are known. */
export function shownProfile(s: ChromeSearchState): string {
  const dirs = (s.profiles ?? []).map((p) => p.dir);
  const chosen = s.settings?.profile_dir ?? "";
  if (chosen && dirs.includes(chosen)) return chosen;
  if (s.last_used_profile && dirs.includes(s.last_used_profile)) return s.last_used_profile;
  return dirs[0] ?? "";
}

/** The profile line's words: why the check may have read another profile, or "" for none. */
export function profileLine(s: ChromeSearchState): string {
  if (!profileHint(s)) return "";
  if (s.profile_failed) {
    const dir = s.settings?.profile_dir ?? "";
    return COPY.profileFailed((s.profiles ?? []).find((p) => p.dir === dir)?.name || "your job-search profile");
  }
  return COPY.profileHow;
}

/**
 * True when the check probably read a different Chrome profile from the one the person signs in with: no board
 * reads signed in, at least one reads signed out, and either the person said they're signed in somewhere or two
 * or more boards read signed out.
 */
export function profileHint(s: ChromeSearchState): boolean {
  if (s.profile_failed) return true;
  if (s.settings?.profile_dir) return false;
  const b = s.boards;
  if (b.some((x) => x.signed_in === "signed_in")) return false;
  const out = b.filter((x) => x.signed_in === "signed_out").length;
  return out >= 1 && (out >= 2 || b.some((x) => !!x.confirmed_at));
}
