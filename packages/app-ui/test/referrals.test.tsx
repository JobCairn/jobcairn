import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { LinkedInImport } from "../src/outreach/LinkedInImport";
import { renderApp } from "./render";

const ROUTE = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "outreach" } as const;

describe("Referral finder", () => {
  it("imports the picked Connections.csv in Settings and can remove it", async () => {
    const bridge = new MockBridge({ pickFile: "/Users/alex/Downloads/Connections.csv" });
    renderApp(<LinkedInImport />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "Import LinkedIn" }));
    expect(await screen.findByText("2 imported")).toBeInTheDocument();
    expect(screen.getByText(/never sent to Claude/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Not imported")).toBeInTheDocument();
  });

  it("shows people you know at the job's company with a referral draft (Mail) and LinkedIn copy", async () => {
    const bridge = new MockBridge();
    await bridge.network.importLinkedIn("/Users/alex/Downloads/Connections.csv");
    renderApp(<JobScreen route={ROUTE} />, { bridge });
    expect(await screen.findByText("Sam Sample")).toBeInTheDocument();
    expect(screen.queryByText("Jo Placeholder")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy a referral request for Sam Sample" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Ask Sam Sample for a referral" }));
    expect(await screen.findByDisplayValue("AI Engineer role at Acme Corp")).toBeInTheDocument();
  });

  it("points to Settings when no connections are imported", async () => {
    renderApp(<JobScreen route={ROUTE} />, { bridge: new MockBridge() });
    expect(await screen.findByRole("button", { name: "Import connections" })).toBeInTheDocument();
  });
});
