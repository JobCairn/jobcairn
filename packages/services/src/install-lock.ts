// One install at a time across the whole app: Homebrew refuses to run twice at once, and a tool must never change
// under another install or a running video. Keyed by the host, so every window and workspace shares it.
import type { ServiceContext } from "./context.js";

export interface InstallInfo {
  id: string; name: string; started_at: string; line: string;
  /** Aborted by setup.cancel (Stop). Only installs that pass it on (`cancellable`) can actually stop. */
  abort: AbortController; cancellable: boolean;
}

const running = new WeakMap<object, InstallInfo>();

/** The install running now (setup tools, video tools, the voice engine or the browser helper), else null. */
export function currentInstall(ctx: ServiceContext): InstallInfo | null {
  return running.get(ctx.host) ?? null;
}

export function installBusyText(info: InstallInfo): string {
  return `${info.name} is installing. Try again when it finishes.`;
}

/** Runs `fn` holding the app-wide install lock. Throws a plain sentence if another install holds it. */
export async function withInstallLock<T>(ctx: ServiceContext, id: string, name: string, fn: (info: InstallInfo) => Promise<T>, o: { cancellable?: boolean } = {}): Promise<T> {
  const busy = currentInstall(ctx);
  if (busy) throw new Error(installBusyText(busy));
  const info: InstallInfo = { id, name, started_at: ctx.now().toISOString(), line: "", abort: new AbortController(), cancellable: !!o.cancellable };
  running.set(ctx.host, info);
  try { return await fn(info); } finally { if (running.get(ctx.host) === info) running.delete(ctx.host); }
}
