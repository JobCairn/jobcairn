import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";
import { VideoScreen } from "../src/screens/Video";
import { partsLine, TimeTaken, timeTakenLine } from "../src/video/TimeTaken";
import { renderApp } from "./render";

const JOB = { kind: "job" as const, company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const FOLDER = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1";
const T = {
  total_ms: 515_000,
  slowest: [
    { stage: "write" as const, label: "Writing the script", ms: 179_600, parts: [] },
    { stage: "final" as const, label: "Final render", ms: 159_600, parts: [{ name: "Contact sheet", ms: 2_900 }, { name: "Render", ms: 151_200 }] },
  ],
};

describe("time taken", () => {
  it("says the total and lists the slowest steps with their parts, slowest part first", () => {
    expect(timeTakenLine(T)).toBe("Time taken: 8:35");
    expect(timeTakenLine({ total_ms: null, slowest: T.slowest })).toBe("Where the time went");
    expect(timeTakenLine({ total_ms: 1000, slowest: [] })).toBeNull();
    expect(timeTakenLine(undefined)).toBeNull();
    expect(partsLine(T.slowest[1]!.parts)).toBe("Render 2:31 · Contact sheet 0:03");
    expect(partsLine([])).toBe("");
  });

  it("folds away under its summary and shows each step's time", async () => {
    render(<TimeTaken timings={T} />);
    const box = screen.getByTestId("video-time");
    expect(box.tagName).toBe("DETAILS");
    await userEvent.click(within(box).getByText("Time taken: 8:35"));
    const rows = within(screen.getByRole("list", { name: "Slowest steps" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["Writing the script3:00", "Final renderRender 2:31 · Contact sheet 0:032:40"]);
  });

  it("shows nothing without timings (an old video)", () => {
    const { container } = render(<TimeTaken timings={null} />);
    expect(container.textContent).toBe("");
  });

  it("is on the video page once there is a render, and in a stopped video's details", async () => {
    const bridge = new MockBridge();
    await bridge.video.start("jd-walkthrough", JOB, {});
    await bridge.video.approveScript(FOLDER);
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    expect(await screen.findByText("Time taken: 8:35")).toBeInTheDocument();
  });

  it("a stopped video lists the slowest steps under Show details", async () => {
    const bridge = new MockBridge();
    await bridge.video.start("jd-walkthrough", JOB, {});
    bridge.simulateStoppedVideo(FOLDER);
    renderApp(<VideoScreen route={{ screen: "video", folder: FOLDER }} />, { bridge });
    const card = await screen.findByTestId("video-stopped");
    expect(within(card).getByText("Time taken: 5:12")).toBeInTheDocument();
    expect(within(card).getByRole("list", { name: "Slowest steps" })).toBeInTheDocument();
  });
});

describe("a step with one part", () => {
  it("shows the part's name without repeating the time", () => {
    expect(partsLine([{ name: "Narrated 14 paragraphs, while the script was checked", ms: 118_400 }])).toBe("Narrated 14 paragraphs, while the script was checked");
  });
});
