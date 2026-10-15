import { parseHash, toHash } from "../router";

/** The page a long list opened on, from the address (Back from a row returns to it). */
export function routePage(): number | undefined {
  const r = parseHash(window.location.hash);
  return r.screen === "jobs" || r.screen === "companies" || r.screen === "searches" ? r.page : undefined;
}

/**
 * Puts a list's page into the address without adding a history entry, so Back skips page turns but returns to the
 * page you opened a row from. Page 1 is left out.
 */
export function writePage(page: number): void {
  const r = parseHash(window.location.hash);
  if (r.screen !== "jobs" && r.screen !== "companies" && r.screen !== "searches") return;
  const { page: _old, ...rest } = r;
  const hash = toHash(page > 1 ? { ...rest, page } : rest);
  if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
}
