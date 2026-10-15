import type { ChangeEvent } from "@careeros/contract";
import { ServiceContext } from "./context.js";
import { dispatch } from "./dispatch.js";
import { resolveMediaFile, type MediaFile } from "./files.js";
import type { Host } from "./host.js";
import { mailAsset, type AssetResponse } from "./mail-read.js";
import { installMailTimer, syncMailSoon } from "./mail-sync.js";
import { checkGrants, installGrantTimer } from "./privacy.js";
import { installTtsHooks, resolveTtsMedia } from "./tts.js";
import { startWatcher } from "./watcher.js";
import { restoreLast, shutdownWorkspace } from "./workspace.js";
import { chromeFor } from "./chrome/service.js";
import { installSearchScheduler } from "./search-schedule.js";

export interface Runtime {
  ctx: ServiceContext;
  dispatch(method: string, args: unknown): Promise<unknown>;
  onChange(cb: (e: ChangeEvent) => void): () => void;
  checkGrants(): number;
  /** Checks a careeros-file: request; the shell must open `real` and confirm dev/ino before serving it. */
  resolveMedia(rel: string): MediaFile;
  /** Checks a careeros-file://tts/<name> request (read-aloud audio or a voice preview); same contract as resolveMedia. */
  resolveTtsMedia(name: string): MediaFile;
  /** Debounced sync, e.g. when the computer wakes from sleep. Does nothing without an account. */
  syncMailSoon(): void;
  /** Answers one careeros-mail: request (the shell's protocol handler calls this). */
  resolveMailAsset(url: string): Promise<AssetResponse>;
  /** App quit: re-lock the workspace, then let Search in my Chrome close its tabs and detach (at most `timeoutMs`). */
  shutdown(timeoutMs?: number): Promise<void>;
  /** The process is exiting (also after a crash in main): a last, synchronous detach from Chrome. */
  shutdownSync(): void;
}

/** How long quitting waits for Search in my Chrome to close its tabs and detach. */
export const SHUTDOWN_WAIT_MS = 4_000;

/** One per app window. Restores the last workspace, keeps grant timers and the watcher running for it. */
export function createRuntime(host: Host, opts: { watch?: boolean; debounceMs?: number } = {}): Runtime {
  const ctx = new ServiceContext(host);
  installGrantTimer(ctx);
  installMailTimer(ctx);
  installTtsHooks(ctx);
  if (opts.watch !== false) ctx.onOpen((root) => startWatcher(ctx, root, { debounceMs: opts.debounceMs }));
  // "Repeat this search": checked every minute while a workspace is open, only where Claude Code can run.
  if (host.claude) installSearchScheduler(ctx);
  restoreLast(ctx);
  // The updater runs in main on its own timers; each step it takes reloads the version badge and About.
  host.updates?.onChange(() => ctx.emit("updates"));
  // A Chrome session left by a crash or a forced quit is closed now, not left under remote control.
  if (host.chrome) void chromeFor(ctx).startup().catch(() => undefined);
  // Memory: the browser helper is stopped when idle (no search, or a search whose browsing went quiet).
  if (host.chrome) chromeFor(ctx).startIdleCheck();
  return {
    ctx,
    dispatch: (method, args) => dispatch(ctx, method, args),
    onChange: (cb) => ctx.onChange(cb),
    checkGrants: () => checkGrants(ctx),
    resolveMedia: (rel) => resolveMediaFile(ctx, rel),
    resolveTtsMedia: (name) => resolveTtsMedia(ctx, name),
    syncMailSoon: () => syncMailSoon(ctx),
    resolveMailAsset: (url) => mailAsset(ctx, url),
    shutdown: async (timeoutMs = SHUTDOWN_WAIT_MS) => {
      shutdownWorkspace(ctx);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); });
      try { await Promise.race([chromeFor(ctx).shutdown().catch(() => undefined), limit]); } finally { clearTimeout(timer); }
    },
    shutdownSync: () => chromeFor(ctx).shutdownSync(),
  };
}
