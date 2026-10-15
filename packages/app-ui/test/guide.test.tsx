import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "@careeros/brand";
import { GettingStarted, NextStep } from "../src/guide";
import { loadFixture, MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";

const step = (name: RegExp) => screen.getByText(name, { selector: ".t-strong" }).closest("li")!;

describe("GettingStarted", () => {
  it("ticks steps from real workspace state", async () => {
    // The sample: a profile but no resume, three jobs (none scored, one applied), one guide.
    renderApp(<GettingStarted />);
    expect(await screen.findByText("Your first week, step by step")).toBeInTheDocument();
    expect(step(/^Add your resume/)).toHaveAttribute("data-state", "next");
    expect(step(/^Find jobs/)).toHaveAttribute("data-state", "done");
    expect(step(/^Score a job/)).toHaveAttribute("data-state", "todo");
    expect(step(/^Prepare your first application/)).toHaveAttribute("data-state", "done");
    expect(step(/^Start a learning topic/)).toHaveAttribute("data-state", "done");
    // The sample mock has Gmail connected.
    expect(step(/^Set up email/)).toHaveAttribute("data-state", "done");
    expect(screen.getByLabelText("4 of 6 steps done")).toBeInTheDocument();
  });

  it("offers Set up email, which opens Settings > Connections > Email, when Gmail isn't connected", async () => {
    renderApp(<GettingStarted />, { bridge: new MockBridge({ mailConnected: false }) });
    await screen.findByText("Your first week, step by step");
    await userEvent.click(within(step(/^Set up email/)).getByRole("button", { name: "Connect Gmail" }));
    expect(window.location.hash).toBe("#/settings?tab=connections&c=email");
  });

  it("each open step has a one-click action; scoring asks Claude", async () => {
    const { bridge } = renderApp(<GettingStarted />);
    await screen.findByText("Your first week, step by step");
    expect(within(step(/^Add your resume/)).getByRole("button", { name: "Add resume" })).toBeEnabled();
    await userEvent.click(within(step(/^Score a job/)).getByRole("button", { name: "Score" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "claude.run")?.args[0]).toBe("score_job"));
  });

  it("a step that can't be done yet says why", async () => {
    const f = loadFixture();
    f.jobs = [];
    renderApp(<GettingStarted />, { bridge: new MockBridge({ fixture: f }) });
    await screen.findByText("Your first week, step by step");
    expect(within(step(/^Score a job/)).getByRole("button", { name: "Score" })).toBeDisabled();
    expect(within(step(/^Score a job/)).getByText("Find a job first.")).toBeInTheDocument();
    expect(within(step(/^Find jobs/)).getByRole("button", { name: "Find jobs" })).toBeEnabled();
  });

  it("compact (on Home): only the next step, with a way to see them all", async () => {
    renderApp(<GettingStarted compact />);
    await screen.findByText("Your first week, step by step");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(step(/^Add your resume/)).toHaveAttribute("data-state", "next");
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("can be hidden, and the choice is saved", async () => {
    const b = new MockBridge();
    renderApp(<GettingStarted />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Hide the getting started checklist" }));
    await waitFor(() => expect(screen.queryByText("Your first week, step by step")).toBeNull());
    expect((await b.guide.state()).dismissed).toBe(true);
  });

  it("Learn's empty state shows it even when hidden", async () => {
    const b = new MockBridge();
    await b.guide.setDismissed(true);
    renderApp(<GettingStarted always />, { bridge: b });
    expect(await screen.findByText("Your first week, step by step")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hide/ })).toBeNull();
  });

  it("Start a topic opens Learn with the dialog", async () => {
    const f = loadFixture();
    f.learning.topics = [];
    f.jobs.forEach((j) => { j.interview = []; });
    renderApp(<GettingStarted />, { bridge: new MockBridge({ fixture: f }) });
    await screen.findByText("Your first week, step by step");
    await userEvent.click(within(step(/^Start a learning topic/)).getByRole("button", { name: "New topic" }));
    expect(window.location.hash).toBe("#/learn?new=1");
  });
});

describe("Set up JobCairn (Home in a real workspace)", () => {
  const title = `Set up ${PRODUCT_NAME}`;
  /** A fictional Chrome connection: helper installed or not, remote control on or not. */
  const withChrome = (b: MockBridge, on: boolean) => {
    (b as unknown as { chrome: unknown }).chrome = { state: async () => ({ available: true, chrome: { found: true }, helper: { found: on }, remote: { on }, connected: on }) };
    return b;
  };

  it("shows the setup steps with live ticks and a count, the next step first", async () => {
    renderApp(<GettingStarted setup />, { bridge: withChrome(new MockBridge(), false) });
    expect(await screen.findByText(title)).toBeInTheDocument();
    // The sample: Claude ready, no Chrome yet, a profile without a resume, roles and places, jobs but none scored.
    expect(step(/^Connect Claude Code/)).toHaveAttribute("data-state", "done");
    expect(step(/^Connect Chrome for job search/)).toHaveAttribute("data-state", "next");
    expect(step(/^Add your resume/)).toHaveAttribute("data-state", "todo");
    expect(step(/^Choose roles and places/)).toHaveAttribute("data-state", "done");
    expect(step(/^Find jobs/)).toHaveAttribute("data-state", "done");
    expect(step(/^Score a job/)).toHaveAttribute("data-state", "todo");
    expect(screen.getByLabelText("3 of 6 setup steps done")).toBeInTheDocument();
  });

  it("each step's button goes straight to the right place", async () => {
    const f = loadFixture();
    (f.profile as unknown as { targets: { roles: string[] } }).targets.roles = [];
    renderApp(<GettingStarted setup />, { bridge: withChrome(new MockBridge({ fixture: f, claudeEngine: { login: "signed_out" } }), false) });
    await screen.findByText(title);
    await userEvent.click(within(step(/^Connect Claude Code/)).getByRole("button", { name: "Connect Claude" }));
    expect(window.location.hash).toBe("#/settings?tab=connections&c=claude");
    await userEvent.click(within(step(/^Connect Chrome/)).getByRole("button", { name: "Set up Chrome" }));
    expect(window.location.hash).toBe("#/settings?tab=connections&c=chrome");
    await userEvent.click(within(step(/^Choose roles and places/)).getByRole("button", { name: "Set roles and places" }));
    expect(window.location.hash).toBe("#/settings?tab=search&section=search-roles");
  });

  it("Chrome can be skipped (and the skip undone); the skip is saved", async () => {
    const b = withChrome(new MockBridge(), false);
    renderApp(<GettingStarted setup />, { bridge: b });
    await screen.findByText(title);
    // Only the optional step offers Skip.
    expect(within(step(/^Add your resume/)).queryByRole("button", { name: /Skip/ })).toBeNull();
    await userEvent.click(within(step(/^Connect Chrome/)).getByRole("button", { name: "Skip Connect Chrome for job search" }));
    await waitFor(() => expect(step(/^Connect Chrome/)).toHaveAttribute("data-state", "skipped"));
    expect(screen.getByLabelText("4 of 6 setup steps done")).toBeInTheDocument();
    expect((await b.guide.state()).skipped).toEqual(["chrome"]);
    await userEvent.click(within(step(/^Connect Chrome/)).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(step(/^Connect Chrome/)).toHaveAttribute("data-state", "next"));
  });

  it("Hide checklist hides it and saves the choice", async () => {
    const b = new MockBridge();
    renderApp(<GettingStarted setup />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Hide the setup checklist" }));
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
    expect((await b.guide.state()).dismissed).toBe(true);
  });

  it("compact: only the next step until expanded", async () => {
    renderApp(<GettingStarted setup compact />, { bridge: withChrome(new MockBridge(), false) });
    await screen.findByText(title);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
  });

  it("once every setup step is done, the first-week list takes over", async () => {
    const f = loadFixture();
    f.texts["me/resumes/alex.md"] = "# Alex Example\n";
    f.jobs[0]!.job.scores.career.scored_at = "2026-01-12T09:00:00.000Z";
    // Leave a first-week step to do, so that list shows.
    f.learning.topics = [];
    f.jobs.forEach((j) => { j.interview = []; });
    renderApp(<GettingStarted setup />, { bridge: withChrome(new MockBridge({ fixture: f }), true) });
    expect(await screen.findByText("Your first week, step by step")).toBeInTheDocument();
    expect(screen.queryByText(title)).toBeNull();
  });

  it("the example folder shows the first-week list, not setup", async () => {
    renderApp(<GettingStarted setup />, { bridge: new MockBridge({ isSample: true }) });
    expect(await screen.findByText("Your first week, step by step")).toBeInTheDocument();
    expect(screen.queryByText(title)).toBeNull();
  });
});

describe("NextStep", () => {
  it("shows a title, a body and the action", async () => {
    renderApp(<NextStep title="No jobs yet" body="Ask Claude to find some." action={<button type="button">Find jobs</button>} />);
    expect(screen.getByRole("heading", { name: "No jobs yet" })).toBeInTheDocument();
    expect(screen.getByText("Ask Claude to find some.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find jobs" })).toBeInTheDocument();
  });
});

describe("Settings: show getting started again", () => {
  it("brings the hidden checklist back, and can hide it", async () => {
    const { GuideSetting } = await import("../src/guide");
    const b = new MockBridge();
    await b.guide.setDismissed(true);
    renderApp(<GuideSetting />, { bridge: b });
    const sw = await screen.findByRole("switch", { name: "Show getting started" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    await waitFor(async () => expect((await b.guide.state()).dismissed).toBe(false));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show getting started" })).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(screen.getByRole("switch", { name: "Show getting started" }));
    await waitFor(async () => expect((await b.guide.state()).dismissed).toBe(true));
  });
});
