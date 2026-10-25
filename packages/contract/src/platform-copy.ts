/**
 * The words that change with the computer the app runs on: Finder or File Explorer, Terminal or PowerShell,
 * Return or Enter, "your Mac" or "your PC". Services and main pass Node's `process.platform`; the window
 * passes `navigator.platform`. Both spellings are understood.
 */
export type OsKind = "mac" | "windows" | "linux";

export function osKind(platform: string | null | undefined): OsKind {
  const p = String(platform ?? "").toLowerCase();
  if (p === "darwin" || p.startsWith("mac")) return "mac";
  if (p === "win32" || p.startsWith("win")) return "windows";
  return "linux";
}

export interface OsWords {
  /** "your Mac": the computer, as the owner would say it. */
  yourComputer: string;
  /** "this Mac". */
  thisComputer: string;
  /** The button and tip that reveal a file. */
  showInFolder: string;
  /** The command-line app, as a name in a sentence ("open Terminal"). */
  terminal: string;
  /** The key that runs a line. */
  enterKey: string;
  /** How to find and open the command-line app, in a sentence after "open". */
  openTerminal: string;
}

export const OS_WORDS: Record<OsKind, OsWords> = {
  mac: {
    yourComputer: "your Mac", thisComputer: "this Mac", showInFolder: "Show in Finder", terminal: "Terminal", enterKey: "Return",
    openTerminal: "open Terminal (in Applications › Utilities, or search Spotlight for Terminal)",
  },
  windows: {
    yourComputer: "your PC", thisComputer: "this PC", showInFolder: "Show in File Explorer", terminal: "PowerShell", enterKey: "Enter",
    openTerminal: "open PowerShell (open the Start menu, type PowerShell and choose it)",
  },
  linux: {
    yourComputer: "your computer", thisComputer: "this computer", showInFolder: "Show in folder", terminal: "the terminal", enterKey: "Enter",
    openTerminal: "open the terminal",
  },
};

export const osWords = (platform: string | null | undefined): OsWords => OS_WORDS[osKind(platform)];

/**
 * The name main gives an OS refusal to use secure storage (the Keychain on a Mac, Windows' credential
 * protection). It survives IPC as part of the error text ("KeychainAccessError: ..."), so the window can tell a
 * refusal from any other failure without reading the English wording.
 */
export const SECURE_STORAGE_DENIED = "KeychainAccessError";

/** Whether an error (as thrown in the window) is the OS refusing secure storage. */
export function isSecureStorageDenied(e: unknown): boolean {
  if (e && typeof e === "object" && (e as { name?: unknown }).name === SECURE_STORAGE_DENIED) return true;
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return new RegExp(`^(?:Error invoking remote method '[^']+': )?${SECURE_STORAGE_DENIED}: `).test(m);
}
