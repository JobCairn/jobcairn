import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RequestComposer } from "../src/composer";
import { MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 15_000 });
const WORKSPACE = { kind: "workspace" } as const;
const runs = (b: MockBridge) => b.calls.filter((c) => c.method === "claude.run").map((c) => c.args[2] as Record<string, unknown>);

describe("Find jobs › Describe the jobs you want", () => {
  it("reads the box into chips for this search only; the rest goes to Claude as words; chips can be removed", async () => {
    const b = new MockBridge();
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    const box = await screen.findByRole("textbox", { name: "Describe the jobs you want" });
    await userEvent.type(box, "remote or hybrid data roles in Sydney, posted this week, no big tech");
    await userEvent.click(screen.getByRole("button", { name: "Use this" }));
    const chips = await screen.findByRole("list", { name: "This search only" });
    for (const label of ["Hybrid or Remote", "Sydney", "Posted this week", "Skip big tech", "Claude will also look for: data"]) {
      expect(within(chips).getByText(label)).toBeInTheDocument();
    }
    await userEvent.click(within(chips).getByRole("button", { name: "Remove Sydney" }));
    expect(within(chips).queryByText("Sydney")).toBeNull();
    // The saved filters are still there, under All filters.
    expect(screen.getByText("All filters")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Find jobs" }));
    await waitFor(() => expect(runs(b)).toHaveLength(1));
    expect(runs(b)[0]!.search).toEqual({ work_modes: ["hybrid", "remote"], posted_week: true, skip_big_tech: true, free_text: "data" });
    // Nothing was saved to the search settings.
    expect(((await b.settings.get("search")).values.filters as Record<string, unknown>).posted_this_week).toBe(false);
  });

  it("Recent jobs: one click for newest first, posted in the last 3 days; a date typed after replaces it", async () => {
    const b = new MockBridge();
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Recent jobs" }));
    const chips = await screen.findByRole("list", { name: "This search only" });
    expect(within(chips).getByText("Newest first")).toBeInTheDocument();
    expect(within(chips).getByText("Posted in the last 3 days")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Describe the jobs you want" }), "last 2 weeks");
    await userEvent.click(screen.getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(within(chips).queryByText("Posted in the last 3 days")).toBeNull());
    expect(within(chips).getByText("Posted in the last 2 weeks")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Find jobs" }));
    await waitFor(() => expect(runs(b)).toHaveLength(1));
    expect(runs(b)[0]!.search).toEqual({ sort: "recent", posted_days: 14 });
  });
});
