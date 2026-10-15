import path from "node:path";

const cleanWorkspace = (ws: unknown): string =>
  typeof ws === "string" && path.isAbsolute(ws) && !ws.includes("\u0000") ? path.normalize(ws) : "";

/** `--background-sync --workspace <abs path>`; a missing or relative workspace gives "" (the run then reports it). */
export function parseBackgroundArgs(argv: readonly string[]): { workspace: string } | null {
  if (!argv.includes("--background-sync")) return null;
  const i = argv.indexOf("--workspace");
  return { workspace: cleanWorkspace(i >= 0 ? argv[i + 1] : undefined) };
}

/** What the OS scheduler runs: the app binary itself, so safeStorage can decrypt the password. */
export function backgroundCommandFor(o: { packaged: boolean; execPath: string; appPath: string; workspace: string }): { program: string; args: string[] } {
  const args = ["--background-sync", "--workspace", o.workspace];
  return o.packaged ? { program: o.execPath, args } : { program: o.execPath, args: [o.appPath, ...args] };
}

/** What a background run passes to the running app through the single-instance lock. */
export interface BackgroundHandoff { syncMail: true; workspace: string }

/**
 * A background run found the app already open and handed over its workspace. Each workspace has its own
 * schedule, so the running app syncs that workspace: "soon" when it is the one open (the usual debounced sync),
 * "headless" when it is another (a one-off run in this process, like the scheduled run itself, which checks
 * that background sync is on there). Anything malformed is ignored.
 */
export function backgroundHandoff(data: unknown, openRoot: string | null): { kind: "soon" } | { kind: "headless"; workspace: string } | { kind: "ignore" } {
  if (typeof data !== "object" || data === null) return { kind: "ignore" };
  const d = data as { syncMail?: unknown; workspace?: unknown };
  if (d.syncMail !== true) return { kind: "ignore" };
  const ws = cleanWorkspace(d.workspace);
  if (!ws) return { kind: "ignore" };
  return openRoot && path.normalize(openRoot) === ws ? { kind: "soon" } : { kind: "headless", workspace: ws };
}

/** A background run's own hand-off (another scheduled run), as opposed to a person opening the app. */
export function isBackgroundHandoff(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { syncMail?: unknown }).syncMail === true;
}

/**
 * How long after `ready` a background run starts treating macOS `activate` as a person opening the app. macOS can fire
 * `activate` at the run's own launch (launchd starts the bundle's executable); that one must not open a window.
 */
export const REOPEN_ARM_MS = 1500;

/** Whether a reopen event in a background run is a person opening the app. `readyAt` is null until `ready`. */
export function isPersonOpening(event: "activate" | "open-file" | "open-url", readyAt: number | null, now: number): boolean {
  // A file or link opened with the app is always a person: launchd never passes one.
  if (event !== "activate") return true;
  return readyAt !== null && now - readyAt >= REOPEN_ARM_MS;
}

/** The arguments to start the normal app from a background run's own (`process.argv.slice(1)`): its flags removed. */
export function relaunchArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--background-sync") continue;
    if (args[i] === "--workspace") { i++; continue; }
    out.push(args[i]!);
  }
  return out;
}
