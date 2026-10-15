// In-app updates (app.updates.*): the installed app checks GitHub Releases, downloads in the background and
// installs on restart. Main owns the updater (app-electron/src/updates.ts); this is what the renderer sees.

/** Where people download the app by hand: the fallback when an update can't be checked or installed. */
export const RELEASES_URL = "https://github.com/jobcairn/jobcairn/releases/latest";

/**
 * One step of an update. `available` lasts until the download starts; `ready` waits for "Restart to update";
 * `none` means this is the newest version. `notes` is plain Markdown (never HTML), "" when the release has none.
 */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string; notes: string }
  | { kind: "none"; checked_at: string }
  | { kind: "error"; message: string };

export interface UpdateView {
  /** This app's version. */
  current: string;
  /** False in development and test runs: they never check (the dialog offers the download page instead). */
  supported: boolean;
  /** Checks on launch and every few hours. Off: only "Check for updates" checks. Saved per computer. */
  auto: boolean;
  status: UpdateStatus;
}
