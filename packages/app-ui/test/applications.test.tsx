import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { ApplicationsScreen } from "../src/screens/Applications";
import { renderApp } from "./render";

describe("Applications", () => {
  beforeEach(() => sessionStorage.clear());
  it("shows stage tabs with counts and opens on To prepare when nothing is in progress", async () => {
    renderApp(<ApplicationsScreen />);
    expect(await screen.findByRole("heading", { name: "Applications", level: 1 })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs.map((t) => t?.replace(/\d+$/, ""))).toEqual(["To prepare", "In progress", "Waiting for your OK", "Sent", "Interviews", "Closed"]);
    expect(screen.getByRole("tab", { name: /^To prepare/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("button", { name: "Prepare: Backend Engineer (LLM)" }));
    expect(window.location.hash).toBe("#/apply/example-labs/2026-01-12-backend-engineer-llm");
  });
  it("opens on In progress when there is one, with Continue as the one primary action", async () => {
    const f = loadFixture();
    f.jobs.find((j) => j.job.company_slug === "example-labs")!.job.status = "Applying";
    renderApp(<ApplicationsScreen />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByRole("tab", { name: /^In progress/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Continue: Backend Engineer (LLM)" })).toHaveClass("btn--primary");
  });
  it("lists what was sent on its own tab, and remembers the tab this session", async () => {
    const first = renderApp(<ApplicationsScreen />);
    await userEvent.click(await screen.findByRole("tab", { name: /^Sent/ }));
    expect(within(screen.getByRole("region", { name: /^Sent/ })).getByText("AI Engineer")).toBeInTheDocument();
    first.unmount();
    renderApp(<ApplicationsScreen />);
    expect(await screen.findByRole("tab", { name: /^Sent/ })).toHaveAttribute("aria-selected", "true");
  });
  it("gives every stage its own empty state, and points to Jobs when nothing is ready", async () => {
    const f = loadFixture();
    for (const j of f.jobs) j.job.status = "Skipped";
    renderApp(<ApplicationsScreen />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByRole("button", { name: "Open Jobs" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /^Interviews/ }));
    expect(screen.getByText(/No interviews yet/)).toBeInTheDocument();
  });
  it("shows ten at a time with Show more instead of a wall of rows, and filters by fit", async () => {
    const f = loadFixture();
    const base = f.jobs.find((j) => j.job.company_slug === "example-labs")!;
    for (let i = 0; i < 14; i++) f.jobs.push({ ...base, job: { ...base.job, id: `2026-01-12-extra-role-${i}`, title: `Extra role ${i}`, url: `https://jobs.example.com/extra-${i}` } });
    renderApp(<ApplicationsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const list = await screen.findByRole("region", { name: /^To prepare/ });
    expect(within(list).getAllByRole("button", { name: /^Prepare:/ })).toHaveLength(10);
    await userEvent.click(within(list).getByRole("button", { name: /^Show \d+ more$/ }));
    expect(within(list).getAllByRole("button", { name: /^Prepare:/ }).length).toBeGreaterThan(10);
    await userEvent.click(within(list).getByRole("button", { name: "Fit 70+" }));
    expect(within(list).queryAllByRole("button", { name: /^Prepare:/ }).length).toBeLessThan(15);
  });
  it("offers applications with no reply for 60 days as No response, and changes only what you confirm", async () => {
    const f = loadFixture();
    const applied = f.jobs.find((j) => j.job.status === "Applied")!;
    const old = new Date(Date.now() - 70 * 86_400_000).toISOString();
    applied.job.timeline = applied.job.timeline.map((e) => ({ ...e, at: old }));
    applied.job.found_at = old;
    const bridge = new MockBridge({ fixture: f });
    renderApp(<ApplicationsScreen />, { bridge });
    const banner = await screen.findByRole("region", { name: "Applications with no reply" });
    expect(within(banner).getByText("1 application has had no reply for 60 days. Mark it No response?")).toBeInTheDocument();
    // Nothing changes until you confirm.
    expect((await bridge.jobs.get(applied.job.company_slug, applied.job.id)).job.status).toBe("Applied");
    await userEvent.click(within(banner).getByRole("button", { name: "Review applications with no reply" }));
    expect(within(banner).getByRole("checkbox")).toBeChecked();
    await userEvent.click(within(banner).getByRole("button", { name: "Mark 1 as No response" }));
    const after = (await bridge.jobs.get(applied.job.company_slug, applied.job.id)).job;
    expect(after.status).toBe("No response");
    expect(after.timeline.at(-1)).toMatchObject({ event: "Status: No response", note: "No reply for 60 days" });
  });
  it("hides the no-reply banner for the session with Not now", async () => {
    const f = loadFixture();
    const applied = f.jobs.find((j) => j.job.status === "Applied")!;
    const old = new Date(Date.now() - 70 * 86_400_000).toISOString();
    applied.job.timeline = applied.job.timeline.map((e) => ({ ...e, at: old }));
    applied.job.found_at = old;
    renderApp(<ApplicationsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const banner = await screen.findByRole("region", { name: "Applications with no reply" });
    await userEvent.click(within(banner).getByRole("button", { name: /^Not now/ }));
    expect(screen.queryByRole("region", { name: "Applications with no reply" })).not.toBeInTheDocument();
  });
});
