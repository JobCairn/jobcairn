import { JOB_BOARDS } from "./job-boards.js";
import type { TerminalFix } from "./setup.js";

/**
 * "Search in my Chrome" (lane S): Claude searches the person's job boards in their own signed-in Chrome, in tabs
 * the app opens, so they can watch. Shared types and the ids of the boards a run may browse. Ids and names come
 * from the shared job board list (job-boards.ts); the hosts and pages a run may open, search addresses and the
 * signed-in checks live in main only (services/src/chrome/boards.ts).
 */

/** The boards Search in my Chrome can browse: a subset of JOB_BOARDS ids (checked by a contract test). */
export const BROWSABLE_BOARD_IDS = ["linkedin", "seek", "indeed", "glassdoor", "jora", "careerone", "workforce"] as const;
export const BOARD_IDS = BROWSABLE_BOARD_IDS;
export type BoardId = (typeof BROWSABLE_BOARD_IDS)[number];
/** The boards a Find recruiters run looks at in Chrome (among the ticked ones): where agencies advertise most. */
export const RECRUITER_BOARDS: readonly BoardId[] = Object.freeze(["seek", "indeed", "linkedin"] as BoardId[]);

/** On by default (AU). Later this can depend on the profile's country. */
export const DEFAULT_BOARDS: readonly BoardId[] = ["linkedin", "seek", "indeed", "glassdoor", "jora"];

export const BOARD_NAMES = Object.fromEntries(
  BROWSABLE_BOARD_IDS.map((id) => [id, JOB_BOARDS.find((b) => b.id === id)?.name ?? id]),
) as Record<BoardId, string>;

/** What `settings/search.json` keeps under `chrome` (schema-validated by the store). */
export interface ChromeSearchSettings {
  enabled: boolean; boards: BoardId[]; set_up_at: string;
  /** Boards the person said they're signed in to when the check couldn't tell, with when they said so. */
  confirmed?: Partial<Record<BoardId, string>>;
  /**
   * The Chrome profile folder the person job-searches in ("Default", "Profile 2"), from Chrome's own profile list.
   * The app opens its tabs there. Absent or "": the window used last.
   */
  profile_dir?: string;
}

/** One Chrome profile: its folder and the name Chrome shows for it. Nothing else is read about it. */
export interface ChromeProfileChoice { dir: string; name: string }

/** "not_loaded": the board's page never showed any controls (slow, or a check page); "unknown": it did, but said neither. */
export type BoardSignIn = "signed_in" | "signed_out" | "unknown" | "not_loaded" | "unchecked";

/**
 * Where the setup tab ended up, from its final address's path only (never the query, never shown raw):
 * "feed" a page only signed-in people get (LinkedIn's feed); "login" the board's sign-in page; "authwall" a
 * "sign in to see more" wall; "checkpoint" a security or "is it you?" check; "board" any other page of the
 * board; "elsewhere" the tab never showed the board; "no_tab" the tab didn't open; "profile_tab" a tab couldn't
 * be opened in the chosen Chrome profile, so nothing was read (no other profile is ever used instead); "" not checked.
 */
export type SignInPage = "feed" | "login" | "authwall" | "checkpoint" | "board" | "elsewhere" | "no_tab" | "profile_tab" | "";
/**
 * Which kind of control decided it (a category, never the control's own name, which can hold the person's name):
 * "account" an account menu, avatar, Sign out or the board's own signed-in nav; "hint" a weaker signed-in hint
 * (a Profile link); "sign_in" a Sign in or Join control; "none" controls, but none of these; "no_controls" the
 * page showed no controls at all; "" not checked, or decided by the address alone.
 */
export type SignInMatch = "account" | "hint" | "sign_in" | "none" | "no_controls" | "";
export interface SignInWhy { page: SignInPage; matched: SignInMatch }

/**
 * Internal facts about how a board's tab was opened, for a "Details" disclosure (so a real failure can be
 * explained). Never an address, a title or another tab's id. `mode`: "profile" opened and checked in the
 * chosen profile, "last_window" no profile chosen, so the window used last. `outcome`: "ok", "bad_profile" the
 * folder isn't in Chrome's list, "no_tab" no tab opened, "wrong_profile" the tab was in another profile,
 * "no_launch" Chrome's command line didn't start, "not_attached" the helper wasn't driving the person's Chrome,
 * "bot_check" the board showed a CAPTCHA or security check, so it stopped at once, "tab_lost" the board's tab
 * couldn't be found again, so it stopped. `launched`: the profile's window was brought to the front once.
 *
 * Added after the owner's 11 Oct run (all optional, older records lack them): `cdp` the browser the helper drove,
 * as "host:port" only ("127.0.0.1:9222" is the person's Chrome; any other port is a browser the helper launched);
 * `profile_seen` the profile path chrome://version showed for the tab, home folder as "~", temporary folders as
 * "<temp>"; `reconnected` the app had to reconnect the helper to Chrome first; `opens` Chrome command-line calls made.
 */
export interface SignInDiag {
  mode: "profile" | "last_window";
  profile_dir: string;
  outcome: "ok" | "bad_profile" | "no_tab" | "wrong_profile" | "no_launch" | "not_attached" | "bot_check" | "tab_lost";
  launched: boolean;
  tries: number;
  ms: number;
  cdp?: string;
  profile_seen?: string;
  reconnected?: boolean;
  opens?: number;
}

/** One board's Details in a find-jobs run record (how its tab was opened). */
export interface BoardRunDiag { board: BoardId; diag: SignInDiag }

export interface ChromeSearchState {
  /** False when this copy of the app can't drive Chrome (no main-process host, for example the preview). */
  available: boolean;
  chrome: { found: boolean };
  helper: {
    found: boolean; version: string; min_version: string; too_old: boolean; installing: boolean; can_install: boolean;
    /** Disk space the install takes, in MB (from the pinned package's published size). */
    size_mb: number;
    /** The helper found is the app's own copy, so Remove helper can delete it (a copy installed elsewhere isn't ours). */
    can_remove: boolean;
    /** The last install failed: the commands to run in Terminal instead. Cleared when the next install starts. */
    fix?: TerminalFix | null;
  };
  /** Chrome's remote control (the switch at chrome://inspect) is on and answering. */
  remote: { on: boolean };
  /** The app's one connection to Chrome is open. */
  connected: boolean;
  /** One entry per ticked board, with the last sign-in check. */
  /**
   * `signed_in` is what the last check saw (reset to "unchecked" when the person says they're signed in, so a later
   * check that sees a sign-in page shows as a contradiction, never a silent flip). `why` says what the check saw.
   */
  boards: { id: BoardId; name: string; signed_in: BoardSignIn; confirmed_at: string; why: SignInWhy; diag?: SignInDiag }[];
  settings: ChromeSearchSettings;
  /** Chrome's profiles (folder and display name), for "Which Chrome profile do you job-search in?". Empty when unknown. */
  profiles: ChromeProfileChoice[];
  /** The profile Chrome used last, to preselect when none is chosen yet, or "". */
  last_used_profile: string;
  /**
   * The last check couldn't open a tab in the chosen profile for at least one board. Those boards weren't read;
   * nothing is ever opened in another profile instead.
   */
  profile_failed: boolean;

  /** A find-jobs run would use Chrome now. */
  ready: boolean;
  /** Plain words for the last thing that went wrong, or "". */
  problem: string;
  /**
   * Set up earlier but never turned on (the old Finish button was never pressed): the helper is installed and
   * boards are ticked, so the UI offers "Turn on" without redoing setup.
   */
  offer_turn_on?: boolean;
  /** How the last find-jobs run searched, and why it searched the web when it did. Null before any run. */
  last_run?: FindJobsMode | null;
}

/**
 * Why a find-jobs run searched the web instead of the person's Chrome. Never silent: the composer and the run strip
 * say which, in plain words (app-ui chrome/state.ts `webReasonText`).
 */
export type WebReason =
  | "unavailable" // this copy of the app can't drive Chrome
  | "not_set_up" // Search in my Chrome was never turned on
  | "off" // the person turned it off
  | "no_helper" // the browser helper is missing or too old
  | "remote_off" // Chrome's remote control is off
  | "connect_failed" // reconnecting at the run's start failed (Allow not clicked, Chrome closed)
  | "busy" // another search is using Chrome
  | "no_boards"; // no boards ticked for this run

export interface FindJobsMode {
  mode: "chrome" | "web";
  /** "" when mode is "chrome". */
  reason: WebReason | "";
  /** The boards a Chrome run searches (canonical order); [] for a web run. */
  boards: BoardId[];
  /** When the run started (ISO). */
  at: string;
}

export type BoardRunState = "waiting" | "searching" | "paused" | "skipped" | "done";

export interface BoardRunProgress {
  id: BoardId; name: string; state: BoardRunState;
  pages: number; ads_read: number;
  /** When paused: "captcha" (a check or "unusual activity") or "login" (a sign-in wall). */
  reason: "" | "captcha" | "login";
}

export interface ChromeRunProgress {
  /** The Claude run this belongs to. */
  run_id: string;
  boards: BoardRunProgress[];
  /** True while any board waits for the person. */
  paused: boolean;
}
