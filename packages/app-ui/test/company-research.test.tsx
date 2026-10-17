import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { CompanyScreen } from "../src/screens/Company";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 15_000 });

function bridgeWith(researched: string) {
  const f = loadFixture();
  f.texts["companies/acme-corp/research.md"] = `# Acme Corp\n\nResearched: ${researched}\n\nWhat they do: example widgets.\n`;
  return new MockBridge({ fixture: f, now: new Date(2026, 9, 17, 10, 0) });
}

describe("company research age", () => {
  it("says stale research is old and offers Refresh", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-corp", tab: "research" }} />, { bridge: bridgeWith("2026-09-06") });
    expect(await screen.findByText(/^Researched 41 days ago\. Research older than 30 days may be out of date/)).toBeInTheDocument();
    expect((await screen.findAllByRole("button", { name: "Refresh the research on Acme Corp" })).length).toBeGreaterThan(0);
  });

  it("says quietly when fresh research was done, with no Refresh", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-corp", tab: "research" }} />, { bridge: bridgeWith("2026-10-15") });
    expect(await screen.findByText("Researched 2 days ago.")).toBeInTheDocument();
    // The research action has loaded its state (done), and offers no Refresh.
    expect((await screen.findAllByText("Research ready")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Refresh the research on Acme Corp" })).toBeNull();
  });
});
