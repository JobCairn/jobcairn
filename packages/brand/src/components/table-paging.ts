/** Paging, sticky offsets and row windowing for the Table: pure maths, so it can be tested without a browser. */

export type PageSize = 25 | 50 | 100 | "all";
export const PAGE_SIZES: readonly PageSize[] = [25, 50, 100, "all"];
export const DEFAULT_PAGE_SIZE: PageSize = 50;
/** With "All", lists longer than this render only the rows in view (windowed), so scrolling stays smooth. */
export const WINDOW_MIN_ROWS = 300;
/** The pager shows once a list is longer than the smallest page. */
export const PAGER_MIN_ROWS = PAGE_SIZES[0] as number;

export const isPageSize = (v: unknown): v is PageSize => (PAGE_SIZES as readonly unknown[]).includes(v);

export function pageCount(total: number, size: PageSize): number {
  if (size === "all" || total <= 0) return 1;
  return Math.ceil(total / size);
}

/** A page number that exists for this many rows (1 when the list shrank under it, or the input is junk). */
export function clampPage(page: number, total: number, size: PageSize): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), pageCount(total, size));
}

/** The rows a page shows, as [start, end) indexes into the sorted list. */
export function pageBounds(page: number, total: number, size: PageSize): { start: number; end: number } {
  if (size === "all") return { start: 0, end: total };
  const p = clampPage(page, total, size);
  return { start: (p - 1) * size, end: Math.min(total, p * size) };
}

/** "1–50 of 127". An en dash between the numbers, as in print. */
export function rangeText(page: number, total: number, size: PageSize): string {
  if (total === 0) return "0 of 0";
  const { start, end } = pageBounds(page, total, size);
  return `${start + 1}–${end} of ${total}`;
}

/** The page number buttons: always the first and last page, the current page with one either side, and gaps. */
export function pageList(page: number, count: number): (number | "gap")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const keep = new Set([1, count, page - 1, page, page + 1]);
  // Near an end, show enough pages that the gap stands for at least two pages.
  if (page <= 4) [2, 3, 4, 5].forEach((n) => keep.add(n));
  if (page >= count - 3) [count - 4, count - 3, count - 2, count - 1].forEach((n) => keep.add(n));
  const nums = [...keep].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  nums.forEach((n, i) => { if (i && n - nums[i - 1]! > 1) out.push("gap"); out.push(n); });
  return out;
}

/** The page that holds row `index` (0-based). */
export function pageOf(index: number, size: PageSize): number {
  return size === "all" ? 1 : Math.floor(Math.max(0, index) / size) + 1;
}

export function shouldWindow(size: PageSize, rows: number): boolean {
  return size === "all" && rows > WINDOW_MIN_ROWS;
}

/**
 * Which rows to render when windowed: the ones in view plus `overscan` either side. `bodyTop` is where the first row
 * starts, measured in the scroll container's content (so a scrolled container has scrollTop > bodyTop once the
 * table's top has gone by).
 */
export function windowRange(o: { scrollTop: number; viewport: number; bodyTop: number; rowHeight: number; count: number; overscan?: number }): { first: number; last: number } {
  const overscan = o.overscan ?? 10;
  const h = o.rowHeight > 0 ? o.rowHeight : 48;
  const top = Math.max(0, o.scrollTop - o.bodyTop);
  const first = Math.max(0, Math.floor(top / h) - overscan);
  const last = Math.min(o.count, Math.ceil((top + Math.max(o.viewport, h)) / h) + overscan);
  return { first: Math.min(first, Math.max(0, o.count - 1)), last: Math.max(last, Math.min(o.count, first + 1)) };
}

/**
 * Where the column headers stick: right under the sticky filter and toolbar block. `stickTop` is that block's own
 * `top` (negative when it cancels the scroll container's top padding) and `height` its measured height.
 */
export function headTop(stickTop: number, height: number): number {
  return Math.round(stickTop + height);
}

/** The most of the screen the sticky block may cover before its filter rows scroll away (the toolbar still sticks). */
export const STICKY_MAX_SHARE = 0.4;

/**
 * How far up the sticky block hides itself: 0 normally; the filters' height when the whole block would cover more
 * than STICKY_MAX_SHARE of the screen (a short window, or many wrapped chips), so the count, Columns and the headers
 * still stick and the rows keep most of the screen.
 */
export function stickyShift(o: { blockHeight: number; filtersHeight: number; viewport: number }): number {
  if (o.viewport <= 0 || o.filtersHeight <= 0) return 0;
  return o.blockHeight > o.viewport * STICKY_MAX_SHARE ? Math.round(o.filtersHeight) : 0;
}
