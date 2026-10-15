import { useEffect, useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { VideoListItem, VideoRunView } from "@careeros/contract";
import { MockBridge } from "../src/mock/MockBridge";
import { BackLink, NavMemory, resetTrail } from "../src/nav";
import { parseHash, toHash } from "../src/router";
import { JobScreen } from "../src/screens/Job";
import { VideosScreen } from "../src/screens/Videos";
import { fmtMaking, videoState } from "../src/video/stage";
import { renderApp } from "./render";

const JOB = { kind: "job" as const, company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const ROUTE = { screen: "job", slug: JOB.company_slug, id: JOB.id } as const;
const DIR = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos";
const OLD = `${DIR}/jd-walkthrough-9`;

/** One video in each state: done, making, script only, failed, stopped (left over), and an older script-only folder. */
async function seeded() {
  const b = new MockBridge();
  const make = async () => (await b.video.start("jd-walkthrough", JOB, {})).folder;
  const done = await make();
  await b.video.render(done, "final");
  b.simulateVideoItem(done, { length_s: 148, making_ms: 513_000, created_at: "2026-10-10T17:50:30.000Z" });
  const building = await make();
  b.simulateVideoRun(building, "building");
  const script = await make();
  const failed = await make();
  b.simulateStoppedVideo(failed);
  const stale = await make();
  b.simulateVideoItem(stale, { status: "rendering" });
  b.simulateLegacyVideo(OLD, "jd-walkthrough", JOB, "2026-10-01T09:26:00.000Z");
  return { b, done, building, script, failed, stale };
}

const item = (o: Partial<VideoListItem>): VideoListItem => ({
  folder: `${DIR}/jd-walkthrough-1`, type: "jd-walkthrough", type_label: "JD walkthrough", title: "", status: "done", subject: JOB, section: "jobs",
  length_s: null, created_at: "", updated_at: "", final: null, draft: null, captions: "rail", used_locked: false, context: "", ...o,
});
const live = (folder: string, status: VideoRunView["status"] = "running"): VideoRunView => ({
  runId: "vr-1", folder, type: "jd-walkthrough", phase: "final", status, started_at: "", error: "", queued_behind: 0,
  stages: [{ id: "narrate", label: "Narrating", status: "running", pct: 10, elapsed_ms: 0, message: "" }],
});

describe("videoState", () => {
  it("reads every list state in plain words", () => {
    expect(videoState(item({ status: "done" }))).toMatchObject({ kind: "done", text: "Done", next: "open" });
    expect(videoState(item({ status: "preview" }))).toMatchObject({ kind: "draft", text: "Draft ready" });
    expect(videoState(item({ status: "review" }))).toMatchObject({ kind: "script", text: "Script only, not made yet", next: "make" });
    expect(videoState(item({ legacy: true }))).toMatchObject({ kind: "legacy", text: "Script only, not made yet", next: "remake" });
    expect(videoState(item({ status: "failed", error: "The video check found 1 problem. First: x." }))).toMatchObject({ kind: "failed", text: "Didn't finish: the video check found 1 problem", next: "retry" });
    expect(videoState(item({ status: "failed" }))).toMatchObject({ text: "Didn't finish", next: "retry" });
  });
  it("shows a live run's step, and a 'rendering' record with no live run as stopped", () => {
    const v = item({ status: "rendering" });
    expect(videoState(v, [live(v.folder)])).toMatchObject({ kind: "running", text: "Making it: narrating", next: "open" });
    expect(videoState(v, [live(v.folder, "queued")]).text).toBe("Making it: waiting for another video");
    expect(videoState(v, [live("other/folder")])).toMatchObject({ kind: "stale", text: "Stopped before it finished", next: "retry" });
    expect(videoState(v, [{ ...live(v.folder), status: "failed" }])).toMatchObject({ kind: "stale" });
    // A script that stopped being written can't be retried as a render: open it instead.
    expect(videoState(item({ status: "writing" }))).toMatchObject({ kind: "stale", next: "open" });
  });
});

describe("fmtMaking", () => {
  it("says how long making took", () => {
    expect(fmtMaking(undefined)).toBe("");
    expect(fmtMaking(0)).toBe("");
    expect(fmtMaking(Number.NaN)).toBe("");
    expect(fmtMaking(42_000)).toBe("under a minute");
    expect(fmtMaking(513_000)).toBe("9 min");
    expect(fmtMaking(60 * 60_000)).toBe("1 h");
    expect(fmtMaking(65 * 60_000)).toBe("1 h 5 min");
  });
});

describe("the job page's Videos tab", () => {
  beforeEach(() => { window.location.hash = ""; });

  it("counts this job's videos on the tab, with the Make buttons on the Description toolbar", async () => {
    const { b } = await seeded();
    renderApp(<JobScreen route={ROUTE} />, { bridge: b });
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Videos/ })).toHaveTextContent("6"));
    // The tab is the one way to the list; the toolbar keeps only the Make buttons.
    expect(screen.queryByTestId("job-videos-link")).toBeNull();
    expect(screen.getByRole("button", { name: "JD video" })).toBeInTheDocument();
  });

  it("lists every state with its next step", async () => {
    const { b, done, script, failed, stale } = await seeded();
    renderApp(<JobScreen route={{ ...ROUTE, tab: "videos" }} />, { bridge: b });
    const list = await screen.findByRole("region", { name: "This job's videos" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(6));
    const states = within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-state"));
    expect(states.sort()).toEqual(["done", "failed", "legacy", "running", "script", "stale"]);
    const byState = (s: string) => within(list).getAllByRole("listitem").find((li) => li.getAttribute("data-state") === s)!;
    expect(within(byState("done")).getByText("Done")).toBeInTheDocument();
    expect(within(byState("done")).getByText("2:28")).toBeInTheDocument();
    expect(within(byState("done")).getByText("Took 9 min to make")).toBeInTheDocument();
    expect(within(byState("done")).getByText("Started 11 Oct 2026")).toBeInTheDocument();
    expect(within(byState("running")).getByText("Making it: checking the video")).toBeInTheDocument();
    expect(within(byState("script")).getByText("Script only, not made yet")).toBeInTheDocument();
    expect(within(byState("stale")).getByText("Stopped before it finished")).toBeInTheDocument();
    expect(within(byState("failed")).getByText(/^Didn't finish: the video check found 1 problem/)).toBeInTheDocument();
    // The older folder has no page to open and nothing the pipeline can delete: make it again, or see its folder.
    const old = byState("legacy");
    expect(within(old).queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(within(old).queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(old).getByRole("button", { name: /^Remake/ })).toBeInTheDocument();

    // Script only: Make the video goes through the same path as Approve.
    await userEvent.click(within(byState("script")).getByRole("button", { name: /^Make video/ }));
    await waitFor(() => expect(b.calls.find((c) => c.method === "video.approveScript")?.args).toEqual([script]));
    // Failed and stopped: Try again resumes through video.retry.
    await userEvent.click(within(byState("failed")).getByRole("button", { name: /^Try again/ }));
    await userEvent.click(within(byState("stale")).getByRole("button", { name: /^Try again/ }));
    await waitFor(() => expect(b.calls.filter((c) => c.method === "video.retry").map((c) => c.args[0])).toEqual([failed, stale]));
    expect(done).toBeTruthy();
  });

  it("offers the two Make buttons when the job has no videos", async () => {
    renderApp(<JobScreen route={{ ...ROUTE, tab: "videos" }} />);
    expect(await screen.findByText(/No videos for this job yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "JD video" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Company video" })).toBeInTheDocument();
  });

  it("opens a video and Back returns to this job's Videos tab", async () => {
    const { b, done } = await seeded();
    resetTrail();
    function Harness() {
      const [hash, setHash] = useState(window.location.hash);
      useEffect(() => { const on = () => setHash(window.location.hash); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
      const route = parseHash(hash);
      return <div id="main"><NavMemory route={route} generation={0} /><BackLink route={route} />{route.screen === "job" ? <JobScreen route={route} /> : null}</div>;
    }
    window.location.hash = "#/jobs";
    renderApp(<Harness />, { bridge: b });
    await act(async () => { window.location.hash = toHash({ ...ROUTE, tab: "videos" }); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    const list = await screen.findByRole("region", { name: "This job's videos" });
    const row = await waitFor(() => within(list).getAllByRole("listitem").find((li) => li.getAttribute("data-state") === "done")!);
    await userEvent.click(within(row).getByRole("button", { name: /^Open/ }));
    expect(window.location.hash).toBe(toHash({ screen: "video", folder: done }));
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    const back = await screen.findByRole("link", { name: /^Back to/ });
    expect(back).toHaveAttribute("href", toHash({ ...ROUTE, tab: "videos" }));
  });
});

describe("the Videos screen", () => {
  it("lists script-only, stopped and older videos too", async () => {
    const { b } = await seeded();
    renderApp(<VideosScreen />, { bridge: b });
    const jobs = await screen.findByRole("region", { name: "Job videos" });
    await waitFor(() => expect(within(jobs).getAllByRole("listitem")).toHaveLength(6));
    expect(within(jobs).getAllByText("Script only, not made yet")).toHaveLength(2);
    expect(within(jobs).getByText("Stopped before it finished")).toBeInTheDocument();
  });
});
