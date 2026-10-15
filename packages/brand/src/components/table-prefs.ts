import { DEFAULT_PAGE_SIZE, isPageSize, type PageSize } from "./table-paging";

/** Per-table preferences: hidden columns, row density and rows per page, remembered in localStorage. */
export type Density = "comfortable" | "compact";
export interface TablePrefs { hidden: string[]; density: Density; pageSize: PageSize }
export const DEFAULT_PREFS: TablePrefs = { hidden: [], density: "comfortable", pageSize: DEFAULT_PAGE_SIZE };

export interface PrefColumn<T> { key: string; alwaysOn?: boolean; hideWhenEmpty?: boolean; isEmpty?: (row: T) => boolean }

/**
 * Which columns show: everything not hidden by the person, minus columns marked hideWhenEmpty whose values are all
 * empty for the rows on screen (those are "auto-hidden" and listed as "(empty)" in the Columns menu). A column marked
 * alwaysOn can't be hidden.
 */
export function visibleColumns<T, C extends PrefColumn<T>>(columns: readonly C[], rows: readonly T[], prefs: TablePrefs): { visible: C[]; autoHidden: Set<string> } {
  const autoHidden = new Set<string>();
  for (const c of columns) {
    if (!c.alwaysOn && c.hideWhenEmpty && c.isEmpty && rows.length && rows.every((r) => c.isEmpty!(r))) autoHidden.add(c.key);
  }
  const visible = columns.filter((c) => c.alwaysOn || (!prefs.hidden.includes(c.key) && !autoHidden.has(c.key)));
  return { visible, autoHidden };
}

const storeKey = (id: string) => `careeros.table.${id}`;
export function loadPrefs(id: string | undefined): TablePrefs {
  if (!id) return DEFAULT_PREFS;
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(id)) ?? "null") as Partial<TablePrefs> | null;
    return {
      hidden: Array.isArray(raw?.hidden) ? raw!.hidden.filter((x): x is string => typeof x === "string") : [],
      density: raw?.density === "compact" ? "compact" : "comfortable",
      pageSize: isPageSize(raw?.pageSize) ? raw!.pageSize : DEFAULT_PAGE_SIZE,
    };
  } catch { return DEFAULT_PREFS; }
}
export function savePrefs(id: string | undefined, p: TablePrefs): void {
  if (!id) return;
  try { localStorage.setItem(storeKey(id), JSON.stringify(p)); } catch { /* storage full or off */ }
}

/** True when an element's content doesn't fit (it shows an ellipsis or a line clamp). */
export function isTruncated(el: Element | null): boolean {
  if (!el) return false;
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}
