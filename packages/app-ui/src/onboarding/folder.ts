import type { CareerosBridge, FolderSuggestion, RecentWorkspace, WorkspaceSummary } from "@careeros/contract";

/**
 * A small adapter for the folder calls, so onboarding still works with an older bridge that lacks them:
 *
 * - `suggest()`: where "Get started" puts the CareerOS folder (shown only, never sent back).
 * - `start()`: "Get started" itself. Main picks the folder; the renderer never sends a path for it.
 * - `openSample()`: a fresh copy of the made-up example in its own folder.
 * - `recent()` / `switchTo()` / `forget()` / `startNew()`: the workspace switcher.
 * Without them, "Get started" falls back to the folder picker, and the example and switcher list are hidden.
 */
export type { FolderSuggestion };

type Maybe<T> = { [K in keyof T]?: T[K] };
const planned = (b: CareerosBridge) => b.workspace as Maybe<CareerosBridge["workspace"]>;

/** True when main picks the folder for "Get started" (suggest to show where, start to make or open it). */
export const hasFolderApi = (b: CareerosBridge) => typeof planned(b).suggest === "function" && typeof planned(b).start === "function";
export const hasExample = (b: CareerosBridge) => typeof planned(b).openSample === "function";
/** True when the bridge keeps a list of workspaces to switch between. */
export const hasSwitcher = (b: CareerosBridge) => typeof planned(b).recent === "function" && typeof planned(b).switchTo === "function";

/** "Get started": main opens the folder it suggested, or makes it. */
export async function startWorkspace(b: CareerosBridge): Promise<WorkspaceSummary> {
  const fn = planned(b).start;
  if (!fn) throw new Error("This version can't choose a folder by itself. Choose one instead.");
  return fn.call(b.workspace);
}

export async function recentWorkspaces(b: CareerosBridge): Promise<RecentWorkspace[]> {
  const fn = planned(b).recent;
  return fn ? fn.call(b.workspace) : [];
}

export async function suggestFolder(b: CareerosBridge): Promise<FolderSuggestion | null> {
  const fn = planned(b).suggest;
  return fn ? fn.call(b.workspace) : null;
}

export async function openExample(b: CareerosBridge): Promise<WorkspaceSummary> {
  const fn = planned(b).openSample;
  if (!fn) throw new Error("The example isn't available in this version.");
  return fn.call(b.workspace);
}

/** Whether an open folder is the made-up example. */
export const isExample = (s: WorkspaceSummary | null | undefined) => s?.isSample === true;

/** "Start my own" from the example banner: onboarding starts "Get started" by itself after the example closes. */
const START_KEY = "careeros.onboarding.startOwn";
export const requestStartOwn = () => { try { sessionStorage.setItem(START_KEY, "1"); } catch { /* storage off: one more click */ } };
export function takeStartOwn(): boolean {
  try {
    const v = sessionStorage.getItem(START_KEY) === "1";
    sessionStorage.removeItem(START_KEY);
    return v;
  } catch { return false; }
}
