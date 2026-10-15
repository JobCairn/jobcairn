import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommandBar, Dialog, NavRail, Table, Tabs, ToastProvider, useCommandShortcut, useToast , Icons, hiddenHasCount, navTip, shownInGroup } from "../src";

describe("brand composites", () => {
  it("NavRail marks the current item and navigates", async () => {
    const onNavigate = vi.fn();
    render(<NavRail current="jobs" onNavigate={onNavigate} onOpenCommand={() => undefined} items={[
      { id: "home", label: "Home", icon: Icons.home }, { id: "jobs", label: "Jobs", icon: Icons.jobs, count: 3 },
      { id: "privacy", label: "Privacy", icon: Icons.privacy, section: "secondary", trailing: "Locked" },
    ]} />);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jobs/ })).toHaveAttribute("aria-current", "page");
    await userEvent.click(screen.getByRole("button", { name: /Privacy/ }));
    expect(onNavigate).toHaveBeenCalledWith("privacy");
  });

  it("NavRail groups related items under small labels, with no native tooltips", () => {
    render(<NavRail current="jobs" onNavigate={() => undefined} onOpenCommand={() => undefined} items={[
      { id: "home", label: "Home", icon: Icons.home },
      { id: "jobs", label: "Jobs", icon: Icons.jobs, group: "Find" }, { id: "searches", label: "Searches", icon: Icons.searches, group: "Find" },
      { id: "apply", label: "Applications", icon: Icons.apply, group: "Apply" },
      { id: "settings", label: "Settings", icon: Icons.settings, section: "secondary" },
    ]} />);
    const find = screen.getByRole("group", { name: "Find" });
    expect(Array.from(find.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Jobs", "Searches"]);
    expect(screen.getByRole("group", { name: "Apply" })).toHaveTextContent("Applications");
    expect(screen.getByRole("button", { name: "Home" }).closest("[role=group]")).toBeNull();
    for (const b of screen.getAllByRole("button")) expect(b.querySelector("[title]") ?? (b.hasAttribute("title") && b.className.includes("nav-item") ? b : null)).toBeNull();
    expect(screen.getByRole("button", { name: "Jobs" })).toHaveAttribute("data-tip", "Jobs");
  });

  it("NavRail folds groups (keeping the current item) and collapses to icons with a toggle", async () => {
    const items = [
      { id: "home", label: "Home", icon: Icons.home },
      { id: "jobs", label: "Jobs", icon: Icons.jobs, group: "Find", count: 3 }, { id: "searches", label: "Searches", icon: Icons.searches, group: "Find" },
    ];
    const onGroup = vi.fn();
    const onToggle = vi.fn();
    const { rerender } = render(<NavRail current="searches" onNavigate={() => undefined} onOpenCommand={() => undefined} items={items}
      closedGroups={["Find"]} onToggleGroup={onGroup} onToggleCollapsed={onToggle} toggleShortcut="Ctrl \" />);
    const head = screen.getByRole("button", { name: "Find (has new items)" });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("group", { name: "Find" })).toHaveTextContent(/^Searches$/);
    await userEvent.click(head);
    expect(onGroup).toHaveBeenCalledWith("Find");
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("data-hint", "Collapse sidebar (Ctrl \\)");
    expect(toggle).not.toHaveAttribute("title");
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<NavRail current="searches" onNavigate={() => undefined} onOpenCommand={() => undefined} items={items} collapsed
      closedGroups={["Find"]} onToggleGroup={onGroup} onToggleCollapsed={onToggle} />);
    expect(screen.getByRole("navigation", { name: "Main" })).toHaveClass("is-collapsed");
    // In the icon rail nothing is folded and group headers are only rules.
    expect(screen.queryByRole("button", { name: /^Find/ })).toBeNull();
    expect(screen.getByRole("group", { name: "Find" })).toHaveTextContent("Jobs");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveFocus();
  });

  it("NavRail helpers: what a folded group shows, its dot, and the icon tooltip", () => {
    const items = [{ id: "a", label: "A", icon: Icons.home, count: 2 }, { id: "b", label: "B", icon: Icons.home }];
    expect(shownInGroup(items, "b", true).map((i) => i.id)).toEqual(["b"]);
    expect(shownInGroup(items, "x", true)).toEqual([]);
    expect(shownInGroup(items, "x", false)).toHaveLength(2);
    expect(hiddenHasCount(items, "b")).toBe(true);
    expect(hiddenHasCount(items, "a")).toBe(false);
    expect(navTip({ label: "Jobs", count: 49 })).toBe("Jobs · 49");
    expect(navTip({ label: "Jobs", count: 0 })).toBe("Jobs");
    expect(navTip({ label: "Privacy", trailing: "Locked" })).toBe("Privacy · Locked");
  });

  it("Table activates rows by click and Enter and shows an empty message", async () => {
    const onRow = vi.fn();
    const rows = [{ id: "a", t: "AI Engineer" }, { id: "b", t: "AI Developer" }];
    const { rerender } = render(<Table caption="Jobs" rows={rows} rowKey={(r) => r.id} onRowActivate={onRow} columns={[{ key: "t", header: "Role", render: (r) => r.t }]} />);
    expect(screen.getByRole("table", { name: "Jobs" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("AI Engineer"));
    screen.getByText("AI Developer").closest("tr")!.focus();
    await userEvent.keyboard("{Enter}");
    expect(onRow.mock.calls.map((c) => c[0].id)).toEqual(["a", "b"]);
    rerender(<Table caption="Jobs" rows={[] as typeof rows} rowKey={(r) => r.id} columns={[]} emptyText="No jobs match." />);
    expect(screen.getByText("No jobs match.")).toBeInTheDocument();
  });

  it("Tabs switch with arrow keys", async () => {
    function T() {
      const [v, setV] = useState("description");
      return <Tabs label="Job" value={v} onChange={setV} tabs={[{ id: "description", label: "Description" }, { id: "score", label: "Score" }]}>panel:{v}</Tabs>;
    }
    render(<T />);
    screen.getByRole("tab", { name: "Description" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Score" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Score" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel:score");
  });

  it("Dialog traps focus, closes on Escape and restores focus", async () => {
    function D() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Save view" actions={<><button>Cancel</button><button>Save</button></>}><input aria-label="Name" /></Dialog></>;
    }
    render(<D />);
    await userEvent.click(screen.getByText("Open"));
    expect(screen.getByRole("dialog", { name: "Save view" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await userEvent.tab(); await userEvent.tab(); await userEvent.tab();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Open")).toHaveFocus();
  });

  it("CommandBar moves with arrows and runs the chosen item; Cmd/Ctrl+K opens it", async () => {
    const run = vi.fn();
    function C() {
      const [open, setOpen] = useState(false);
      const [q, setQ] = useState("");
      useCommandShortcut(() => setOpen(true));
      return <CommandBar open={open} onClose={() => setOpen(false)} query={q} onQueryChange={setQ} items={[
        { id: "jobs", label: "Go to Jobs", group: "Go to", run: () => run("jobs") },
        { id: "inbox", label: "Go to Inbox", group: "Go to", run: () => run("inbox") },
      ]} />;
    }
    render(<C />);
    await userEvent.keyboard("{Control>}k{/Control}");
    const box = screen.getByRole("combobox", { name: "Command" });
    expect(box).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(run).toHaveBeenCalledWith("inbox");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("CommandBar's combobox is aria-expanded whenever it is open, even with no matches", async () => {
    function C() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button>
        <CommandBar open={open} onClose={() => setOpen(false)} query="zzz" onQueryChange={() => undefined} items={[]} /></>;
    }
    render(<C />);
    await userEvent.click(screen.getByText("Open"));
    const box = screen.getByRole("combobox", { name: "Command" });
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("Dialog keeps its title and actions outside the scrolling body, so long content never hides the buttons", () => {
    render(<Dialog open onClose={() => undefined} title="Make a video" actions={<><button>Cancel</button><button>Start</button></>}>
      {Array.from({ length: 80 }, (_, i) => <p key={i}>Line {i}</p>)}
    </Dialog>);
    const dialog = screen.getByRole("dialog", { name: "Make a video" });
    const parts = [...dialog.children].map((c) => c.className);
    expect(parts).toEqual(["dialog__head", "dialog__body", "dialog__actions"]);
    const body = dialog.querySelector(".dialog__body")!;
    expect(body).toHaveTextContent("Line 79");
    expect(body.contains(screen.getByRole("button", { name: "Start" }))).toBe(false);
    // Primary on the right: the last action is the main one.
    const actions = dialog.querySelector(".dialog__actions")!;
    expect(actions.lastElementChild).toHaveTextContent("Start");
  });

  it("Dialog CSS caps the height and scrolls only the body (layout isn't measurable in jsdom)", () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, "../src/styles/composites.css"), "utf8");
    const rule = (sel: string) => new RegExp(`(^|\\n)${sel.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? "";
    expect(rule(".dialog")).toMatch(/max-height:\s*85vh/);
    expect(rule(".dialog")).toMatch(/overflow:\s*hidden/);
    expect(rule(".dialog__body")).toMatch(/overflow-y:\s*auto/);
    expect(rule(".dialog__body")).toMatch(/min-height:\s*0/);
  });

  it("stacked Dialogs: Escape closes only the top one and restores focus to its opener", async () => {
    function Nested() {
      const [outerOpen, setOuterOpen] = useState(false);
      const [innerOpen, setInnerOpen] = useState(false);
      return <>
        <button onClick={() => setOuterOpen(true)}>Open outer</button>
        <Dialog open={outerOpen} onClose={() => setOuterOpen(false)} title="Outer">
          <button onClick={() => setInnerOpen(true)}>Open inner</button>
          <Dialog open={innerOpen} onClose={() => setInnerOpen(false)} title="Inner">
            <button>Inner action</button>
          </Dialog>
        </Dialog>
      </>;
    }
    render(<Nested />);
    await userEvent.click(screen.getByText("Open outer"));
    await userEvent.click(screen.getByText("Open inner"));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeInTheDocument();
    expect(screen.getByText("Open inner")).toHaveFocus();
  });

  it("useCommandShortcut ignores Cmd/Ctrl+K while a Dialog is open", async () => {
    function Scene() {
      const [dialogOpen, setDialogOpen] = useState(false);
      const [cmdOpen, setCmdOpen] = useState(false);
      useCommandShortcut(() => setCmdOpen(true));
      return <>
        <button onClick={() => setDialogOpen(true)}>Open dialog</button>
        <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Blocking">
          <button>Inside</button>
        </Dialog>
        <CommandBar open={cmdOpen} onClose={() => setCmdOpen(false)} query="" onQueryChange={() => undefined} items={[]} />
      </>;
    }
    render(<Scene />);
    await userEvent.click(screen.getByText("Open dialog"));
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Blocking" })).toBeInTheDocument();
  });

  it("Toast announces politely and dismisses itself", async () => {
    vi.useFakeTimers();
    function B() { const toast = useToast(); return <button onClick={() => toast({ text: "Filed into me/resumes", tone: "success" })}>Go</button>; }
    render(<ToastProvider timeoutMs={1000}><B /></ToastProvider>);
    act(() => screen.getByText("Go").click());
    expect(screen.getByRole("status")).toHaveTextContent("Filed into me/resumes");
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.getByRole("status")).not.toHaveTextContent("Filed into me/resumes");
    vi.useRealTimers();
  });
});
