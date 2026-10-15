import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RequestComposer } from "../src/composer";
import { MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 15_000 });
const WORKSPACE = { kind: "workspace" } as const;

describe("Find jobs › Repeat this search", () => {
  it("is off by default; every 6 hours, 3 times, saved in the workspace with the next run shown", async () => {
    const b = new MockBridge();
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    const g = await screen.findByRole("group", { name: "Repeat this search" });
    expect(within(g).getByText("Runs only when you press Find jobs.")).toBeInTheDocument();
    await userEvent.selectOptions(within(g).getByRole("combobox", { name: "Repeat this search" }), "hours");
    await userEvent.selectOptions(within(g).getByRole("combobox", { name: "Every" }), "6");
    await userEvent.selectOptions(within(g).getByRole("combobox", { name: "How many times" }), "3");
    await userEvent.click(within(g).getByRole("checkbox", { name: /at login/ }));
    await userEvent.click(within(g).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(g).getByText(/^Every 6 hours, 3 times\. Next run: /)).toBeInTheDocument());
    const v = await b.schedule.get();
    expect(v).toMatchObject({ schedule: { mode: "hours", every_hours: 6, times: 3, runs: 0 }, open_at_login: true });
    expect(Date.parse(v.next_run_at) - Date.parse("2026-01-15T09:00:00.000Z")).toBe(6 * 3_600_000);
  });

  it("daily needs at least one day", async () => {
    const b = new MockBridge();
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    const g = await screen.findByRole("group", { name: "Repeat this search" });
    await userEvent.selectOptions(within(g).getByRole("combobox", { name: "Repeat this search" }), "daily");
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) await userEvent.click(within(g).getByRole("checkbox", { name: d }));
    expect(within(g).getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(within(g).getByRole("checkbox", { name: "Sat" }));
    await userEvent.click(within(g).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await b.schedule.get()).schedule).toMatchObject({ mode: "daily", days: [6], at: "08:00" }));
  });
});
