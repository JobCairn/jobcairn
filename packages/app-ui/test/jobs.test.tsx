import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { JobsScreen, queryFromForm } from "../src/screens/Jobs";
import { EMPTY_FORM, NO_FILTERS } from "../src/jobs/filters";
import { renderApp, cutAndHover } from "./render";

const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
function bridgeWithStatus(status: string): MockBridge {
  const f = loadFixture();
  (f.profile as { work_rights: { status: string } }).work_rights.status = status;
  return new MockBridge({ fixture: f });
}

/** Opens a quick-filter chip and ticks (or unticks) a choice, then closes the panel. */
async function pick(chip: string, choice: string) {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`^(Filter by ${chip.toLowerCase()}|${chip}: .*Change)$`) }));
  await userEvent.click(within(await screen.findByRole("group", { name: chip })).getByRole(/Any|^\d/.test(choice) ? "radio" : "checkbox", { name: new RegExp(`^${choice}`) }));
  await userEvent.keyboard("{Escape}");
}
beforeEach(() => { localStorage.clear(); window.location.hash = "#/jobs"; });

async function openSaveDialog() {
  await userEvent.click(screen.getByRole("button", { name: "Save view" }));
}
async function typeViewName(name: string) {
  await userEvent.type(screen.getByLabelText("View name"), name);
}
async function clickDialogSave() {
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
}

describe("Jobs", () => {
  it("pins sponsorship-offered rows first and hides ads you can't apply for", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    expect(rows()[0]).toHaveTextContent("AI Engineer");
    expect(rows()[0]).toHaveClass("is-pinned");
    expect(screen.queryByText("AI Developer")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Show ads I can't apply for \(1 hidden\)/));
    expect(await screen.findByText("AI Developer")).toBeInTheDocument();
  });
  it("round 2: shows the sponsor column, sort option and pin for a candidate who needs sponsorship (primary)", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: bridgeWithStatus("needs_sponsorship") });
    await screen.findByRole("table");
    expect(screen.getByRole("columnheader", { name: /Sponsor/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sort: sponsor score" })).toBeInTheDocument();
    expect(rows()[0]).toHaveClass("is-pinned");
  });
  it("round 2: hides the sponsor column, sort option and pin highlight for a citizen (sponsorship off)", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: bridgeWithStatus("citizen") });
    await screen.findByRole("table");
    expect(screen.queryByRole("columnheader", { name: /Sponsor/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Sort: sponsor score" })).not.toBeInTheDocument();
    expect(rows().some((r) => r.classList.contains("is-pinned"))).toBe(false);
    // A citizen is never excluded by "Citizens/PR only", so it reads as plain info, not a warning.
    const devRow = rows().find((r) => r.textContent?.includes("AI Developer"))!;
    expect(within(devRow).getByText("Citizens/PR only").closest(".cell-tag")).toHaveClass("cell-tone--muted");
    // Sponsorship wording isn't relevant to a citizen: no sponsorship pills, and no sponsorship filter choices.
    expect(within(screen.getByRole("table")).queryByText("Sponsorship offered")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Sponsorship offered" })).not.toBeInTheDocument();
  });
  it("round 2: shows the sponsor column and sort option, but no pin highlight, for a full-rights visa holder (secondary)", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: bridgeWithStatus("full_visa") });
    await screen.findByRole("table");
    expect(screen.getByRole("columnheader", { name: /Sponsor/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sort: sponsor score" })).toBeInTheDocument();
    expect(rows().some((r) => r.classList.contains("is-pinned"))).toBe(false);
  });
  it("takes the status from the route", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs", status: "Applied" }} />);
    await screen.findByRole("table");
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Status: Applied. Change" })).toBeInTheDocument();
  });
  it("filters by text", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    await userEvent.type(screen.getByLabelText("Search jobs"), "labs");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Backend Engineer (LLM)");
  });
  it("saves, applies and deletes a view", async () => {
    const { bridge } = renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    await pick("Work rights", "Sponsorship offered");
    await userEvent.click(screen.getByRole("button", { name: "Save view" }));
    await userEvent.type(screen.getByLabelText("View name"), "Sponsored");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await bridge.jobs.views()).toEqual([{ name: "Sponsored", query: { labels: ["sponsorship_offered"], sort: "default", limit: 200 } }]);
    await userEvent.click(screen.getByRole("button", { name: "Clear work rights filter" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.selectOptions(await screen.findByLabelText("Saved view"), "Sponsored");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Delete view" }));
    expect(await bridge.jobs.views()).toEqual([]);
  });
  it("opens a job on click or Enter", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByText("Backend Engineer (LLM)"));
    expect(window.location.hash).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm");
  });
  it("opens a job with Enter on a focused row", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    const row = rows().find((r) => r.textContent?.includes("Backend Engineer (LLM)"))!;
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(window.location.hash).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm");
  });
  it("sorts by a column header and keeps the full role in a tooltip", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    const head = screen.getByRole("columnheader", { name: /Role/ });
    await userEvent.click(within(head).getByRole("button"));
    expect(head).toHaveAttribute("aria-sort", "ascending");
    const titles = rows().map((r) => r.querySelector(".role-title")!.textContent!);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    cutAndHover(rows()[0]!.querySelector("td")!);
    expect(rows()[0]!.querySelector("td")!.getAttribute("title")).toMatch(/^.+, .+$/);
  });
  it("says when saved views can't be loaded, instead of silently showing none", async () => {
    const b = new MockBridge();
    b.jobs.views = async () => { throw new Error("views file is corrupt"); };
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: b });
    await screen.findByRole("table");
    expect(await screen.findByText("Saved views can't be loaded right now.")).toBeInTheDocument();
  });

  it("saves a new view name directly, with no confirm step", async () => {
    const { bridge } = renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    await openSaveDialog();
    await typeViewName("Remote AI roles");
    await clickDialogSave();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    expect(await bridge.jobs.views()).toEqual([{ name: "Remote AI roles", query: { sort: "default", limit: 200 } }]);
  });

  it("shows a confirm step for a duplicate name and doesn't call saveView until Replace is clicked", async () => {
    const b = new MockBridge();
    const realSave = b.jobs.saveView;
    let saveCalls = 0;
    b.jobs.saveView = (name, q) => { saveCalls++; return realSave(name, q); };
    const { bridge } = renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: b });
    await screen.findByRole("table");

    // Establish an existing saved view named "Remote AI roles".
    await openSaveDialog();
    await typeViewName("Remote AI roles");
    await clickDialogSave();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveCalls).toBe(1);

    // Change the filters, then try to save a view under the same name.
    await pick("Work rights", "Sponsorship offered");
    await openSaveDialog();
    await typeViewName("Remote AI roles");
    await clickDialogSave();

    expect(await screen.findByText('A view called "Remote AI roles" already exists. Replace it?')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.queryByLabelText("View name")).not.toBeInTheDocument();
    expect(saveCalls).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveCalls).toBe(2);
    expect(await bridge.jobs.views()).toEqual([{ name: "Remote AI roles", query: { labels: ["sponsorship_offered"], sort: "default", limit: 200 } }]);
  });

  it("returns to editing the name when Back is clicked, and calls nothing", async () => {
    const b = new MockBridge();
    const realSave = b.jobs.saveView;
    let saveCalls = 0;
    b.jobs.saveView = (name, q) => { saveCalls++; return realSave(name, q); };
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: b });
    await screen.findByRole("table");

    await openSaveDialog();
    await typeViewName("Remote AI roles");
    await clickDialogSave();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveCalls).toBe(1);

    await openSaveDialog();
    await typeViewName("Remote AI roles");
    await clickDialogSave();
    await screen.findByText('A view called "Remote AI roles" already exists. Replace it?');

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("View name")).toHaveValue("Remote AI roles");
    expect(saveCalls).toBe(1);
  });

  it("calls saveView exactly once when Replace is clicked twice synchronously", async () => {
    const b = new MockBridge();
    const realSave = b.jobs.saveView;
    let saveCalls = 0;
    b.jobs.saveView = (name, q) => { saveCalls++; return realSave(name, q); };
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: b });
    await screen.findByRole("table");

    await openSaveDialog();
    await typeViewName("Remote AI roles");
    await clickDialogSave();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveCalls).toBe(1);

    await openSaveDialog();
    await typeViewName("Remote AI roles");
    await clickDialogSave();
    await screen.findByText('A view called "Remote AI roles" already exists. Replace it?');

    const replaceBtn = screen.getByRole("button", { name: "Replace" });
    act(() => { replaceBtn.click(); replaceBtn.click(); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveCalls).toBe(2);
  });

  it("builds queries without empty filters", () => {
    expect(queryFromForm({ ...EMPTY_FORM, text: " ai ", sort: "fit" })).toEqual({ text: "ai", sort: "fit", limit: 200 });
    expect(queryFromForm({ ...EMPTY_FORM, showIneligible: true, filters: { ...NO_FILTERS, statuses: ["Applied"], labels: ["visa_ok"], fitMin: 60 } }))
      .toEqual({ statuses: ["Applied"], labels: ["visa_ok"], fitMin: 60, showIneligible: true, sort: "default", limit: 200 });
  });

  it("explains why the count differs from Home: ads hidden for work rights, with a way to show them", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    expect(screen.getAllByText("2 shown · 1 hidden because it needs work rights you don't have").length).toBeGreaterThan(0);
    // One control shows them: the "Show ads I can't apply for" box above the table (no second link beside the count).
    expect(screen.queryByRole("button", { name: "Show hidden" })).toBeNull();
    await userEvent.click(screen.getByLabelText(/Show ads I can't apply for/));
    await waitFor(() => expect(rows()).toHaveLength(3));
    await userEvent.type(screen.getByLabelText("Search jobs"), "zzz");
    expect(await screen.findAllByText(/filters are on/)).not.toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });
  it("titles the Apply view 'Apply' and offers saved jobs to prepare when nothing is in progress", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs", status: "Applying" }} />);
    expect(await screen.findByRole("heading", { name: "Apply" })).toBeInTheDocument();
    const ready = await screen.findByRole("region", { name: "Ready to prepare" });
    const prepare = await within(ready).findAllByRole("button", { name: "Prepare" });
    await userEvent.click(prepare[0]!);
    expect(window.location.hash).toMatch(/^#\/apply\//);
  });
});
