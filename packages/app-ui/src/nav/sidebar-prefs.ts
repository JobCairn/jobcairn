import { useCallback, useEffect, useState } from "react";

/**
 * The sidebar's remembered layout, per install: whether it is folded to icons, and which groups (Find, Apply,
 * Prepare) are folded to their header. Until the person chooses, narrow windows get the icon rail.
 */
export const SIDEBAR_KEY = "careeros.sidebar";
export const SIDEBAR_GROUPS_KEY = "careeros.sidebar.groups";
/** Below this width the rail starts as icons (a 1024-1180 px laptop), unless the person opened it. */
export const NARROW_QUERY = "(max-width: 1180px)";

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** The person's choice: true (icons), false (full), or null when they haven't chosen. */
export function readCollapsed(): boolean | null {
  const v = storage()?.getItem(SIDEBAR_KEY);
  return v === "collapsed" ? true : v === "expanded" ? false : null;
}

export function readClosedGroups(): string[] {
  try {
    const v: unknown = JSON.parse(storage()?.getItem(SIDEBAR_GROUPS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === "string") : [];
  } catch { return []; }
}

/** Cmd+\ on a Mac, Ctrl+\ elsewhere. Matches the key's position too, for keyboard layouts where "\" moves. */
export function isSidebarShortcut(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">, mac: boolean): boolean {
  if (e.altKey) return false;
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false;
  return e.key === "\\" || e.code === "Backslash";
}

function narrowQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => !!narrowQuery()?.matches);
  useEffect(() => {
    const mq = narrowQuery();
    if (!mq) return undefined;
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

export function useSidebarPrefs(mac: boolean) {
  const narrow = useNarrow();
  const [pref, setPref] = useState<boolean | null>(readCollapsed);
  const [closedGroups, setClosedGroups] = useState<string[]>(readClosedGroups);
  const collapsed = pref ?? narrow;

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    setPref(next);
    storage()?.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
  }, [collapsed]);

  const toggleGroup = useCallback((group: string) => {
    setClosedGroups((prev) => {
      const next = prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group];
      storage()?.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSidebarShortcut(e, mac)) return;
      e.preventDefault();
      toggleCollapsed();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac, toggleCollapsed]);

  return { collapsed, toggleCollapsed, closedGroups, toggleGroup };
}
