import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { checkJobPlace, searchPrefsFrom } from "@careeros/contract";
import { FieldForm } from "../src/components/FieldForm";
import { MockBridge } from "../src/mock/MockBridge";
import { SEARCH_ADDONS } from "../src/screens/Settings";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 20_000 });
const filters = async (b: MockBridge) => (await b.settings.get("search")).values.filters as Record<string, unknown>;
const places = async (b: MockBridge) => ((await b.settings.get("profile")).values.locations as { place: string }[]).map((p) => p.place);

describe("Settings › Search", () => {
  it("breadth is a pair of radio choices, like the Find jobs chip, and saves on pick", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="search" only={["filters.breadth"]} choices={["filters.breadth"]} bare />, { bridge: b });
    const group = await screen.findByRole("group", { name: "Search breadth" });
    expect(within(group).getByRole("radio", { name: /^Focused/ })).toBeChecked();
    expect(within(group).getByText("Up to 5 searches on your closest roles")).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("radio", { name: /^Broad/ }));
    await waitFor(async () => expect((await filters(b)).breadth).toBe("broad"));
  });

  it("a custom place that isn't in the suggestion list saves as typed, on leaving the box, and reaches the search", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="profile" only="locations" />, { bridge: b });
    const group = await screen.findByRole("group", { name: "Preferred locations" });
    await userEvent.click(within(group).getByRole("button", { name: "Add place" }));
    const box = within(group).getByRole("combobox", { name: "Place 3" });
    expect(box).toHaveAttribute("autocomplete", "off");
    expect(box).not.toHaveAttribute("list");
    fireEvent.change(box, { target: { value: "  Anywhere in QLD " } });
    // The app's own suggestions only help: "Anywhere in QLD" isn't one of them.
    fireEvent.blur(box);
    await waitFor(async () => expect(await places(b)).toEqual(["Sampletown NSW", "Remote Australia", "Anywhere in QLD"]));
    const prefs = searchPrefsFrom((await b.settings.get("profile")).values, (await b.settings.get("search")).values);
    expect(prefs.locations).toContain("Anywhere in QLD");
    // A place the country list doesn't know never makes the search refuse jobs there.
    expect(checkJobPlace(searchPrefsFrom({ locations: [{ place: "Smalltown Ridge" }] }, {}), { location: "Smalltown Ridge" }).verdict).toBe("ok");
  });

  it("place suggestions are the app's own list: arrows and Enter pick one", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="profile" only="locations" />, { bridge: b });
    const group = await screen.findByRole("group", { name: "Preferred locations" });
    await userEvent.click(within(group).getByRole("button", { name: "Add place" }));
    const box = within(group).getByRole("combobox", { name: "Place 3" });
    await userEvent.type(box, "bris");
    expect(within(group).getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(async () => expect((await places(b)).at(-1)).toBe("Brisbane"));
  });

  it("related titles and fallback places are chips: Enter, a comma and leaving the box all add one", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="search" />, { bridge: b });
    const titles = await screen.findByRole("group", { name: "Related job titles" });
    const add = within(titles).getByRole("textbox", { name: "Add related job title" });
    await userEvent.type(add, "Applied AI Engineer{Enter}");
    await waitFor(async () => expect((await filters(b)).related_titles).toEqual(["Applied AI Engineer"]));
    await userEvent.type(add, "LLM Engineer,");
    await waitFor(async () => expect((await filters(b)).related_titles).toEqual(["Applied AI Engineer", "LLM Engineer"]));
    await userEvent.type(add, "  AI Developer ");
    fireEvent.blur(add);
    await waitFor(async () => expect((await filters(b)).related_titles).toEqual(["Applied AI Engineer", "LLM Engineer", "AI Developer"]));
    await userEvent.click(within(titles).getByRole("button", { name: "Remove LLM Engineer" }));
    await waitFor(async () => expect((await filters(b)).related_titles).toEqual(["Applied AI Engineer", "AI Developer"]));
    const fallback = screen.getByRole("group", { name: "If there aren't enough jobs there, also search" });
    await userEvent.type(within(fallback).getByRole("combobox"), "Outer Example Shire{Enter}");
    await waitFor(async () => expect((await filters(b)).fallback_locations).toEqual(["Outer Example Shire"]));
  });

  it("too few matches shows 10 as its default in a stepper; there's one work-modes control (per place)", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="search" />, { bridge: b });
    const step = await screen.findByRole("group", { name: "Too few matches means fewer than" });
    expect(within(step).getByRole("textbox")).toHaveValue("10");
    await userEvent.click(within(step).getByRole("button", { name: "More: 11" }));
    await waitFor(async () => expect((await filters(b)).min_results).toBe(11));
    expect(screen.queryByRole("group", { name: "Work modes" })).toBeNull();
  });

  it("jobs to find shows 100 as its default in a stepper, with the plain cost hint, and saves", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="search" />, { bridge: b });
    const step = await screen.findByRole("group", { name: "Jobs to find each time" });
    expect(within(step).getByRole("textbox")).toHaveValue("100");
    expect(screen.getByText(/Bigger searches take longer and use more of your Claude plan\./)).toBeInTheDocument();
    await userEvent.click(within(step).getByRole("button", { name: "More: 101" }));
    await waitFor(async () => expect((await filters(b)).max_jobs).toBe(101));
  });

  it("Suggest offers related titles from the resume, leaving out ones already listed, and adds the picked ones", async () => {
    const b = new MockBridge();
    await b.settings.save("search", [{ path: "filters.related_titles", value: ["LLM Engineer"] }]);
    renderApp(<FieldForm kind="search" addons={SEARCH_ADDONS} />, { bridge: b });
    const ask = await screen.findByRole("button", { name: "Suggest" });
    await waitFor(() => expect(ask).toHaveAttribute("title", "Suggest 5-10 titles from your resume"));
    await userEvent.click(ask);
    await waitFor(() => expect(document.querySelector(".rfill-chip")).not.toBeNull());
    b.claudeSim.finish(b.claudeSim.runs[0]!.id);
    const group = await screen.findByRole("group", { name: "Suggested titles" }, { timeout: 5000 });
    const offered = within(group).getAllByRole("button").map((x) => x.textContent);
    expect(offered).not.toContain("LLM Engineer");
    expect(offered).toContain("Applied AI Engineer");
    await userEvent.click(within(group).getByRole("button", { name: "AI Developer" }));
    const n = offered.length - 1;
    await userEvent.click(screen.getByRole("button", { name: `Add ${n} titles` }));
    await waitFor(async () => expect((await filters(b)).related_titles).toHaveLength(1 + n));
    const saved = (await filters(b)).related_titles as string[];
    expect(saved[0]).toBe("LLM Engineer");
    expect(saved).not.toContain("AI Developer");
    expect(new Set(saved.map((s) => s.toLowerCase())).size).toBe(saved.length);
  });

  it("Suggest points to Claude setup when Claude isn't ready", async () => {
    const b = new MockBridge({ claudeEngine: { cli: "missing" } });
    renderApp(<FieldForm kind="search" addons={SEARCH_ADDONS} />, { bridge: b });
    expect(await screen.findByRole("button", { name: "Claude setup" })).toBeInTheDocument();
  });
});
