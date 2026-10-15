import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeActivityProvider } from "../src/claude";
import { JustFinished } from "../src/home/JustFinished";
import { newRows, newestFound, readSeen, seenKey, writeSeen } from "../src/jobs/seen";
import { MockBridge } from "../src/mock/MockBridge";
import { JobsScreen } from "../src/screens/Jobs";
import { renderApp } from "./render";

afterEach(() => localStorage.clear());
const wsKey = async (b: MockBridge) => (await b.workspace.recent()).find((w) => w.current)?.key ?? "default";

describe("jobs you haven't seen", () => {
  const rows = [{ found_at: "2026-01-10T00:00:00Z" }, { found_at: "2026-01-14T00:00:00Z" }, { found_at: "2026-01-12T00:00:00Z" }];
  it("counts jobs found after the newest one you saw; none on a first visit", () => {
    expect(newRows(rows, null)).toEqual([]);
    expect(newRows(rows, "2026-01-11T00:00:00Z")).toHaveLength(2);
    expect(newestFound(rows)).toBe("2026-01-14T00:00:00Z");
  });
  it("only moves the baseline forward", () => {
    writeSeen("w", "2026-01-14T00:00:00Z");
    writeSeen("w", "2026-01-01T00:00:00Z");
    expect(readSeen("w")).toBe("2026-01-14T00:00:00Z");
  });
  it("Jobs shows 'N new' and filters to them; leaving moves the baseline on", async () => {
    const b = new MockBridge();
    const all = (await b.jobs.list({ limit: 500 })).rows;
    const distinct = [...new Set(all.map((r) => r.found_at))].sort();
    // Jobs found at the newest time are "new" (or all of them when they share one time).
    const cut = distinct.length > 1 ? distinct[distinct.length - 2]! : "2000-01-01T00:00:00.000Z";
    const expected = all.filter((r) => r.found_at > cut).length;
    const key = await wsKey(b);
    localStorage.setItem(seenKey(key), cut);
    const { unmount } = renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: b });
    const chip = await screen.findByRole("button", { name: `${expected} new` }, { timeout: 5000 });
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("table")).getAllByRole("row").length - 1).toBe(expected);
    unmount();
    expect(readSeen(key)! > cut).toBe(true);
  });
});

describe("Home: Just finished", () => {
  it("lists finished tasks from this workspace's History with a link to each result", async () => {
    const b = new MockBridge();
    localStorage.setItem(`careeros.activity.history:${await wsKey(b)}`, JSON.stringify([
      { id: "claude:r1", kind: "claude", label: "Score this job", status: "done", started_at: "", ended_at: "2026-01-15T09:00:00.000Z",
        open: { label: "Open score", to: { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "score" } } },
    ]));
    renderApp(<ClaudeActivityProvider><JustFinished /></ClaudeActivityProvider>, { bridge: b });
    const card = (await screen.findByRole("heading", { name: "Just finished" })).closest(".just-finished") as HTMLElement;
    await userEvent.click(within(card).getByRole("button", { name: "Open score: Score this job" }));
    expect(window.location.hash).toBe("#/job/acme-corp/2026-01-12-ai-engineer?tab=score");
  });
  it("shows nothing until something has finished", async () => {
    renderApp(<ClaudeActivityProvider><JustFinished /></ClaudeActivityProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByText("Just finished")).toBeNull();
  });
});
void render;
