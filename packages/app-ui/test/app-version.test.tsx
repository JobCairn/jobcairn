import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RELEASES_URL } from "@careeros/contract";
import { AppVersion } from "../src/components/AppVersion";
import { MockBridge } from "../src/mock/MockBridge";
import { renderApp } from "./render";

const openAbout = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: /JobCairn version 0\.1\.0/ }));
  return screen.findByRole("dialog", { name: "About JobCairn" });
};

describe("AppVersion and About: in-app updates", () => {
  it("checks on request and says when this is the newest version; the automatic setting is saved", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<AppVersion />);
    const about = await openAbout(user);
    expect(within(about).getByText("JobCairn version 0.1.0")).toBeInTheDocument();
    expect(within(about).getByText("Checks for updates automatically.")).toBeInTheDocument();
    expect(within(about).queryByText(/What's new will show here/)).toBeNull();
    await user.click(within(about).getByRole("button", { name: "Check for updates" }));
    expect(await within(about).findByText("You have the newest version.")).toBeInTheDocument();
    const auto = within(about).getByRole("checkbox", { name: "Check for updates automatically" });
    expect(auto).toBeChecked();
    await user.click(auto);
    expect(bridge.calls.find((c) => c.method === "app.updates.setAuto")?.args).toEqual([false]);
    expect(await within(about).findByRole("checkbox", { name: "Check for updates automatically" })).not.toBeChecked();
  });

  it("shows download progress as it moves", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<AppVersion />);
    const about = await openAbout(user);
    act(() => bridge.setUpdateStatus({ kind: "downloading", version: "0.2.0", percent: 42 }));
    expect(await within(about).findByText("Downloading version 0.2.0… 42%")).toBeInTheDocument();
    expect(within(about).getByRole("progressbar", { name: "Update download progress" })).toHaveAttribute("value", "42");
    expect(within(about).getByRole("button", { name: "Check for updates" })).toBeDisabled();
  });

  it("marks the version once an update is ready, shows what's new and restarts to update", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge();
    bridge.setUpdateStatus({ kind: "ready", version: "0.2.0", notes: "### Better\n\n- Faster job search" });
    renderApp(<AppVersion />, { bridge });
    const version = await screen.findByRole("button", { name: /Update ready: version 0\.2\.0/ });
    expect(version).toHaveClass("has-update");
    await user.click(version);
    const about = await screen.findByRole("dialog", { name: "About JobCairn" });
    expect(within(about).getByText(/Version 0\.2\.0 is ready\. Restart JobCairn to finish updating/)).toBeInTheDocument();
    expect(within(about).getByText("What's new in 0.2.0")).toBeInTheDocument();
    expect(within(about).getByText("Faster job search")).toBeInTheDocument();
    expect(within(about).queryByRole("button", { name: "Check for updates" })).toBeNull();
    await user.click(within(about).getByRole("button", { name: "Restart to update" }));
    expect(bridge.calls.some((c) => c.method === "app.updates.install")).toBe(true);
  });

  it("on an error, says what went wrong in plain words and links to the download page", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge();
    bridge.setUpdateStatus({ kind: "error", message: "Couldn't reach GitHub to check for updates. Check your internet connection and try again." });
    renderApp(<AppVersion />, { bridge });
    const about = await openAbout(user);
    expect(within(about).getByText(/Couldn't reach GitHub/)).toBeInTheDocument();
    expect(within(about).getByRole("link", { name: /Download from GitHub/ })).toHaveAttribute("href", RELEASES_URL);
    expect(within(about).getByRole("button", { name: "Check for updates" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /JobCairn version 0\.1\.0/ })).not.toHaveClass("has-update");
  });

  it("in a copy that can't update itself, offers only the download page", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge();
    bridge.updatesSupported = false;
    renderApp(<AppVersion />, { bridge });
    const about = await openAbout(user);
    expect(within(about).getByText(/This copy can't update itself/)).toBeInTheDocument();
    expect(within(about).getByRole("link", { name: /Download from GitHub/ })).toBeInTheDocument();
    expect(within(about).queryByRole("button", { name: "Check for updates" })).toBeNull();
    expect(within(about).queryByRole("checkbox")).toBeNull();
  });
});
