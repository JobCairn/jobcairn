import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Table, type Column } from "../src";
import { loadPrefs } from "../src/components/table-prefs";
import {
  WINDOW_MIN_ROWS, clampPage, stickyShift, headTop, pageBounds, pageCount, pageList, pageOf, rangeText, shouldWindow, windowRange,
} from "../src/components/table-paging";

interface R { id: string; name: string; n: number }
const make = (count: number): R[] => Array.from({ length: count }, (_, i) => ({ id: `r${i + 1}`, name: `Company ${i + 1}`, n: i + 1 }));
const COLS: Column<R>[] = [
  { key: "name", header: "Name", render: (r) => r.name, text: (r) => r.name, sortValue: (r) => r.n },
  { key: "n", header: "Number", align: "end", render: (r) => r.n, sortValue: (r) => r.n, firstSort: "desc" },
];
const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1).filter((r) => !r.classList.contains("table__spacer")) as HTMLTableRowElement[];
const names = () => bodyRows().map((r) => r.cells[0]!.textContent);
const pager = () => screen.getByRole("navigation", { name: "Companies pages" });

afterEach(() => localStorage.clear());

describe("paging maths", () => {
  it("counts pages and clamps a page to what exists", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(127, 50)).toBe(3);
    expect(pageCount(127, "all")).toBe(1);
    expect(clampPage(9, 127, 50)).toBe(3);
    expect(clampPage(0, 127, 50)).toBe(1);
    expect(clampPage(Number.NaN, 127, 50)).toBe(1);
    expect(clampPage(2.7, 127, 50)).toBe(2);
  });
  it("gives each page's rows and says the range like 1–50 of 127", () => {
    expect(pageBounds(3, 127, 50)).toEqual({ start: 100, end: 127 });
    expect(pageBounds(1, 127, "all")).toEqual({ start: 0, end: 127 });
    expect(rangeText(1, 127, 50)).toBe("1–50 of 127");
    expect(rangeText(3, 127, 50)).toBe("101–127 of 127");
    expect(rangeText(1, 1, 25)).toBe("1–1 of 1");
    expect(rangeText(1, 0, 25)).toBe("0 of 0");
    expect(rangeText(1, 1000, "all")).toBe("1–1000 of 1000");
  });
  it("lists page numbers with gaps, always keeping the first, last and neighbours", () => {
    expect(pageList(1, 3)).toEqual([1, 2, 3]);
    expect(pageList(1, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageList(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
    expect(pageList(20, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
  });
  it("finds the page that holds a row", () => {
    expect(pageOf(0, 50)).toBe(1);
    expect(pageOf(49, 50)).toBe(1);
    expect(pageOf(50, 50)).toBe(2);
    expect(pageOf(999, "all")).toBe(1);
  });
  it("windows only All lists longer than the threshold", () => {
    expect(shouldWindow("all", WINDOW_MIN_ROWS)).toBe(false);
    expect(shouldWindow("all", WINDOW_MIN_ROWS + 1)).toBe(true);
    expect(shouldWindow(100, 1000)).toBe(false);
  });
  it("renders the rows in view plus a margin", () => {
    expect(windowRange({ scrollTop: 0, viewport: 480, bodyTop: 200, rowHeight: 48, count: 1000, overscan: 5 })).toEqual({ first: 0, last: 15 });
    // 4800 px past the body's top is row 100.
    expect(windowRange({ scrollTop: 5000, viewport: 480, bodyTop: 200, rowHeight: 48, count: 1000, overscan: 5 })).toEqual({ first: 95, last: 115 });
    expect(windowRange({ scrollTop: 1e7, viewport: 480, bodyTop: 0, rowHeight: 48, count: 1000, overscan: 5 }).last).toBe(1000);
  });
  it("lets the filter rows scroll away when the block would cover more than 40% of the screen", () => {
    expect(stickyShift({ blockHeight: 210, filtersHeight: 150, viewport: 768 })).toBe(0);
    expect(stickyShift({ blockHeight: 257, filtersHeight: 200, viewport: 600 })).toBe(200);
    expect(stickyShift({ blockHeight: 257, filtersHeight: 0, viewport: 600 })).toBe(0);
    expect(stickyShift({ blockHeight: 257, filtersHeight: 200, viewport: 0 })).toBe(0);
  });
  it("sticks the headers right under the sticky block", () => {
    // The block's top cancels 32 px of padding; it's 120 px tall.
    expect(headTop(-32, 120)).toBe(88);
    expect(headTop(0, 57.6)).toBe(58);
  });
});

describe("Table paging", () => {
  it("shows 50 rows with a footer, and moves through pages with Previous, Next and the numbers", async () => {
    render(<Table caption="Companies" id="companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} />);
    expect(bodyRows()).toHaveLength(50);
    expect(within(pager()).getByText("1–50 of 127")).toBeInTheDocument();
    expect(within(pager()).getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(within(pager()).getByRole("button", { name: "Previous page" })).toHaveAttribute("title", "This is the first page.");
    expect(within(pager()).getByRole("button", { name: "Previous page" })).toHaveAccessibleDescription("This is the first page.");
    await userEvent.click(within(pager()).getByRole("button", { name: "Next page" }));
    expect(names()[0]).toBe("Company 51");
    await userEvent.click(within(pager()).getByRole("button", { name: "Page 3" }));
    expect(bodyRows()).toHaveLength(27);
    expect(within(pager()).getByRole("button", { name: "Page 3" })).toHaveAttribute("aria-current", "page");
    expect(within(pager()).getByText("101–127 of 127")).toBeInTheDocument();
    expect(within(pager()).getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(within(pager()).getByRole("button", { name: "Next page" })).toHaveAccessibleDescription("This is the last page.");
  });

  it("turns pages with the arrow keys on the pager", async () => {
    render(<Table caption="Companies" id="companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} />);
    within(pager()).getByRole("button", { name: "Page 1" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(names()[0]).toBe("Company 51");
    await userEvent.keyboard("{End}");
    expect(names()[0]).toBe("Company 101");
    await userEvent.keyboard("{ArrowLeft}{Home}");
    expect(names()[0]).toBe("Company 1");
  });

  it("remembers the rows per page for this table, and keeps the first row in view when it changes", async () => {
    const { unmount } = render(<Table caption="Companies" id="companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} />);
    await userEvent.click(within(pager()).getByRole("button", { name: "Next page" }));
    await userEvent.selectOptions(within(pager()).getByLabelText("Rows per page"), "25");
    // Row 51 was first on screen; with 25 a page it's on page 3.
    expect(names()[0]).toBe("Company 51");
    expect(bodyRows()).toHaveLength(25);
    expect(loadPrefs("companies").pageSize).toBe(25);
    unmount();
    render(<Table caption="Companies" id="companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} />);
    expect(bodyRows()).toHaveLength(25);
    expect(loadPrefs("jobs").pageSize).toBe(50);
  });

  it("hides the footer for short lists and for tables that don't page", () => {
    const { rerender } = render(<Table caption="Companies" id="companies" rows={make(25)} rowKey={(r) => r.id} columns={COLS} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    rerender(<Table caption="Companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(bodyRows()).toHaveLength(127);
    rerender(<Table caption="Companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} paginate />);
    expect(bodyRows()).toHaveLength(50);
  });

  it("opens on the page it's given, reports page changes, and survives rows arriving late", async () => {
    const onPage = vi.fn();
    const { rerender } = render(<Table caption="Companies" id="companies" rows={[] as R[]} rowKey={(r) => r.id} columns={COLS} page={2} onPageChange={onPage} />);
    rerender(<Table caption="Companies" id="companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} page={2} onPageChange={onPage} />);
    expect(names()[0]).toBe("Company 51");
    expect(onPage).not.toHaveBeenCalled();
    await userEvent.click(within(pager()).getByRole("button", { name: "Page 3" }));
    expect(onPage).toHaveBeenLastCalledWith(3);
  });

  it("goes back to page 1 when the filters or the sort change, not when the rows reload", async () => {
    const onPage = vi.fn();
    const el = (rows: R[], key: string) => <Table caption="Companies" id="companies" rows={rows} rowKey={(r) => r.id} columns={COLS} page={3} onPageChange={onPage} resetKey={key} />;
    const { rerender } = render(el(make(127), "a"));
    expect(names()[0]).toBe("Company 101");
    rerender(el(make(127).map((r) => ({ ...r })), "a"));
    expect(names()[0]).toBe("Company 101");
    rerender(el(make(127), "b"));
    expect(names()[0]).toBe("Company 1");
    expect(onPage).toHaveBeenLastCalledWith(1);
    await userEvent.click(within(pager()).getByRole("button", { name: "Page 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Number" }));
    expect(names()[0]).toBe("Company 127");
    expect(onPage).toHaveBeenLastCalledWith(1);
  });

  it("follows a new page from outside (a link to the same list), but not its own echo", () => {
    const el = (page: number | undefined) => <Table caption="Companies" id="companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} page={page} />;
    const { rerender } = render(el(2));
    expect(names()[0]).toBe("Company 51");
    rerender(el(2));
    expect(names()[0]).toBe("Company 51");
    rerender(el(undefined));
    expect(names()[0]).toBe("Company 1");
    rerender(el(3));
    expect(names()[0]).toBe("Company 101");
  });

  it("shows the last page when the list shrinks under the current one", () => {
    const onPage = vi.fn();
    const { rerender } = render(<Table caption="Companies" id="companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} page={3} onPageChange={onPage} />);
    rerender(<Table caption="Companies" id="companies" rows={make(60)} rowKey={(r) => r.id} columns={COLS} page={3} onPageChange={onPage} />);
    expect(names()[0]).toBe("Company 51");
    expect(onPage).toHaveBeenLastCalledWith(2);
  });

  it("steps through rows across a page edge with the arrow keys, and turns pages with Page Down and Page Up", async () => {
    render(<Table caption="Companies" id="companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} />);
    bodyRows()[49]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(names()[0]).toBe("Company 51");
    expect(document.activeElement?.textContent).toContain("Company 51");
    await userEvent.keyboard("{End}");
    expect(document.activeElement?.textContent).toContain("Company 100");
    await userEvent.keyboard("{PageDown}");
    expect(document.activeElement?.textContent).toContain("Company 101");
    await userEvent.keyboard("{PageUp}{PageUp}");
    expect(document.activeElement?.textContent).toContain("Company 1");
    expect(names()[0]).toBe("Company 1");
  });

  it("follows the drawer's Next across a page edge, so closing it lands on that row's page", async () => {
    render(<Table caption="Companies" id="companies" rows={make(127)} rowKey={(r) => r.id} columns={COLS} itemLabel="company" />);
    await userEvent.click(screen.getByText("Company 50"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("50 of 127")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Next company/ }));
    expect(within(screen.getByRole("dialog")).getByText("51 of 127")).toBeInTheDocument();
    expect(names()[0]).toBe("Company 51");
  });
});

describe("Table windowing", () => {
  it("renders every row with All up to the threshold, and only a window beyond it", async () => {
    localStorage.setItem("careeros.table.companies", JSON.stringify({ hidden: [], density: "comfortable", pageSize: "all" }));
    const { rerender } = render(<Table caption="Companies" id="companies" rows={make(WINDOW_MIN_ROWS)} rowKey={(r) => r.id} columns={COLS} />);
    expect(bodyRows()).toHaveLength(WINDOW_MIN_ROWS);
    rerender(<Table caption="Companies" id="companies" rows={make(1000)} rowKey={(r) => r.id} columns={COLS} />);
    const shown = bodyRows().length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(150);
    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("aria-rowcount", "1001");
    expect(table.className).toContain("table--windowed");
    // The bottom spacer stands in for the rows not rendered, so the scrollbar has the full list's height.
    const spacer = table.querySelector<HTMLElement>("tr.table__spacer:last-child td")!;
    expect(parseInt(spacer.style.height, 10)).toBe((1000 - shown) * 48);
    expect(bodyRows()[0]).toHaveAttribute("aria-rowindex", "2");
    expect(within(pager()).getByText("1–1000 of 1000")).toBeInTheDocument();
  });

  it("brings a row into view to focus it with End in a windowed list", async () => {
    localStorage.setItem("careeros.table.companies", JSON.stringify({ hidden: [], density: "compact", pageSize: "all" }));
    render(<Table caption="Companies" id="companies" rows={make(1000)} rowKey={(r) => r.id} columns={COLS} />);
    bodyRows()[0]!.focus();
    await userEvent.keyboard("{End}");
    expect(document.activeElement?.textContent).toContain("Company 1000");
  });
});

describe("Table sticky", () => {
  it("wraps the filters and toolbar in a sticky block, and the headers stick at its measured height", () => {
    const original = window.getComputedStyle;
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, p?: string | null) => {
      const s = original(el, p);
      if ((el as HTMLElement).classList?.contains("table-top")) return { ...s, top: "-32px", getPropertyValue: s.getPropertyValue.bind(s) } as CSSStyleDeclaration;
      return s;
    });
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("table-top") ? 120 : 0; });
    try {
      render(<Table caption="Companies" id="companies" rows={make(3)} rowKey={(r) => r.id} columns={COLS} filters={<input aria-label="Find" />} toolbar={<span>3 companies</span>} />);
      const top = screen.getByLabelText("Find").closest(".table-top")!;
      expect(top.className).toContain("table-top--sticky");
      expect(within(top as HTMLElement).getByText("3 companies")).toBeInTheDocument();
      expect(within(top as HTMLElement).getByRole("button", { name: "Columns" })).toBeInTheDocument();
      const frame = top.closest(".table-frame") as HTMLElement;
      expect(frame.className).toContain("table-frame--sticky");
      expect(frame.style.getPropertyValue("--table-head-top")).toBe("88px");
      // The headers and the rows are one table, so the columns can't drift apart.
      expect(frame.querySelectorAll("table")).toHaveLength(1);
    } finally { spy.mockRestore(); height.mockRestore(); }
  });

  it("marks the block stuck once its sentinel scrolls out of view", () => {
    let fire: ((e: Partial<IntersectionObserverEntry>[]) => void) | undefined;
    const IO = vi.fn(function (this: unknown, cb: (e: Partial<IntersectionObserverEntry>[]) => void) { fire = cb; return { observe: vi.fn(), disconnect: vi.fn() }; });
    vi.stubGlobal("IntersectionObserver", IO);
    try {
      render(<Table caption="Companies" id="companies" rows={make(3)} rowKey={(r) => r.id} columns={COLS} filters={<input aria-label="Find" />} />);
      const top = screen.getByLabelText("Find").closest(".table-top") as HTMLElement;
      expect(top.className).not.toContain("is-stuck");
      act(() => fire!([{ isIntersecting: false, boundingClientRect: { top: -10 } as DOMRectReadOnly, rootBounds: { top: 0 } as DOMRectReadOnly }]));
      expect(top.className).toContain("is-stuck");
      expect(top.closest(".table-frame")!.className).toContain("is-stuck");
      act(() => fire!([{ isIntersecting: true, boundingClientRect: { top: 10 } as DOMRectReadOnly, rootBounds: { top: 0 } as DOMRectReadOnly }]));
      expect(top.className).not.toContain("is-stuck");
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps the filters on screen with no rows, and isn't sticky without an id unless asked", () => {
    const { rerender } = render(<Table caption="Companies" id="companies" rows={[] as R[]} rowKey={(r) => r.id} columns={COLS} filters={<input aria-label="Find" />} emptyText="No companies match." />);
    expect(screen.getByLabelText("Find").closest(".table-top--sticky")).not.toBeNull();
    expect(screen.getByText("No companies match.")).toBeInTheDocument();
    rerender(<Table caption="Companies" rows={make(2)} rowKey={(r) => r.id} columns={COLS} filters={<input aria-label="Find" />} />);
    expect(screen.getByLabelText("Find").closest(".table-top--sticky")).toBeNull();
    rerender(<Table caption="Companies" rows={make(2)} rowKey={(r) => r.id} columns={COLS} filters={<input aria-label="Find" />} sticky />);
    expect(screen.getByLabelText("Find").closest(".table-top--sticky")).not.toBeNull();
  });
});

// A screen that owns its filter, like Companies: typing resets the page through resetKey.
function Filtered() {
  const [q, setQ] = useState("");
  const rows = make(127).filter((r) => r.name.includes(q));
  return <Table caption="Companies" id="companies" rows={rows} rowKey={(r) => r.id} columns={COLS} resetKey={q} page={3}
    filters={<input aria-label="Find" value={q} onChange={(e) => setQ(e.target.value)} />} />;
}
describe("Table with a screen's filters", () => {
  it("resets to page 1 as you filter", () => {
    render(<Filtered />);
    expect(names()[0]).toBe("Company 101");
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "Company 1" } });
    expect(names()[0]).toBe("Company 1");
  });
});
