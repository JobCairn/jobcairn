import { describe, expect, it } from "vitest";
import type { ClaudeRunView, VideoRunView } from "@careeros/contract";
import {
  HISTORY_CAP, allTasks, claudeTask, endedSince, mergeHistory, notifyText, parseHistory, shouldNotify, sidebarLine, toHistory, videoTask, type HistoryEntry,
} from "../src/claude/tasks-model";

const job = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
function run(over: Partial<ClaudeRunView> = {}): ClaudeRunView {
  return {
    id: "r1", action: "score_job", target: job, key: "k", status: "running", started_at: "2026-10-10T05:00:00.000Z", ended_at: "",
    elapsed_ms: 0, steps: [], summary: "", files: [], missing: [], stray: [], error: "", cost_usd: null, turns: null, ...over,
  };
}
function video(over: Partial<VideoRunView> = {}): VideoRunView {
  return { runId: "vr-1", folder: "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd-walkthrough", type: "jd-walkthrough", phase: "build",
    status: "running", stages: [], started_at: "2026-10-10T05:01:00.000Z", error: "", queued_behind: 0, ...over };
}

describe("tasks model", () => {
  it("lists Claude runs and video jobs together, newest first, without the video's own script writer", () => {
    const list = allTasks([run(), run({ id: "s", action: "video_script", started_at: "2026-10-10T05:02:00.000Z" })], [video()], () => "JD walkthrough");
    expect(list.map((t) => t.id)).toEqual(["video:vr-1", "claude:r1"]);
    expect(list[0]).toMatchObject({ label: "Video: JD walkthrough", verb: "Making a video", status: "running" });
    expect(list[1]).toMatchObject({ verb: "Scoring", status: "running" });
  });

  it("names the one running task in the sidebar, or counts several", () => {
    expect(sidebarLine([])).toBe("");
    expect(sidebarLine([videoTask(video())])).toBe("Claude · Making a video");
    expect(sidebarLine([videoTask(video({ phase: "write" }))])).toBe("Claude · Writing a video script");
    expect(sidebarLine([claudeTask(run()), videoTask(video())])).toBe("Claude · 2 running");
  });

  it("opens a video job on its video page; a script waiting for you says Review script", () => {
    expect(videoTask(video()).open).toEqual({ label: "Open", to: { screen: "video", folder: video().folder } });
    expect(videoTask(video({ status: "review" }))).toMatchObject({ status: "review", open: { label: "Review script" } });
    expect(claudeTask(run({ status: "succeeded" })).open.label).toBe("Open score");
  });

  it("History keeps one entry per task, newest first, at most 50", () => {
    const e = (i: number): HistoryEntry => ({ id: `claude:${i}`, kind: "claude", label: `T${i}`, status: "done", started_at: "", ended_at: `2026-10-10T05:${String(i % 60).padStart(2, "0")}:00.000Z`, open: { label: "Open", to: null } });
    const many = Array.from({ length: 60 }, (_, i) => e(i));
    const merged = mergeHistory([], many);
    expect(merged).toHaveLength(HISTORY_CAP);
    expect(merged[0]!.id).toBe("claude:59");
    expect(mergeHistory([e(1)], [{ ...e(1), status: "failed" }])).toEqual([{ ...e(1), status: "failed" }]);
    expect(toHistory(claudeTask(run({ status: "succeeded", ended_at: "" })), "2026-10-10T06:00:00.000Z").ended_at).toBe("2026-10-10T06:00:00.000Z");
  });

  it("reads stored History safely", () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory("not json")).toEqual([]);
    expect(parseHistory('{"a":1}')).toEqual([]);
    expect(parseHistory('[{"id":"claude:1","label":"A","ended_at":"x"},{"id":2}]')).toHaveLength(1);
  });

  it("finds tasks that ended (or reached review) since the last look", () => {
    const before = new Map([["claude:r1", "running" as const], ["video:vr-1", "running" as const]]);
    const now = [claudeTask(run({ status: "succeeded" })), videoTask(video({ status: "review" }))];
    expect(endedSince(before, now).map((t) => t.id)).toEqual(["claude:r1", "video:vr-1"]);
    expect(endedSince(new Map([["claude:r1", "done" as const]]), now)).toEqual([]);
  });

  it("notifies only for tasks over 30 seconds, while the window isn't focused, when switched on", () => {
    const t = claudeTask(run({ status: "succeeded", started_at: "2026-10-10T05:00:00.000Z" }));
    const at = (s: number) => Date.parse("2026-10-10T05:00:00.000Z") + s * 1000;
    expect(shouldNotify(t, { focused: false, enabled: true, now: at(31) })).toBe(true);
    expect(shouldNotify(t, { focused: false, enabled: true, now: at(29) })).toBe(false);
    expect(shouldNotify(t, { focused: true, enabled: true, now: at(60) })).toBe(false);
    expect(shouldNotify(t, { focused: false, enabled: false, now: at(60) })).toBe(false);
    expect(shouldNotify(claudeTask(run()), { focused: false, enabled: true, now: at(60) })).toBe(false);
    expect(notifyText(t, "Score ready")).toEqual({ title: "Score ready", body: t.label });
    expect(notifyText(claudeTask(run({ status: "failed" })), "x").title).toBe("Claude didn't finish");
  });

  it("never calls a written script a finished video (owner report: 'it only created a script?')", () => {
    expect(videoTask(video({ status: "review", phase: "write" }))).toMatchObject({ done: "Script ready: review it to make the video", stage: "Script ready for your review" });
    expect(videoTask(video({ phase: "write" })).stage).toBe("Writing the script…");
    expect(videoTask(video()).stage).toBe("Making video…");
    expect(videoTask(video({ status: "preview" })).done).toBe("Draft video ready");
    expect(videoTask(video({ status: "done", phase: "final" }))).toMatchObject({ done: "Video ready", stage: "Video ready" });
    expect(notifyText(videoTask(video({ status: "review" })), videoTask(video({ status: "review" })).done).title).not.toMatch(/^Video ready/);
  });
});
