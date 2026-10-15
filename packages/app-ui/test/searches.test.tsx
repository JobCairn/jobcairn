import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { SearchesScreen } from "../src/screens/Searches";
import { renderApp, cutAndHover } from "./render";

const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("Searches", () => {
  it("lists searches and marks the ones from the last 7 days", async () => {
    renderApp(<SearchesScreen />);
    await screen.findByRole("table");
    expect(rows()[0]).toHaveTextContent("ai engineer");
    expect(rows()[0]).toHaveTextContent("Greenhouse");
    expect(within(rows()[0]!).getByText("Run in the last 7 days")).toBeInTheDocument();
  });

  it("drops the badge once a search is older than a week", async () => {
    renderApp(<SearchesScreen />, { bridge: new MockBridge({ now: new Date("2026-02-01T09:00:00.000Z") }) });
    await screen.findByRole("table");
    expect(screen.queryByText("Run in the last 7 days")).not.toBeInTheDocument();
  });

  it("filters by site", async () => {
    const f = loadFixture();
    f.searches.push({ at: "2026-01-13T09:00:00.000Z", site: "Adzuna", query: "llm engineer", location: "Remote", results: "40", kept: "0", notes: "" });
    renderApp(<SearchesScreen />, { bridge: new MockBridge({ fixture: f }) });
    await screen.findByRole("table");
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveTextContent("llm engineer");
    await userEvent.selectOptions(screen.getByLabelText("Site"), "Greenhouse");
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  // The "Last 7 days" badge uses a 7-day cutoff: `at >= now - 7 days`. Pin the exact boundary
  // (inclusive) and the instant just past it (excluded), rather than relying on dates that are
  // merely "old" or "new".
  it("shows the badge exactly at the 7-day boundary and hides it just after", async () => {
    const now = new Date("2026-02-01T09:00:00.000Z");
    const f = loadFixture();
    f.searches = [
      { at: "2026-01-25T09:00:00.000Z", site: "Greenhouse", query: "exactly seven days old", location: "Remote", results: "5", kept: "0", notes: "" },
      { at: "2026-01-25T08:59:59.000Z", site: "Greenhouse", query: "one second over a week", location: "Remote", results: "5", kept: "0", notes: "" },
    ];
    renderApp(<SearchesScreen />, { bridge: new MockBridge({ now, fixture: f }) });
    await screen.findByRole("table");
    const rs = rows();
    const atBoundary = rs.find((r) => r.textContent?.includes("exactly seven days old"))!;
    const pastBoundary = rs.find((r) => r.textContent?.includes("one second over a week"))!;
    expect(within(atBoundary).getByText("Run in the last 7 days")).toBeInTheDocument();
    expect(within(pastBoundary).queryByText("Run in the last 7 days")).not.toBeInTheDocument();
  });

  it("renders an untrusted query and notes safely", async () => {
    const f = loadFixture();
    f.searches = [{ at: "2026-01-12T09:00:00.000Z", site: "Greenhouse", query: "ai‮engineer", location: "Remote", results: "1", kept: "0", notes: "note‮text" }];
    renderApp(<SearchesScreen />, { bridge: new MockBridge({ fixture: f }) });
    await screen.findByRole("table");
    expect(screen.getByText("ai�engineer")).toBeInTheDocument();
    expect(screen.getByText("note�text")).toBeInTheDocument();
    expect(screen.queryByText(/‮/)).not.toBeInTheDocument();
  });

  it("shows a helpful message when no searches have been logged at all", async () => {
    const f = loadFixture();
    f.searches = [];
    renderApp(<SearchesScreen />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByText(/No searches yet\. Each time Claude looks for jobs, the search is logged here/)).toBeInTheDocument();
    // First use offers the way to start, and drops the filters (there is nothing to filter yet).
    expect(await screen.findByRole("button", { name: "Find jobs" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Find a search")).not.toBeInTheDocument();
  });

  it("shows the error over stale data when a reload fails, instead of hiding the table", async () => {
    const b = new MockBridge();
    const list = b.searches.list;
    let calls = 0;
    b.searches.list = async () => {
      calls += 1;
      if (calls > 1) throw new Error("the search log is not readable");
      return list();
    };
    renderApp(<SearchesScreen />, { bridge: b });
    await screen.findByRole("table");
    b.emitExternalChange("searches");
    expect(await screen.findByText("Searches can't be refreshed")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(rows().length).toBeGreaterThan(0);
  });

  it("shows a clear error when searches fail to load at all", async () => {
    const b = new MockBridge();
    b.searches.list = async () => { throw new Error("the search log is not readable"); };
    renderApp(<SearchesScreen />, { bridge: b });
    expect(await screen.findByText("Searches can't be shown")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  describe("dates, results and details", () => {
    const rich = () => {
      const f = loadFixture();
      f.searches = [
        { at: "2026-01-10T00:00:00", site: "SEEK", query: "ai engineer", location: "Brisbane QLD", results: "81 (c. 30 relevant)", kept: "3", notes: "Kept three. Most ads needed full work rights; two said sponsorship considered; one was a duplicate of an earlier lead." },
        { at: "2026-01-09", site: "LinkedIn", query: "llm engineer", location: "Remote", results: "2,000+ (too broad)", kept: "0", notes: "" },
        { at: "2026-01-11T03:15:00.000Z", site: "SEEK", query: "applied ai", location: "Sydney NSW", results: "12", kept: "1", notes: "kept Acme Corp" },
      ];
      return f;
    };

    it("shows a date-only search as a date, never with an invented time", async () => {
      renderApp(<SearchesScreen />, { bridge: new MockBridge({ fixture: rich() }) });
      await screen.findByRole("table");
      const row = rows().find((r) => r.textContent?.includes("ai engineer"))!;
      expect(row).toHaveTextContent("10 Jan 2026");
      expect(row.textContent).not.toMatch(/12:00|am|pm/);
      expect(row.querySelector("time")).not.toHaveAttribute("title");
      const timed = rows().find((r) => r.textContent?.includes("applied ai"))!;
      expect(timed.querySelector("time")!.getAttribute("title")).toMatch(/11 Jan 2026, \d{1,2}:\d{2} (am|pm)/);
    });

    it("sorts results by their leading number and keeps the full text in a tooltip", async () => {
      renderApp(<SearchesScreen />, { bridge: new MockBridge({ fixture: rich() }) });
      await screen.findByRole("table");
      const head = screen.getByRole("columnheader", { name: /Results/ });
      await userEvent.click(within(head).getByRole("button"));
      expect(head).toHaveAttribute("aria-sort", "descending");
      expect(rows().map((r) => r.textContent)).toEqual([
        expect.stringContaining("llm engineer"), expect.stringContaining("ai engineer"), expect.stringContaining("applied ai"),
      ]);
      rows()[0]!.querySelectorAll("td").forEach(cutAndHover);
      const cell = [...rows()[0]!.querySelectorAll("td")].find((td) => td.getAttribute("title") === "2,000+ (too broad)") ?? null;
      expect(cell).not.toBeNull();
      expect(cell).toHaveTextContent("2,000");
    });

    it("opens a drawer with the full results text and the full notes", async () => {
      renderApp(<SearchesScreen />, { bridge: new MockBridge({ fixture: rich() }) });
      await screen.findByRole("table");
      await userEvent.click(within(rows().find((r) => r.textContent?.includes("ai engineer"))!).getByText("ai engineer"));
      const d = screen.getByRole("dialog", { name: "ai engineer" });
      expect(within(d).getByText("81 (c. 30 relevant)")).toBeInTheDocument();
      expect(within(d).getByText(/one was a duplicate of an earlier lead\./)).toBeInTheDocument();
      expect(within(d).getByText("Brisbane QLD")).toBeInTheDocument();
    });

    it("filters by text, site and date", async () => {
      renderApp(<SearchesScreen />, { bridge: new MockBridge({ fixture: rich(), now: new Date("2026-01-12T09:00:00.000Z") }) });
      await screen.findByRole("table");
      await userEvent.type(screen.getByLabelText("Find a search"), "sydney");
      await waitFor(() => expect(rows()).toHaveLength(1));
      await userEvent.clear(screen.getByLabelText("Find a search"));
      await userEvent.selectOptions(screen.getByLabelText("Site"), "SEEK");
      await waitFor(() => expect(rows()).toHaveLength(2));
      await userEvent.selectOptions(screen.getByLabelText("Site"), "");
      await userEvent.selectOptions(screen.getByLabelText("When"), "older");
      await waitFor(() => expect(screen.getByText("No searches match these filters.")).toBeInTheDocument());
    });
  });
});
