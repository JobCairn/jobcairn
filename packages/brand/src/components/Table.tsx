import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { DEFAULT_PREFS, isTruncated, loadPrefs, savePrefs, visibleColumns, type Density, type TablePrefs } from "./table-prefs";
import { Icon } from "./Icon";
import { Icons } from "../icons";
import { DetailList, Drawer, type DetailField } from "./Drawer";
import { PAGE_SIZES, PAGER_MIN_ROWS, clampPage, stickyShift, headTop, pageBounds, pageCount, pageList, pageOf, rangeText, shouldWindow, windowRange, type PageSize } from "./table-paging";
import "../styles/table.css";

export type SortDir = "asc" | "desc";
export type SortValue = string | number | null | undefined;

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  width?: string;
  /**
   * For the column without a fixed `width` (such as Role): the least it gets. The table's minimum width is then the
   * fixed columns plus this, so a narrow window scrolls sideways (and low-priority columns hide) before it shrinks.
   */
  minWidth?: string;
  align?: "start" | "center" | "end";
  /** The cell as plain text: the tooltip on a truncated cell, the default sort key and the default drawer value. */
  text?: (row: T) => string;
  /** Sort key when it differs from `text` (numbers, dates). Empty values always sort last. */
  sortValue?: (row: T) => SortValue;
  /** Defaults to true when the column has `text` or `sortValue`. */
  sortable?: boolean;
  /** Direction of the first click. Default "asc"; numbers usually want "desc". */
  firstSort?: SortDir;
  /** How the value reads in the drawer. Defaults to `text`, then `render`. */
  detail?: (row: T) => ReactNode;
  /** Leave this column out of the default drawer (e.g. an action button). */
  inDetail?: boolean;
  /** Let the cell wrap to two lines instead of one line with an ellipsis. */
  wrap?: boolean;
  /** "low": hidden on narrow windows (the value stays in the drawer). */
  priority?: "low";
  /** Can't be turned off in the Columns menu (the main column, such as Role). */
  alwaysOn?: boolean;
  /** Hide this column by itself while every row on screen has no value for it (listed as "(empty)" in Columns). */
  hideWhenEmpty?: boolean;
  /** Whether a row has no value here. Defaults to an empty `text` / `sortValue`. */
  isEmpty?: (row: T) => boolean;
}

export interface RowDetail { title: string; subtitle?: ReactNode; fields?: DetailField[]; children?: ReactNode; actions?: ReactNode }

export interface TableProps<T> {
  caption: string; columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string;
  /** Open the row's own page. When given, it replaces the detail drawer. */
  onRowActivate?: (r: T) => void;
  /** Custom drawer content. Without it the drawer lists every column. */
  detail?: (r: T) => RowDetail;
  /** What one row is called, for the drawer's stepper: "Next employer". */
  itemLabel?: string;
  defaultSort?: { key: string; dir: SortDir };
  rowClassName?: (r: T) => string | undefined; emptyText?: string;
  /**
   * A stable name for this table ("jobs"). With it, the toolbar offers Columns and Density, and the choices are
   * remembered on this computer.
   */
  id?: string;
  /** Left side of the toolbar row: the count, filter chips, hints. */
  toolbar?: ReactNode;
  /** The screen's filters (search, selects, chips). They sit above the toolbar and stick with it. */
  filters?: ReactNode;
  /**
   * Keep the filters, the toolbar and the column headers at the top while the rows scroll (default: on when the
   * table has an `id`). Turn off for a table inside a card, a dialog or under sticky tabs.
   */
  sticky?: boolean;
  /** Show rows a page at a time, with a footer to move between pages and pick 25, 50, 100 or All (default: on with `id`). */
  paginate?: boolean;
  /** The page to open on (from the address, so Back returns to it). */
  page?: number;
  /** Called with the new page whenever it changes, to keep it in the address. */
  onPageChange?: (page: number) => void;
  /** Changes whenever the screen's filters change; the table then goes back to page 1. */
  resetKey?: string;
}

const INTERACTIVE = "button, a, input, select, textarea, label, [role='button']";
const empty = (v: SortValue) => v === null || v === undefined || v === "";

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * The one data table. Every row opens: to its own page (`onRowActivate`) or to a detail drawer
 * that lists every field and steps through rows. Headers sort; a cell that doesn't fit ends in
 * an ellipsis and carries its full value as a tooltip.
 */
/**
 * The table's minimum width when a column asks for one (Column.minWidth): every visible column's fixed width plus
 * the flexible columns' minimums, as a CSS calc. `narrow`: without the low-priority columns, which hide on narrow
 * windows. Null when no column has a minimum (the table keeps its default minimum).
 */
export function tableMinWidth<T>(columns: readonly Column<T>[], narrow = false): string | null {
  if (!columns.some((c) => c.minWidth)) return null;
  const parts = columns.filter((c) => !(narrow && c.priority === "low")).map((c) => c.width ?? c.minWidth).filter((w): w is string => !!w);
  return parts.length ? `calc(${parts.join(" + ")})` : null;
}

export function Table<T>({ caption, columns: allColumns, rows, rowKey, onRowActivate, detail, itemLabel = "row", defaultSort, rowClassName, emptyText = "Nothing here yet.", id, toolbar, filters, sticky, paginate, page: initialPage, onPageChange, resetKey }: TableProps<T>) {
  const [prefs, setPrefsState] = useState<TablePrefs>(() => loadPrefs(id));
  const setPrefs = (p: TablePrefs) => { setPrefsState(p); savePrefs(id, p); };
  const withEmpty = useMemo(() => allColumns.map((c) => ({
    ...c, isEmpty: c.isEmpty ?? ((r: T) => { const v = c.sortValue ? c.sortValue(r) : c.text?.(r); return v === null || v === undefined || v === ""; }),
  })), [allColumns]);
  const { visible: columns, autoHidden } = useMemo(() => visibleColumns(withEmpty, rows, prefs), [withEmpty, rows, prefs]);
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(defaultSort ?? null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLTableRowElement>());

  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    const get = col && (col.sortValue ?? col.text);
    if (!sort || !get) return rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    return rows.map((r, i) => ({ r, i, v: get(r) })).sort((a, b) => {
      // Empty values go last in both directions; ties keep the incoming order.
      if (empty(a.v) || empty(b.v)) return empty(a.v) === empty(b.v) ? a.i - b.i : empty(a.v) ? 1 : -1;
      return sign * compare(a.v, b.v) || a.i - b.i;
    }).map((x) => x.r);
  }, [rows, sort, columns]);

  // Paging. The page lives here; the screen hears about changes (to put it in the address) and can say where to start.
  const paging = paginate ?? !!id;
  const stickyOn = sticky ?? !!id;
  const size: PageSize = paging ? prefs.pageSize : "all";
  const [pageState, setPageState] = useState(() => initialPage ?? 1);
  const onPageRef = useRef(onPageChange);
  onPageRef.current = onPageChange;
  const setPage = useCallback((p: number) => { setPageState(p); onPageRef.current?.(p); }, []);
  // A new address for the same list (the sidebar link, a Home link) moves the page with it. Our own address
  // writes keep the two equal, so this only fires for changes from outside.
  const lastPageProp = useRef(initialPage);
  useEffect(() => {
    if (lastPageProp.current === initialPage) return;
    lastPageProp.current = initialPage;
    setPageState(initialPage ?? 1);
  }, [initialPage]);
  const page = clampPage(pageState, sorted.length, size);
  // A list that shrank under the page (a filter, a deletion) shows its last page; the address follows. Rows that
  // haven't loaded yet don't count, so a page restored from the address survives the first load.
  useEffect(() => { if (rows.length && page !== pageState) setPage(page); }, [rows.length, page, pageState, setPage]);
  // New filters start again at page 1. Not on mount, and not when only the rows reload.
  const lastReset = useRef(resetKey);
  useEffect(() => { if (lastReset.current === resetKey) return; lastReset.current = resetKey; setPage(1); }, [resetKey, setPage]);
  const { start, end } = pageBounds(page, sorted.length, size);
  const windowed = shouldWindow(size, sorted.length);

  // Layout: the scroll container, the sticky block's height (so the headers stick right under it), and whether
  // the table is wider than the screen.
  const frameRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [headAt, setHeadAt] = useState<number | null>(null);
  const [stuck, setStuck] = useState(false);
  const [wide, setWide] = useState(false);
  const [viewWidth, setViewWidth] = useState<number | null>(null);
  const [shift, setShift] = useState(0);
  const shiftRef = useRef(0);
  useLayoutEffect(() => {
    const top = topRef.current;
    const wrap = wrapRef.current;
    const scroller = scrollerOf(frameRef.current);
    const measure = () => {
      if (stickyOn && top) {
        // The block's own top without any shift, then the shift for a block too tall for the screen.
        const base = (parseFloat(getComputedStyle(top).top) || 0) + shiftRef.current;
        const filtersEl = top.querySelector<HTMLElement>(":scope > .table-top__filters");
        const next = stickyShift({ blockHeight: top.offsetHeight, filtersHeight: filtersEl?.offsetHeight ?? 0, viewport: scroller?.clientHeight ?? 0 });
        shiftRef.current = next;
        setShift(next);
        setHeadAt(headTop(base - next, top.offsetHeight));
      }
      // Wider than the screen: the table keeps its minimum width and the screen scrolls sideways, while the filters,
      // toolbar and pager stay at the screen's width (sticky to the left edge).
      const table = wrap?.firstElementChild as HTMLElement | null | undefined;
      if (!stickyOn || !scroller || !table) { setWide(false); return; }
      const cs = getComputedStyle(scroller);
      const view = scroller.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      const min = parseFloat(getComputedStyle(table).minWidth);
      setViewWidth(view > 0 ? Math.floor(view) : null);
      setWide(Number.isFinite(min) && view > 0 && min > view + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    if (top) ro.observe(top);
    if (scroller) ro.observe(scroller);
    return () => ro.disconnect();
  }, [stickyOn, rows.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = sentinel.current;
    if (!stickyOn || !el || typeof IntersectionObserver === "undefined") return undefined;
    // The sentinel sits just above the sticky block: once it scrolls out of view, the block is stuck (as in Tabs).
    const io = new IntersectionObserver(([e]) => setStuck(!!e && !e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 1), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [stickyOn]);

  // Windowing: with "All" and a long list, only the rows in view (plus a margin) are in the page.
  const densityHeight = prefs.density === "compact" ? 32 : 48;
  const [rowHeight, setRowHeight] = useState(densityHeight);
  const [win, setWin] = useState({ first: 0, last: 60 });
  useEffect(() => {
    if (!windowed) return undefined;
    const scroller = scrollerOf(frameRef.current);
    const update = () => {
      const body = bodyRef.current;
      if (!body) return;
      const sTop = scroller ? scroller.scrollTop : window.scrollY;
      const sRect = scroller ? scroller.getBoundingClientRect().top : 0;
      const bodyTop = body.getBoundingClientRect().top - sRect + sTop;
      const measured = body.querySelector<HTMLElement>("tr.table__row")?.offsetHeight;
      const h = measured && measured > 0 ? measured : densityHeight;
      setRowHeight(h);
      const viewport = scroller ? scroller.clientHeight : window.innerHeight;
      const next = windowRange({ scrollTop: sTop, viewport: viewport || 900, bodyTop, rowHeight: h, count: sorted.length });
      setWin((w) => (w.first === next.first && w.last === next.last ? w : next));
    };
    update();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { target.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [windowed, sorted.length, densityHeight]);
  const shownFrom = windowed ? win.first : start;
  const shownTo = windowed ? Math.min(win.last, sorted.length) : end;
  const shown = sorted.slice(shownFrom, shownTo);

  // Focus that has to wait for a page change or for a windowed row to render.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingFocus.current) return;
    const el = rowEls.current.get(pendingFocus.current);
    if (el) { el.focus(); pendingFocus.current = null; }
  });

  const pageTo = (p: number, opts: { scroll?: boolean } = {}) => {
    const next = clampPage(p, sorted.length, size);
    if (next !== page) setPage(next);
    if (opts.scroll) scrollToTop(frameRef.current);
  };

  const bar = id || toolbar ? (
    <div className="table-toolbar">
      <div className="table-toolbar__start">{toolbar}</div>
      {id ? <TableSettings columns={withEmpty} prefs={prefs} autoHidden={autoHidden} onChange={setPrefs} /> : null}
    </div>
  ) : null;
  const minAll = tableMinWidth(columns), minNarrow = tableMinWidth(columns, true);
  const frameStyle = headAt === null && viewWidth === null && minAll === null ? undefined : ({
    ...(headAt === null ? {} : { "--table-head-top": `${headAt}px` }),
    ...(viewWidth === null ? {} : { "--table-view-width": `${viewWidth}px` }),
    ...(minAll === null ? {} : { "--table-min": minAll, "--table-min-narrow": minNarrow ?? minAll }),
  } as CSSProperties);
  const frameClass = cx("table-frame", stickyOn && "table-frame--sticky", stuck && "is-stuck", wide && "is-wide");
  const top = filters || bar ? (
    <>
      {stickyOn ? <div ref={sentinel} className="table-frame__sentinel" aria-hidden="true" /> : null}
      <div ref={topRef} className={cx("table-top", stickyOn && "table-top--sticky", stuck && "is-stuck")} data-stuck={stuck || undefined}
        style={shift ? { top: `calc(var(--tabs-sticky-offset, 0px) * -1 - ${shift}px)` } : undefined}>
        {filters ? <div className="table-top__filters">{filters}</div> : null}{bar}
      </div>
    </>
  ) : null;
  if (!rows.length) return <div ref={frameRef} className={frameClass} style={frameStyle}>{top}<p className="table-empty t-body-sm t-muted">{emptyText}</p></div>;

  const openIndex = openKey === null ? -1 : sorted.findIndex((r) => rowKey(r) === openKey);
  const openRow = openIndex >= 0 ? sorted[openIndex]! : null;

  const sortable = (c: Column<T>) => c.sortable ?? !!(c.sortValue ?? c.text);
  const activate = (r: T) => (onRowActivate ? onRowActivate(r) : setOpenKey(rowKey(r)));
  // First click sorts in the column's natural direction, the second reverses it, the third
  // goes back to the order the screen gave (or its default sort).
  const clickSort = (c: Column<T>) => {
    const first = c.firstSort ?? "asc";
    // A new order starts again at page 1.
    if (page !== 1) setPage(1);
    setSort((s) => {
      if (!s || s.key !== c.key) return { key: c.key, dir: first };
      if (s.dir === first) return { key: c.key, dir: first === "asc" ? "desc" : "asc" };
      return defaultSort && defaultSort.key !== c.key ? defaultSort : null;
    });
  };
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, r: T) => {
    const hit = (e.target as HTMLElement).closest(INTERACTIVE);
    if (hit && e.currentTarget.contains(hit)) return;
    activate(r);
  };
  // Moves focus to row `to` of the whole sorted list: turns the page, or scrolls a windowed list, when it has to.
  const focusRow = (to: number) => {
    const key = rowKey(sorted[to]!);
    const el = rowEls.current.get(key);
    if (el) { el.focus(); return; }
    pendingFocus.current = key;
    if (size !== "all") { setPage(pageOf(to, size)); return; }
    const scroller = scrollerOf(frameRef.current);
    const body = bodyRef.current;
    if (scroller && body) {
      const bodyTop = body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, bodyTop + to * rowHeight - scroller.clientHeight / 3);
    }
    setWin(windowRange({ scrollTop: to * rowHeight, viewport: 900, bodyTop: 0, rowHeight, count: sorted.length }));
  };
  // Up and Down step through every row (across pages); Home and End go to the ends of the page; Page Up and
  // Page Down turn the page.
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, r: T, i: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") { e.preventDefault(); activate(r); return; }
    const pages = pageCount(sorted.length, size);
    const lastOnPage = size === "all" ? sorted.length - 1 : end - 1;
    const firstOnPage = size === "all" ? 0 : start;
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? firstOnPage : e.key === "End" ? lastOnPage
      : e.key === "PageDown" && size !== "all" && page < pages ? page * size
      : e.key === "PageUp" && size !== "all" && page > 1 ? (page - 2) * size : null;
    if (to === null || to < 0 || to >= sorted.length) return;
    e.preventDefault();
    focusRow(to);
  };

  // Stepping through the drawer turns the page with it, so closing the drawer lands on the row it showed.
  const stepOpen = (to: number) => {
    setOpenKey(rowKey(sorted[to]!));
    if (size !== "all" && pageOf(to, size) !== page) setPage(pageOf(to, size));
  };
  const fieldsFor = (r: T): DetailField[] =>
    columns.filter((c) => c.inDetail !== false).map((c) => ({ label: c.header, value: c.detail ? c.detail(r) : c.text ? c.text(r) : c.render(r) }));
  const d: RowDetail | null = openRow ? (detail ? detail(openRow) : { title: columns[0]?.text?.(openRow) || caption }) : null;

  return (
    <div ref={frameRef} className={frameClass} style={frameStyle}>
      {top}
      <div ref={wrapRef} className="table-scroll">
      <table className={cx("table", `table--${prefs.density}`, windowed && "table--windowed")} aria-rowcount={windowed ? sorted.length + 1 : undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>{columns.map((c) => {
            const active = sort?.key === c.key ? sort.dir : null;
            return (
              <th key={c.key} scope="col" className={cx("t-label", c.align === "end" && "is-end", c.align === "center" && "is-center", c.priority === "low" && "is-low")} style={c.width ? { width: c.width } : undefined}
                aria-sort={active ? (active === "asc" ? "ascending" : "descending") : undefined}>
                {sortable(c) ? (
                  <button type="button" className={cx("table__sort", active && "is-active")} onClick={() => clickSort(c)}>
                    <span>{c.header}</span>
                    <Icon icon={active === "asc" ? Icons.sortAsc : active === "desc" ? Icons.sortDesc : Icons.sortNone} size="sm" className="table__sort-icon" />
                  </button>
                ) : c.header}
              </th>
            );
          })}</tr>
        </thead>
        <tbody ref={bodyRef}>
          {windowed && shownFrom > 0 ? <tr className="table__spacer" aria-hidden="true"><td colSpan={columns.length} style={{ height: shownFrom * rowHeight }} /></tr> : null}
          {shown.map((r, j) => {
            const k = rowKey(r);
            const i = shownFrom + j;
            return (
              <tr
                key={k}
                aria-rowindex={windowed ? i + 2 : undefined}
                ref={(el) => { if (el) rowEls.current.set(k, el); else rowEls.current.delete(k); }}
                className={cx("table__row", "table__row--clickable", openKey === k && "is-open", rowClassName?.(r))}
                tabIndex={0}
                onClick={(e) => onRowClick(e, r)}
                onKeyDown={(e) => onRowKey(e, r, i)}
              >
                {columns.map((c) => {
                  const full = c.text?.(r);
                  return (
                    // The full value shows as a tooltip only when the cell is actually cut off.
                    <td key={c.key} className={cx(c.align === "end" && "is-end", c.align === "center" && "is-center", c.wrap && "is-wrap", c.priority === "low" && "is-low")}
                      onMouseEnter={full ? (e) => tooltipIfCut(e.currentTarget, full) : undefined}>
                      {c.wrap ? <div className="table__clamp">{c.render(r)}</div> : c.render(r)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {windowed && shownTo < sorted.length ? <tr className="table__spacer" aria-hidden="true"><td colSpan={columns.length} style={{ height: (sorted.length - shownTo) * rowHeight }} /></tr> : null}
        </tbody>
      </table>
      </div>
      {paging && sorted.length > PAGER_MIN_ROWS ? (
        <Pager caption={caption} page={page} total={sorted.length} size={size}
          onPage={(p) => pageTo(p, { scroll: true })}
          onSize={(s2) => {
            // Keep the first row on screen in view: the new page is the one that holds it.
            setPrefs({ ...prefs, pageSize: s2 });
            const p = s2 === "all" ? 1 : pageOf(start, s2);
            if (p !== page) setPage(p);
          }} />
      ) : null}
      {openRow && d ? (
        <Drawer
          open
          onClose={() => setOpenKey(null)}
          title={d.title}
          subtitle={d.subtitle}
          actions={d.actions}
          itemLabel={itemLabel}
          position={`${openIndex + 1} of ${sorted.length}`}
          onPrev={openIndex > 0 ? () => stepOpen(openIndex - 1) : undefined}
          onNext={openIndex < sorted.length - 1 ? () => stepOpen(openIndex + 1) : undefined}
          returnFocus={() => (openKey ? rowEls.current.get(openKey) : null)}
        >
          <DetailList fields={d.fields ?? fieldsFor(openRow)} />
          {d.children}
        </Drawer>
      ) : null}
    </div>
  );
}

/** The nearest ancestor that scrolls vertically (the app's main area), or null for the window. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/** After a page turn, bring the start of the table back into view if it scrolled away (the sticky block stays put). */
function scrollToTop(frame: HTMLElement | null): void {
  const scroller = scrollerOf(frame);
  if (!frame || !scroller) return;
  const pad = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
  const at = frame.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - pad;
  // Only scroll up: the rows start under the sticky block, so a page turn lands on the first row.
  if (scroller.scrollTop > at) scroller.scrollTop = Math.max(0, at);
}

const SIZE_LABEL = (s: PageSize) => (s === "all" ? "All" : String(s));

/** The footer: "1–50 of 127", rows per page, and Previous, page numbers, Next. Left and Right arrows turn the page. */
function Pager({ caption, page, total, size, onPage, onSize }: { caption: string; page: number; total: number; size: PageSize; onPage: (p: number) => void; onSize: (s: PageSize) => void }) {
  const count = pageCount(total, size);
  const navRef = useRef<HTMLDivElement>(null);
  const sizeId = useId();
  const go = (p: number) => {
    if (p < 1 || p > count) return;
    onPage(p);
    // Keep keyboard focus on the pager: on the new page's button once it renders.
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLButtonElement>(`[data-page="${p}"]`)?.focus({ preventScroll: true }));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); go(page - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(page + 1); }
    else if (e.key === "Home") { e.preventDefault(); go(1); }
    else if (e.key === "End") { e.preventDefault(); go(count); }
  };
  return (
    <nav className="table-pager" aria-label={`${caption} pages`}>
      <span className="table-pager__range t-body-sm" aria-live="polite">{rangeText(page, total, size)}</span>
      <span className="table-pager__size">
        <label htmlFor={sizeId} className="t-body-sm t-muted">Rows per page</label>
        <select id={sizeId} className="table-pager__select" value={String(size)} onChange={(e) => onSize(e.target.value === "all" ? "all" : (Number(e.target.value) as PageSize))}>
          {PAGE_SIZES.map((s) => <option key={String(s)} value={String(s)}>{SIZE_LABEL(s)}</option>)}
        </select>
      </span>
      {count > 1 ? (
        <div className="table-pager__pages" ref={navRef} onKeyDown={onKey}>
          {/* A disabled button says why, as a tooltip and to screen readers. */}
          <span id={`${sizeId}-first`} hidden>This is the first page.</span>
          <span id={`${sizeId}-last`} hidden>This is the last page.</span>
          <button type="button" className="table-pager__btn" onClick={() => go(page - 1)} disabled={page === 1}
            title={page === 1 ? "This is the first page." : undefined} aria-describedby={page === 1 ? `${sizeId}-first` : undefined} aria-label="Previous page">
            <Icon icon={Icons.stepPrev} size="sm" /><span className="table-pager__word">Previous</span>
          </button>
          {pageList(page, count).map((n, i) => (n === "gap"
            ? <span key={`gap-${i}`} className="table-pager__gap" aria-hidden="true">…</span>
            : (
              <button key={n} type="button" data-page={n} className="table-pager__btn table-pager__num" aria-current={n === page ? "page" : undefined}
                aria-label={`Page ${n}`} onClick={() => go(n)}>{n}</button>
            )))}
          <button type="button" className="table-pager__btn" onClick={() => go(page + 1)} disabled={page === count}
            title={page === count ? "This is the last page." : undefined} aria-describedby={page === count ? `${sizeId}-last` : undefined} aria-label="Next page">
            <span className="table-pager__word">Next</span><Icon icon={Icons.stepNext} size="sm" />
          </button>
        </div>
      ) : null}
    </nav>
  );
}

/** Sets the cell's tooltip to its full value only when the cell (or a clamped/truncated part of it) is cut off. */
function tooltipIfCut(td: HTMLElement, full: string): void {
  const parts = [td, ...td.querySelectorAll<HTMLElement>(".table__clamp, [data-truncate]")];
  if (parts.some((p) => isTruncated(p))) td.title = full;
  else td.removeAttribute("title");
}

/** Columns (checkboxes, Reset) and Density (Comfortable / Compact) in the table's toolbar. */
function TableSettings<T>({ columns, prefs, autoHidden, onChange }: { columns: Column<T>[]; prefs: TablePrefs; autoHidden: Set<string>; onChange: (p: TablePrefs) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: globalThis.MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const toggle = (key: string) => onChange({ ...prefs, hidden: prefs.hidden.includes(key) ? prefs.hidden.filter((k) => k !== key) : [...prefs.hidden, key] });
  const density = (d: Density) => onChange({ ...prefs, density: d });
  return (
    <div className="table-settings" ref={ref}>
      <div className="table-density" role="group" aria-label="Row density">
        {(["comfortable", "compact"] as const).map((d) => (
          <button key={d} type="button" className="table-density__btn" aria-pressed={prefs.density === d} onClick={() => density(d)}>{d === "comfortable" ? "Comfortable" : "Compact"}</button>
        ))}
      </div>
      <button type="button" className="table-settings__btn" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)}>
        <Icon icon={Icons.settings} size="sm" />Columns
      </button>
      {open ? (
        <div className="table-settings__menu" id={menuId} role="group" aria-label="Columns">
          {columns.filter((c) => c.header).map((c) => (
            <label key={c.key} className="checkbox table-settings__item">
              <input type="checkbox" checked={c.alwaysOn || !prefs.hidden.includes(c.key)} disabled={c.alwaysOn} onChange={() => toggle(c.key)} />
              {c.header}{autoHidden.has(c.key) ? <span className="t-muted"> (empty)</span> : null}{c.alwaysOn ? <span className="t-muted"> (always shown)</span> : null}
            </label>
          ))}
          <button type="button" className="table-settings__reset" onClick={() => onChange({ ...DEFAULT_PREFS, pageSize: prefs.pageSize })}>Reset</button>
        </div>
      ) : null}
    </div>
  );
}
