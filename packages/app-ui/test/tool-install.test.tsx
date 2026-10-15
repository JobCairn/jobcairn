import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToolInstall } from "../src/components/ToolInstall";
import { MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";

describe("ToolInstall", () => {
  it("renders nothing when every tool it needs is ready", async () => {
    const bridge = new MockBridge();
    const { container } = renderApp(<ToolInstall ids={["python", "ffmpeg"]} />, { bridge });
    await waitFor(() => expect(bridge.calls.some((c) => c.method === "setup.status")).toBe(true));
    expect(container.querySelector(".tinstall")).toBeNull();
  });

  it("shows only what's missing, installs on a click with live progress and Stop, then says it worked", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge({ setup: { missing: ["ffmpeg"], tooOld: ["python"] } });
    let done = 0;
    renderApp(<ToolInstall ids={["python", "ffmpeg", "node"]} onInstalled={() => { done++; }} />, { bridge });
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Too old (3.9.6)")).toBeInTheDocument();
    expect(screen.getByText("brew install ffmpeg")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Install ffmpeg" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Install progress" })).toHaveTextContent("Starting: brew install ffmpeg"));
    act(() => bridge.setSetupProgress("Pouring ffmpeg bottle"));
    await waitFor(() => expect(screen.getByRole("status", { name: "Install progress" })).toHaveTextContent("Pouring ffmpeg bottle"));
    // One install at a time: the other tool's button waits.
    expect(screen.getByRole("button", { name: "Update Python" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    act(() => bridge.finishSetupInstall(true));
    expect(await screen.findByText("ffmpeg is installed.")).toBeInTheDocument();
    expect(done).toBe(1);
    expect(bridge.calls.filter((c) => c.method === "setup.install").map((c) => c.args)).toEqual([["ffmpeg"]]);
  });

  it("without Homebrew, gives the one line to run in Terminal, never an Install button, and checks again", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge({ setup: { missing: ["node"], brew: false } });
    renderApp(<ToolInstall ids={["node"]} />, { bridge });
    expect(await screen.findByText(/installs with Homebrew, which isn't on this Mac yet/)).toBeInTheDocument();
    expect(screen.getByText(/raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install Node.js" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    act(() => bridge.setSetupBrew(true));
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("button", { name: "Install Node.js" })).toBeEnabled();
  });

  it("shows how a failed install ended, in plain words", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge({ setup: { missing: ["claude-code"], failWith: "Claude Code didn't install. Check the internet connection and try again." } });
    renderApp(<ToolInstall ids={["claude-code"]} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Install Claude Code" }));
    act(() => bridge.finishSetupInstall(true));
    expect(await screen.findByText("Claude Code didn't install. Check the internet connection and try again.")).toBeInTheDocument();
  });

  it("after a failure, offers the exact lines to run in Terminal, each with Copy, and says what sudo asks", async () => {
    const user = userEvent.setup();
    const fix = { problem: "permission" as const, options: [
      { title: "Run it in Terminal", command: "curl -fsSL https://claude.ai/install.sh | bash" },
      { title: "If it says permission denied: fix your ~/.local folder's owner, then install", command: 'sudo chown -R "$(whoami)" "$HOME/.local"\ncurl -fsSL https://claude.ai/install.sh | bash', note: "sudo asks for your Mac password (the one you log in with). Nothing shows while you type it; that's normal." },
    ] };
    const bridge = new MockBridge({ setup: { missing: ["claude-code"], failWith: "Claude Code didn't install: your Mac said permission denied for a folder it needs. Run it in Terminal instead (below).", failFix: fix } });
    renderApp(<ToolInstall ids={["claude-code"]} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Install Claude Code" }));
    act(() => bridge.finishSetupInstall(true));
    const panel = await screen.findByRole("group", { name: "Run it in Terminal" });
    expect(within(panel).getByText(/open Terminal/)).toBeInTheDocument();
    expect(within(panel).getByText(/Nothing shows while you type it/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: `Copy: ${fix.options[1]!.title}` }));
    expect(await navigator.clipboard.readText()).toBe(fix.options[1]!.command);
    expect(within(panel).getByRole("button", { name: `Copy: ${fix.options[1]!.title}` })).toHaveTextContent("Copied");
  });

  it("shows how long an install has been running", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge({ setup: { missing: ["node"] } });
    renderApp(<ToolInstall ids={["node"]} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Install Node.js" }));
    expect(await screen.findByLabelText(/^Running for \d+:\d\d$/)).toBeInTheDocument();
    act(() => bridge.finishSetupInstall(true));
  });

  it("links the install guide when this copy can't install", async () => {
    const bridge = new MockBridge({ setup: { missing: ["ffmpeg"], canInstall: false } });
    renderApp(<ToolInstall ids={["ffmpeg"]} />, { bridge });
    expect(await screen.findByRole("button", { name: "Install guide" })).toBeInTheDocument();
  });
});

describe("Make video tools card", () => {
  it("waits for what a video tool needs first, and says so", async () => {
    const { waitsFor } = await import("../src/components/MakeVideo");
    const tools = { ok: false, checked_at: "", can_install: true, tools: [
      { id: "hyperframes", label: "HyperFrames", ok: false, required: true, version: "", message: "", install: "hyperframes" },
      { id: "ffmpeg", label: "ffmpeg", ok: false, required: true, version: "", message: "", install: "ffmpeg" },
    ] } as never;
    const bridge = new MockBridge({ setup: { missing: ["node"] } });
    const setup = await bridge.setup.status(false);
    expect(waitsFor("hyperframes", setup, tools)).toBe("Install Node.js first.");
    expect(waitsFor("supertonic", setup, tools)).toBeNull();
    expect(waitsFor("whisper", setup, tools)).toBe("Install ffmpeg first.");
    expect(waitsFor("ffmpeg", setup, tools)).toBeNull();
  });
});

describe("Voice hint", () => {
  it("points below on Settings > Voice itself", async () => {
    const { hereHint } = await import("../src/listen/VoiceSettings");
    expect(hereHint("Install ffmpeg in Settings > Voice.")).toBe("Install ffmpeg below.");
  });
});
