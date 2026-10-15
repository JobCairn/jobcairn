import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";
import { SettingsScreen } from "../src/screens/Settings";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 15_000 });

const saves = (b: MockBridge) => b.calls.filter((c) => c.method === "settings.save").map((c) => c.args);
const row = async (name: string) => (await screen.findByRole("radiogroup", { name: `${name} length` })) as HTMLElement;

describe("Settings › Video", () => {
  it("has one Video heading and no raw zero lengths or full-width number boxes", async () => {
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=video" });
    await row("Skill-gap lesson");
    expect(screen.queryByRole("heading", { name: "Videos" })).toBeNull();
    expect(screen.queryByText(/Default lengths in seconds/)).toBeNull();
    expect(screen.queryByDisplayValue("0")).toBeNull();
    // Type default shows the type's own target, never 0.
    const pitch = await row("Tell me about yourself");
    expect(within(pitch).getByRole("radio", { name: /Type default about 1:00/ })).toBeChecked();
  });
  it("offers only the presets inside each type's range", async () => {
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=video" });
    const recap = await row("Weekly recap"); // 0:30 to 1:00
    expect(within(recap).getByRole("radio", { name: /Quick/ })).toBeInTheDocument();
    expect(within(recap).queryByRole("radio", { name: /Standard/ })).toBeNull();
    expect(within(recap).queryByRole("radio", { name: /In-depth/ })).toBeNull();
    const lesson = await row("Skill-gap lesson");
    expect(within(lesson).getByRole("radio", { name: /In-depth/ })).toBeInTheDocument();
  });
  it("saves a preset as soon as it's picked, and Type default saves 0", async () => {
    const { bridge } = renderApp(<SettingsScreen />, { hash: "#/settings?tab=video" });
    const lesson = await row("Skill-gap lesson");
    await userEvent.click(within(lesson).getByRole("radio", { name: /Quick/ }));
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["integrations", [{ path: "video.lengths.skill_gap_lesson", value: 60 }]]));
    await userEvent.click(within(lesson).getByRole("radio", { name: /Type default/ }));
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["integrations", [{ path: "video.lengths.skill_gap_lesson", value: 0 }]]));
  });
  it("saves a custom m:ss length once it's valid, and never an out-of-range one", async () => {
    const { bridge } = renderApp(<SettingsScreen />, { hash: "#/settings?tab=video" });
    const pitch = await row("Tell me about yourself");
    await userEvent.click(within(pitch).getByRole("radio", { name: /Custom/ }));
    expect(saves(bridge)).toEqual([]);
    const box = screen.getByLabelText("Tell me about yourself custom length (minutes:seconds)");
    fireEvent.change(box, { target: { value: "9:00" } });
    fireEvent.blur(box);
    expect(await screen.findByText(/can run 0:30 to 3:00/)).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(saves(bridge)).toEqual([]);
    fireEvent.change(box, { target: { value: "1:45" } });
    fireEvent.blur(box);
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["integrations", [{ path: "video.lengths.pitch", value: 105 }]]));
  });
  it("saves the caption style on change and previews it", async () => {
    const { bridge } = renderApp(<SettingsScreen />, { hash: "#/settings?tab=video" });
    const select = await screen.findByLabelText("Caption style");
    await userEvent.selectOptions(select, "none");
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["integrations", [{ path: "video.captions", value: "none" }]]));
    expect(await screen.findByText("Videos have no captions burned in.")).toBeInTheDocument();
  });
  it("gives a custom video type a default-length row that saves like the built-in ones", async () => {
    const b = new MockBridge();
    b.seedVideoType({ id: "team-intro", label: "Team intro", description: "A fictional custom type.", subject: "job", entry_points: ["job"],
      length: { min_s: 30, target_s: 90, max_s: 180 }, modes: [], writer: "claude" });
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=video" });
    const custom = await row("Team intro");
    expect(screen.getByText(/your own type/)).toBeInTheDocument();
    expect(within(custom).getByRole("radio", { name: /Type default about 1:30/ })).toBeChecked();
    await userEvent.click(within(custom).getByRole("radio", { name: /Quick/ }));
    await waitFor(() => expect(saves(b).at(-1)).toEqual(["integrations", [{ path: "video.lengths.team_intro", value: 60 }]]));
    await waitFor(() => expect(within(custom).getByRole("radio", { name: /Quick/ })).toBeChecked());
  });
});
