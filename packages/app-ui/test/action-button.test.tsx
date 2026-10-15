import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ActionTarget } from "@careeros/contract";
import { ActionButton } from "../src/components/ActionButton";
import { ClaudeActivityProvider } from "../src/claude";
import { MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const LABS: ActionTarget = { kind: "job", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" };
const ACME: ActionTarget = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };

describe("ActionButton", () => {
  it("runs Claude Code behind a one-line chip that never grows, then shows the files", async () => {
    const { bridge, container } = renderApp(<ActionButton action="score_job" target={LABS} />);
    await userEvent.click(await screen.findByRole("button", { name: "Score" }));
    const chip = await screen.findByRole("button", { name: /^Score this job: Scoring, 0:\d\d\. Show details$/ });
    expect(bridge.calls.find((c) => c.method === "claude.run")?.args).toEqual(["score_job", LABS, {}]);
    expect(bridge.calls.some((c) => c.method === "claude.prepare")).toBe(false);
    expect(bridge.copied).toEqual([]);
    // The button's slot holds the chip; no run panel or step list appears inline.
    expect(screen.queryByRole("button", { name: "Score" })).toBeNull();
    expect(chip.closest(".rchip")).toBeInTheDocument();
    const id = bridge.claudeSim.runs[0]!.id;
    act(() => { bridge.claudeSim.advance(id, "Reading the job ad"); bridge.claudeSim.advance(id, "Reading the job ad"); });
    expect(container.querySelector(".crun, .crun__steps")).toBeNull();
    expect(screen.queryByText("Reading the job ad")).toBeNull();
    act(() => bridge.claudeSim.finish(id));
    await waitFor(() => expect(screen.getAllByText("Score ready").length).toBe(2)); // pill, toast
    expect(screen.getAllByText("Score ready").some((e) => e.closest(".toast"))).toBe(true);
    expect(container.querySelector(".rchip")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show files: Score" }));
    expect(bridge.revealed).toEqual(["companies/example-labs/jobs/2026-01-12-backend-engineer-llm"]);
  });

  it("keeps Find jobs as a button after a search, with its last report opening in the app", async () => {
    const W: ActionTarget = { kind: "workspace" };
    const { bridge } = renderApp(<ActionButton action="find_jobs" target={W} variant="primary" />);
    await userEvent.click(await screen.findByRole("button", { name: "Find jobs" }));
    const id = bridge.claudeSim.runs[0]!.id;
    act(() => bridge.claudeSim.finish(id));
    // Done, but the search can be run again from the same button: never only a "Redo".
    await screen.findByRole("button", { name: "View files: Find jobs" });
    expect(screen.getByRole("button", { name: "Find jobs" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Redo: Find jobs" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "View files: Find jobs" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(bridge.revealed).toEqual([]);
  });

  it("cancels a run from the chip, and offers to run it again", async () => {
    const { bridge } = renderApp(<ActionButton action="score_job" target={LABS} />);
    await userEvent.click(await screen.findByRole("button", { name: "Score" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel: Score this job" }));
    expect(await screen.findByRole("button", { name: "Score this job: Stopped. Show details" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run again: Score this job" }));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "claude.run")).toHaveLength(2));
  });

  it("says a run didn't finish in the chip, and retries", async () => {
    const { bridge } = renderApp(<ActionButton action="score_job" target={LABS} />);
    await userEvent.click(await screen.findByRole("button", { name: "Score" }));
    await screen.findByRole("button", { name: /^Score this job: Scoring/ });
    act(() => bridge.claudeSim.fail(bridge.claudeSim.runs[0]!.id, "Claude Code isn't signed in. Open Settings > Claude to sign in."));
    expect(await screen.findByRole("button", { name: "Score this job: Didn't finish. Show details" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry: Score this job" }));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "claude.run")).toHaveLength(2));
  });

  it("opens the run's details in the Activity panel from the chip, with each step once", async () => {
    const { bridge } = renderApp(<ClaudeActivityProvider><ActionButton action="score_job" target={LABS} /></ClaudeActivityProvider>);
    await userEvent.click(await screen.findByRole("button", { name: "Score" }));
    const id = bridge.claudeSim.runs[0]!.id;
    act(() => { bridge.claudeSim.advance(id, "Reading your experience"); bridge.claudeSim.advance(id, "Looking through your files"); bridge.claudeSim.advance(id, "Reading your experience"); });
    await userEvent.click(await screen.findByRole("button", { name: /^Score this job: Scoring/ }));
    const panel = await screen.findByRole("dialog", { name: "Claude activity" });
    expect(within(panel).getByText(/Tasks keep going when you switch screens\. They stop if you quit/)).toBeInTheDocument();
    const steps = within(panel).getByRole("list", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent?.replace(/\s*\(.*\)$/, ""))).toEqual(["Reading your experience×2", "Looking through your files"]);
    await userEvent.click(within(panel).getByRole("button", { name: "Cancel: Score this job, Backend Engineer (LLM) at Example Labs" }));
    await waitFor(() => expect(bridge.claudeSim.runs[0]!.status).toBe("cancelled"));
  });

  it("starts once on its own when autoStart is set and the action is idle, never again after it ends", async () => {
    const { bridge } = renderApp(<ActionButton action="score_job" target={LABS} autoStart />);
    await screen.findByRole("button", { name: /^Score this job: Scoring/ });
    act(() => bridge.claudeSim.fail(bridge.claudeSim.runs[0]!.id, "Stopped for the test."));
    await screen.findByRole("button", { name: "Score this job: Didn't finish. Show details" });
    await new Promise((res) => setTimeout(res, 20));
    expect(bridge.calls.filter((c) => c.method === "claude.run")).toHaveLength(1);
  });

  it("never auto-starts an action that is already ready", async () => {
    const b = new MockBridge();
    b.simulateActionOutput("score_job", LABS);
    renderApp(<ActionButton action="score_job" target={LABS} autoStart />, { bridge: b });
    expect(await screen.findByText("Score ready")).toBeInTheDocument();
    await new Promise((res) => setTimeout(res, 20));
    expect(b.calls.some((c) => c.method === "claude.run")).toBe(false);
  });

  it("re-attaches to a run that is still going after you leave and come back", async () => {
    const b = new MockBridge();
    const first = renderApp(<ActionButton action="score_job" target={LABS} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Score" }));
    await screen.findByRole("button", { name: /^Score this job: Scoring/ });
    first.unmount();
    renderApp(<ActionButton action="score_job" target={LABS} />, { bridge: b });
    expect(await screen.findByRole("button", { name: /^Score this job: Scoring/ })).toBeInTheDocument();
    expect(b.calls.filter((c) => c.method === "claude.run")).toHaveLength(1);
  });

  it("toasts a finish with Open when you're on another screen", async () => {
    const b = new MockBridge();
    window.location.hash = "#/home";
    renderApp(<ClaudeActivityProvider><span>Home</span></ClaudeActivityProvider>, { bridge: b });
    const r = await act(async () => b.claude.run("score_job", LABS, {}));
    await new Promise((res) => setTimeout(res, 20));
    act(() => b.claudeSim.finish(r.id));
    const toast = (await screen.findByText("Score ready")).closest(".toast") as HTMLElement;
    await userEvent.click(within(toast).getByRole("button", { name: "Open score: Score this job" }));
    expect(window.location.hash).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm?tab=score");
  });

  it("turns ready when Claude's files appear, and shows the folder", async () => {
    const { bridge } = renderApp(<ActionButton action="score_job" target={LABS} />);
    await screen.findByRole("button", { name: "Score" });
    bridge.simulateActionOutput("score_job", LABS);
    expect(await screen.findByText("Score ready")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show files: Score" }));
    expect(bridge.revealed).toEqual(["companies/example-labs/jobs/2026-01-12-backend-engineer-llm"]);
    expect(screen.getByRole("button", { name: "Redo: Score" })).toBeEnabled();
  });

  it("hands a video action to the Make video dialog, never to Claude directly (Task 23)", async () => {
    const { bridge } = renderApp(<ActionButton action="pitch_video" target={ACME} />);
    await userEvent.click(await screen.findByRole("button", { name: "Pitch video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect(await within(dialog).findByRole("radio", { name: /Tell me about yourself/ })).toBeChecked();
    expect(bridge.calls.some((c) => c.method === "claude.run" || c.method === "claude.status")).toBe(false);
  });

  it("one run per action: the chip replaces the button, so nothing starts another", async () => {
    const { bridge } = renderApp(<ActionButton action="score_job" target={LABS} />);
    const btn = await screen.findByRole("button", { name: "Score" });
    await userEvent.click(btn);
    await screen.findByRole("button", { name: /^Score this job: Scoring, 0:\d\d\. Show details$/ });
    expect(screen.queryByRole("button", { name: "Score" })).toBeNull();
    expect(bridge.calls.filter((c) => c.method === "claude.run")).toHaveLength(1);
  });

  it("is blocked until its prerequisite is ready (now inside Make video)", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<ActionButton action="company_background_video" target={ACME} />);
    await user.click(await screen.findByRole("button", { name: "Company video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    const start = within(dialog).getByRole("button", { name: "Start" });
    await waitFor(() => expect(start).toHaveAccessibleDescription("Do “Research company” first."));
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("title", "Do “Research company” first.");
    act(() => bridge.simulateActionOutput("research_company", ACME));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled());
  });

  it("offers one click to run the missing step when it's blocked", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<ActionButton action="company_background_video" target={ACME} />);
    await user.click(await screen.findByRole("button", { name: "Company video" }));
    await user.click(await screen.findByRole("button", { name: "Research company" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "claude.run")?.args.slice(0, 1)).toEqual(["research_company"]));
    expect(bridge.calls.some((c) => c.method === "claude.prepare")).toBe(false);
  });

  it("when Claude isn't set up, a blocked video links to Settings > Claude instead of starting the missing step", async () => {
    const user = userEvent.setup();
    renderApp(<ActionButton action="company_background_video" target={ACME} />, { bridge: new MockBridge({ claudeEngine: { consent: false } }) });
    await user.click(await screen.findByRole("button", { name: "Company video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect(await within(dialog).findByText(/Claude isn't set up yet/)).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole("button", { name: "Claude setup" })[0]!);
    expect(window.location.hash).toBe("#/settings?tab=connections&c=claude");
    expect(screen.queryByRole("button", { name: /Start with/ })).toBeNull();
  });

  it("when Claude isn't set up, says how and offers the prompt as a fallback", async () => {
    const { bridge } = renderApp(<ActionButton action="score_job" target={ACME} />, { bridge: new MockBridge({ claudeEngine: { consent: false } }) });
    await userEvent.click(await screen.findByRole("button", { name: "Score" }));
    expect(await screen.findByRole("button", { name: "Claude setup" })).toBeInTheDocument();
    expect(bridge.calls.some((c) => c.method === "claude.run")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /^Copy prompt/ }));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "claude.prepare").map((c) => c.args[2])).toEqual([false]));
    expect(bridge.copied.at(-1)).toContain("score.md");
    expect(await screen.findByText("Prompt copied. Paste it into Claude.")).toBeInTheDocument();
  });

  it("shows the prompt itself when the clipboard failed", async () => {
    renderApp(<ActionButton action="score_job" target={LABS} />, { bridge: new MockBridge({ clipboard: false, claudeEngine: { cli: "missing" } }) });
    await userEvent.click(await screen.findByRole("button", { name: "Score" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Copy prompt/ }));
    expect(await screen.findByText(new RegExp(String.raw`Use the career skill from the ${brand.name} plugin`))).toBeInTheDocument();
  });

  it("runs its before step first, and stops if it fails", async () => {
    const b = new MockBridge();
    const preparedAlready: boolean[] = [];
    const before = async () => { preparedAlready.push(b.calls.some((c) => c.method === "claude.run")); };
    renderApp(<ActionButton action="score_job" target={LABS} before={before} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Score" }));
    await waitFor(() => expect(b.calls.some((c) => c.method === "claude.run")).toBe(true));
    expect(preparedAlready).toEqual([false]);
  });

  it("does not ask Claude when the before step fails, and says why", async () => {
    const b = new MockBridge();
    renderApp(<ActionButton action="score_job" target={LABS} before={async () => { throw new Error("application isn't a real folder"); }} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Score" }));
    const msg = await screen.findByText("application isn't a real folder");
    expect(msg.closest(".toast")).toHaveClass("toast--danger");
    expect(b.calls.some((c) => c.method === "claude.run")).toBe(false);
  });

  it("asks only once on a double click", async () => {
    const b = new MockBridge();
    let release!: () => void;
    const before = () => new Promise<void>((r) => { release = r; });
    renderApp(<ActionButton action="score_job" target={LABS} before={before} />, { bridge: b });
    const btn = await screen.findByRole("button", { name: "Score" });
    await userEvent.dblClick(btn);
    release();
    await screen.findByRole("button", { name: /^Score this job: Scoring/ });
    expect(b.calls.filter((c) => c.method === "claude.run")).toHaveLength(1);
  });

  it("shows a plain error for a job that is gone", async () => {
    renderApp(<ActionButton action="score_job" target={{ kind: "job", company_slug: "acme-corp", id: "2026-01-01-deleted" }} />);
    expect(await screen.findByText(/no job acme-corp\/2026-01-01-deleted/)).toBeInTheDocument();
  });

  it("toasts a failed reveal", async () => {
    const b = new MockBridge();
    b.files.reveal = async () => { throw new Error("can't be found"); };
    renderApp(<ActionButton action="interview_prep" target={ACME} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: /^Show files/ }));
    const msg = await screen.findByText("can't be found");
    expect(msg.closest(".toast")).toHaveClass("toast--danger");
  });
});
