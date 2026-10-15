import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ClaudeProjectSettings } from "../src/claude/ClaudeWorkspace";
import { MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";

describe("Settings › Claude: this project's setup and auto mode", () => {
  it("shows the checklist, says auto mode is on and what that means, and turns it off and on", async () => {
    const b = new MockBridge();
    renderApp(<ClaudeProjectSettings />, { bridge: b });
    const list = await screen.findByRole("list", { name: "Claude setup for this project" });
    for (const t of ["Claude ready", "Skills installed", "Browser helper ready"]) expect(within(list).getByText(t)).toBeInTheDocument();
    const sw = screen.getByRole("switch", { name: "Auto mode: on for this project" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Claude can read and write files in this project without asking\. Locked folders, your settings and secrets stay off limits\./)).toBeInTheDocument();
    expect(screen.getByText(/Searches in your Chrome always use a fixed list of allowed steps/)).toBeInTheDocument();
    await userEvent.click(sw);
    expect(await screen.findByRole("switch", { name: "Auto mode: off for this project" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Claude can only read this project and write the files each task names\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Auto mode: off for this project" }));
    expect(await screen.findByRole("switch", { name: "Auto mode: on for this project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("offers Repair when the project's setup is out of date", async () => {
    const b = new MockBridge({ claudeEngine: { setupStale: true } });
    renderApp(<ClaudeProjectSettings />, { bridge: b });
    expect(await screen.findByText("Some of Claude's setup for this project is missing or out of date.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Repair" }));
    expect(await screen.findByText("Claude's setup for this project is repaired.")).toBeInTheDocument();
  });
});
