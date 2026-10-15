import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CLAUDE_INSTALL_URL, type ActionTarget } from "@careeros/contract";
import { ClaudeRunPanel, ClaudeSetup, ClaudeWorkingIndicator, formatCost, formatElapsed } from "../src/claude";
import { strayName, workingTitle } from "../src/claude/ClaudeRunPanel";
import { MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";

const LABS: ActionTarget = { kind: "job", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" };
const methods = (b: MockBridge) => b.calls.map((c) => c.method);

describe("ClaudeSetup", () => {
  it("asks for consent first, and records it", async () => {
    const b = new MockBridge({ claudeEngine: { consent: false } });
    renderApp(<ClaudeSetup />, { bridge: b });
    expect(await screen.findByText(/starts Anthropic's Claude Code program/)).toBeInTheDocument();
    expect(screen.getByText(/Claude gets no command line/)).toBeInTheDocument();
    expect(screen.getByText(/ignore your own Claude Code settings/)).toBeInTheDocument();
    expect(screen.queryByText("Experimental")).toBeNull();
    expect(screen.getByText(/opens only if you allow it/)).toBeInTheDocument();
    expect(screen.getByText(/can't read your files/)).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Continue" });
    expect(go).toBeDisabled();
    expect(go).toHaveAttribute("title", 'Tick "I understand" first');
    await userEvent.click(screen.getByLabelText("I understand"));
    await userEvent.click(go);
    expect(await screen.findByText("You agreed to this notice.")).toBeInTheDocument();
    expect(methods(b)).toContain("claude.consent");
  });

  it("explains how to install a missing Claude Code, and checks again", async () => {
    const b = new MockBridge({ claudeEngine: { cli: "missing" } });
    renderApp(<ClaudeSetup />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Install guide" }));
    expect(b.opened).toEqual([CLAUDE_INSTALL_URL]);
    b.claudeSim.opts.cli = "ok";
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Claude Code found (version 2.1.280)")).toBeInTheDocument();
    expect(b.calls.find((c) => c.method === "claude.engine" && c.args[0] === true)).toBeTruthy();
  });

  it("installs a missing Claude Code with Anthropic's installer after a yes, then checks again by itself", async () => {
    const b = new MockBridge({ claudeEngine: { cli: "missing" }, setup: { missing: ["claude-code"] } });
    renderApp(<ClaudeSetup />, { bridge: b });
    expect(await screen.findByText("curl -fsSL https://claude.ai/install.sh | bash")).toBeInTheDocument();
    const install = screen.getByRole("button", { name: "Install Claude Code" });
    expect(install).toHaveTextContent(/^Install$/);
    await userEvent.click(install);
    act(() => b.finishSetupInstall(true));
    // The engine checks again by itself: step 1 is done and signing in (step 2) opens up.
    expect(await screen.findByText("Claude Code found (version 2.1.280)")).toBeInTheDocument();
    expect(screen.queryByText("Available once Claude Code is installed.")).toBeNull();
  });

  it("says when Claude Code is too old", async () => {
    renderApp(<ClaudeSetup />, { bridge: new MockBridge({ claudeEngine: { cli: "too_old" } }) });
    expect(await screen.findByText(/This Claude Code is version 1.0.40/)).toBeInTheDocument();
    expect(screen.getByText("claude update")).toBeInTheDocument();
  });

  it("opens Terminal to sign in; the app never handles the login", async () => {
    const b = new MockBridge({ claudeEngine: { login: "signed_out" } });
    renderApp(<ClaudeSetup />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(methods(b)).toContain("claude.openSignIn"));
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it("has three steps and nothing to install into Claude Code", async () => {
    renderApp(<ClaudeSetup />, { bridge: new MockBridge() });
    await screen.findByText("Claude Code found (version 2.1.280)");
    expect(document.querySelectorAll(".csetup__step")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /install the plugin|update/i })).toBeNull();
  });

  it("says plainly when this copy of the app lacks its plugin", async () => {
    renderApp(<ClaudeSetup />, { bridge: new MockBridge({ claudeEngine: { plugin: "missing" } }) });
    expect(await screen.findByText(/missing its Claude add-on/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run test" })).toBeNull();
  });

  it("shows this month's cost estimate in Settings", async () => {
    const b = new MockBridge();
    renderApp(<ClaudeSetup />, { bridge: b });
    await screen.findByRole("button", { name: "Run test" });
    expect(screen.queryByText(/cost this month/)).toBeNull();
    const r = await b.claude.run("score_job", LABS, {});
    act(() => b.claudeSim.finish(r.id));
    await userEvent.click(screen.getByRole("button", { name: "Run test" }));
    act(() => b.claudeSim.finish(b.claudeSim.runs[0]!.id, { summary: "OK" }));
    expect(await screen.findByText("API key cost this month: $0.19 estimated across 2 runs.")).toBeInTheDocument();
  });

  it("runs a test", async () => {
    const b = new MockBridge();
    renderApp(<ClaudeSetup />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Run test" }));
    await screen.findByText("Claude is answering a one-word test…");
    act(() => b.claudeSim.finish(b.claudeSim.runs[0]!.id, { summary: "OK" }));
    expect(await screen.findByText("Test run passed")).toBeInTheDocument();
  });
});

describe("ClaudeRunPanel and the indicator", () => {
  it("shows nothing without a run when Claude is ready", async () => {
    const { container } = renderApp(<ClaudeRunPanel action="score_job" target={LABS} />);
    await waitFor(() => expect(container.querySelector(".crun")).toBeNull());
  });

  it("flags files changed outside the run's folder, by name", async () => {
    const b = new MockBridge();
    renderApp(<ClaudeRunPanel action="score_job" target={LABS} />, { bridge: b });
    const r = await b.claude.run("score_job", LABS, {});
    act(() => b.claudeSim.finish(r.id, { stray: ["settings/profile.json"] }));
    expect(await screen.findByText("Score ready")).toBeInTheDocument();
    expect(screen.getByText("Another file also changed while Claude worked. Worth a look:")).toBeInTheDocument();
    expect(screen.getByText("profile.json in settings")).toBeInTheDocument();
    // A changed file opens in the app's own viewer, not Finder.
    await userEvent.setup().click(screen.getByRole("button", { name: "View profile.json in settings" }));
    await waitFor(() => expect(b.calls.some((c) => c.method === "files.preview" && JSON.stringify(c.args).includes("settings/profile.json"))).toBe(true));
    expect(b.calls.some((c) => c.method === "files.reveal")).toBe(false);
    expect(screen.getByText("Cost estimate: $0.18")).toBeInTheDocument();
  });

  it("never flags dot-files or OS clutter (owner report: '.DS_Store in jobs')", async () => {
    const b = new MockBridge();
    renderApp(<ClaudeRunPanel action="score_job" target={LABS} />, { bridge: b });
    const r = await b.claude.run("score_job", LABS, {});
    act(() => b.claudeSim.finish(r.id, { stray: ["companies/example-labs/jobs/.DS_Store", ".git/index", "Thumbs.db"] }));
    expect(await screen.findByText("Score ready")).toBeInTheDocument();
    expect(screen.queryByRole("note", { name: "Also changed" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/DS_Store|warning/);
  });

  it("the sidebar line says when Claude is working", async () => {
    const b = new MockBridge();
    renderApp(<ClaudeWorkingIndicator />, { bridge: b });
    // An icon with a status dot; the words are its tooltip and accessible name.
    const icon = await screen.findByRole("button", { name: /^Claude · ready/ });
    expect(icon).toHaveAttribute("data-tip", "Claude · ready");
    await act(async () => { await b.claude.run("score_job", LABS, {}); });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Claude/ })).toHaveAttribute("data-tip", "Claude · 1 running"));
  });

  it("names what the run is doing and for whom", () => {
    expect(workingTitle("research_company", { company: "Acme Corp" })).toBe("Researching Acme Corp…");
    expect(workingTitle("score_job", { title: "AI Engineer", company: "Acme Corp" })).toBe('Scoring "AI Engineer" at Acme Corp…');
    expect(workingTitle("pitch_video", {})).toBe('Making a "tell me about yourself" video…');
  });

  it("formats time and stray names plainly", () => {
    expect(formatElapsed(42_000)).toBe("0:42");
    expect(formatElapsed(725_000)).toBe("12:05");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(strayName("notes/old.md (deleted)")).toBe("old.md in notes (deleted)");
    expect(strayName("a file outside your workspace")).toBe("a file outside your workspace");
    expect(strayName("notes/x.md (link)")).toBe("x.md in notes (a shortcut link)");
    expect(formatCost(0.004)).toBe("under $0.01");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1.234)).toBe("$1.23");
  });

  it("the mock refuses option keys the action doesn't allow, like main", async () => {
    await expect(new MockBridge().claude.run("score_job", LABS, { options: { tools: "Bash" } })).rejects.toThrow(/isn't an option/);
  });
});
