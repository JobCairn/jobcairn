import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeRunView, VideoDraftView, VideoRunView } from "@careeros/contract";
import { MockBridge } from "../src/mock/MockBridge";
import { parseHash, toHash } from "../src/router";
import { SCREENS } from "../src/screens/registry";
import { FIX_NOTE, fixedLine, RunPanel, VideoPreview, VideoScreen, reviewStatus, videoProgress } from "../src/screens/Video";
import { videoStage } from "../src/video/stage";
import { renderApp } from "./render";

const JOB = { kind: "job" as const, company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const FOLDER = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1";

async function withVideo() {
  const bridge = new MockBridge();
  await bridge.video.start("jd-walkthrough", JOB, {});
  return bridge;
}

/** The mock hands out copies, so a test changes what the screen loads by wrapping draft(). */
function patchDraft(bridge: MockBridge, over: Partial<VideoDraftView>) {
  const real = bridge.video.draft;
  bridge.video.draft = async (f) => ({ ...(await real(f)), ...over });
}

const run = (over: Partial<VideoRunView>): VideoRunView => ({
  runId: "vr-1", folder: FOLDER, type: "jd-walkthrough", phase: "build", status: "running", started_at: "2026-01-15T09:00:00.000Z", error: "", queued_behind: 0,
  stages: [
    { id: "narrate", label: "Narrating", status: "done", pct: 100, elapsed_ms: 900, message: "" },
    { id: "draft", label: "Draft render", status: "running", pct: 40, elapsed_ms: 1200, message: "" },
    { id: "final", label: "Final render", status: "skipped", pct: 0, elapsed_ms: 0, message: "" },
  ],
  ...over,
});

const writerRun = (over: Partial<ClaudeRunView>): ClaudeRunView => ({
  id: "r-mock0099-1", action: "video_script", title: "Video script", target: { kind: "workspace" }, key: `video_script--${FOLDER}`, status: "succeeded",
  started_at: "2026-01-15T09:00:00.000Z", ended_at: "2026-01-15T09:03:00.000Z", elapsed_ms: 180_000, steps: [{ label: "Writing the script", state: "done", at: "2026-01-15T09:01:00.000Z" }],
  summary: "", files: [], missing: [], stray: [], error: "", cost_usd: 0.18, turns: 9,
  ...over,
});

describe("video route", () => {
  it("round-trips a video folder and refuses junk", () => {
    expect(toHash({ screen: "video", folder: FOLDER })).toBe(`#/video?folder=${encodeURIComponent(FOLDER)}`);
    expect(parseHash(toHash({ screen: "video", folder: FOLDER }))).toEqual({ screen: "video", folder: FOLDER });
    expect(parseHash("#/video?folder=..%2Fsecrets")).toEqual({ screen: "home" });
    expect(parseHash("#/video?folder=me%2Fidentity%2Fvideos%2F1")).toEqual({ screen: "home" });
    expect(parseHash("#/video")).toEqual({ screen: "home" });
    expect(SCREENS.video).toBe(VideoScreen);
  });
});

describe("VideoScreen", () => {
  it("shows the scenes for review and blocks Approve until edits are saved and clean (Review Focus 1)", async () => {
    const user = userEvent.setup();
    const bridge = await withVideo();
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    expect(await screen.findByRole("heading", { name: "Review the script", level: 2 })).toBeInTheDocument();
    // A readable script: each scene's narration as text, edited in place after a click.
    expect(screen.queryAllByRole("textbox", { name: /^Scene \d script$/ })).toHaveLength(0);
    expect(within(screen.getByRole("listitem", { name: "Scene 2" })).getByText("The role asks for agents and retrieval.")).toBeInTheDocument();
    expect(screen.getByTestId("video-summary")).toHaveTextContent("4 scenes · about 2:30 long · you asked for about 2:30.");
    await user.click(screen.getByRole("button", { name: "Edit scene 2" }));
    const approve = screen.getByRole("button", { name: "Approve script" });
    expect(approve).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save edits" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save edits" })).toHaveAccessibleDescription("No changes to save.");
    expect(screen.getByRole("textbox", { name: "Scene 2: Headline" })).toHaveAccessibleDescription("7 of 12 words");

    await user.clear(screen.getByRole("textbox", { name: "Scene 2 script" }));
    expect(approve).toBeDisabled();
    expect(screen.getByText("Save your changes first.")).toBeInTheDocument();
    expect(approve).toHaveAccessibleDescription("Save your changes first.");

    await user.click(screen.getByRole("button", { name: "Save edits" }));
    const scene2 = await screen.findByRole("list", { name: "Scene 2: what needs a change" });
    expect(within(scene2).getByText("The script is empty. Put the words back.")).toBeInTheDocument();
    expect(screen.getByText("Scene 2 needs a change. It's marked below.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve script" })).toBeDisabled();
    expect(screen.getByText("Fix what's marked in the script first.")).toBeInTheDocument();
    expect(screen.getByTestId("video-status")).toHaveTextContent("Script written. Fix what's marked below, then approve to make a draft");
    expect(bridge.calls.find((c) => c.method === "video.saveScript")?.args).toEqual([FOLDER, { scenes: [{ index: 1, script: "" }] }]);
  });

  it("shows sources by name, not by path", async () => {
    const bridge = await withVideo();
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    // Sources sit behind a small "Sources (1)".
    expect((await screen.findAllByText("Sources (1)"))[0]!.closest("details")).not.toHaveAttribute("open");
    const sources = await screen.findByRole("list", { name: "Scene 1 sources" });
    expect(within(sources).getByText("Job ad")).toBeInTheDocument();
    expect(screen.queryByText(/companies\/acme-corp/)).toBeNull();
  });

  it("keeps typing when another run announces a change", async () => {
    const user = userEvent.setup();
    const bridge = await withVideo();
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Edit scene 1" }));
    const box = await screen.findByRole("textbox", { name: "Scene 1 script" });
    await user.type(box, " Extra.");
    await bridge.video.start("company-briefing", { kind: "company", company_slug: "acme-corp" }, {});
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "video.draft").length).toBeGreaterThan(1));
    expect(screen.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Here is what Acme Corp wants from an AI Engineer. Extra.");
  });

  it("keeps unsaved typing when a run for this video starts elsewhere, and says so when the review returns", async () => {
    const user = userEvent.setup();
    const bridge = await withVideo();
    let active: VideoRunView[] = [];
    bridge.video.runs = async () => active;
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Edit scene 1" }));
    await user.type(await screen.findByRole("textbox", { name: "Scene 1 script" }), " Extra.");
    expect(screen.queryByText("Your unsaved edits were kept.")).toBeNull();

    active = [run({})];
    await bridge.video.start("company-briefing", { kind: "company", company_slug: "acme-corp" }, {}); // any "video" change reloads runs
    expect(await screen.findByRole("progressbar", { name: "Draft render progress" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Scene 1 script" })).toBeNull();

    active = [];
    await bridge.video.start("company-briefing", { kind: "company", company_slug: "acme-corp" }, {});
    expect(await screen.findByText("Your unsaved edits were kept.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Here is what Acme Corp wants from an AI Engineer. Extra.");
    expect(screen.getByRole("button", { name: "Approve script" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Save edits" }));
    await waitFor(() => expect(screen.queryByText("Your unsaved edits were kept.")).toBeNull());
    expect(bridge.calls.find((c) => c.method === "video.saveScript")?.args).toEqual([FOLDER, { scenes: [{ index: 0, script: "Here is what Acme Corp wants from an AI Engineer. Extra." }] }]);
  });

  it("can drop kept edits", async () => {
    const user = userEvent.setup();
    const bridge = await withVideo();
    let active: VideoRunView[] = [];
    bridge.video.runs = async () => active;
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Edit scene 1" }));
    await user.type(await screen.findByRole("textbox", { name: "Scene 1 script" }), " Extra.");
    active = [run({})];
    await bridge.video.start("company-briefing", { kind: "company", company_slug: "acme-corp" }, {});
    await screen.findByRole("progressbar", { name: "Draft render progress" });
    active = [];
    await bridge.video.start("company-briefing", { kind: "company", company_slug: "acme-corp" }, {});
    await user.click(await screen.findByRole("button", { name: "Discard edits" }));
    // Dropped: the scene goes back to reading its saved words.
    expect(within(screen.getByRole("listitem", { name: "Scene 1" })).getByText("Here is what Acme Corp wants from an AI Engineer.")).toBeInTheDocument();
    expect(screen.queryByText("Your unsaved edits were kept.")).toBeNull();
  });

  it("approves, previews the draft and makes the final video", async () => {
    const user = userEvent.setup();
    const bridge = await withVideo();
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Approve script" }));
    expect(await screen.findByRole("heading", { name: "Preview", level: 2 })).toBeInTheDocument();
    const player = screen.getByLabelText("What Acme Corp asks for video");
    expect(player.getAttribute("src")).toBe(bridge.fileUrl(`${FOLDER}/renders/draft.mp4`));
    expect(screen.getByRole("img", { name: "Contact sheet: one frame from each scene" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Make final" }));
    expect(await screen.findByText("Final video saved")).toBeInTheDocument();
    expect(screen.getByLabelText("What Acme Corp asks for video").getAttribute("src")).toBe(bridge.fileUrl(`${FOLDER}/renders/final.mp4`));
    await user.click(screen.getByRole("button", { name: "Export SRT" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.exportCaptions")?.args).toEqual([FOLDER, "srt"]));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "files.reveal")?.args).toEqual([`${FOLDER}/captions.srt`]));
  });

  it("sends a revision note to Claude, and says why Send waits for one", async () => {
    const user = userEvent.setup();
    const bridge = await withVideo();
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Revise" }));
    const dialog = screen.getByRole("dialog", { name: "Ask Claude to revise" });
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(dialog).getByText("Write what should change first.")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "What should change?" }), "Shorter scene 3.");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.revise")?.args).toEqual([FOLDER, "Shorter scene 3."]));
  });

  it("explains a folder that isn't a video", async () => {
    renderApp(<VideoScreen route={{ screen: "video", folder: "learning/rag/videos/9" }} />);
    expect(await screen.findByText("This video can't be opened")).toBeInTheDocument();
    expect(screen.getByText("There is no video in that folder.")).toBeInTheDocument();
  });

  it("shows the run panel and hides the review while a run is active", async () => {
    const bridge = await withVideo();
    bridge.video.runs = async () => [run({})];
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    expect(await screen.findByRole("progressbar", { name: "Draft render progress" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Review the script" })).toBeNull();
  });

  it("says plainly when the last run failed or was cancelled", async () => {
    const bridge = await withVideo();
    patchDraft(bridge, { status: "failed", error: "The draft render stopped. Try again." });
    const { unmount } = renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    expect(await screen.findByRole("alert")).toHaveTextContent("The draft render stopped. Try again.");
    unmount();
    patchDraft(bridge, { status: "cancelled", error: "" });
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    expect(await screen.findByText("Cancelled. Your script is kept. Approve it again when you are ready.")).toBeInTheDocument();
  });

  it("shows the script writer's Claude run while it works, then its cost in the run details", async () => {
    const bridge = await withVideo();
    bridge.claudeSim.runs.unshift(writerRun({ status: "running", ended_at: "", cost_usd: null, turns: null, steps: [{ label: "Reading the job ad", state: "active", at: "2026-01-15T09:01:00.000Z" }] }));
    bridge.video.runs = async () => [run({ phase: "write", stages: [{ id: "write", label: "Writing the script", status: "running", pct: 0, elapsed_ms: 0, message: "" }] })];
    const { unmount } = renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    // One panel: Claude's steps sit inside the video's progress, under the step they belong to.
    const progress = await screen.findByRole("region", { name: "Progress" });
    const panel = within(progress).getByRole("group", { name: "Claude is writing the script" });
    expect(within(panel).getByText("Reading the job ad")).toBeInTheDocument();
    expect(within(panel).queryByText(/Cost estimate/)).toBeNull();
    unmount();

    act(() => { bridge.claudeSim.runs[0] = writerRun({}); });
    bridge.video.runs = async () => [];
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    await screen.findByRole("heading", { name: "Review the script", level: 2 });
    const details = await screen.findByText("Claude wrote this script on 15 Jan 2026.");
    expect(details.closest("details")).toHaveTextContent("Cost estimate: $0.18");
  });

  it("offers an empty state when the script isn't written yet", async () => {
    const bridge = await withVideo();
    patchDraft(bridge, { status: "writing", scenes: [] });
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    expect(await screen.findByText("The script isn't ready yet. It shows here as soon as it is.")).toBeInTheDocument();
  });
});

describe("VideoPreview", () => {
  const draft = async () => {
    const bridge = await withVideo();
    await bridge.video.approveScript(FOLDER);
    return { bridge, d: await bridge.video.draft(FOLDER) };
  };

  it("shows the QA label when the video has one", async () => {
    const { bridge, d } = await draft();
    const { unmount } = renderApp(<VideoPreview draft={{ ...d, qa: { status: "passed", open_issues: 0 } }} folder={FOLDER} />, { bridge });
    expect(screen.getByText("Quality check")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    unmount();
    const r2 = renderApp(<VideoPreview draft={{ ...d, qa: { status: "open_issues", open_issues: 2 } }} folder={FOLDER} />, { bridge });
    expect(screen.getByText("2 open issues")).toBeInTheDocument();
    r2.unmount();
    renderApp(<VideoPreview draft={{ ...d, qa: null } as VideoDraftView} folder={FOLDER} />, { bridge });
    expect(screen.queryByText("Quality check")).toBeNull();
  });

  it("lists a long video's chapters and plays from the one clicked", async () => {
    const user = userEvent.setup();
    const play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const { bridge, d } = await draft();
    renderApp(<VideoPreview draft={{ ...d, chapters: [{ title: "What the role asks", start_s: 0 }, { title: "Where you stand", start_s: 95.5 }] }} folder={FOLDER} />, { bridge });
    const nav = screen.getByRole("navigation", { name: "Chapters" });
    const video = document.querySelector("video")!;
    await user.click(within(nav).getByRole("button", { name: "Play from 1:36: Where you stand" }));
    expect(video.currentTime).toBe(95.5);
    expect(play).toHaveBeenCalled();
    play.mockRestore();
  });

  it("shows no chapter list for a short video", async () => {
    const { bridge, d } = await draft();
    renderApp(<VideoPreview draft={{ ...d, chapters: [] }} folder={FOLDER} />, { bridge });
    expect(screen.queryByRole("navigation", { name: "Chapters" })).toBeNull();
  });

  it("warns before export when the script used a locked fact, without showing the path", async () => {
    const { bridge, d } = await draft();
    renderApp(<VideoPreview draft={{ ...d, locked_facts: [{ folder: "me/identity", granted_at: "2026-01-15T09:00:00.000Z" }] }} folder={FOLDER} />, { bridge });
    expect(screen.getByText(/uses facts from your identity folder/)).toBeInTheDocument();
    expect(screen.queryByText(/me\/identity/)).toBeNull();
  });
});

describe("RunPanel", () => {
  it("shows progress, the queue and Cancel", async () => {
    const onCancel = vi.fn();
    renderApp(<RunPanel run={run({})} onCancel={onCancel} cancelling={false} />);
    expect(screen.getByRole("progressbar", { name: "Draft render progress" })).toHaveAttribute("value", "40");
    expect(screen.queryByText("Final render")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("is one compact line: what it's making, the step it's on, one bar; every step behind Show all steps", () => {
    const r = run({});
    const p = videoProgress(r);
    renderApp(<RunPanel run={r} onCancel={() => {}} cancelling={false} />);
    expect(screen.getByText(new RegExp(`^Step ${p.step} of ${p.total}`))).toBeInTheDocument();
    expect(screen.getByText("All steps").closest("details")).not.toHaveAttribute("open");
    expect(p.pct).toBeGreaterThan(0);
    expect(p.pct).toBeLessThan(100);
  });

  it("says when it waits behind another video (Review Focus 5)", () => {
    renderApp(<RunPanel run={run({ status: "queued", queued_behind: 1 })} onCancel={() => {}} cancelling={false} />);
    expect(screen.getByText("Waiting for another video to finish.")).toBeInTheDocument();
  });
});

describe("ScriptReview: a script that failed its format check", () => {
  async function broken() {
    const bridge = await withVideo();
    bridge.simulateBrokenScript(FOLDER);
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    await screen.findByRole("heading", { name: "Review the script", level: 2 });
    return bridge;
  }

  it("never shows a spec path; format problems become one line with Ask Claude to fix these as the main action", async () => {
    await broken();
    const main = document.body.textContent ?? "";
    const details = screen.getByText("Technical details").closest("details")!;
    const outside = main.replace(details.textContent ?? "", "");
    expect(outside).not.toMatch(/sources\.0|items\.0|must be an object|workspace file path|recap-card|problems to fix/);
    expect(screen.getByText("Claude wrote parts of this script in the wrong format. Ask Claude to fix it.")).toBeInTheDocument();
    expect(screen.getByText("The video is missing a closing summary scene.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Scene 2: what needs a change" })).getByText("Headline has 13 words. Keep it to 12.")).toBeInTheDocument();
    expect(screen.getByTestId("video-status")).toHaveTextContent("Script written, but Claude needs to fix how parts of it are set up.");
    const fix = screen.getByRole("button", { name: "Fix issues" });
    expect(fix.className).toMatch(/primary/);
    const approve = screen.getByRole("button", { name: "Approve script" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription("Claude needs to fix the script's set-up first.");
    expect(details).not.toHaveAttribute("open");
    expect(details.textContent).toContain("items.0 must be an object.");
  });

  it("shows a hint, not a blank box, for fields left empty by the format problem", async () => {
    await broken();
    await userEvent.setup().click(screen.getByRole("button", { name: "Edit scene 4" }));
    expect(screen.queryByRole("textbox", { name: "Scene 4: Closing line" })).toBeNull();
    const hint = screen.getByRole("group", { name: "Scene 4: Closing line" });
    expect(hint).toHaveTextContent("Empty because of the format problem. It fills in when Claude fixes the script.");
    expect(screen.getByRole("textbox", { name: "Scene 4: Headline" })).toBeInTheDocument();
  });

  it("asks Claude to fix it with a plain note, and the fixed script can be approved", async () => {
    const user = userEvent.setup();
    const bridge = await broken();
    await user.click(screen.getByRole("button", { name: "Fix issues" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.revise")?.args).toEqual([FOLDER, FIX_NOTE]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve script" })).toBeEnabled());
    expect(screen.queryByText(/wrong format/)).toBeNull();
    expect(screen.getByTestId("video-status")).toHaveTextContent(/^Script written\. Review it, then approve to make a draft \(about \d+ min\)\.$/);
  });
});

describe("video stage words", () => {
  it("keeps a written script apart from a made video", () => {
    expect(videoStage("review").text).toBe("Script ready for your review");
    expect(videoStage("rendering").text).toBe("Making video…");
    expect(videoStage("done").text).toBe("Video ready");
    expect(reviewStatus({ format: 0, content: 0, minutes: 7 })).toBe("Script written. Review it, then approve to make a draft (about 7 min).");
    const d = (autofix: unknown) => ({ autofix }) as unknown as VideoDraftView;
    expect(fixedLine(d(null))).toBe("");
    expect(fixedLine(d({ repairs: [], claude_passes: 1, claude_fixed: 0, left: 2 }))).toBe("");
    expect(fixedLine(d({ repairs: ["a"], claude_passes: 1, claude_fixed: 3, left: 0 }))).toBe("Claude already fixed 3 problems, and 1 small format slip was put right.");
    expect(fixedLine(d({ repairs: [], claude_passes: 2, claude_fixed: 1, left: 2 }))).toBe("Claude already fixed 1 problem. The rest are listed below.");
  });
});
