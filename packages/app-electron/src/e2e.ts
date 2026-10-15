import path from "node:path";
import type { BackgroundScheduler } from "@careeros/mail";

type Env = Record<string, string | undefined>;

/** Folder paths the pickers return in end-to-end tests. Ignored in a packaged app. */
export function e2ePicks(env: Env, packaged: boolean): string[] | null {
  if (packaged || !env.CAREEROS_E2E_PICK) return null;
  try {
    const v = JSON.parse(env.CAREEROS_E2E_PICK) as unknown;
    return Array.isArray(v) && v.every((p) => typeof p === "string" && path.isAbsolute(p)) ? (v as string[]) : null;
  } catch { return null; }
}

export function e2eUserData(env: Env, packaged: boolean): string | null {
  const d = env.CAREEROS_USER_DATA;
  return !packaged && d && path.isAbsolute(d) ? d : null;
}

/** A temporary home folder for end-to-end runs, so "Get started" and the example never write to the real one. */
export function e2eHome(env: Env, packaged: boolean): string | null {
  const d = env.CAREEROS_HOME_OVERRIDE;
  return !packaged && d && path.isAbsolute(d) ? d : null;
}

/** A fake Gmail for end-to-end runs: messages from `fixture`, sent mail written to `sentDir`. */
export function e2eMail(env: Env, packaged: boolean): { fixture: string; sentDir: string } | null {
  if (packaged || !env.CAREEROS_E2E_MAIL) return null;
  try {
    const v = JSON.parse(env.CAREEROS_E2E_MAIL) as { fixture?: unknown; sentDir?: unknown };
    return typeof v.fixture === "string" && path.isAbsolute(v.fixture) && typeof v.sentDir === "string" && path.isAbsolute(v.sentDir)
      ? { fixture: v.fixture, sentDir: v.sentDir } : null;
  } catch { return null; }
}

/** In-memory secrets for end-to-end runs (CI Linux has no keyring). Never in a packaged app. */
export const e2eMemorySecrets = (env: Env, packaged: boolean): boolean => !packaged && env.CAREEROS_E2E_SECRETS === "memory";

/** An absolute file that gets one JSON line per IPC reply, so a test can prove a secret never comes back. */
export function e2eIpcLog(env: Env, packaged: boolean): string | null {
  const f = env.CAREEROS_E2E_IPC_LOG;
  return !packaged && f && path.isAbsolute(f) ? f : null;
}

/**
 * The background-sync scheduler for end-to-end runs (with the fake Gmail): jobs live in memory, so a test can
 * turn background sync on and off without touching launchd, Task Scheduler or systemd on the machine.
 */
export function e2eScheduler(): BackgroundScheduler {
  let installed = false;
  return {
    supported: true,
    status: async () => ({ installed, detail: installed ? "Test run: kept in memory only." : "Test run: nothing is installed on this computer." }),
    install: async () => { installed = true; },
    remove: async () => { installed = false; },
  };
}
