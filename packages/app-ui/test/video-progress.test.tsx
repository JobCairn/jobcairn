import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ClaudeRunView, VideoRunView } from "@careeros/contract";
import { aboutTime, RunPanel, timeLeft, videoProgress } from "../src/video/RunProgress";
import { renderApp } from "./render";

const IDS = ["request", "sources", "write", "check", "review", "narrate", "captions", "media", "expand", "lint", "draft", "final", "save"] as const;
const stages = (status: Partial<Record<(typeof IDS)[number], VideoRunView["stages"][number]["status"]>>, elapsed: Partial<Record<string, number>> = {}) =>
  IDS.map((id) => ({ id, label: id === "check" ? "Checking facts" : id === "write" ? "Writing the script" : id === "lint" ? "Checking the video" : id[0]!.toUpperCase() + id.slice(1), status: status[id] ?? "pending", pct: 0, elapsed_ms: elapsed[id] ?? 0, message: "" }));
const PLAN: VideoRunView["plan"] = ["request", "sources", "write", "check", "narrate", "captions", "expand", "lint", "final", "save"];
const run = (over: Partial<VideoRunView>): VideoRunView => ({
  runId: "vr-1", folder: "learning/rag/videos/1", type: "jd-walkthrough", phase: "write", status: "running", started_at: "2026-01-15T09:00:00.000Z",
  error: "", queued_behind: 0, plan: PLAN, stages: stages({}), ...over,
});
const writer = (steps: ClaudeRunView["steps"]): ClaudeRunView => ({
  id: "r-1", action: "video_script", title: "Video script", target: { kind: "workspace" }, key: "video_script--learning/rag/videos/1", status: "running",
  started_at: "2026-01-15T09:00:00.000Z", ended_at: "", elapsed_ms: 60_000, steps, summary: "", files: [], missing: [], stray: [], error: "", cost_usd: null, turns: null,
});

describe("one progress panel", () => {
  it("counts the planned steps only, so the total doesn't change when review is skipped mid-run", () => {
    const before = videoProgress(run({ stages: stages({ request: "done", sources: "done", write: "done", check: "running" }) }));
    const after = videoProgress(run({ phase: "final", stages: stages({ request: "done", sources: "done", write: "done", check: "done", review: "skipped", media: "skipped", narrate: "running" }) }));
    expect([before.step, before.total]).toEqual([4, 10]);
    expect([after.step, after.total]).toEqual([5, 10]);
  });

  it("shows Claude's steps inside the current step, not as a second panel", () => {
    renderApp(<RunPanel run={run({ stages: stages({ request: "done", sources: "done", write: "running" }) })} cancelling={false} onCancel={() => {}}
      writer={writer([{ label: "Reading the job ad", state: "done", at: "" }, { label: "Writing scene 2", state: "active", at: "" }])} />);
    const progress = screen.getByRole("region", { name: "Progress" });
    expect(within(progress).getByText("Step 3 of 10: Writing the script")).toBeInTheDocument();
    const sub = within(progress).getByRole("group", { name: "Claude is writing the script" });
    expect(within(sub).getByText("Writing scene 2")).toBeInTheDocument();
    expect(screen.getAllByRole("region")).toHaveLength(1);
  });

  it("doesn't show Claude's steps once the video is being built", () => {
    renderApp(<RunPanel run={run({ phase: "final", stages: stages({ request: "done", sources: "done", write: "done", check: "done", review: "skipped", narrate: "running" }) })} cancelling={false} onCancel={() => {}}
      writer={writer([{ label: "Writing scene 2", state: "active", at: "" }])} />);
    expect(screen.queryByRole("group", { name: /Claude/ })).toBeNull();
  });

  it("lists every planned step with done, current and next, and the time each took or should take", () => {
    const r = run({
      phase: "final", stages: stages({ request: "done", sources: "done", write: "done", check: "done", review: "skipped", narrate: "running" }, { write: 130_000, check: 77_000, narrate: 10_000 }),
      estimates: { ms: { narrate: 30_000, captions: 18_000, expand: 3000, lint: 60_000, final: 66_000, save: 2000 }, measured: false },
    });
    renderApp(<RunPanel run={r} cancelling={false} onCancel={() => {}} />);
    const list = screen.getByRole("list", { name: "Steps" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(10);
    expect(rows[2]).toHaveTextContent("Writing the script, done2:10");
    expect(rows[3]).toHaveTextContent("Checking facts, done1:17");
    expect(rows[4]).toHaveAttribute("aria-current", "step");
    expect(rows[4]).toHaveTextContent("0:10 of about 30 s");
    expect(rows[7]).toHaveTextContent("Checking the video, to doabout 1 min");
    expect(screen.queryByText(/Review/)).toBeNull();
    expect(screen.getByText("About 3 min left")).toBeInTheDocument();
  });

  it("time helpers", () => {
    expect(aboutTime(2000)).toBe("about 5 s");
    expect(aboutTime(61_000)).toBe("about 2 min");
    expect(aboutTime(3_900_000)).toBe("about 1 hr 5 min");
    expect(timeLeft(run({}))).toBeNull();
  });
});

describe("slide preview parts", () => {
  it("sorts a scene's on-screen fields into kicker, title, subtitle and points", async () => {
    const { slideParts } = await import("../src/video/SlidePreview");
    expect(slideParts([{ path: "kicker", value: "JD walkthrough" }, { path: "title", value: "What Acme Corp asks for" }, { path: "subtitle", value: "AI Engineer" }]))
      .toEqual({ kicker: "JD walkthrough", title: "What Acme Corp asks for", subtitle: "AI Engineer", points: [], more: 0 });
    const many = [{ path: "headline", value: "Remember" }, ...[1, 2, 3, 4, 5].map((i) => ({ path: `items.${i}.text`, value: `Point ${i}` })), { path: "closing", value: "Good luck." }];
    expect(slideParts(many)).toEqual({ kicker: "", title: "Remember", subtitle: "Good luck.", points: ["Point 1", "Point 2", "Point 3", "Point 4"], more: 1 });
  });
});
