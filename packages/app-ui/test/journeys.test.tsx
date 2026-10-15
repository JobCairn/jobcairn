import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { GUIDE_MEDIA_NAME, TOUR_IDS } from "@careeros/contract";
import { JourneyVideos } from "../src/tour/JourneyVideos";
import { guideUrl, journeyForTour, JOURNEYS, setVideoProbe } from "../src/tour/journeys";
import { renderApp } from "./render";

afterEach(() => setVideoProbe(null));

describe("guide video manifest", () => {
  it("has one entry per journey with bundled, safe file names", () => {
    expect(JOURNEYS.map((j) => j.id)).toEqual(["find-and-score", "tailor-and-apply", "interview-prep", "track-everything"]);
    expect(new Set(JOURNEYS.map((j) => j.id)).size).toBe(JOURNEYS.length);
    for (const j of JOURNEYS) {
      expect(j.title.length).toBeGreaterThan(0);
      expect(j.description.split(/(?<=[.!?])\s+/)).toHaveLength(1);
      expect(j.length).toBe(`${j.minutes} min`);
      for (const [file, ext] of [[j.poster, /\.webp$/], [j.video, /\.mp4$/], [j.captions, /\.vtt$/]] as const) {
        expect(file).toMatch(GUIDE_MEDIA_NAME);
        expect(file).toMatch(ext);
        expect(file.startsWith(j.id)).toBe(true);
      }
      expect(guideUrl(j.video)).toBe(`careeros-file://guides/${j.video}`);
      expect(`${j.title} ${j.description}`).not.toMatch(/\b(sample|demo|fixture|workspace)\b/i);
    }
    expect(() => guideUrl("../secret.mp4")).toThrow();
    expect(() => guideUrl("file:///x.mp4")).toThrow();
  });

  it("each journey belongs to real tours, and the main screens each have one", () => {
    for (const j of JOURNEYS) for (const t of j.tours) expect(TOUR_IDS).toContain(t);
    for (const t of ["home", "jobs", "job", "apply", "resume", "learn", "inbox"] as const) expect(journeyForTour(t)).not.toBeNull();
    expect(journeyForTour("settings")).toBeNull();
  });
});

describe("JourneyVideos", () => {
  it("without the files yet: calm posters that say the video is coming soon, and nothing to click", async () => {
    setVideoProbe(async () => false);
    renderApp(<JourneyVideos variant="welcome" />);
    expect(screen.getByRole("heading", { name: "See how it works" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("Video coming soon")).toHaveLength(4));
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("plays in an in-app player with captions; Esc closes it and focus goes back", async () => {
    setVideoProbe(async () => true);
    renderApp(<JourneyVideos variant="welcome" />);
    const card = await screen.findByRole("button", { name: "Watch: Prepare for an interview, 1 min" });
    await userEvent.click(card);
    const player = await screen.findByRole("dialog", { name: "Prepare for an interview" });
    const video = player.querySelector("video")!;
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("src", "careeros-file://guides/interview-prep.mp4");
    const track = video.querySelector("track")!;
    expect(track).toHaveAttribute("src", "careeros-file://guides/interview-prep.vtt");
    expect(track).toHaveAttribute("default");
    expect(within(player).getByRole("button", { name: "Close" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(card).toHaveFocus();
  });

  it("a video that can't play shows a note, never a broken player", async () => {
    setVideoProbe(async () => true);
    renderApp(<JourneyVideos variant="settings" />);
    await userEvent.click(await screen.findByRole("button", { name: "Watch: Find and score jobs, 1 min" }));
    const player = await screen.findByRole("dialog", { name: "Find and score jobs" });
    player.querySelector("video")!.dispatchEvent(new Event("error"));
    expect(await within(player).findByText(/This video is coming soon/)).toBeInTheDocument();
    expect(player.querySelector("video")).toBeNull();
    await userEvent.click(within(player).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Settings lists every journey with its description", async () => {
    setVideoProbe(async () => false);
    renderApp(<JourneyVideos variant="settings" />);
    for (const j of JOURNEYS) {
      expect(screen.getByText(j.title)).toBeInTheDocument();
      expect(screen.getByText(j.description)).toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getAllByText("Coming soon")).toHaveLength(4));
  });
});
