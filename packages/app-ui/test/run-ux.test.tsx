import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "@careeros/brand";
import { ClaudeActivityProvider, ClaudeWorkingIndicator } from "../src/claude";
import { notificationsOn, setNotificationsOn } from "../src/claude/Activity";
import { MockBridge } from "../src/mock/MockBridge";
import { parseHash, toHash } from "../src/router";
import { JobScreen } from "../src/screens/Job";
import { SidebarStatusLink } from "../src/components/SidebarStatus";
import { renderApp } from "./render";

const ACME = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;

describe("Job > Activity tab", () => {
  it("shows the job's runs with live steps (each once) and counts the running ones on the tab", async () => {
    const b = new MockBridge();
    renderApp(<JobScreen route={{ ...ACME, tab: "activity" }} />, { bridge: b });
    expect(await screen.findByText(/Nothing yet\. When you ask Claude/)).toBeInTheDocument();
    const r = await act(async () => b.claude.run("research_company", JOB, {}));
    act(() => { b.claudeSim.advance(r.id, "Reading your experience"); b.claudeSim.advance(r.id, "Searching the web"); b.claudeSim.advance(r.id, "Reading your experience"); });
    expect(await screen.findByRole("tab", { name: /^Activity\s*\(1 running\)$/ })).toBeInTheDocument();
    const running = await screen.findByRole("list", { name: "Running now" });
    const steps = within(running).getByRole("list", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(within(steps).getByText("×2")).toBeInTheDocument();
    act(() => b.claudeSim.finish(r.id));
    const earlier = await screen.findByRole("region", { name: "Earlier runs" });
    expect(within(earlier).getByText("Research ready")).toBeInTheDocument();
    expect(within(earlier).getByRole("list", { name: "Files Claude made" })).toBeInTheDocument();
    // Finished: a result line and chips, not the step list.
    expect(within(earlier).queryByRole("list", { name: "Steps" })).toBeNull();
    expect(within(earlier).getByRole("button", { name: "Show steps" })).toHaveAttribute("aria-expanded", "false");
  });

  it("routes and parses the Activity tab", () => {
    expect(parseHash(toHash({ ...ACME, tab: "activity" }))).toEqual({ ...ACME, tab: "activity" });
  });
});

describe("sidebar Claude line", () => {
  it("reads 'Claude · ready' (green), opens the Activity panel, and turns amber with a ring while running", async () => {
    const b = new MockBridge();
    renderApp(<ClaudeActivityProvider><ClaudeWorkingIndicator /></ClaudeActivityProvider>, { bridge: b });
    const ready = await screen.findByRole("button", { name: "Claude · ready. Show activity" });
    expect(ready).toHaveAttribute("data-tone", "ok");
    expect(ready).toHaveAttribute("data-tip", "Claude · ready");
    await userEvent.click(ready);
    // The panel keeps a way into Claude's settings.
    const idlePanel = await screen.findByRole("dialog", { name: "Claude activity" });
    expect(within(idlePanel).getByRole("button", { name: "Claude setup" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await act(async () => { await b.claude.run("score_job", JOB, {}); });
    const busy = await screen.findByRole("button", { name: "Claude · Scoring. Show activity" });
    expect(busy).toHaveAttribute("data-tone", "busy");
    expect(busy.querySelector(".rail-stat__ring")).toBeTruthy();
    await userEvent.click(busy);
    const panel = await screen.findByRole("dialog", { name: "Claude activity" });
    expect(within(panel).getByRole("region", { name: "Running" })).toHaveTextContent("Score this job");
    await userEvent.click(within(panel).getByRole("button", { name: /^Open: Score this job/ }));
    expect(window.location.hash).toBe("#/job/acme-corp/2026-01-12-ai-engineer?tab=activity");
  });

  it("opens Claude settings instead when Claude isn't set up", async () => {
    const b = new MockBridge();
    b.claude.engine = async (recheck: boolean) => ({ ...(await new MockBridge().claude.engine(recheck)), ready: false });
    renderApp(<ClaudeActivityProvider><ClaudeWorkingIndicator /></ClaudeActivityProvider>, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Claude · set up needed. Open Claude settings" }));
    expect(window.location.hash).toBe("#/settings?tab=connections&c=claude");
  });

  it("counts several tasks, video jobs included, and lists the video in the panel with Open", async () => {
    const b = new MockBridge();
    // A video job rendering in main (the mock's own Make video stops at the script review).
    b.video.runs = async () => [{
      runId: "vr-9", folder: "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd-walkthrough", type: "jd-walkthrough", phase: "build", status: "running",
      stages: [], started_at: new Date().toISOString(), error: "", queued_behind: 0,
    }];
    renderApp(<ClaudeActivityProvider><ClaudeWorkingIndicator /></ClaudeActivityProvider>, { bridge: b });
    await screen.findByRole("button", { name: "Claude · Making a video. Show activity" });
    await act(async () => { await b.claude.run("score_job", JOB, {}); });
    await userEvent.click(await screen.findByRole("button", { name: "Claude · 2 running. Show activity" }));
    const running = within(await screen.findByRole("dialog", { name: "Claude activity" })).getByRole("region", { name: "Running" });
    expect(running).toHaveTextContent("Score this job");
    expect(running).toHaveTextContent(/Video: /);
    expect(within(running).getByRole("button", { name: /^Cancel: Video/ })).toBeInTheDocument();
  });
});

describe("Activity history and notifications", () => {
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

  it("keeps finished tasks in History for this workspace, and notifies after 30 s when the window is in the back", async () => {
    const shown: { title: string; body?: string }[] = [];
    class FakeNotification { onclick: (() => void) | null = null; constructor(title: string, o?: { body?: string }) { shown.push({ title, body: o?.body }); } }
    vi.stubGlobal("Notification", FakeNotification);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const b = new MockBridge();
    renderApp(<ClaudeActivityProvider><ClaudeWorkingIndicator /></ClaudeActivityProvider>, { bridge: b });
    await screen.findByRole("button", { name: "Claude · ready. Show activity" });
    const run = await act(async () => b.claude.run("score_job", JOB, {}));
    await screen.findByRole("button", { name: "Claude · Scoring. Show activity" });
    // Pretend it started a minute ago, then let it finish.
    const started = new Date(Date.now() - 60_000).toISOString();
    await act(async () => { b.claudeSim.finish(run.id, { started_at: started }); });
    await waitFor(() => expect(Object.keys(localStorage).some((k) => k.startsWith("careeros.activity.history:"))).toBe(true));
    const key = Object.keys(localStorage).find((k) => k.startsWith("careeros.activity.history:"))!;
    expect(JSON.parse(localStorage.getItem(key)!)[0]).toMatchObject({ id: `claude:${run.id}`, label: "Score this job", status: "done" });
    expect(shown).toEqual([{ title: "Score ready", body: "Score this job" }]);
    focus.mockRestore();
  });

  it("no notification when switched off in Settings", async () => {
    setNotificationsOn(false);
    expect(notificationsOn()).toBe(false);
    setNotificationsOn(true);
    expect(notificationsOn()).toBe(true);
  });
});

describe("sidebar status links", () => {
  it("the Mail line opens its exact settings place", async () => {
    renderApp(<SidebarStatusLink id="mail" />);
    await userEvent.click(screen.getByRole("button", { name: "Mail · coming soon. Email settings" }));
    expect(window.location.hash).toBe("#/settings?tab=connections&c=email");
  });
});

describe("Tabs", () => {
  function T({ sticky }: { sticky?: boolean }) {
    return <Tabs label="Sections" value="a" onChange={() => undefined} sticky={sticky} tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }]}><p>Body</p></Tabs>;
  }
  it("are sticky by default and can opt out", () => {
    const { container, rerender } = render(<T />);
    expect(container.querySelector(".tabs")).toHaveClass("tabs--sticky");
    rerender(<T sticky={false} />);
    expect(container.querySelector(".tabs")).not.toHaveClass("tabs--sticky");
  });
  it("move with the arrow keys", async () => {
    let value = "a";
    const { rerender } = render(<Tabs label="Sections" value={value} onChange={(v) => { value = v; }} tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }]}><p>Body</p></Tabs>);
    screen.getByRole("tab", { name: "A" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(value).toBe("b");
    rerender(<Tabs label="Sections" value={value} onChange={(v) => { value = v; }} tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }]}><p>Body</p></Tabs>);
    await waitFor(() => expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("aria-selected", "true"));
  });
});
