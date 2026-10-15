// The tools the app can install itself, each only after the person says yes (setup.* methods).

/** The public install guide. Shown when the app can't fix something itself (a copy missing its own files). */
export const INSTALL_PAGE_URL = "https://jobcairn.github.io/install.html";
/** Homebrew's own one-line installer, from brew.sh. The person runs it in Terminal: it asks for their Mac password. */
export const HOMEBREW_INSTALL_COMMAND = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
export const HOMEBREW_URL = "https://brew.sh";

/** Tools the Setup cards offer (each matches a setup/components/<id>.json). Videos' own tools stay video.installTool. */
export const SETUP_TOOLS = ["claude-code", "node", "python", "ffmpeg"] as const;
export type SetupToolId = (typeof SETUP_TOOLS)[number];

export interface SetupToolView {
  id: SetupToolId;
  /** "Python", "Claude Code". */
  name: string;
  /** "Python 3.11 to 3.14": what counts as installed. */
  needs: string;
  /** One line on what it is for. */
  why: string;
  state: "ok" | "missing" | "too_old";
  /** The version that will be used, or the newest too-old one found. "" when none. */
  version: string;
  /** How the app installs it: Homebrew (needs Homebrew first) or Anthropic's installer. */
  via: "homebrew" | "anthropic";
  /** The exact command the app runs, shown before the person agrees. */
  command: string;
}

/** Why an install failed, read from the installer's own output (services install-error.ts). */
export type InstallProblem = "permission" | "network" | "timeout" | "disk" | "other";

/** One way to finish an install by hand: lines to paste into Terminal, run in order. */
export interface TerminalOption { title: string; command: string; /** Plain words under the lines (what sudo asks, what to do after). */ note?: string }

/** Shown when an install fails: the exact commands to run in Terminal instead, the usual one first. */
export interface TerminalFix { problem: InstallProblem; options: TerminalOption[] }

export interface SetupInstalling { id: SetupToolId | string; name: string; started_at: string; /** The installer's latest output line, cleaned up. */ line: string }

export interface SetupView {
  /** False when this copy of the app has no installer (it shows the install page instead). */
  can_install: boolean;
  homebrew: { found: boolean; command: string; url: string };
  tools: SetupToolView[];
  /** The install running now (any tool, from any card), else null. */
  installing: SetupInstalling | null;
  /** How the last install ended, until the next one starts. */
  last: { id: string; ok: boolean; message: string; /** A failure's Terminal fallback. */ fix?: TerminalFix } | null;
}
