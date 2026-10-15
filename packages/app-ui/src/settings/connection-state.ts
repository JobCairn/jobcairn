import type { ConnectionId } from "../router";

const KEY = "careeros.settings.connection";

/** Which connection row starts open: the one a link asked for, else the one open last time, else one that needs setup. */
export function initialConnection(o: { asked?: ConnectionId; remembered?: ConnectionId | null; needsSetup: readonly ConnectionId[] }): ConnectionId | null {
  return o.asked ?? o.remembered ?? o.needsSetup[0] ?? null;
}

export function rememberedConnection(): ConnectionId | null {
  try { return (sessionStorage.getItem(KEY) as ConnectionId | null) || null; } catch { return null; }
}
export function rememberConnection(c: ConnectionId | null): void {
  try { if (c) sessionStorage.setItem(KEY, c); else sessionStorage.removeItem(KEY); } catch { /* private mode */ }
}
