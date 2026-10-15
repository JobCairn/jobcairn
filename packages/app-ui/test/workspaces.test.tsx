import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClaudeRunView } from "@careeros/contract";
import { App } from "../src/App";
import { MockBridge, type MockOptions } from "../src/mock/MockBridge";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const called = (b: MockBridge, m: string) => b.calls.filter((c) => c.method === m);
const trigger = () => screen.findByRole("button", { name: /^Workspace: / });

async function openMenu() {
  await userEvent.click(await trigger());
  return screen.findByRole("menu", { name: "Workspaces" });
}
function setup(o: MockOptions = {}) {
  const b = new MockBridge(o);
  render(<App bridge={b} />);
  return b;
}

describe("Workspace switcher", () => {
  beforeEach(() => { sessionStorage.clear(); window.location.hash = ""; });

  it("shows the open workspace by the person's name at the top of the sidebar", async () => {
    setup();
    const t = await trigger();
    expect(t).toHaveAccessibleName("Workspace: Alex Example. Switch workspace");
    expect(t).toHaveAttribute("aria-haspopup", "menu");
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByText("Alex Example")).toBeInTheDocument();
  });

  it("lists recent workspaces by name and folder name, never a full path", async () => {
    setup();
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining("Alex Example"), expect.stringContaining("Sam Sample")]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    // A quiet second line: where it is and how much is in it; when it was made is in its tooltip. Never a path.
    expect(items[1]).toHaveTextContent(new RegExp(String.raw`${brand.name} Sam · (No companies yet|\d+ compan(y|ies))$`));
    expect(items[1]!.querySelector(".ws-switch__item-folder")).toHaveAttribute("title", expect.stringContaining(" · created "));
    expect(menu.textContent).not.toContain("/fictional");
    for (const label of ["New workspace", "Open…", "Example", "Remove…"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(await trigger()).toHaveFocus();
  });

  it("switches to another person's workspace, by key, and starts the screens afresh on Home", async () => {
    window.location.hash = "#/jobs";
    const b = setup();
    await screen.findByRole("heading", { name: "Jobs", level: 1 });
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Sam Sample/ }));
    await waitFor(async () => expect(await trigger()).toHaveAccessibleName("Workspace: Sam Sample. Switch workspace"));
    const args = called(b, "workspace.switchTo")[0]!.args;
    expect(args[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(window.location.hash).toBe("#/home");
    // Sam's own workspace: none of Alex's jobs.
    expect((await b.jobs.list({})).rows).toHaveLength(0);
  });

  it("asks before switching when a Claude task is still running, and keeps working on No", async () => {
    const b = setup();
    b.claude.runs = async () => [{ status: "running" } as ClaudeRunView];
    let menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Sam Sample/ }));
    const dialog = await screen.findByRole("dialog", { name: "Stop the running task?" });
    expect(within(dialog).getByText("A task is still running in Alex Example. Stop it and switch?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep working" }));
    expect(called(b, "workspace.switchTo")).toHaveLength(0);
    menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Sam Sample/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop & switch" }));
    await waitFor(() => expect(called(b, "workspace.switchTo")).toHaveLength(1));
  });

  it("starts a new workspace for someone else: main makes the folder from the name", async () => {
    const b = setup();
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "New workspace" }));
    expect(await screen.findByRole("heading", { name: "Start a new workspace" })).toBeInTheDocument();
    // Someone else: not prefilled with the account's name.
    expect(screen.getByLabelText("What's your name?")).toHaveValue("");
    await userEvent.type(screen.getByLabelText("What's your name?"), "Jordan Demo");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(async () => expect(await trigger()).toHaveAccessibleName("Workspace: Jordan Demo. Switch workspace"));
    expect(called(b, "workspace.startNew").map((c) => c.args)).toEqual([["Jordan Demo"]]);
    expect(called(b, "workspace.create")).toHaveLength(0);
  });

  it("Cancel on the new-workspace page goes back with nothing made", async () => {
    const b = setup();
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "New workspace" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await trigger()).toHaveAccessibleName("Workspace: Alex Example. Switch workspace");
    expect(called(b, "workspace.startNew")).toHaveLength(0);
  });

  it("opens the example and tags it as the example", async () => {
    setup();
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Example" }));
    await waitFor(async () => expect(await trigger()).toHaveAccessibleName("Workspace: Alex Example (example). Switch workspace"));
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByText("Example")).toBeInTheDocument();
  });

  it("opens another workspace through the folder picker", async () => {
    const b = setup();
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Open…" }));
    await waitFor(() => expect(called(b, "workspace.open")).toHaveLength(1));
    expect(called(b, "workspace.pickFolder").map((c) => c.args)).toEqual([["open"]]);
  });

  it("removes a workspace from the list (files stay), and shows a missing folder plainly", async () => {
    const b = setup({ otherWorkspaces: [{ name: "Sam Sample", folder: "CareerOS Sam" }, { name: "Riley Test", folder: "CareerOS Riley", available: false }] });
    let menu = await openMenu();
    const missing = within(menu).getByRole("menuitemradio", { name: /CareerOS Riley/ });
    expect(missing).toHaveAttribute("aria-disabled", "true");
    expect(missing).toHaveTextContent("Can't find this folder");
    // Clicking it never tries to open it: it opens the list's tools (Locate…, Remove).
    await userEvent.click(missing);
    expect(called(b, "workspace.switchTo")).toHaveLength(0);
    let dialog = await screen.findByRole("dialog", { name: "Remove from this list" });
    expect(within(dialog).getByRole("button", { name: "Locate Riley Test's folder" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove…" }));
    dialog = await screen.findByRole("dialog", { name: "Remove from this list" });
    expect(within(dialog).getByText(/Its folder and files stay where they are/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove: Sam Sample" }));
    await waitFor(() => expect(within(dialog).queryByText("Sam Sample")).not.toBeInTheDocument());
    expect(called(b, "workspace.forget")).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    menu = await openMenu();
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).not.toContainEqual(expect.stringContaining("Sam Sample"));
  });

  it("lists every workspace in the dialog, the open one marked and without actions", async () => {
    setup();
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Remove…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove from this list" });
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Alex Example");
    expect(within(rows[0]!).getByText("You're using this one")).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows[1]!).getByRole("button", { name: "Remove: Sam Sample" })).toBeInTheDocument();
    // Sam's workspace has things in it: removing from the list is the only option.
    expect(within(rows[1]!).queryByRole("button", { name: /Trash/ })).not.toBeInTheDocument();
  });

  it("tells two workspaces with the same name and folder apart by where they are", async () => {
    setup({ otherWorkspaces: [
      { name: "Sam Sample", folder: "CareerOS", parent: "personal-workspace", companies: 52 },
      { name: "Sam Sample", folder: "CareerOS", parent: "old-laptop", companies: 1 },
    ] });
    const items = within(await openMenu()).getAllByRole("menuitemradio");
    expect(items[1]).toHaveTextContent("personal-workspace › CareerOS · 52 companies");
    expect(items[2]).toHaveTextContent("old-laptop › CareerOS · 1 company");
    // Screen readers get the place too, where the names clash.
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Remove…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove from this list" });
    expect(within(dialog).getByRole("button", { name: "Remove: Sam Sample (personal-workspace › CareerOS)" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove: Sam Sample (old-laptop › CareerOS)" })).toBeInTheDocument();
  });

  it("moves only an empty workspace to the Trash, after a confirm", async () => {
    const b = setup({ otherWorkspaces: [{ name: "Sam Sample", folder: "CareerOS Sam", companies: 4 }, { name: "Jordan Demo", folder: "CareerOS Jordan", companies: 0, empty: true }] });
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Remove…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove from this list" });
    expect(within(dialog).queryByRole("button", { name: "Trash: Sam Sample" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Trash: Jordan Demo" }));
    const confirm = within(dialog).getByRole("alert");
    expect(confirm).toHaveTextContent("Move this empty workspace to the Trash?");
    expect(called(b, "workspace.trash")).toHaveLength(0);
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(called(b, "workspace.trash")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Trash: Jordan Demo" }));
    await userEvent.click(within(within(dialog).getByRole("alert")).getByRole("button", { name: "Trash folder" }));
    await waitFor(() => expect(within(dialog).queryByText("Jordan Demo")).not.toBeInTheDocument());
    expect(called(b, "workspace.trash")).toHaveLength(1);
    expect(b.trashed).toEqual(["CareerOS Jordan"]);
  });

  it("finds a missing folder with Locate…, and offers a different workspace as a separate entry", async () => {
    const b = setup({ otherWorkspaces: [{ name: "Riley Test", folder: "CareerOS Riley", available: false }] });
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Remove…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove from this list" });
    // The picker returns a folder holding another workspace: not accepted as Riley's.
    b.workspace.pickFolder = async (): Promise<string | null> => "/fictional/alex-example/Shared/CareerOS Jordan";
    await userEvent.click(within(dialog).getByRole("button", { name: "Locate Riley Test's folder" }));
    const note = await within(dialog).findByRole("alert");
    expect(note).toHaveTextContent("That folder holds a different workspace");
    await userEvent.click(within(note).getByRole("button", { name: "Add separately" }));
    await waitFor(() => expect(called(b, "workspace.addRecent")).toHaveLength(1));
    await waitFor(() => expect(within(dialog).getAllByRole("listitem")).toHaveLength(3));
    // The same workspace, found where it was moved: it's in the list again and can be opened.
    b.workspace.pickFolder = async (): Promise<string | null> => "/fictional/alex-example/Moved/CareerOS Riley";
    await userEvent.click(within(dialog).getByRole("button", { name: "Locate Riley Test's folder" }));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Locate Riley Test's folder" })).not.toBeInTheDocument());
    const riley = within(dialog).getAllByRole("listitem").find((li) => li.textContent?.includes("Riley Test"))!;
    expect(riley).not.toHaveTextContent("Can't find this folder");
  });

  it("keeps secrets per workspace", async () => {
    const b = new MockBridge();
    await b.secrets.set("anthropic_api_key", "sk-" + "test");
    expect((await b.secrets.status("anthropic_api_key")).set).toBe(true);
    const sam = (await b.workspace.recent()).find((r) => r.name === "Sam Sample")!;
    await b.workspace.switchTo(sam.key);
    expect((await b.secrets.status("anthropic_api_key")).set).toBe(false);
    const alex = (await b.workspace.recent()).find((r) => r.name === "Alex Example")!;
    await b.workspace.switchTo(alex.key);
    expect((await b.secrets.status("anthropic_api_key")).set).toBe(true);
  });

  it("explains workspaces in Settings > Appearance", async () => {
    window.location.hash = "#/settings?tab=appearance";
    setup();
    expect(await screen.findByText("Each person can have their own workspace. For full privacy, use separate computer accounts.")).toBeInTheDocument();
  });
});
