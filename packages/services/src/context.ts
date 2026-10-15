import type { Clock } from "@careeros/core";
import type { ChangeArea, ChangeEvent } from "@careeros/contract";
import type { Host } from "./host.js";

type OpenHook = (root: string) => (() => void) | void;

/** Per-window state: the host, the open workspace, change listeners, and per-workspace hooks (timers, watcher). */
export class ServiceContext {
  root: string | null = null;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private openHooks = new Set<OpenHook>();
  private closers: (() => void)[] = [];

  constructor(readonly host: Host) {}

  now(): Date { return this.host.now?.() ?? new Date(); }
  clock(): Clock { return { now: this.now() }; }
  requireRoot(): string {
    if (!this.root) throw new Error("No workspace is open.");
    return this.root;
  }

  /** Switches workspace: stops the old workspace's hooks, then starts every hook for the new one. */
  setRoot(root: string | null): void {
    for (const close of this.closers.splice(0)) {
      // A failing closer must not block the switch, but it shouldn't vanish silently either.
      try { close(); } catch (err) { console.error("careeros: workspace close hook failed", err); }
    }
    this.root = root;
    if (root) for (const hook of this.openHooks) { const c = hook(root); if (c) this.closers.push(c); }
  }

  onOpen(fn: OpenHook): () => void {
    this.openHooks.add(fn);
    if (this.root) { const c = fn(this.root); if (c) this.closers.push(c); }
    return () => { this.openHooks.delete(fn); };
  }

  emit(...areas: ChangeArea[]): void {
    if (!areas.length) return;
    const e = { areas: [...new Set(areas)] };
    for (const l of [...this.listeners]) {
      // One broken listener must not stop the others, nor turn a finished change into a failure.
      try { l(e); } catch (err) { console.error(`careeros: a change listener failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }

  onChange(cb: (e: ChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
}
