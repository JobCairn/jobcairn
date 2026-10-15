// In-app updates: electron-updater against GitHub Releases (builder-config.mjs `publish`, so the packaged app carries
// app-update.yml and each release carries latest-mac.yml and the zips). The installed mac app checks 10 seconds after
// launch and every 6 hours while "check automatically" is on, downloads in the background (Squirrel.Mac takes the
// zip), and installs when the person presses "Restart to update" (or on their next quit). Development and e2e runs
// never load the updater. The status machine is plain code over an injected updater, so tests drive it with a fake.
import type { UpdateStatus } from "@careeros/contract";
import type { UpdateHost } from "@careeros/services";

/** What this module uses of electron-updater's AppUpdater. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // electron-updater's events carry its own info types; only the fields read below are relied on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Download progress pushes to the renderer at most this often. */
export const PROGRESS_EVERY_MS = 250;
/** Release notes longer than this are cut (the full notes stay on GitHub). */
const NOTES_MAX = 4000;

/** Only the packaged mac app updates itself: releases carry mac builds only, and e2e runs must never check. */
export function updatesSupported(o: { packaged: boolean; platform: string; env: Record<string, string | undefined> }): boolean {
  return o.packaged && o.platform === "darwin" && !Object.keys(o.env).some((k) => k.startsWith("CAREEROS_E2E"));
}

/**
 * Release notes as plain Markdown. GitHub's release feed gives HTML (a string), a multi-version check gives a list;
 * either way no markup reaches the renderer: list items, headings and paragraphs become Markdown, other tags go.
 */
export function notesMarkdown(notes: unknown): string {
  const raw = typeof notes === "string" ? notes
    : Array.isArray(notes) ? notes.map((n: { version?: unknown; note?: unknown }) => `### ${String(n?.version ?? "")}\n\n${typeof n?.note === "string" ? n.note : ""}`).join("\n\n")
    : "";
  let s = raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n\n### ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|ul|ol)>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > NOTES_MAX) s = `${s.slice(0, NOTES_MAX).trimEnd()}…`;
  return s;
}

/** electron-updater's error, in plain words. The raw message goes to the log only. */
export function updateErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_CONNECTION|net::/i.test(m)) {
    return "Couldn't reach GitHub to check for updates. Check your internet connection and try again.";
  }
  if (/\b404\b|latest-mac\.yml|Cannot find latest|No published versions/i.test(m)) return "The newest release isn't ready for automatic updates yet. You can download it from GitHub.";
  if (/sha512 checksum mismatch|signature|ShipIt|Squirrel/i.test(m)) return "The update couldn't be installed. Download the newest version from GitHub instead.";
  return "Couldn't check for updates. Try again later, or download the newest version from GitHub.";
}

export interface UpdatesOptions {
  supported: boolean;
  /** "Check automatically", as saved. */
  auto: boolean;
  /** Loads electron-updater's autoUpdater (only ever called when supported). */
  load: () => Promise<Updater>;
  /** Runs before quit-and-install (lets go of Chrome), so the app's own quit handling can't hold up the relaunch. */
  beforeInstall?: () => Promise<void>;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface Updates extends UpdateHost {
  /** Starts the launch check and the 6-hour timer. Call once the window exists. */
  start(): void;
  stop(): void;
}

export function createUpdates(o: UpdatesOptions): Updates {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? ((msg: string) => console.error(`careeros: ${msg}`));
  let status: UpdateStatus = { kind: "idle" };
  let auto = o.auto;
  let updater: Promise<Updater> | null = null;
  let checking: Promise<void> | null = null;
  let lastPush = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const listeners = new Set<() => void>();

  const push = () => { for (const l of [...listeners]) { try { l(); } catch { /* one listener can't stop the others */ } } };
  const set = (s: UpdateStatus) => {
    status = s;
    if (pending) { clearTimeout(pending); pending = null; }
    lastPush = Date.now();
    push();
  };
  // Download progress: the status moves every chunk, the renderer hears at most every PROGRESS_EVERY_MS.
  const setProgress = (s: UpdateStatus) => {
    status = s;
    const wait = PROGRESS_EVERY_MS - (Date.now() - lastPush);
    if (wait <= 0) { lastPush = Date.now(); push(); return; }
    pending ??= setTimeout(() => { pending = null; lastPush = Date.now(); push(); }, wait);
  };
  const versionOf = (info: unknown) => String((info as { version?: unknown } | null)?.version ?? "");
  const fail = (e: unknown) => {
    log(`update: ${e instanceof Error ? e.message : String(e)}`);
    // A downloaded update stays ready: a later failed check must not hide "Restart to update".
    if (status.kind !== "ready") set({ kind: "error", message: updateErrorText(e) });
  };

  const get = (): Promise<Updater> => {
    updater ??= o.load().then((u) => {
      u.autoDownload = true;
      u.autoInstallOnAppQuit = true;
      u.on("checking-for-update", () => { if (status.kind !== "ready" && status.kind !== "downloading") set({ kind: "checking" }); });
      u.on("update-available", (info) => { if (status.kind !== "ready") set({ kind: "available", version: versionOf(info) }); });
      u.on("update-not-available", () => { if (status.kind !== "ready") set({ kind: "none", checked_at: now().toISOString() }); });
      u.on("download-progress", (p: { percent?: number }) => {
        if (status.kind === "ready") return;
        const version = status.kind === "available" || status.kind === "downloading" ? status.version : "";
        setProgress({ kind: "downloading", version, percent: Math.max(0, Math.min(100, Math.floor(Number(p?.percent) || 0))) });
      });
      u.on("update-downloaded", (info: { releaseNotes?: unknown }) => set({ kind: "ready", version: versionOf(info), notes: notesMarkdown(info?.releaseNotes) }));
      u.on("error", fail);
      return u;
    });
    return updater;
  };

  const check = (): Promise<void> => {
    if (!o.supported) return Promise.resolve();
    // One check at a time; a download under way or a downloaded update needs no new check.
    if (checking) return checking;
    if (status.kind === "ready" || status.kind === "downloading") return Promise.resolve();
    set({ kind: "checking" });
    checking = get()
      .then((u) => u.checkForUpdates())
      .then((r) => {
        // The background download's own promise: a failure there arrives as the "error" event, so it is only silenced.
        void (r as { downloadPromise?: Promise<unknown> } | null)?.downloadPromise?.catch(() => undefined); if (status.kind === "checking") set({ kind: "none", checked_at: now().toISOString() }); }, fail)
      .finally(() => { checking = null; });
    return checking;
  };

  const autoCheck = () => { if (auto) void check(); };

  return {
    supported: o.supported,
    status: () => status,
    check,
    install: () => {
      if (status.kind !== "ready" || !updater) return;
      // Quit, let Squirrel.Mac swap the app in, and open it again.
      void (o.beforeInstall?.() ?? Promise.resolve()).catch(() => undefined)
        .then(() => updater).then((u) => u!.quitAndInstall(false, true)).catch(fail);
    },
    setAuto: (on) => {
      const was = auto;
      auto = on;
      // Turned back on after the launch check was skipped: check now rather than in up to 6 hours.
      if (on && !was && timers.length && status.kind === "idle") autoCheck();
    },
    onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    start: () => {
      if (!o.supported || timers.length) return;
      timers.push(setTimeout(autoCheck, FIRST_CHECK_MS), setInterval(autoCheck, CHECK_EVERY_MS));
    },
    stop: () => {
      for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
      if (pending) { clearTimeout(pending); pending = null; }
    },
  };
}
