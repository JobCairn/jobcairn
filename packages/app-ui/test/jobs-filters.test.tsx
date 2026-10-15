import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { JobsScreen } from "../src/screens/Jobs";
import { EMPTY_FORM, NO_FILTERS, filtersKey, formFromParams, formFromQuery, paramsFromForm, type JobsForm } from "../src/jobs/filters";
import { chipValue } from "../src/filters/FilterChip";
import { parseHash, toHash } from "../src/router";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 15_000 });
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
const chip = (name: string) => screen.getByRole("button", { name: new RegExp(`^(Filter by ${name.toLowerCase()}|${name}: .*Change)$`) });
function sponsorBridge(): MockBridge {
  const f = loadFixture();
  (f.profile as { work_rights: { status: string } }).work_rights.status = "needs_sponsorship";
  return new MockBridge({ fixture: f });
}
beforeEach(() => { localStorage.clear(); window.location.hash = "#/jobs"; });

describe("the list's state in the address", () => {
  const full: JobsForm = {
    text: "ai engineer", sort: "fit", showIneligible: true,
    filters: { ...NO_FILTERS, sponsor: ["confirmed", "likely"], modes: ["remote"], location: "Sydney", salaryMin: 120000, postedDays: 7, fitMin: 70,
      statuses: ["Found", "Saved"], sites: ["SEEK", "LinkedIn"], jobTypes: ["contract", ""], labels: ["visa_ok"] },
  };
  it("round-trips every filter, in a fixed order, and drops junk", () => {
    const p = paramsFromForm(full);
    expect(p.toString()).toBe("st=Found%2CSaved&wr=visa_ok&sp=confirmed%2Clikely&mode=remote&loc=Sydney&pay=120000&posted=7&fit=70&site=SEEK%2CLinkedIn&type=contract%2Cnone&q=ai+engineer&sort=fit&all=1");
    expect(formFromParams(p)).toEqual(full);
    expect(formFromParams(new URLSearchParams("sp=likely,nope&mode=teleport&pay=-5&posted=1.5&fit=200&sort=up&status=Lost"))).toEqual({ ...EMPTY_FORM, filters: { ...NO_FILTERS, sponsor: ["likely"] } });
    expect(paramsFromForm(EMPTY_FORM).toString()).toBe("");
  });
  it("the route keeps Home's one-filter links and carries the rest", () => {
    expect(parseHash("#/jobs?status=Applied")).toEqual({ screen: "jobs", status: "Applied" });
    expect(parseHash("#/jobs?label=visa_ok")).toEqual({ screen: "jobs", label: "visa_ok" });
    const r = parseHash(`#/jobs?${paramsFromForm(full).toString()}`);
    expect(r).toMatchObject({ screen: "jobs", filters: paramsFromForm(full).toString() });
    expect(parseHash(toHash(r))).toEqual(r);
    expect(parseHash("#/jobs?mode=remote&junk=1")).toEqual({ screen: "jobs", filters: "mode=remote" });
  });
  it("a list with only one status or one work-rights label comes back as that list, not as Home's link", () => {
    for (const filters of [{ ...NO_FILTERS, statuses: ["Applying" as const] }, { ...NO_FILTERS, labels: ["sponsorship_offered" as const] }]) {
      const form: JobsForm = { ...EMPTY_FORM, filters };
      const r = parseHash(toHash({ screen: "jobs", filters: paramsFromForm(form).toString() }));
      expect(r).toEqual({ screen: "jobs", filters: paramsFromForm(form).toString() });
      expect(formFromParams(new URLSearchParams((r as { filters: string }).filters))).toEqual(form);
    }
    // Home's links still read as before (Apply view; work-rights link).
    expect(formFromParams(new URLSearchParams("status=Applied&label=visa_ok")).filters).toMatchObject({ statuses: ["Applied"], labels: ["visa_ok"] });
  });
  it("an old saved view with free-text modes still loads", () => {
    expect(formFromQuery({ modes: ["Remote", "on-site"], statuses: ["Found"] }).filters).toMatchObject({ modes: ["remote", "onsite"], statuses: ["Found"] });
  });
  it("chip values stay short", () => {
    expect(chipValue(["Likely"])).toBe("Likely");
    expect(chipValue(["Likely", "Possible"])).toBe("Likely, Possible");
    expect(chipValue(["Likely", "Possible", "Low"])).toBe("Likely +2");
  });
});

describe("Jobs quick filters", () => {
  it("each chip shows choices with live counts; ticking one filters the list and the chip shows it with an x", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: sponsorBridge() });
    await screen.findByRole("table");
    expect(rows()).toHaveLength(2);
    await userEvent.click(chip("Sponsorship"));
    const panel = await screen.findByRole("dialog", { name: "Sponsorship" });
    const likely = within(panel).getByRole("checkbox", { name: /^Likely/ });
    expect(likely.closest("label")).toHaveTextContent("Likely");
    expect(within(panel).getByRole("checkbox", { name: /^Confirmed/ }).closest("label")).toHaveTextContent("1");
    expect(within(panel).getByRole("checkbox", { name: /^Low/ }).closest("label")).toHaveTextContent("1");
    await userEvent.click(within(panel).getByRole("checkbox", { name: /^Confirmed/ }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("AI Engineer");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip("Sponsorship")).toHaveFocus();
    expect(chip("Sponsorship")).toHaveAccessibleName("Sponsorship: Confirmed. Change");
    // Work-mode counts follow the sponsorship filter: only the confirmed job (hybrid) is left.
    await userEvent.click(chip("Work mode"));
    const modes = await screen.findByRole("dialog", { name: "Work mode" });
    expect(within(modes).getByRole("checkbox", { name: /^Hybrid/ }).closest("label")).toHaveTextContent("1");
    expect(within(modes).getByRole("checkbox", { name: /^Remote/ }).closest("label")).toHaveTextContent("0");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Clear sponsorship filter" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it("covers location, posted and board, and Clear all turns every filter off", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    await userEvent.click(chip("Location"));
    const loc = await screen.findByRole("dialog", { name: "Location" });
    await userEvent.click(within(loc).getByRole("button", { name: /^Remote Australia/ }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.click(chip("Board"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Board" })).getByRole("checkbox", { name: /^Adzuna/ }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Backend Engineer (LLM)");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(chip("Posted"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Posted" })).getByRole("radio", { name: /^Last 24 hours/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The ad shows no posted date: it stays (never filtered by the day it was found) until undated jobs are left out.
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.click(chip("Posted"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Posted" })).getByRole("checkbox", { name: /^Include jobs with no posted date/ }));
    await waitFor(() => expect(screen.getByText("No jobs match these filters.")).toBeInTheDocument());
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  it("writes the list's state into the address and keeps it for this workspace", async () => {
    const b = new MockBridge();
    const { unmount } = renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: b });
    await screen.findByRole("table");
    await userEvent.click(chip("Work mode"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Work mode" })).getByRole("checkbox", { name: /^Remote/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/jobs?mode=remote"));
    const key = Object.keys(localStorage).find((k) => k.startsWith("careeros.jobs.filters:jobs:"));
    expect(key).toBeDefined();
    expect(localStorage.getItem(key!)).toBe("mode=remote");
    unmount();
    // Coming back with a plain address (the sidebar's Jobs link) brings the same list back.
    window.location.hash = "#/jobs";
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: b });
    await waitFor(() => expect(chip("Work mode")).toHaveAccessibleName("Work mode: Remote. Change"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(filtersKey("w", "jobs")).toBe("careeros.jobs.filters:jobs:w");
  });

  it("an address with filters (Back from a job) wins over the kept list", async () => {
    localStorage.setItem("careeros.jobs.filters:jobs:default", "mode=remote");
    renderApp(<JobsScreen route={parseHash("#/jobs?site=Greenhouse&st=Applied")} />);
    await screen.findByRole("table");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("AI Engineer");
    expect(chip("Work mode")).toHaveAccessibleName("Filter by work mode");
    expect(chip("Board")).toHaveAccessibleName("Board: Greenhouse. Change");
  });
});
