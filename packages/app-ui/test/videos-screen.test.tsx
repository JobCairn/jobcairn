import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { MockBridge } from "../src/mock/MockBridge";
import { parseHash } from "../src/router";
import { VideosScreen } from "../src/screens/Videos";
import { renderApp } from "./render";

describe("Videos screen", () => {
  it("is its own route and sidebar item", async () => {
    expect(parseHash("#/videos")).toEqual({ screen: "videos" });
    window.location.hash = "#/home";
    render(<App bridge={new MockBridge()} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    await userEvent.click(within(nav).getByRole("button", { name: /Videos/ }));
    expect(window.location.hash).toBe("#/videos");
    expect(await screen.findByRole("heading", { name: "Videos" })).toBeInTheDocument();
  });

  it("lists the workspace's videos, or says how to make the first one", async () => {
    const b = new MockBridge();
    renderApp(<VideosScreen />, { bridge: b });
    const head = (await screen.findByRole("heading", { name: "Videos" })).closest("header")!;
    expect(within(head).getByRole("button", { name: "Weekly recap" })).toBeInTheDocument();
    expect(within(head).getByRole("button", { name: "Video settings" })).toBeInTheDocument();
    const data = await b.learn.list();
    if (data.videos.length + data.video_recaps.length) expect(document.querySelector(".video-sections")).not.toBeNull();
    else expect(screen.getByText(/No videos yet/)).toBeInTheDocument();
  });

  it("an empty workspace gets the empty state", async () => {
    const b = new MockBridge();
    const orig = b.learn.list.bind(b.learn);
    b.learn.list = async () => ({ ...(await orig()), videos: [], video_recaps: [] });
    renderApp(<VideosScreen />, { bridge: b });
    expect(await screen.findByText(/No videos yet\. Make one from a job's page, a Learn topic, or start with this week's recap\./)).toBeInTheDocument();
  });
});
