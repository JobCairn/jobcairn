import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { JobsScreen } from "../src/screens/Jobs";
import { EMPTY_FORM, formFromParams, paramsFromForm, queryFromForm } from "../src/jobs/filters";
import { GhostPills } from "../src/jobs/GhostPills";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 15_000 });
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
beforeEach(() => { localStorage.clear(); window.location.hash = "#/jobs"; });

/**
 * The mock's fixture with its first visible job posted long before the mock's clock (15 Jan 2026), and with
 * `closed` set, the second one's closing date passed.
 */
function staleBridge(closed = false): MockBridge {
  const f = loadFixture();
  const visible = f.jobs.filter((j) => !["citizen_pr_only", "clearance"].includes(j.job.work_rights.label));
  const open = visible.find((j) => j.job.status === "Found")!;
  open.job.posted = "2025-11-01";
  if (closed) {
    const other = visible.find((j) => j !== open)!;
    other.job.status = "Saved";
    other.job.closes_on = "2026-01-10";
  }
  return new MockBridge({ fixture: f });
}

describe("ghost pills", () => {
  it("show a quiet label with the reason as a tooltip and for screen readers", () => {
    renderApp(<GhostPills ghost={{ stale: "Posted 75 days ago.", repost: "The same ad text as \"Data Analyst\"." }} />);
    const stale = screen.getByText("Possibly stale");
    expect(stale).toHaveAttribute("title", "Posted 75 days ago.");
    expect(stale).toHaveTextContent("Possibly stale: Posted 75 days ago.");
    expect(screen.getByText("Reposted")).toHaveAttribute("title", "The same ad text as \"Data Analyst\".");
  });

  it("show nothing without a flag", () => {
    const { container } = renderApp(<GhostPills ghost={{}} />);
    expect(container.querySelector(".ghost-pills")).toBeNull();
  });
});

describe("Hide likely stale", () => {
  it("round-trips through the address and the query", () => {
    const form = { ...EMPTY_FORM, hideStale: true };
    expect(paramsFromForm(form).toString()).toBe("fresh=1");
    expect(formFromParams(new URLSearchParams("fresh=1"))).toEqual(form);
    expect(queryFromForm(form)).toMatchObject({ hideStale: true });
    expect(queryFromForm(EMPTY_FORM).hideStale).toBeUndefined();
  });

  it("flags the old ad and keeps it, and hides the closed ad when ticked", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: staleBridge(true) });
    await screen.findByRole("table");
    expect(await screen.findByText("Possibly stale")).toHaveAttribute("title", expect.stringMatching(/^Posted 75 days ago/));
    expect(screen.getByText("Closed")).toHaveAttribute("title", "The ad said applications closed on 10 Jan 2026.");
    const before = rows().length;
    await userEvent.click(screen.getByRole("checkbox", { name: "Hide likely stale" }));
    await waitFor(() => expect(rows()).toHaveLength(before - 1));
    expect(screen.queryByText("Closed")).toBeNull();
    expect(screen.getByText("Possibly stale")).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe("#/jobs?fresh=1"));
  });
});
