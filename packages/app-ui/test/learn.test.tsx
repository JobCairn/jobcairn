import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { displayName } from "../src/components/displayName";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { LearnScreen } from "../src/screens/Learn";
import { PlayerProvider, type AudioLike } from "../src/listen";
import { renderApp } from "./render";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const empty = () => {
  const f = loadFixture();
  f.learning.topics = [];
  f.jobs.forEach((j) => { j.interview = []; });
  return f;
};
const openCard = async (name: string) => userEvent.click(await screen.findByRole("button", { name }));

describe("Learn: rendering states", () => {
  it("empty: a clear next step and the getting started checklist, not a dead end", async () => {
    const f = empty();
    f.jobs = [];
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByText("Nothing to study yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New topic" }).length).toBeGreaterThan(1);
    expect(await screen.findByText("Your first week, step by step")).toBeInTheDocument();
    expect(screen.queryByText(/Weekly recaps arrive/)).toBeNull();
  });

  it("with suggestions: skills the saved jobs ask for, with how many jobs", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ learnDemo: true }) });
    const region = await screen.findByRole("region", { name: "Suggested topics" });
    expect(within(region).getByRole("button", { name: /^Kubernetes, in 2 of 2 jobs \(100%\)\. Open guide$/ })).toBeInTheDocument();
    // "of 2": the sample's citizens-only ad isn't an active job, so it isn't counted.
    // Skills on the profile or resume are not suggested.
    expect(within(region).queryByText("TypeScript")).toBeNull();
    expect(within(region).queryByText("Python")).toBeNull();
  });

  it("with history: finished items listed with the date they were finished", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ learnDemo: true }) });
    const history = await screen.findByRole("region", { name: "History" });
    expect(within(history).getByRole("button", { name: "RAG pipelines" })).toBeInTheDocument();
    expect(within(history).getByText("11 Jan 2026")).toBeInTheDocument();
  });

  it("shows every item as a card with its type, source job and progress", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />);
    const card = (await screen.findByRole("button", { name: "Interview prep: Acme Corp" })).closest("article")!;
    expect(within(card).getByText("Interview prep", { selector: ".learn-card__type" })).toBeInTheDocument();
    expect(within(card).getByText(/For AI Engineer at Acme Corp/)).toBeInTheDocument();
    expect(within(card).getByText("Not started")).toBeInTheDocument();
  });

  it("filters by type and searches", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />);
    await screen.findByRole("button", { name: "RAG pipelines" });
    await userEvent.click(screen.getByRole("button", { name: "Interview prep 1" }));
    expect(screen.queryByRole("button", { name: "RAG pipelines" })).toBeNull();
    expect(screen.getByRole("button", { name: "Interview prep: Acme Corp" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^All \d/ }));
    await userEvent.type(screen.getByLabelText("Search your topics"), "rag");
    expect(screen.getByRole("button", { name: "RAG pipelines" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Interview prep: Acme Corp" })).toBeNull();
  });
});

describe("Learn: start a topic and score jobs", () => {
  it("opens the dialog from the address bar and offers suggestions to pick", async () => {
    const { bridge } = renderApp(<LearnScreen route={{ screen: "learn", start: true }} />, { bridge: new MockBridge({ learnDemo: true }) });
    const dialog = await screen.findByRole("dialog", { name: "Start a topic" });
    await userEvent.click(within(dialog).getByRole("button", { name: "AWS" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Ask Claude" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "claude.run")?.args).toEqual(["study_topic", { kind: "topic", topic: "aws", label: "AWS" }, {}]));
    expect(await screen.findByRole("region", { name: "Study guides Claude is writing" })).toBeInTheDocument();
  });

  it("when Claude isn't set up, the dialog says how instead of starting a run", async () => {
    const { bridge } = renderApp(<LearnScreen route={{ screen: "learn", start: true }} />, { bridge: new MockBridge({ claudeEngine: { cli: "missing" } }) });
    const dialog = await screen.findByRole("dialog", { name: "Start a topic" });
    await userEvent.type(within(dialog).getByLabelText("What do you want to learn?"), "Kafka");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ask Claude" }));
    expect(await within(dialog).findByRole("button", { name: /^copy prompt/i })).toBeInTheDocument();
    expect(bridge.calls.some((c) => c.method === "claude.run")).toBe(false);
  });

  it("refuses an empty topic with a readable message", async () => {
    const { bridge } = renderApp(<LearnScreen route={{ screen: "learn" }} />);
    await userEvent.click((await screen.findAllByRole("button", { name: "New topic" }))[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Ask Claude" }));
    expect(screen.getByText("Type a topic, or pick one below.")).toBeInTheDocument();
    expect(bridge.calls.some((c) => c.method === "claude.run")).toBe(false);
  });

  it("lists jobs not scored yet, and Score this job asks Claude to score it", async () => {
    const { bridge } = renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ learnDemo: true }) });
    await userEvent.click(await screen.findByRole("tab", { name: /^Not scored yet/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Score AI Developer at Acme Recruiting" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "claude.run")?.args?.slice(0, 2)).toEqual(["score_job", { kind: "job", company_slug: "acme-recruiting", id: "2026-01-12-ai-developer" }]));
    // A one-line chip takes the button's place; no run panel opens inline.
    expect(await screen.findByRole("button", { name: /^Score this job: Scoring/ })).toBeInTheDocument();
    expect(document.querySelector(".job-learn .crun")).toBeNull();
  });

  it("keeps a job scored here in place, turned into its result with a link to the score", async () => {
    const b = new MockBridge({ learnDemo: true });
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: b });
    await userEvent.click(await screen.findByRole("tab", { name: /^Not scored yet/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Score AI Developer at Acme Recruiting" }));
    await screen.findByRole("button", { name: /^Score this job: Scoring/ });
    act(() => b.claudeSim.finish(b.claudeSim.runs[0]!.id));
    // The row is now a scored row (it shows its fit), and the whole row opens the job on its Score tab.
    const view = () => screen.getByRole("button", { name: "AI Developer Acme Recruiting" });
    await waitFor(() => expect(view().closest("li")).toHaveAttribute("data-fresh", "true"));
    await userEvent.click(view());
    expect(window.location.hash).toBe("#/job/acme-recruiting/2026-01-12-ai-developer?tab=score");
  });

  it("lists scored jobs with their gaps; a gap starts a topic", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ learnDemo: true }) });
    await userEvent.click(await screen.findByRole("button", { name: "Start a topic on Kafka" }));
    expect(await screen.findByLabelText("What do you want to learn?")).toHaveValue("Kafka");
  });

  it("a job row opens the job; its Score button scores it and stays on Learn", async () => {
    const { bridge } = renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ learnDemo: true }) });
    window.location.hash = "#/learn";
    await userEvent.click(await screen.findByRole("tab", { name: /^Not scored yet/ }));
    const score = await screen.findByRole("button", { name: "Score AI Developer at Acme Recruiting" });
    expect(score).toHaveClass("cell-action");
    expect(score).toHaveTextContent(/^Score$/);
    // The Score button and the row share one line: the button is in the row, not under it.
    const row = score.closest("li")!;
    await userEvent.click(score);
    await waitFor(() => expect(bridge.calls.some((c) => c.method === "claude.run" && c.args?.[0] === "score_job")).toBe(true));
    expect(window.location.hash).toBe("#/learn");
    await userEvent.click(within(row).getByRole("button", { name: "AI Developer Acme Recruiting" }));
    expect(window.location.hash).toBe("#/job/acme-recruiting/2026-01-12-ai-developer");
  });

  it("Score all asks Claude to score every listed job through the queue, and each row follows its own run", async () => {
    const { bridge } = renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ learnDemo: true }) });
    await userEvent.click(await screen.findByRole("tab", { name: /^Not scored yet/ }));
    const panel = screen.getByRole("region", { name: "From your jobs" });
    const rows = within(panel).getAllByRole("button", { name: /^Score .+ at / });
    const all = within(panel).getByRole("button", { name: /^Score all \d+ jobs not scored yet$/ });
    const n = Number(/\d+/.exec(all.textContent ?? "")![0]);
    expect(all).toHaveTextContent(`Score all ${n}`);
    expect(n).toBeGreaterThan(1);
    expect(rows.length).toBe(Math.min(n, 5));
    await userEvent.click(all);
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "claude.run" && c.args?.[0] === "score_job")).toHaveLength(n));
    // Each row's button turns into its run's chip.
    await waitFor(() => expect(within(panel).queryAllByRole("button", { name: /^Score .+ at / })).toHaveLength(0));
    expect(within(panel).getAllByRole("button", { name: /^Score this job: / }).length).toBeGreaterThan(0);
  });

  it("says Score these N, with a way to Jobs, when more jobs have no score than are listed", async () => {
    const f = loadFixture();
    const base = f.jobs[0]!;
    for (let i = 0; i < 10; i++) f.jobs.push({ ...structuredClone(base), job: { ...structuredClone(base.job), id: `2026-01-0${i % 9}-extra-${i}`, title: `Extra role ${i}` } });
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ fixture: f }) });
    await userEvent.click(await screen.findByRole("tab", { name: /^Not scored yet/ }));
    expect(screen.getByRole("button", { name: "Score these 8 jobs not scored yet" })).toHaveTextContent("Score these 8");
    await userEvent.click(screen.getByRole("button", { name: /^All \d+ jobs$/ }));
    expect(window.location.hash).toBe("#/jobs");
  });

  it("a scored job shows its fit as the Jobs ring and its top gaps", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ learnDemo: true }) });
    const open = await screen.findByRole("button", { name: "Backend Engineer (LLM) Example Labs" });
    const row = open.closest("li")!;
    await waitFor(() => expect(row.querySelector(".score-meter")).not.toBeNull());
    expect(within(row).getByText("72")).toBeInTheDocument();
    expect(within(row).getByText("Gaps:")).toBeInTheDocument();
    await userEvent.click(open);
    expect(window.location.hash).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm?tab=score");
  });

  it("a missing topic from a Gaps link offers to start it", async () => {
    renderApp(<LearnScreen route={{ screen: "learn", topic: "kubernetes" }} />);
    expect(await screen.findByText("No study guide for kubernetes yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start topic" }));
    expect(await screen.findByLabelText("What do you want to learn?")).toHaveValue("kubernetes");
  });
});

describe("Learn: balance and next steps", () => {
  it("skill cards say how many jobs ask, the share, and Make a guide (which opens the dialog with that skill)", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ learnDemo: true }) });
    const region = await screen.findByRole("region", { name: "Suggested topics" });
    const aws = within(region).getByRole("button", { name: /^AWS, in \d+ of \d+ jobs \(\d+%\)\. Make guide$/ });
    expect(within(aws).getByText("Make guide")).toBeInTheDocument();
    await userEvent.click(aws);
    expect(await screen.findByLabelText("What do you want to learn?")).toHaveValue("AWS");
  });

  it("hides type filters with nothing in them", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />);
    await screen.findByRole("button", { name: "RAG pipelines" });
    const filter = screen.getByRole("group", { name: "Show" });
    expect(within(filter).queryByRole("button", { name: /^Videos/ })).toBeNull();
    expect(within(filter).getByRole("button", { name: /^Guides 1/ })).toBeInTheDocument();
  });

  it("with one topic, the list ends with what to study next: a guide or a video", async () => {
    const f = loadFixture();
    f.learning.topics = [];
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ fixture: f, learnDemo: false }) });
    await screen.findByRole("button", { name: "Interview prep: Acme Corp" });
    const next = await screen.findByRole("region", { name: "Study next" });
    const guide = within(next).getAllByRole("button", { name: /^Make guide: / })[0]!;
    expect(within(next).getAllByRole("button", { name: /^Make video: / }).length).toBeGreaterThan(0);
    const skill = guide.getAttribute("aria-label")!.replace("Make guide: ", "");
    await userEvent.click(guide);
    expect(await screen.findByLabelText("What do you want to learn?")).toHaveValue(skill);
  });

  it("empty: suggests topics from the saved jobs with Make a guide and Make a video", async () => {
    const f = empty();
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ fixture: f }) });
    const next = await screen.findByRole("region", { name: "Study next" });
    expect(within(next).getAllByRole("button", { name: /^Make guide: / }).length).toBeGreaterThan(0);
    await userEvent.click(within(next).getAllByRole("button", { name: /^Make video: / })[0]!);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("with many topics, no study-next block (the page is full)", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ learnDemo: true }) });
    await screen.findAllByRole("button", { name: "RAG pipelines" });
    expect(screen.queryByRole("region", { name: "Study next" })).toBeNull();
  });
});

describe("Learn: reader and progress", () => {
  it("opens a topic from the route and shows the guide", async () => {
    renderApp(<LearnScreen route={{ screen: "learn", topic: "rag-pipelines" }} />);
    expect(await screen.findByText("Chunk the documents")).toBeInTheDocument();
    expect(document.querySelector("[data-slot='listen']")).not.toBeNull();
  });

  it("a guide in the reader has a Listen button (read aloud)", async () => {
    renderApp(<PlayerProvider createAudio={() => ({ play: async () => {}, pause: () => {}, src: "", currentTime: 0, duration: 0, playbackRate: 1, onended: null, onerror: null, ontimeupdate: null } as unknown as AudioLike)}><LearnScreen route={{ screen: "learn", topic: "rag-pipelines" }} /></PlayerProvider>);
    expect(await screen.findByText("Chunk the documents")).toBeInTheDocument();
    expect(within(document.querySelector<HTMLElement>("[data-slot='listen']")!).getByRole("button", { name: /listen/i })).toBeInTheDocument();
  });

  it("opening marks an item in progress, and the checkbox marks it done", async () => {
    const b = new MockBridge();
    const progress = async () => (await b.learn.hub()).entries.find((e) => e.path === "learning/rag-pipelines/guide.md")?.progress;
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: b });
    await openCard("RAG pipelines");
    expect(await screen.findByText("Chunk the documents")).toBeInTheDocument();
    await waitFor(async () => expect(await progress()).toBe("in_progress"));
    await userEvent.click(screen.getByLabelText("I've finished this"));
    await waitFor(async () => expect(await progress()).toBe("done"));
    await userEvent.click(screen.getByRole("button", { name: "All topics" }));
    const history = await screen.findByRole("region", { name: "History" });
    expect(within(history).getByRole("button", { name: "RAG pipelines" })).toBeInTheDocument();
  });

  it("never shows the previous item's text while the next guide is still loading", async () => {
    const f = loadFixture();
    f.learning.topics[0]!.items.push({ path: "learning/rag-pipelines/guide-2.md", title: "Guide 2", kind: "guide" });
    const b = new MockBridge({ fixture: f });
    const readText = b.files.readText;
    let resolveSecond!: (v: string) => void;
    b.files.readText = async (rel: string) => {
      if (rel.endsWith("guide-2.md")) return new Promise<string>((resolve) => { resolveSecond = resolve; });
      return readText(rel);
    };
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: b });
    await openCard("RAG pipelines");
    expect(await screen.findByText("Chunk the documents")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All topics" }));
    await openCard("Guide 2");
    expect(screen.queryByText("Chunk the documents")).toBeNull();
    resolveSecond("Second guide body text.");
    expect(await screen.findByText("Second guide body text.")).toBeInTheDocument();
  });

  it("shows the error, not stale text, when a guide fails to load", async () => {
    const b = new MockBridge();
    b.files.readText = async () => { throw new Error("guide is locked"); };
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: b });
    await openCard("RAG pipelines");
    expect(await screen.findByText("guide is locked")).toBeInTheDocument();
  });

  it("plays videos through the careeros-file scheme, never autoplaying", async () => {
    const f = loadFixture();
    f.learning.topics[0]!.items.push({ path: "learning/rag-pipelines/demo clip.mp4", title: "demo clip.mp4", kind: "video" });
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ fixture: f }) });
    await openCard("demo clip.mp4");
    const video = document.querySelector("video")!;
    expect(video).toHaveAttribute("src", "careeros-file://ws/learning/rag-pipelines/demo%20clip.mp4");
    expect(video).toHaveAttribute("controls");
    expect(video).not.toHaveAttribute("autoplay");
    fireEvent.error(video);
    expect(await screen.findByText(/demo clip\.mp4.*didn't load/)).toBeInTheDocument();
  });
});

describe("Learn: errors and untrusted text", () => {
  it("shows an error when Learn can't be loaded at all", async () => {
    const b = new MockBridge();
    b.learn.hub = async () => { throw new Error("workspace unreadable"); };
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: b });
    expect(await screen.findByText("Learn can't be shown")).toBeInTheDocument();
    expect(screen.getByText("Workspace unreadable")).toBeInTheDocument();
  });

  it("keeps the last-known list but shows a banner when a reload fails", async () => {
    const b = new MockBridge();
    const hub = b.learn.hub;
    let calls = 0;
    b.learn.hub = async () => { calls += 1; if (calls > 1) throw new Error("learning folder vanished"); return hub(); };
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: b });
    expect(await screen.findByRole("button", { name: "RAG pipelines" })).toBeInTheDocument();
    b.emitExternalChange("learn");
    expect(await screen.findByText("Learning folder vanished")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "RAG pipelines" })).toBeInTheDocument();
  });

  it("renders an untrusted title as plain text with a tooltip", async () => {
    const f = loadFixture();
    const name = "RAG‮gnilif‬ pipelines";
    f.learning.topics[0]!.items[0]!.title = name;
    renderApp(<LearnScreen route={{ screen: "learn" }} />, { bridge: new MockBridge({ fixture: f }) });
    const label = await screen.findByRole("button", { name: displayName(name) });
    expect(label).toHaveAttribute("title", displayName(name));
  });
});

describe("Learn: one job's interview prep", () => {
  const ACME = "acme-corp/2026-01-12-ai-engineer";
  const LABS = "example-labs/2026-01-12-backend-engineer-llm";

  it("opens filtered to that job's prep, with a way back to everything", async () => {
    renderApp(<LearnScreen route={{ screen: "learn", job: ACME }} />);
    const section = await screen.findByRole("region", { name: "Interview prep for AI Engineer at Acme Corp" });
    expect(within(section).getByRole("button", { name: "Interview prep: Acme Corp" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "RAG pipelines" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "All topics" }));
    expect(window.location.hash).toBe("#/learn");
  });

  it("offers to start interview prep when the job has none", async () => {
    const { bridge } = renderApp(<LearnScreen route={{ screen: "learn", job: LABS }} />);
    expect(await screen.findByText("No interview prep for Backend Engineer (LLM) at Example Labs yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Interview prep" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "claude.run")?.args.slice(0, 2))
      .toEqual(["interview_prep", { kind: "job", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" }]));
  });

  it("says so plainly when the job isn't in the workspace", async () => {
    renderApp(<LearnScreen route={{ screen: "learn", job: "acme-corp/2026-01-01-gone" }} />);
    expect(await screen.findByText(`That job isn't in your ${brand.name} folder any more`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All topics" })).toBeInTheDocument();
  });
});

describe("Learn: videos", () => {
  it("offers this week's recap at the top and a video on the topic in the reader, with no coming-soon note", async () => {
    renderApp(<LearnScreen route={{ screen: "learn" }} />);
    expect(await screen.findByRole("button", { name: "Weekly recap" })).toBeEnabled();
    expect(screen.queryByText(/coming soon/)).toBeNull();
    await openCard("RAG pipelines");
    expect(await screen.findByRole("button", { name: "Make video: RAG pipelines" })).toBeEnabled();
  });
});

describe("Learn: the reader's video button", () => {
  it("sits in the top row next to Listen, not below the guide", async () => {
    renderApp(<LearnScreen route={{ screen: "learn", topic: "rag-pipelines" }} />);
    const make = await screen.findByRole("button", { name: "Make video: RAG pipelines" });
    const bar = make.closest(".reader__bar");
    expect(bar).not.toBeNull();
    expect((bar as HTMLElement).querySelector("[data-slot=listen]")).not.toBeNull();
    // Only one Make video button for the topic: the old one under the card is gone.
    expect(screen.getAllByRole("button", { name: "Make video: RAG pipelines" })).toHaveLength(1);
    expect(make.compareDocumentPosition(screen.getByRole("checkbox", { name: "I've finished this" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the topic's video when one is made, and still offers a new one", async () => {
    const b = new MockBridge();
    const { folder } = await b.video.start("skill-gap-lesson", { kind: "topic", topic: "RAG pipelines" }, {});
    await b.video.render(folder, "final");
    renderApp(<LearnScreen route={{ screen: "learn", topic: "rag-pipelines" }} />, { bridge: b });
    const watch = await screen.findByRole("button", { name: "Watch video: RAG pipelines" });
    expect(watch.closest(".reader__bar")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Make video: RAG pipelines" })).toHaveTextContent("New video");
    await userEvent.click(watch);
    await waitFor(() => expect(window.location.hash).toContain("video"));
  });
});
