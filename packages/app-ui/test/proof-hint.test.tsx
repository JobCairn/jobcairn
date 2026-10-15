import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { ApplyScreen } from "../src/screens/Apply";
import { renderApp } from "./render";

const ROUTE = { screen: "apply", slug: "example-labs", id: "2026-01-12-backend-engineer-llm" } as const;

function bridgeWith(links: string[]) {
  const f = loadFixture();
  (f.profile.contact as { links: string[] }).links = links;
  return new MockBridge({ fixture: f });
}

describe("Apply › Prepare › Proof of work", () => {
  it("names the profile link that best proves the top must-have, with a cover-letter line", async () => {
    // A fictional project link for Alex Example.
    renderApp(<ApplyScreen route={ROUTE} />, { bridge: bridgeWith(["https://github.com/alexexample/typescript-api-demo"]) });
    expect(await screen.findByText(/is github\.com\/alexexample\/typescript-api-demo\. A line for your cover letter:/)).toBeInTheDocument();
    expect(screen.getByText(/^For an example of my .+ work, see https:\/\/github\.com\/alexexample\/typescript-api-demo\.$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy line" })).toBeInTheDocument();
  });

  it("shows nothing when no artefact fits", async () => {
    renderApp(<ApplyScreen route={ROUTE} />, { bridge: bridgeWith(["https://example.com/alex"]) });
    expect(await screen.findByRole("heading", { name: /Apply:/ })).toBeInTheDocument();
    expect(screen.queryByText("Proof of work")).toBeNull();
  });
});
