import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FieldDef } from "@careeros/contract";
import { FieldForm } from "../src/components/FieldForm";
import { blankRow, checkRows, moveRow } from "../src/components/ListField";
import { MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 15_000 });

const saves = (b: MockBridge) => b.calls.filter((c) => c.method === "settings.save").map((c) => c.args);
const sub = (over: Partial<FieldDef>): FieldDef => ({ path: "x", label: "X", type: "string", options: [], optionLabels: {}, help: "", pattern: "", fields: [], ...over });
const PLACES: FieldDef = sub({
  path: "locations", label: "Preferred locations", type: "object[]",
  fields: [sub({ path: "place", label: "Place" }), sub({ path: "modes", label: "Work modes", type: "enum[]", options: ["onsite", "hybrid", "remote"] }), sub({ path: "will_relocate", label: "Willing to relocate", type: "boolean" })],
});
const places = async (b: MockBridge) => (await b.settings.get("profile")).values.locations as { place: string; modes: string[]; will_relocate: boolean }[];

describe("list editor logic", () => {
  it("makes a blank row from the schema, moves rows, and checks names", () => {
    expect(blankRow(PLACES)).toEqual({ place: "", modes: ["onsite", "hybrid", "remote"], will_relocate: false });
    expect(moveRow(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveRow(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
    expect(moveRow(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(checkRows(PLACES, [{ place: "  Perth " }])).toEqual({ value: [{ place: "Perth" }] });
    expect(checkRows(PLACES, [{ place: " " }]).error).toMatch(/Each row needs a place/);
    expect(checkRows(PLACES, [{ place: "Perth" }, { place: "perth" }]).error).toMatch(/perth is in the list twice/i);
    expect(checkRows(PLACES, "oops")).toEqual({ value: [] });
  });
});

describe("Preferred locations editor", () => {
  it("adds a place with suggestions, saving once typing pauses, with every work mode on", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="profile" only="locations" />, { bridge: b });
    const group = await screen.findByRole("group", { name: "Preferred locations" });
    expect(within(group).getByRole("combobox", { name: "Place 1" })).toHaveValue("Sampletown NSW");
    await userEvent.click(within(group).getByRole("button", { name: "Add place" }));
    const box = within(group).getByRole("combobox", { name: "Place 3" });
    await waitFor(() => expect(box).toHaveFocus());
    await userEvent.type(box, "Brisb");
    // The app's own suggestion list, not the browser's.
    expect(within(group).getByRole("option", { name: "Brisbane" })).toBeInTheDocument();
    await userEvent.type(box, "ane");
    await waitFor(() => expect(saves(b).length).toBeGreaterThan(0), { timeout: 4000 });
    expect((await places(b)).map((p) => p.place)).toEqual(["Sampletown NSW", "Remote Australia", "Brisbane"]);
    expect((await places(b))[2]).toEqual({ place: "Brisbane", modes: ["onsite", "hybrid", "remote"], will_relocate: false });
    for (const [kind, changes] of saves(b)) { expect(kind).toBe("profile"); expect((changes as { path: string }[]).map((c) => c.path)).toEqual(["locations"]); }
  });

  it("reorders with the arrow buttons and with the handle's Up key, and says so", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="profile" only="locations" />, { bridge: b });
    const group = await screen.findByRole("group", { name: "Preferred locations" });
    expect(within(group).getByRole("button", { name: "Move Sampletown NSW up" })).toBeDisabled();
    await userEvent.click(within(group).getByRole("button", { name: "Move Sampletown NSW down" }));
    await waitFor(async () => expect((await places(b)).map((p) => p.place)).toEqual(["Remote Australia", "Sampletown NSW"]));
    expect(screen.getByText("Sampletown NSW moved to position 2 of 2.")).toBeInTheDocument();
    const handle = await within(group).findByRole("button", { name: /^Reorder Sampletown NSW, position 2 of 2/ });
    handle.focus();
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(async () => expect((await places(b)).map((p) => p.place)).toEqual(["Sampletown NSW", "Remote Australia"]));
    await waitFor(() => expect(within(group).getByRole("button", { name: /^Reorder Sampletown NSW, position 1/ })).toHaveFocus());
  });

  it("reorders by dragging a row's handle onto another row", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="profile" only="locations" />, { bridge: b });
    const group = await screen.findByRole("group", { name: "Preferred locations" });
    const rows = group.querySelectorAll("li");
    const handle = within(group).getByRole("button", { name: /^Reorder Remote Australia/ });
    const data = { effectAllowed: "", dropEffect: "", setData: () => undefined, getData: () => "" };
    fireEvent.dragStart(handle, { dataTransfer: data });
    fireEvent.dragOver(rows[0]!, { dataTransfer: data });
    fireEvent.drop(rows[0]!, { dataTransfer: data });
    await waitFor(async () => expect((await places(b)).map((p) => p.place)).toEqual(["Remote Australia", "Sampletown NSW"]));
  });

  it("removes a place, ticks work modes and relocation, and offers Undo", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="profile" only="locations" />, { bridge: b });
    const group = await screen.findByRole("group", { name: "Preferred locations" });
    const modes = within(group).getByRole("group", { name: "Work modes for Sampletown NSW" });
    await userEvent.click(within(modes).getByRole("checkbox", { name: "On site" }));
    await waitFor(async () => expect((await places(b))[0]!.modes).toEqual(["hybrid", "remote"]));
    await userEvent.click(within(group).getAllByRole("checkbox", { name: "Willing to relocate" })[0]!);
    await waitFor(async () => expect((await places(b))[0]!.will_relocate).toBe(true));
    await userEvent.click(within(group).getByRole("button", { name: "Remove Remote Australia" }));
    await waitFor(async () => expect((await places(b)).map((p) => p.place)).toEqual(["Sampletown NSW"]));
    expect(screen.getByText("Remote Australia removed.")).toBeInTheDocument();
  });

  it("an empty place isn't saved; it says what to do", async () => {
    const b = new MockBridge();
    renderApp(<FieldForm kind="profile" only="locations" />, { bridge: b });
    const group = await screen.findByRole("group", { name: "Preferred locations" });
    await userEvent.click(within(group).getByRole("button", { name: "Add place" }));
    await userEvent.click(within(group).getByRole("button", { name: "Remove Sampletown NSW" }));
    expect(await within(group).findByText(/Each row needs a place\. Type one, or remove the empty row\./)).toBeInTheDocument();
    expect(saves(b)).toEqual([]);
    expect((await places(b)).map((p) => p.place)).toEqual(["Sampletown NSW", "Remote Australia"]);
  });
});
