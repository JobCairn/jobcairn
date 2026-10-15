import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";
import { VideoScreen } from "../src/screens/Video";
import { VideoRows } from "../src/components/VideoList";
import { plainReason, stoppedTitle } from "../src/video/Stopped";
import { shortReason, videoStatus } from "../src/video/stage";
import { videoTask } from "../src/claude/tasks-model";
import { renderApp } from "./render";

const JOB = { kind: "job" as const, company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const FOLDER = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1";
const REASON = "The video check found 1 problem. First: HyperFrames stopped: Chrome could not be started.";

async function stoppedVideo() {
  const bridge = new MockBridge();
  await bridge.video.start("jd-walkthrough", JOB, {});
  bridge.simulateStoppedVideo(FOLDER, REASON);
  return bridge;
}

describe("status words when making the video stopped", () => {
  it("says Didn't finish with a short reason, never Script ready for your review", () => {
    expect(videoStatus("failed", REASON)).toMatchObject({ text: "Didn't finish: the video check found 1 problem", tone: "danger", title: REASON });
    expect(videoStatus("failed", "").text).toBe("Didn't finish");
    expect(videoStatus("review").text).toBe("Script ready for your review");
    expect(shortReason("A".repeat(100)).length).toBeLessThanOrEqual(60);
  });
  it("Activity's task line says it too", () => {
    const t = videoTask({ runId: "vr-1", folder: FOLDER, type: "jd-walkthrough", phase: "final", status: "failed", stages: [], started_at: "2026-01-15T09:00:00.000Z", error: REASON, queued_behind: 0 });
    expect(t.stage).toBe("Didn't finish: the video check found 1 problem");
    expect(t.done).toBe("Didn't finish: the video check found 1 problem");
  });
  it("titles and reasons in plain words", () => {
    expect(stoppedTitle({ stage: "lint", label: "Checking the video", reason: REASON, quality: "final", can_skip_check: true })).toBe("The video check hit a problem");
    expect(plainReason(REASON)).toBe("The video check found 1 problem.");
  });
});

describe("VideoScreen after the video check stopped a video that skipped review", () => {
  it("shows the failure first, says the script is fine, and keeps the script out of the way", async () => {
    const bridge = await stoppedVideo();
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    const card = await screen.findByTestId("video-stopped");
    expect(within(card).getByRole("heading", { name: "The video check hit a problem" })).toBeInTheDocument();
    expect(card).toHaveTextContent("The video check found 1 problem. Your script is fine.");
    expect(within(card).getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Skip check" })).toBeEnabled();
    expect(within(card).getByText("Show details")).toBeInTheDocument();
    expect(screen.getByText(/Didn't finish: the video check found 1 problem/)).toBeInTheDocument();
    expect(screen.queryByText("Script ready for your review")).toBeNull();
    // The review is still there, but folded away under the failure.
    expect(screen.getByText("Your script (4 scenes)")).toBeInTheDocument();
    expect(screen.getByText("Your script (4 scenes)").closest("details")).not.toHaveAttribute("open");
  });

  it("Try again retries the same render; Make it without the check asks to skip it", async () => {
    const user = userEvent.setup();
    const bridge = await stoppedVideo();
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Skip check" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.retry")?.args).toEqual([FOLDER, { skip_check: true }]));
    await waitFor(() => expect(screen.queryByTestId("video-stopped")).toBeNull());

    const b2 = await stoppedVideo();
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge: b2 });
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(b2.calls.find((c) => c.method === "video.retry")?.args).toEqual([FOLDER, {}]));
  });

  it("the Videos list row says Didn't finish with the reason, and offers Try again", async () => {
    const bridge = await stoppedVideo();
    const items = await bridge.video.list({});
    renderApp(<VideoRows items={items} label="Job videos" />, { bridge });
    expect(await screen.findByText("Didn't finish: the video check found 1 problem")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Try again/ })).toBeInTheDocument();
  });
});

describe("Delivered with notes", () => {
  it("shows what the check noted but didn't stop for, behind Show notes", async () => {
    const { CheckNotes } = await import("../src/screens/Video");
    renderApp(<CheckNotes notes={[{ area: "layout", text: "The title overflows its box" }, { area: "contrast", text: "Text contrast is 4.2:1" }]} />);
    expect(screen.getByText("Delivered with 2 notes")).toBeInTheDocument();
    const more = screen.getByText("Show notes").closest("details")!;
    expect(more).not.toHaveAttribute("open");
    expect(more).toHaveTextContent("Layout: The title overflows its box");
    expect(more).toHaveTextContent("Contrast: Text contrast is 4.2:1");
  });
});
