import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { BoardId, ClaudeRunView, SignInDiag } from "@careeros/contract";
import { MockBridge } from "../src/mock/MockBridge";
import { stopLine } from "../src/chrome/state";
import { RunCard } from "../src/claude/RunCard";
import { renderApp } from "./render";

const run = (o: Partial<ClaudeRunView> = {}): ClaudeRunView => ({
  id: "r1", action: "find_jobs", target: { kind: "workspace" }, key: "find_jobs--workspace", status: "failed",
  started_at: "2026-10-11T01:39:00.000Z", ended_at: "2026-10-11T01:44:00.000Z", elapsed_ms: 300_000, steps: [], summary: "", files: [],
  missing: [], stray: [], error: "Claude finished but didn't write 2026-10-11.md.", cost_usd: null, turns: null, ...o,
});

describe("a find-jobs run's Chrome details", () => {
  it("shows a closed Chrome details disclosure with each board's facts", async () => {
    renderApp(<RunCard run={run({ browser_diag: [{ board: "seek", diag: { mode: "profile", profile_dir: "Profile 6", outcome: "wrong_profile", launched: true, tries: 2, ms: 2100, cdp: "127.0.0.1:53111", profile_seen: "<temp>/agent-browser-chrome-1/Default", reconnected: false, opens: 1 } }] })} action="find_jobs" target={{ kind: "workspace" }} onCancel={() => undefined} onRetry={() => undefined} />);
    const summary = screen.getByText("Chrome details");
    expect(screen.getByText("SEEK")).not.toBeVisible();
    await userEvent.click(summary);
    expect(screen.getByText("SEEK")).toBeVisible();
    expect(screen.getByText("Browser: not your Chrome (127.0.0.1:53111). The helper was driving a browser of its own.")).toBeInTheDocument();
    expect(screen.getByText("Profile the tab was in: <temp>/agent-browser-chrome-1/Default")).toBeInTheDocument();
    expect(screen.getByText("Window calls to Chrome: 1.")).toBeInTheDocument();
  });

  it("isn't there for a run without Chrome", () => {
    renderApp(<RunCard run={run()} action="find_jobs" target={{ kind: "workspace" }} onCancel={() => undefined} onRetry={() => undefined} />);
    expect(screen.queryByText("Chrome details")).toBeNull();
  });
});

const diag = (o: Partial<SignInDiag>): SignInDiag => ({ mode: "profile", profile_dir: "Profile 6", outcome: "ok", launched: false, tries: 1, ms: 600, ...o });

/** A bridge whose Chrome knows the profile names and records "Open <board>" clicks (Chrome's own program, no remote control). */
function chromeBridge(o: { fail?: boolean } = {}) {
  const bridge = new MockBridge();
  const opened: BoardId[] = [];
  (bridge as unknown as { chrome: unknown }).chrome = {
    state: async () => ({ profiles: [{ dir: "Profile 6", name: "Career Search" }, { dir: "Default", name: "Personal" }] }),
    openHome: async (b: BoardId) => { opened.push(b); if (o.fail) throw new Error("Chrome didn't open. Open SEEK in Chrome yourself."); },
  };
  return { bridge, opened };
}

describe("a find-jobs run's boards that stopped early", () => {
  it("shows a plain line per stopped board, in sight (not in Chrome details), with Open <board> that opens it in Chrome", async () => {
    const { bridge, opened } = chromeBridge();
    renderApp(<RunCard run={run({ status: "succeeded", error: undefined, browser_diag: [
      { board: "seek", diag: diag({ outcome: "bot_check" }) },
      { board: "linkedin", diag: diag({ outcome: "ok" }) },
    ] })} action="find_jobs" target={{ kind: "workspace" }} onCancel={() => undefined} onRetry={() => undefined} />, { bridge });
    const line = await screen.findByText("SEEK asked for a security check. Finish it in your Career Search window, then run again.");
    expect(line).toBeVisible();
    expect(screen.queryByText(/LinkedIn asked|LinkedIn stopped|LinkedIn couldn't/)).toBeNull();
    const btn = screen.getByRole("button", { name: "Open SEEK in Chrome" });
    expect(btn).toHaveTextContent("Open SEEK");
    await userEvent.click(btn);
    expect(opened).toEqual(["seek"]);
  });

  it("says plainly when Chrome couldn't be opened", async () => {
    const { bridge } = chromeBridge({ fail: true });
    renderApp(<RunCard run={run({ browser_diag: [{ board: "seek", diag: diag({ outcome: "tab_lost" }) }] })} action="find_jobs" target={{ kind: "workspace" }} onCancel={() => undefined} onRetry={() => undefined} />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "Open SEEK in Chrome" }));
    expect(await screen.findByText("Chrome didn't open. Open SEEK in Chrome yourself.")).toBeInTheDocument();
  });

  it("words each reason, and stays quiet for boards that ran fine", () => {
    expect(stopLine("seek", diag({ outcome: "bot_check" }), "Career Search")).toBe("SEEK asked for a security check. Finish it in your Career Search window, then run again.");
    expect(stopLine("seek", diag({ outcome: "bot_check" }))).toBe("SEEK asked for a security check. Finish it in Chrome, then run again.");
    expect(stopLine("seek", diag({ outcome: "tab_lost" }), "Career Search")).toBe("SEEK stopped early because its tab was lost. Check SEEK in your Career Search window, then run again.");
    expect(stopLine("linkedin", diag({ outcome: "wrong_profile" }), "Career Search")).toBe("LinkedIn couldn't open in your Career Search profile. Open a Career Search window in Chrome, then run again.");
    for (const outcome of ["ok", "bad_profile", "no_tab", "no_launch", "not_attached"] as const) expect(stopLine("seek", diag({ outcome }), "Career Search")).toBeNull();
    expect(stopLine("seek", undefined)).toBeNull();
    for (const o of ["bot_check", "tab_lost", "wrong_profile"] as const) expect(stopLine("seek", diag({ outcome: o }), "Career Search")!).not.toMatch(/\u2014/);
  });

  it("no Open button where the app can't open Chrome (an older shell), the line still shows", () => {
    renderApp(<RunCard run={run({ browser_diag: [{ board: "seek", diag: diag({ outcome: "bot_check" }) }] })} action="find_jobs" target={{ kind: "workspace" }} onCancel={() => undefined} onRetry={() => undefined} />);
    expect(screen.getByText("SEEK asked for a security check. Finish it in Chrome, then run again.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open SEEK/ })).toBeNull();
  });
});

describe("a find-jobs run's board health", () => {
  it("shows each warning and its suggestion under a finished run", () => {
    const board_health = [{ board: "seek", name: "SEEK", kind: "nothing" as const, message: "SEEK returned nothing this time, it usually finds about 20. Its pages may have changed.", suggestion: "Try the same search on SEEK yourself." }];
    renderApp(<RunCard run={run({ status: "succeeded", error: "", summary: "Added 4 jobs.", board_health })} action="find_jobs" target={{ kind: "workspace" }} onCancel={() => undefined} onRetry={() => undefined} />);
    const note = screen.getByRole("note", { name: "Boards to check" });
    expect(note).toHaveTextContent("SEEK returned nothing this time, it usually finds about 20. Its pages may have changed.");
    expect(note).toHaveTextContent("Try the same search on SEEK yourself.");
  });

  it("isn't there when every board was fine", () => {
    renderApp(<RunCard run={run({ status: "succeeded", error: "" })} action="find_jobs" target={{ kind: "workspace" }} onCancel={() => undefined} onRetry={() => undefined} />);
    expect(screen.queryByRole("note", { name: "Boards to check" })).toBeNull();
  });
});
