import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "../src/App";
import { identity } from "@careeros/brand";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { parseHash, toHash } from "../src/router";
import { mailState, syncedAt } from "../src/Shell";
import { seenKey } from "../src/jobs/seen";
import { SIDEBAR_GROUPS_KEY, SIDEBAR_KEY, isSidebarShortcut } from "../src/nav/sidebar-prefs";

describe("router", () => {
  it("round-trips routes and falls back to Home on junk", () => {
    for (const r of [{ screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "files" }, { screen: "apply", slug: "acme-corp", id: "x" }, { screen: "learn", topic: "rag-pipelines" }, { screen: "learn", job: "acme-corp/2026-01-12-ai-engineer" }, { screen: "jobs", status: "Applying" }, { screen: "privacy" }] as const) {
      expect(parseHash(toHash(r))).toEqual(r);
    }
    expect(parseHash("#/job/../../etc/x")).toEqual({ screen: "home" });
    expect(parseHash("#/%E0%A4%A")).toEqual({ screen: "home" });
    expect(toHash({ screen: "learn", job: "acme-corp/2026-01-12-ai-engineer" })).toBe("#/learn?job=acme-corp/2026-01-12-ai-engineer");
    expect(parseHash("#/learn?job=acme-corp/../x")).toEqual({ screen: "learn" });
    expect(parseHash("#/learn?job=acme-corp")).toEqual({ screen: "learn" });
    expect(parseHash("#/jobs?status=Ghosted")).toEqual({ screen: "jobs" });
    expect(parseHash(toHash({ screen: "settings", tab: "search" }))).toEqual({ screen: "settings", tab: "search" });
    expect(toHash({ screen: "settings", tab: "search" })).toBe("#/settings?tab=search");
    expect(parseHash("#/settings?tab=../x")).toEqual({ screen: "settings" });
  });
});

describe("Sidebar by candidate type", () => {
  const withStatus = (status: string) => {
    const f = loadFixture();
    (f.profile as { work_rights: { status: string } }).work_rights.status = status;
    return new MockBridge({ fixture: f });
  };
  it("shows Companies to everyone", async () => {
    for (const status of ["needs_sponsorship", "citizen"]) {
      const { unmount } = render(<App bridge={withStatus(status)} />);
      const nav = await screen.findByRole("navigation", { name: "Main" });
      expect(await within(nav).findByRole("button", { name: /Companies/ })).toBeInTheDocument();
      expect(within(nav).queryByRole("button", { name: /Sponsors/ })).toBeNull();
      unmount();
    }
  });
  it("sends an old Sponsors link to Companies, and rewrites the address", async () => {
    window.location.hash = "#/sponsors";
    render(<App bridge={withStatus("citizen")} />);
    expect(await screen.findByRole("heading", { name: "Companies", level: 1 })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/companies");
  });
});

describe("syncedAt", () => {
  it("says when, in full but short, in local time", () => {
    const now = new Date(2026, 9, 11, 16, 0);
    expect(syncedAt("", now)).toBe("never");
    expect(syncedAt(new Date(2026, 9, 11, 15, 42).toISOString(), now)).toBe("today 3:42 pm");
    expect(syncedAt(new Date(2026, 9, 10, 9, 5).toISOString(), now)).toBe("yesterday 9:05 am");
    expect(syncedAt(new Date(2026, 9, 8, 12, 0).toISOString(), now)).toBe("8 Oct, 12:00 pm");
    expect(syncedAt(new Date(2025, 11, 30, 0, 15).toISOString(), now)).toBe("30 Dec 2025, 12:15 am");
  });
});

describe("App shell", () => {
  it("shows onboarding when no workspace is open", async () => {
    render(<App bridge={new MockBridge({ workspaceOpen: false })} />);
    expect(await screen.findByRole("heading", { name: new RegExp(`Welcome to ${identity.name}`) })).toBeInTheDocument();
  });
  it("shows the nav rail with live counts and the connection footer", async () => {
    render(<App bridge={new MockBridge()} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(within(nav).getByRole("button", { name: /Approvals/ })).toHaveTextContent("1"));
    expect(within(nav).getByRole("button", { name: /Drop box/ })).toHaveTextContent("2");
    expect(within(nav).getByRole("button", { name: /Privacy/ })).toHaveTextContent("Locked");
    // The Claude Code engine's line: ready (green) when set up, "Claude is working…" while runs are active.
    const claude = await within(nav).findByRole("button", { name: /^Claude · ready/ });
    expect(claude).toHaveAttribute("data-tone", "ok");
    expect(claude.querySelector(".rail-stat__dot--ok")).toBeTruthy();
    await waitFor(() => expect(within(nav).getByRole("button", { name: /^Mail · synced/ })).toBeInTheDocument());
    expect(within(nav).getByRole("button", { name: /^Mail\s*\d*$/ })).toHaveTextContent("2");
  });
  it("shows Mail as an icon with the full last-sync time in its tooltip, and opens mail settings", async () => {
    render(<App bridge={new MockBridge()} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const icon = await within(nav).findByRole("button", { name: /^Mail · synced / });
    // "Mail · synced today 3:42 pm", "Mail · synced 15 Jan, 6:45 pm".
    expect(icon.getAttribute("data-tip")).toMatch(/^Mail · synced (today |yesterday |\d{1,2} [A-Z][a-z]{2}( \d{4})?, )\d{1,2}:\d{2} [ap]m$/);
    expect(icon).toHaveAttribute("data-tone", "ok");
    expect(icon.textContent).toBe("");
    expect(icon).not.toHaveAttribute("title");
    await userEvent.click(within(nav).getByRole("button", { name: /^Mail · synced .*\. Open mail settings$/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/settings?tab=connections&c=email"));
  });
  it("shows no unread count when Gmail isn't connected", async () => {
    render(<App bridge={new MockBridge({ mailConnected: false })} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(await within(nav).findByRole("button", { name: /^Mail · not connected/ })).toHaveAttribute("data-tone", "off");
    await waitFor(() => expect(within(nav).getByRole("button", { name: /Approvals/ })).toHaveTextContent("1"));
    expect(within(nav).getByRole("button", { name: /^Mail\s*\d*$/ })).toHaveTextContent(/^Mail$/);
  });
  it("navigates from the rail and the command bar", async () => {
    render(<App bridge={new MockBridge()} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    await userEvent.click(await within(nav).findByRole("button", { name: /Companies/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/companies"));
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox", { name: "Command" }), "drop box");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/inbox"));
  });
  it("finds jobs from the command bar", async () => {
    render(<App bridge={new MockBridge()} />);
    await screen.findByRole("navigation", { name: "Main" });
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox", { name: "Command" }), "backend");
    await userEvent.click(await screen.findByRole("option", { name: /Backend Engineer \(LLM\)/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm"));
  });
  it("follows the OS theme on first run and remembers a choice", async () => {
    render(<App bridge={new MockBridge()} />);
    await screen.findByRole("navigation", { name: "Main" });
    expect(document.documentElement.dataset.theme).toBe("graphite");
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("combobox", { name: "Command" }), "paper");
    await userEvent.keyboard("{Enter}");
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(localStorage.getItem("careeros.theme")).toBe("paper");
  });
  it("says Open while a grant is active and Check when a locked folder moved (final review M7)", async () => {
    // The mock's clock is fixed; fake only Date so the rail's "now" agrees with it (waitFor keeps real timers).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T09:01:00.000Z"));
    onTestFinished(() => { vi.useRealTimers(); });
    const b = new MockBridge();
    render(<App bridge={b} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const privacy = () => within(nav).getByRole("button", { name: /Privacy/ });
    await waitFor(() => expect(privacy()).toHaveTextContent("Locked"));
    const req = (await b.privacy.get()).requests.find((r) => r.status === "pending")!;
    await b.privacy.allow(req.id, 15);
    await waitFor(() => expect(privacy()).toHaveTextContent("Open"));
    b.simulateLockProblem({ folder: "me/employment", kind: "missing", found_at: null });
    await waitFor(() => expect(privacy()).toHaveTextContent("Check"));
  });
});

describe("Collapsible sidebar", () => {
  afterEach(() => { localStorage.removeItem(SIDEBAR_KEY); localStorage.removeItem(SIDEBAR_GROUPS_KEY); window.location.hash = ""; });

  it("matches Cmd+\\ on a Mac and Ctrl+\\ elsewhere", () => {
    const k = (o: Partial<KeyboardEvent>) => ({ key: "\\", code: "Backslash", metaKey: false, ctrlKey: false, altKey: false, ...o });
    expect(isSidebarShortcut(k({ metaKey: true }), true)).toBe(true);
    expect(isSidebarShortcut(k({ ctrlKey: true }), true)).toBe(false);
    expect(isSidebarShortcut(k({ ctrlKey: true }), false)).toBe(true);
    expect(isSidebarShortcut(k({ ctrlKey: true, key: "|" }), false)).toBe(true);
    expect(isSidebarShortcut(k({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isSidebarShortcut(k({ ctrlKey: true, key: "k", code: "KeyK" }), false)).toBe(false);
  });

  it("collapses to icons from the toggle and the shortcut, and remembers it", async () => {
    const { unmount } = render(<App bridge={new MockBridge()} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(nav).not.toHaveClass("is-collapsed");
    const toggle = within(nav).getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(nav).toHaveClass("is-collapsed");
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe("collapsed");
    // Focus moves to the new toggle, so a keyboard user can open it again straight away.
    expect(within(nav).getByRole("button", { name: "Expand sidebar" })).toHaveFocus();
    // Icons only: names and counts move into tooltips; labels stay readable to screen readers.
    expect(within(nav).getByRole("button", { name: /^Jobs/ })).toHaveAttribute("data-tip", "Jobs");
    expect(within(nav).getByRole("button", { name: /Privacy/ })).toHaveAttribute("data-tip", "Privacy · Locked");
    expect(within(nav).getByRole("button", { name: /^Claude · ready/ })).toHaveAttribute("data-tip", "Claude · ready");
    unmount();
    render(<App bridge={new MockBridge()} />);
    const again = await screen.findByRole("navigation", { name: "Main" });
    expect(again).toHaveClass("is-collapsed");
    await userEvent.keyboard("{Control>}\\{/Control}");
    expect(again).not.toHaveClass("is-collapsed");
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe("expanded");
  });

  it("folds a group to its header, keeps the current page's item, and marks hidden counts with a dot", async () => {
    window.location.hash = "#/applications";
    const { unmount } = render(<App bridge={new MockBridge()} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(within(nav).getByRole("button", { name: /Approvals/ })).toHaveTextContent("1"));
    const apply = within(nav).getByRole("button", { name: /^Apply/ });
    expect(apply).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(apply);
    expect(apply).toHaveAttribute("aria-expanded", "false");
    expect(apply).toHaveAccessibleName("Apply (has new items)");
    const group = within(nav).getByRole("group", { name: "Apply" });
    expect(apply).toHaveAttribute("aria-controls", group.id);
    // The current page (Applications) stays; the rest of the group is folded away.
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([expect.stringMatching(/^Applications\d*$/)]);
    expect(JSON.parse(localStorage.getItem(SIDEBAR_GROUPS_KEY)!)).toEqual(["Apply"]);
    // Prepare has no counts, so folding it adds no dot.
    await userEvent.click(within(nav).getByRole("button", { name: /^Prepare/ }));
    expect(within(nav).getByRole("button", { name: /^Prepare/ })).toHaveAccessibleName("Prepare");
    expect(within(within(nav).getByRole("group", { name: "Prepare" })).queryAllByRole("button")).toEqual([]);
    unmount();
    render(<App bridge={new MockBridge()} />);
    const again = await screen.findByRole("navigation", { name: "Main" });
    expect(within(again).getByRole("button", { name: /^Apply/ })).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(within(again).getByRole("button", { name: /^Apply/ }));
    expect(within(within(again).getByRole("group", { name: "Apply" })).getAllByRole("button")).toHaveLength(5);
  });

  it("puts the status icons, the version and the help button in one footer row", async () => {
    render(<App bridge={new MockBridge()} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const footer = nav.querySelector(".rail__footer")!;
    const status = within(nav).getByRole("group", { name: "Connections" });
    expect(footer).toContainElement(status);
    await waitFor(() => expect(within(status).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Claude · ready. Show activity", expect.stringMatching(/^Mail · synced .*\. Open mail settings$/),
    ]));
    const help = within(nav).getByRole("button", { name: "Show me around this page" });
    expect(help).toHaveAttribute("data-tip", "Show me around");
    expect(help).toHaveAttribute("data-tour", "tour-help");
    const version = await within(nav).findByRole("button", { name: /version .*About/ });
    // One row: [Claude] [Mail] … [version] [help].
    const row = footer.querySelector(".rail-foot")!;
    expect(row).toContainElement(status);
    expect(Array.from(row.querySelector(".rail-foot__end")!.children)).toEqual([version, help]);
  });
});

describe("Jobs badge", () => {
  afterEach(() => { localStorage.clear(); window.location.hash = ""; });
  it("counts jobs found since you last looked (the Jobs 'N new' chip), not the total; none means no badge", async () => {
    const b = new MockBridge();
    const all = (await b.jobs.list({ limit: 500 })).rows;
    const distinct = [...new Set(all.map((r) => r.found_at))].sort();
    const cut = distinct.length > 1 ? distinct[distinct.length - 2]! : "2000-01-01T00:00:00.000Z";
    const expected = all.filter((r) => r.found_at > cut).length;
    const key = (await b.workspace.recent()).find((w) => w.current)?.key ?? "default";
    // No baseline yet (first visit): no badge.
    const first = render(<App bridge={b} />);
    let nav = await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(within(nav).getByRole("button", { name: /Approvals/ })).toHaveTextContent("1"));
    expect(within(nav).getByRole("button", { name: /^Jobs/ })).toHaveTextContent(/^Jobs$/);
    first.unmount();
    localStorage.setItem(seenKey(key), cut);
    render(<App bridge={b} />);
    nav = await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(within(nav).getByRole("button", { name: /^Jobs/ })).toHaveTextContent(new RegExp(`^Jobs${expected}$`)));
    // Leaving Jobs moves the baseline on, so the badge clears.
    window.location.hash = "#/jobs";
    await screen.findByRole("heading", { name: "Jobs", level: 1 });
    window.location.hash = "#/home";
    await waitFor(() => expect(within(nav).getByRole("button", { name: /^Jobs/ })).toHaveTextContent(/^Jobs$/), { timeout: 8000 });
  });
});

describe("mailState", () => {
  it("gives one state word per case", () => {
    const base = { available: true, connected: true, syncing: false, last_error: "", last_sync: "2026-01-15T11:45:00.000Z" };
    expect(mailState(undefined)).toEqual({ state: "not available", tone: "off" });
    expect(mailState({ ...base, connected: false } as never).state).toBe("not connected");
    expect(mailState({ ...base, last_error: "Login failed" } as never)).toEqual({ state: "needs attention", tone: "alert" });
    expect(mailState({ ...base, syncing: true } as never)).toEqual({ state: "syncing…", tone: "busy" });
    expect(mailState(base as never).state).toMatch(/^synced /);
  });
});
