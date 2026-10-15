import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DetailList, Drawer, Table, type Column } from "../src";

interface R { id: string; name: string; score: number | null; note: string }
const ROWS: R[] = [
  { id: "a", name: "Acme Corp", score: 70, note: "Ad says 482 sponsorship is considered for senior roles" },
  { id: "b", name: "Example Labs", score: null, note: "" },
  { id: "c", name: "Acme Recruiting", score: 95, note: "Recruiter confirmed sponsorship" },
];
const COLS: Column<R>[] = [
  { key: "name", header: "Employer", render: (r) => r.name, text: (r) => r.name },
  { key: "score", header: "Score", align: "end", render: (r) => r.score ?? "–", sortValue: (r) => r.score, firstSort: "desc" },
  { key: "note", header: "Latest evidence", render: (r) => r.note, text: (r) => r.note },
];
const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1) as HTMLTableRowElement[];
const names = () => bodyRows().map((r) => r.cells[0]!.textContent);

describe("Table", () => {
  it("opens a row by click and by Enter when a page handler is given", async () => {
    const onRow = vi.fn();
    render(<Table caption="Jobs" rows={ROWS} rowKey={(r) => r.id} columns={COLS} onRowActivate={onRow} />);
    await userEvent.click(screen.getByText("Acme Corp"));
    bodyRows()[1]!.focus();
    await userEvent.keyboard("{Enter}");
    expect(onRow.mock.calls.map((c) => c[0].id)).toEqual(["a", "b"]);
    expect(bodyRows()[0]).toHaveAttribute("tabindex", "0");
    expect(bodyRows()[0]!.className).toContain("table__row--clickable");
  });

  it("moves between rows with the arrow keys", async () => {
    render(<Table caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={COLS} />);
    bodyRows()[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(bodyRows()[1]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(bodyRows()[0]).toHaveFocus();
  });

  it("opens a detail drawer with every field when no page exists, steps with prev/next and restores focus", async () => {
    render(<Table caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={COLS} itemLabel="employer" />);
    bodyRows()[0]!.focus();
    await userEvent.keyboard("{Enter}");
    const drawer = screen.getByRole("dialog", { name: "Acme Corp" });
    const terms = within(drawer).getAllByRole("term").map((t) => t.textContent);
    expect(terms).toEqual(["Employer", "Score", "Latest evidence"]);
    expect(within(drawer).getByText("Ad says 482 sponsorship is considered for senior roles")).toBeInTheDocument();
    expect(within(drawer).getByText("1 of 3")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Previous employer" })).toBeDisabled();

    await userEvent.click(within(drawer).getByRole("button", { name: "Next employer" }));
    const next = screen.getByRole("dialog", { name: "Example Labs" });
    // An empty value is said plainly, never left blank.
    expect(within(next).getByText("Not recorded")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Focus returns to the row now shown, not the one first opened.
    expect(bodyRows()[1]).toHaveFocus();
  });

  it("P5: never puts aria-haspopup on a <tr> (not an allowed role for it)", () => {
    render(<Table caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={COLS} />);
    for (const row of bodyRows()) expect(row).not.toHaveAttribute("aria-haspopup");
  });

  it("ignores clicks on buttons inside a row", async () => {
    const onRow = vi.fn();
    const cols: Column<R>[] = [...COLS, { key: "x", header: "Open", render: () => <button type="button">Open source</button> }];
    render(<Table caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={cols} onRowActivate={onRow} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Open source" })[0]!);
    expect(onRow).not.toHaveBeenCalled();
  });

  it("sorts on header click with aria-sort, keeping empty values last", async () => {
    render(<Table caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={COLS} />);
    const nameHead = screen.getByRole("columnheader", { name: /Employer/ });
    const scoreHead = screen.getByRole("columnheader", { name: /Score/ });
    expect(nameHead).not.toHaveAttribute("aria-sort");

    await userEvent.click(within(nameHead).getByRole("button"));
    expect(nameHead).toHaveAttribute("aria-sort", "ascending");
    expect(names()).toEqual(["Acme Corp", "Acme Recruiting", "Example Labs"]);
    await userEvent.click(within(nameHead).getByRole("button"));
    expect(nameHead).toHaveAttribute("aria-sort", "descending");
    expect(names()).toEqual(["Example Labs", "Acme Recruiting", "Acme Corp"]);

    // Numbers start high-to-low (firstSort: "desc"), and a missing score sorts last either way.
    await userEvent.click(within(scoreHead).getByRole("button"));
    expect(scoreHead).toHaveAttribute("aria-sort", "descending");
    expect(nameHead).not.toHaveAttribute("aria-sort");
    expect(names()).toEqual(["Acme Recruiting", "Acme Corp", "Example Labs"]);
    await userEvent.click(within(scoreHead).getByRole("button"));
    expect(names()).toEqual(["Acme Corp", "Acme Recruiting", "Example Labs"]);
    // A third click returns to the original order.
    await userEvent.click(within(scoreHead).getByRole("button"));
    expect(scoreHead).not.toHaveAttribute("aria-sort");
    expect(names()).toEqual(["Acme Corp", "Example Labs", "Acme Recruiting"]);
  });

  it("shows a cell's full value as a tooltip only when the cell is cut off", async () => {
    render(<Table caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={COLS} />);
    const cut = bodyRows()[0]!.cells[2]!;
    const fits = bodyRows()[2]!.cells[0]!;
    Object.defineProperty(cut, "scrollWidth", { configurable: true, value: 400 });
    Object.defineProperty(cut, "clientWidth", { configurable: true, value: 120 });
    await userEvent.hover(cut);
    expect(cut).toHaveAttribute("title", "Ad says 482 sponsorship is considered for senior roles");
    await userEvent.hover(fits);
    expect(fits).not.toHaveAttribute("title");
  });

  it("puts the sort icon after the header text, numbers included", () => {
    render(<Table caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={COLS} />);
    const score = screen.getByRole("button", { name: "Score" });
    expect(score.firstElementChild?.tagName).toBe("SPAN");
    expect(score.lastElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("hides a column whose values are all empty, and lists it as (empty) in Columns", async () => {
    const cols: Column<R>[] = [{ ...COLS[0]!, alwaysOn: true }, COLS[1]!, { ...COLS[2]!, hideWhenEmpty: true }];
    const rows = ROWS.map((r) => ({ ...r, note: "" }));
    render(<Table id="t-empty" caption="Sponsors" rows={rows} rowKey={(r) => r.id} columns={cols} />);
    expect(screen.queryByRole("columnheader", { name: /Latest evidence/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.getByRole("group", { name: "Columns" })).toHaveTextContent("Latest evidence (empty)");
    expect(screen.getByRole("checkbox", { name: /Employer/ })).toBeDisabled();
  });

  it("remembers hidden columns and density per table, with Reset", async () => {
    localStorage.clear();
    const { unmount } = render(<Table id="t-prefs" caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={COLS} />);
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Score" }));
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(screen.queryByRole("columnheader", { name: /Score/ })).toBeNull();
    unmount();
    render(<Table id="t-prefs" caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={COLS} />);
    expect(screen.queryByRole("columnheader", { name: /Score/ })).toBeNull();
    expect(screen.getByRole("table")).toHaveClass("table--compact");
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("columnheader", { name: /Score/ })).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveClass("table--comfortable");
  });

  it("uses a custom detail when given", async () => {
    render(<Table caption="Sponsors" rows={ROWS} rowKey={(r) => r.id} columns={COLS}
      detail={(r) => ({ title: `${r.name} details`, fields: [{ label: "Name", value: r.name }], children: <p>Extra section</p> })} />);
    await userEvent.click(screen.getByText("Acme Corp"));
    const d = screen.getByRole("dialog", { name: "Acme Corp details" });
    expect(within(d).getByText("Extra section")).toBeInTheDocument();
    expect(within(d).getAllByRole("term").map((t) => t.textContent)).toEqual(["Name"]);
  });

  it("shows the empty message", () => {
    render(<Table caption="Jobs" rows={[] as R[]} rowKey={(r) => r.id} columns={COLS} emptyText="No jobs match." />);
    expect(screen.getByText("No jobs match.")).toBeInTheDocument();
  });
});

describe("Drawer", () => {
  it("traps focus, closes on Escape and restores focus", async () => {
    function D() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button>
        <Drawer open={open} onClose={() => setOpen(false)} title="Acme Corp"><a href="https://example.com">Source</a></Drawer></>;
    }
    render(<D />);
    await userEvent.click(screen.getByText("Open"));
    const d = screen.getByRole("dialog", { name: "Acme Corp" });
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(d.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      expect(d.contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(d.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Open")).toHaveFocus();
  });

  it("DetailList renders labels and values, and says when a value is missing", () => {
    render(<DetailList fields={[{ label: "Status", value: "Verified sponsor" }, { label: "QLD", value: "" }, { label: "Jobs", value: 0 }]} />);
    expect(screen.getAllByRole("term").map((t) => t.textContent)).toEqual(["Status", "QLD", "Jobs"]);
    expect(screen.getAllByRole("definition").map((t) => t.textContent)).toEqual(["Verified sponsor", "Not recorded", "0"]);
  });
});

describe("tableMinWidth", () => {
  it("fits the flexible column's minimum next to the fixed ones, and drops low-priority columns when narrow", async () => {
    const { tableMinWidth } = await import("../src/components/Table");
    const cols = [
      { key: "role", header: "Role", minWidth: "16rem", render: () => null },
      { key: "where", header: "Location", width: "10rem", priority: "low" as const, render: () => null },
      { key: "fit", header: "Fit", width: "5rem", render: () => null },
    ];
    expect(tableMinWidth(cols)).toBe("calc(16rem + 10rem + 5rem)");
    expect(tableMinWidth(cols, true)).toBe("calc(16rem + 5rem)");
    expect(tableMinWidth(cols.map(({ minWidth: _m, ...c }) => c))).toBeNull();
  });
});
