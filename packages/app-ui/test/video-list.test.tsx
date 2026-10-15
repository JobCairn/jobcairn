import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { VideoSettingsPanel } from "../src/components/VideoList";
import { loadFixture } from "../src/mock/MockBridge";
import { SettingsScreen } from "../src/screens/Settings";
import { parseHash, toHash } from "../src/router";
import { MockBridge } from "../src/mock/MockBridge";
import { LearnScreen } from "../src/screens/Learn";
import { renderApp } from "./render";
import { JobVideos } from "../src/video/JobVideos";

const JOB = { kind: "job" as const, company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const JD_FOLDER = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1";

async function seeded() {
  const bridge = new MockBridge();
  await bridge.video.start("jd-walkthrough", JOB, {});
  await bridge.video.start("weekly-recap", { kind: "week", week: "2026-W03" }, {});
  await bridge.video.start("skill-gap-lesson", { kind: "topic", topic: "Kubernetes" }, {});
  return bridge;
}

describe("videos in Learn", () => {
  it("lists videos by section", async () => {
    const bridge = await seeded();
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge });
    const jobs = await screen.findByRole("region", { name: "Job videos" });
    expect(within(jobs).getByText("AI Engineer at Acme Corp")).toBeInTheDocument();
    expect(within(jobs).getByText("JD walkthrough")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Weekly recaps" })).getAllByRole("listitem")).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "Topic videos" })).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Company videos" })).toBeNull();
  });

  it("opens a video", async () => {
    const user = userEvent.setup();
    const bridge = await seeded();
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge });
    const jobs = await screen.findByRole("region", { name: "Job videos" });
    await user.click(within(jobs).getByRole("button", { name: "Open What Acme Corp asks for" }));
    expect(window.location.hash).toBe(`#/video?folder=${encodeURIComponent(JD_FOLDER)}`);
  });

  it("renders again only once a draft exists", async () => {
    const user = userEvent.setup();
    const bridge = await seeded();
    await bridge.video.approveScript(JD_FOLDER);
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge });
    const jobs = await screen.findByRole("region", { name: "Job videos" });
    expect(within(screen.getByRole("region", { name: "Weekly recaps" })).queryByRole("button", { name: /Render again/ })).toBeNull();
    await user.click(within(jobs).getByRole("button", { name: "Render again: What Acme Corp asks for" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.render")?.args).toEqual([JD_FOLDER, "final"]));
  });

  it("deletes after asking", async () => {
    const user = userEvent.setup();
    const bridge = await seeded();
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge });
    const jobs = await screen.findByRole("region", { name: "Job videos" });
    await user.click(within(jobs).getByRole("button", { name: "Delete What Acme Corp asks for" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this video?" });
    expect(within(dialog).getByText(/goes with its script and captions/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Job videos" })).toBeNull());
    expect(bridge.calls.find((c) => c.method === "video.delete")?.args).toEqual([JD_FOLDER]);
    // Undo puts it back.
    await user.click(await screen.findByRole("button", { name: "Undo deleting What Acme Corp asks for" }));
    expect(await screen.findByRole("region", { name: "Job videos" })).toBeInTheDocument();
  });
});

describe("VideoSettingsPanel", () => {
  it("says when the tools are ready", async () => {
    renderApp(<VideoSettingsPanel />);
    expect(await screen.findByText("Every tool for videos is ready.")).toBeInTheDocument();
    expect(screen.getByText("No custom video types.")).toBeInTheDocument();
  });

  it("shows the missing-tools card", async () => {
    renderApp(<VideoSettingsPanel />, { bridge: new MockBridge({ videoToolsOk: false }) });
    expect(await screen.findByRole("region", { name: "Tools for videos" })).toBeInTheDocument();
  });
});

describe("videos in Learn: locks, refusals and wording", () => {
  it("shows a delete refusal on the row", async () => {
    const user = userEvent.setup();
    const bridge = await seeded();
    bridge.video.delete = async () => { throw new Error("This folder has files CareerOS did not make: notes-of-mine.txt. Move them out first, then delete the video."); };
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge });
    const jobs = await screen.findByRole("region", { name: "Job videos" });
    await user.click(within(jobs).getByRole("button", { name: "Delete What Acme Corp asks for" }));
    await user.click(within(screen.getByRole("dialog", { name: "Delete this video?" })).getByRole("button", { name: "Delete" }));
    expect(await within(jobs).findByRole("alert")).toHaveTextContent(/notes-of-mine\.txt/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cuts an absolute path in a delete refusal down to the file name", async () => {
    const user = userEvent.setup();
    const bridge = await seeded();
    bridge.video.delete = async () => { throw new Error("This folder has files CareerOS did not make: /Users/alex/CareerOS/companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1/notes-of-mine.txt. Move them out first, then delete the video."); };
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge });
    const jobs = await screen.findByRole("region", { name: "Job videos" });
    await user.click(within(jobs).getByRole("button", { name: "Delete What Acme Corp asks for" }));
    await user.click(within(screen.getByRole("dialog", { name: "Delete this video?" })).getByRole("button", { name: "Delete" }));
    const alert = await within(jobs).findByRole("alert");
    expect(alert).toHaveTextContent("did not make: notes-of-mine.txt. Move them out first");
    expect(alert.textContent).not.toMatch(/\/|Users|companies/);
  });

  it("locks Render again once, with one click to the tool setup", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge({ videoToolsOk: false });
    for (const s of [JOB, { kind: "topic" as const, topic: "Kubernetes" }]) await bridge.video.start(s.kind === "job" ? "jd-walkthrough" : "skill-gap-lesson", s, {});
    await bridge.video.approveScript(JD_FOLDER);
    await bridge.video.approveScript("learning/kubernetes/videos/1");
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge });
    const button = await screen.findByRole("button", { name: "Video tools" });
    expect(screen.getAllByText(/Render again needs a few tools/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Render again/ })).toBeNull();
    await user.click(button);
    expect(window.location.hash).toBe("#/settings?tab=video");
  });

  it("lists a topic's own videos on its page", async () => {
    const bridge = await seeded();
    renderApp(<LearnScreen route={{ screen: "learn", topic: "kubernetes" }} />, { bridge });
    const own = await screen.findByRole("region", { name: "Videos on this topic" });
    expect(within(own).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Job videos" })).toBeNull();
  });

  it("drops sponsorship wording for people it doesn't apply to", async () => {
    const f = loadFixture();
    (f.profile as { work_rights: { status: string } }).work_rights.status = "citizen";
    const bridge = new MockBridge({ fixture: f });
    await bridge.video.start("company-briefing", { kind: "company", company_slug: "acme-corp" }, {});
    const list = bridge.learn.list;
    bridge.learn.list = async () => {
      const d = await list();
      return { ...d, videos: d.videos.map((v) => ({ ...v, context: "Acme Corp, sponsorship evidence and culture." })) };
    };
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge });
    const companies = await screen.findByRole("region", { name: "Company videos" });
    await waitFor(() => expect(within(companies).getByText("Acme Corp and culture.")).toBeInTheDocument());
    expect(within(companies).queryByText(/sponsor/i)).toBeNull();
  });
});

describe("Settings › Video", () => {
  it("opens a known tab from the address and ignores any other", () => {
    expect(parseHash("#/settings?tab=video")).toEqual({ screen: "settings", tab: "video" });
    expect(parseHash("#/settings?tab=zzzzz")).toEqual({ screen: "settings" });
    expect(toHash({ screen: "settings", tab: "video" })).toBe("#/settings?tab=video");
  });

  it("opens from the address and shows the caption style with the tool check", async () => {
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=video" });
    expect(await screen.findByRole("tab", { name: "Video", selected: true })).toBeInTheDocument();
    const panel = (await screen.findByLabelText("Caption style")).closest(".tabs__panel > div") as HTMLElement;
    expect(panel).not.toHaveAttribute("hidden");
    expect(within(panel).queryByLabelText("Voice engine")).toBeNull();
    expect(await screen.findByText("Every tool for videos is ready.")).toBeInTheDocument();
  });

  it("lists custom video types that failed their check", async () => {
    const bridge = new MockBridge();
    bridge.video.types = async () => ({ types: [], errors: [{ file: "settings/video-types/my-type.json", origin: "workspace", problems: ["length.max_s must be at most 600."] }] });
    renderApp(<VideoSettingsPanel />, { bridge });
    const types = await screen.findByRole("region", { name: "Custom video types" });
    expect(await within(types).findByText(/My type can.t be used yet/)).toBeInTheDocument();
    expect(within(types).getByText(/checks your custom video types/)).toBeInTheDocument();
    expect(types.textContent).not.toMatch(/settings\/|video-types\/|\.json/);
    expect(within(types).getByText("length.max_s must be at most 600.")).toBeInTheDocument();
  });

  it("refuses to install a tool while a video is being made, and says why", async () => {
    const bridge = new MockBridge({ videoToolsOk: false });
    bridge.video.runs = async () => [{ runId: "vr-1", folder: JD_FOLDER, type: "jd-walkthrough", phase: "build", status: "running", stages: [], started_at: "", error: "", queued_behind: 0 }];
    renderApp(<VideoSettingsPanel />, { bridge });
    const card = await screen.findByRole("region", { name: "Tools for videos" });
    await waitFor(() => expect(within(card).getByRole("button", { name: /Install ffmpeg/ })).toBeDisabled());
    expect(within(card).getByText(/A video is being made/)).toBeInTheDocument();
  });
});

describe("video stage on rows and the job's Interview tab", () => {
  it("says a script waits for review, not that a video is ready", async () => {
    const bridge = new MockBridge();
    await bridge.video.start("jd-walkthrough", { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }, {});
    renderApp(<JobVideos slug="acme-corp" id="2026-01-12-ai-engineer" />, { bridge });
    const region = await screen.findByRole("region", { name: "This job's videos" });
    expect(region).toHaveTextContent("Script only, not made yet");
    expect(region).not.toHaveTextContent(/Video ready|Final video/);
  });
});
