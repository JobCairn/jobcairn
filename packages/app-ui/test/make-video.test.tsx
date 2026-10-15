import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { isoWeek } from "@careeros/contract";
import { ActionButton, WORKSPACE } from "../src/components/ActionButton";
import { MakeVideoButton, openMakeVideo, subjectFor, VideoIntentListener, withoutSponsorship } from "../src/components/MakeVideo";
import { loadFixture, MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const JOB = { kind: "job" as const, company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const JD_FOLDER = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1";

describe("subjectFor", () => {
  it("derives the subject the type needs from the target", () => {
    const now = new Date("2026-01-15T09:00:00Z");
    expect(subjectFor({ subject: "job" }, JOB, now)).toEqual(JOB);
    expect(subjectFor({ subject: "company" }, JOB, now)).toEqual({ kind: "company", company_slug: "acme-corp" });
    expect(subjectFor({ subject: "topic" }, { ...JOB, kind: "topic", topic: "kubernetes", label: "Kubernetes" }, now))
      .toEqual({ kind: "topic", topic: "Kubernetes", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" });
    expect(subjectFor({ subject: "week" }, WORKSPACE, now)).toEqual({ kind: "week", week: "2026-W03" });
    expect(subjectFor({ subject: "job" }, WORKSPACE, now)).toBeNull();
  });
});

describe("Make video: a video that already exists (final review I1)", () => {
  it("asks before replacing it, keeps a dated copy by default, and says hand edits would be lost", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge();
    bridge.simulateClaudeOutput(JOB.company_slug, JOB.id);
    await bridge.video.start("application-summary", JOB, {});
    renderApp(<MakeVideoButton target={JOB} typeId="application-summary" />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    const group = await within(dialog).findByRole("group", { name: "This video already exists" });
    expect(within(group).getByRole("radio", { name: /Keep the old one as a dated copy/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /Replace the existing video\? Your edits to the script will be lost/ })).not.toBeChecked();
    await user.click(within(group).getByRole("radio", { name: /Replace the existing video/ }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "video.start").at(-1)?.args[2]).toMatchObject({ existing: "replace" }));
  });

  it("the mock, like the pipeline, refuses to overwrite without a choice", async () => {
    const bridge = new MockBridge();
    await bridge.video.start("application-summary", JOB, {});
    await expect(bridge.video.start("application-summary", JOB, {})).rejects.toThrow(/already exists/);
    const copy = await bridge.video.start("application-summary", JOB, { existing: "keep_copy" });
    expect(copy.folder).toBe("companies/acme-corp/jobs/2026-01-12-ai-engineer/application/summary-video");
    expect((await bridge.video.list({})).map((v) => v.folder)).toContain("companies/acme-corp/jobs/2026-01-12-ai-engineer/application/summary-video-2026-01-15");
  });
});

describe("Make video", () => {
  it("opens from a video action with the type picked, and Start opens the video screen", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<ActionButton action="jd_walkthrough_video" target={JOB} />);
    await user.click(await screen.findByRole("button", { name: "JD video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect(within(dialog).getByRole("radio", { name: /JD walkthrough/ })).toBeChecked();
    // The files it uses, by plain name (no workspace paths on screen).
    expect(await within(dialog).findByText("Job ad")).toBeInTheDocument();
    expect(within(dialog).queryByText(/companies\/acme-corp/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/video?folder=${encodeURIComponent(JD_FOLDER)}`));
    expect(bridge.calls.filter((c) => c.method === "video.start").map((c) => c.args)).toEqual([["jd-walkthrough", JOB, { length_s: 150, sound: "on" }]]);
  });

  it("turns this video's sound effects off when \"Sound effects\" is unticked", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<ActionButton action="jd_walkthrough_video" target={JOB} />);
    await user.click(await screen.findByRole("button", { name: "JD video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    const box = await within(dialog).findByRole("checkbox", { name: "Sound effects" });
    expect(box).toBeChecked();
    await user.click(box);
    expect(within(dialog).getByText("Voice only.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.start")?.args[2]).toMatchObject({ sound: "off" }));
  });

  it("asks for a review stop only when \"Let me review the script first\" is ticked", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<ActionButton action="jd_walkthrough_video" target={JOB} />);
    await user.click(await screen.findByRole("button", { name: "JD video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    const box = await within(dialog).findByRole("checkbox", { name: "Let me review the script first" });
    expect(box).not.toBeChecked();
    expect(within(dialog).getByText(/stops for you only if something needs a look/)).toBeInTheDocument();
    await user.click(box);
    await user.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.start")?.args[2]).toEqual({ length_s: 150, review: "always", sound: "on" }));
  });

  it("sends one start for a double click (Review Focus 5)", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MakeVideoButton target={JOB} typeId="pitch" />);
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const start = within(await screen.findByRole("dialog", { name: "Make a video" })).getByRole("button", { name: "Start" });
    await waitFor(() => expect(start).toBeEnabled());
    await user.dblClick(start);
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "video.start")).toHaveLength(1));
  });

  it("lets the candidate pick length, mode and a note", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MakeVideoButton target={JOB} typeId="interview-prep" />);
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    const length = await within(dialog).findByRole("group", { name: "Length" });
    await user.click(within(length).getByRole("radio", { name: /Custom/ }));
    const custom = within(length).getByRole("textbox", { name: "Custom length (minutes:seconds)" });
    await user.clear(custom);
    await user.type(custom, "4:00");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Mode" }), "watch");
    await user.type(within(dialog).getByRole("textbox", { name: "Note for Claude (optional)" }), "Focus on system design.");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.start")?.args)
      .toEqual(["interview-prep", JOB, { length_s: 240, mode: "watch", note: "Focus on system design.", sound: "on" }]));
  });

  it("offers Quick, Standard and In-depth with Standard as the walkthrough default, and says how long it takes to make", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MakeVideoButton target={JOB} typeId="jd-walkthrough" />);
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    const length = await within(dialog).findByRole("group", { name: "Length" });
    expect(within(length).getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["quick", "standard", "in_depth", "custom"]);
    expect(within(length).getByRole("radio", { name: /Standard/ })).toBeChecked();
    // Mock rate: 2 min fixed plus 2.5 s per second of video. Standard (2:30) takes about 9 min.
    expect(within(length).getByText(/^About 9 min to make on this (Mac|computer)\.$/)).toBeInTheDocument();
    await user.click(within(length).getByRole("radio", { name: /In-depth/ }));
    expect(within(length).getByText(/^About 19 min to make on this/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.start")?.args[2]).toEqual({ length_s: 390, sound: "on" }));
  });

  it("a custom length outside 0:30 to 10:00 (or the type's own range) says so and keeps Start off", async () => {
    const user = userEvent.setup();
    renderApp(<MakeVideoButton target={JOB} typeId="pitch" />);
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    const length = await within(dialog).findByRole("group", { name: "Length" });
    // The pitch runs at most 3 minutes: no In-depth.
    expect(within(length).getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["quick", "standard", "custom"]);
    expect(within(length).getByRole("radio", { name: /Quick/ })).toBeChecked();
    await user.click(within(length).getByRole("radio", { name: /Custom/ }));
    const custom = within(length).getByRole("textbox", { name: "Custom length (minutes:seconds)" });
    await user.clear(custom);
    await user.type(custom, "4:00");
    await user.tab();
    expect(within(length).getByText("Tell me about yourself can run 0:30 to 3:00.")).toBeInTheDocument();
    expect(custom).toHaveAttribute("aria-invalid", "true");
    const start = within(dialog).getByRole("button", { name: "Start" });
    await waitFor(() => expect(start).toBeDisabled());
    expect(start).toHaveAccessibleDescription("Fix the custom length first.");
    await user.clear(custom);
    await user.type(custom, "2:45");
    await waitFor(() => expect(start).toBeEnabled());
  });

  it("makes this week's recap from Home", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<ActionButton action="weekly_recap_video" target={WORKSPACE} />);
    await user.click(await screen.findByRole("button", { name: "Weekly recap" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled());
    // A template video: no note for Claude, and no length choice (the recap is built to its own length).
    expect(within(dialog).queryByRole("textbox", { name: "Note for Claude (optional)" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Length" })).toBeNull();
    // Made from the week's numbers, never a job ad.
    expect(within(dialog).getByText("Your week's numbers")).toBeInTheDocument();
    expect(within(dialog).queryByText("Job ad")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.start")?.args[1]).toEqual({ kind: "week", week: isoWeek(new Date()) }));
  });

  it("asks for a job when the type needs one, and Start says why it is off", async () => {
    const user = userEvent.setup();
    renderApp(<MakeVideoButton target={WORKSPACE} typeId="pitch" />);
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect((await within(dialog).findAllByText("Open a job first, then make this video from there.")).length).toBeGreaterThan(0);
    const start = within(dialog).getByRole("button", { name: "Start" });
    expect(start).toBeDisabled();
    expect(start).toHaveAccessibleDescription("Open a job first, then make this video from there.");
  });

  it("shows missing tools, installs one and enables Start", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge({ videoToolsOk: false });
    renderApp(<MakeVideoButton target={JOB} typeId="jd-walkthrough" />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    const card = await within(dialog).findByRole("region", { name: "Tools for videos" });
    expect(within(card).getByText(`Videos need ffmpeg to join audio and pictures. ${brand.name} can install it for you.`)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Start" })).toBeDisabled();
    await user.click(within(card).getByRole("button", { name: "Install ffmpeg" }));
    await waitFor(() => expect(within(dialog).queryByRole("region", { name: "Tools for videos" })).toBeNull());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled());
    expect(bridge.calls.find((c) => c.method === "video.installTool")?.args).toEqual(["ffmpeg"]);
  });

  it("won't install a tool while a video is being made, and says why", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge({ videoToolsOk: false });
    const running = { runId: "vr-9", folder: JD_FOLDER, type: "jd-walkthrough", phase: "build" as const, status: "running" as const, stages: [], started_at: "", error: "", queued_behind: 0 };
    bridge.video.runs = async () => [running];
    renderApp(<MakeVideoButton target={JOB} typeId="jd-walkthrough" />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const card = await within(await screen.findByRole("dialog", { name: "Make a video" })).findByRole("region", { name: "Tools for videos" });
    await waitFor(() => expect(within(card).getByRole("button", { name: "Install ffmpeg" })).toBeDisabled());
    expect(within(card).getByRole("button", { name: "Install ffmpeg" })).toHaveAccessibleDescription(/A video is being made/);
  });

  it("keeps a company briefing locked until the company is researched, with one click to start that", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<ActionButton action="company_background_video" target={JOB} />);
    await user.click(await screen.findByRole("button", { name: "Company video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect((await within(dialog).findAllByText("Do “Research company” first.")).length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Start" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Research company" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "claude.run")?.args[0]).toBe("research_company"));
    act(() => bridge.simulateActionOutput("research_company", JOB));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled());
  });

  it("says when Claude Code isn't set up, with a link to set it up", async () => {
    const user = userEvent.setup();
    renderApp(<MakeVideoButton target={JOB} typeId="pitch" />, { bridge: new MockBridge({ claudeEngine: { consent: false } }) });
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect(await within(dialog).findByText(/goes to Claude Desktop instead/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Claude setup" }));
    expect(window.location.hash).toBe("#/settings?tab=connections&c=claude");
  });
});

describe("sponsorship wording", () => {
  it("drops sponsorship from type descriptions for people it doesn't apply to", () => {
    expect(withoutSponsorship("What the company does, its products, tech stack, recent news, sponsorship evidence and culture, each fact with its source."))
      .toBe("What the company does, its products, tech stack, recent news and culture, each fact with its source.");
    expect(withoutSponsorship("Your week in numbers: jobs found, applications, replies, interviews, the sponsorship mix and what to do next. Built from your data, no Claude call."))
      .toBe("Your week in numbers: jobs found, applications, replies, interviews and what to do next. Built from your data, no Claude call.");
    expect(withoutSponsorship("Covers visa options. Then the rest.")).toBe("Then the rest.");
  });

  it("the dialog hides sponsorship wording for a citizen", async () => {
    const f = loadFixture();
    (f.profile as { work_rights: { status: string } }).work_rights.status = "citizen";
    const bridge = new MockBridge({ fixture: f });
    const types = bridge.video.types;
    bridge.video.types = async (s) => {
      const r = await types(s);
      return { ...r, types: r.types.map((t) => (t.id === "company-briefing" ? { ...t, description: "Its products, recent news, sponsorship evidence and culture." } : t)) };
    };
    const user = userEvent.setup();
    renderApp(<MakeVideoButton target={JOB} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Make video" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect(await within(dialog).findByText("Its products, recent news and culture.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/sponsor/i)).toBeNull();
  });
});

describe("chat hand-off", () => {
  it("opens the dialog when Claude asks for a video", async () => {
    const bridge = new MockBridge();
    renderApp(<VideoIntentListener />, { bridge, hash: "#/job/acme-corp/2026-01-12-ai-engineer" });
    act(() => bridge.simulateVideoIntent("pitch", "Why I fit Acme Corp"));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect(await within(dialog).findByRole("radio", { name: /Tell me about yourself/ })).toBeChecked();
    expect(within(dialog).getByRole("textbox", { name: "Note for Claude (optional)" })).toHaveValue("Why I fit Acme Corp");
  });

  it("ignores a careeros:open-video window event (no channel any page script can use)", async () => {
    renderApp(<VideoIntentListener />, { hash: "#/learn" });
    act(() => { window.dispatchEvent(new CustomEvent("careeros:open-video", { detail: { type: "skill-gap-lesson", subject: "Kubernetes basics" } })); });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Final review I6: every Make video button in the app goes through openMakeVideo (the Shell's listener), with its
  // own target, so the hand-off path is the one people actually use.
  it("a Make video button opens through the app's listener with the button's own target", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<><VideoIntentListener /><ActionButton action="jd_walkthrough_video" target={JOB} /></>, { hash: "#/learn" });
    await user.click(await screen.findByRole("button", { name: "JD video" }));
    expect(await screen.findAllByRole("dialog", { name: "Make a video" })).toHaveLength(1);
    const dialog = screen.getByRole("dialog", { name: "Make a video" });
    expect(within(dialog).getByRole("radio", { name: /JD walkthrough/ })).toBeChecked();
    expect(within(dialog).getByRole("textbox", { name: "Note for Claude (optional)" })).toHaveValue("");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "video.start")?.args.slice(0, 2)).toEqual(["jd-walkthrough", JOB]));
  });

  it("opens from a services hand-off that carries its target", async () => {
    const bridge = new MockBridge();
    renderApp(<VideoIntentListener />, { bridge, hash: "#/home" });
    act(() => bridge.simulateVideoIntent("company-briefing", "", { kind: "company", company_slug: "acme-corp" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect(await within(dialog).findByRole("radio", { name: /Company briefing/ })).toBeChecked();
    // The company came with the hand-off, so it doesn't ask for a page first; it asks for the research it needs.
    expect(await within(dialog).findByRole("button", { name: "Research company" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Open a job or a company first/)).toBeNull();
  });

  it("opens from an in-app call to openMakeVideo", async () => {
    renderApp(<VideoIntentListener />, { hash: "#/learn" });
    act(() => { expect(openMakeVideo({ type: "skill-gap-lesson", subject: "Kubernetes basics" })).toBe(true); });
    const dialog = await screen.findByRole("dialog", { name: "Make a video" });
    expect(await within(dialog).findByRole("radio", { name: /Skill-gap lesson/ })).toBeChecked();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled());
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/video?folder=${encodeURIComponent("learning/kubernetes-basics/videos/1")}`));
  });
});
