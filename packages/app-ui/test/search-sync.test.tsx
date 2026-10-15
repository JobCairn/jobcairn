import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RequestComposer } from "../src/composer";
import { SearchSettings } from "../src/settings/SearchSettings";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 20_000 });
const WORKSPACE = { kind: "workspace" } as const;
const chip = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}: .*Change$`) });
function sponsorBridge(): MockBridge {
  const f = loadFixture();
  (f.profile as { work_rights: { status: string } }).work_rights.status = "needs_sponsorship";
  return new MockBridge({ fixture: f });
}
const both = (b: MockBridge) => renderApp(
  <>
    <RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />
    <SearchSettings />
  </>,
  { bridge: b },
);

describe("Find jobs chips and Settings › Search are one set of filters", () => {
  it("a change in the dialog shows in Settings at once, and after reopening", async () => {
    const b = sponsorBridge();
    const { unmount } = both(b);
    await screen.findByRole("region", { name: "What you're looking for" });
    const words = await screen.findByRole("group", { name: "Skip ads that mention" });
    await userEvent.click(chip("Skip"));
    const panel = await screen.findByRole("dialog", { name: "Skip" });
    // The panel puts focus on its first box on the next frame; wait for it before typing in the second.
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    await userEvent.type(within(panel).getByRole("textbox", { name: "Add word" }), "clearance{Enter}");
    await userEvent.keyboard("{Escape}");
    await waitFor(async () => expect(((await b.settings.get("search")).values.filters as Record<string, unknown>).exclude_keywords).toEqual(["clearance"]));
    await waitFor(() => expect(within(words).getByText("clearance")).toBeInTheDocument());
    await userEvent.click(chip("Sponsorship"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Sponsorship" })).getByRole("checkbox", { name: "Only ads that offer sponsorship" }));
    await userEvent.keyboard("{Escape}");
    const settings = document.querySelector<HTMLElement>(".settings-search")!;
    await waitFor(() => expect(within(settings).getByRole("checkbox", { name: "Only ads that offer sponsorship" })).toBeChecked());
    unmount();
    renderApp(<SearchSettings />, { bridge: b });
    expect(within(await screen.findByRole("group", { name: "Skip ads that mention" })).getByText("clearance")).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: "Only ads that offer sponsorship" })).toBeChecked();
  });

  it("a change in Settings shows on the dialog's chips", async () => {
    const b = new MockBridge();
    both(b);
    await screen.findByRole("region", { name: "What you're looking for" });
    expect(chip("Breadth")).toHaveAccessibleName("Breadth: Focused. Change");
    await userEvent.click(within(await screen.findByRole("group", { name: "Search breadth" })).getByRole("radio", { name: /^Broad/ }));
    await waitFor(() => expect(chip("Breadth")).toHaveAccessibleName("Breadth: Broad. Change"));
    const roles = await screen.findByRole("group", { name: "Target roles" });
    await userEvent.type(within(roles).getByRole("textbox"), "Data Engineer{Enter}");
    await waitFor(() => expect(chip("Roles")).toHaveAccessibleName("Roles: AI Engineer +2. Change"));
    expect(chip("Skip")).toHaveAccessibleName("Skip: Big tech. Change");
    await userEvent.click(screen.getByRole("checkbox", { name: "Skip big tech" }));
    await waitFor(() => expect(chip("Skip")).toHaveAccessibleName("Skip: any. Change"));
  });

  it("Settings › Search shows every chip's filter; sponsorship only for someone who needs it", async () => {
    const citizen = new MockBridge();
    await citizen.settings.save("profile", [{ path: "work_rights.status", value: "citizen" }]);
    const { unmount } = renderApp(<SearchSettings />, { bridge: citizen });
    for (const name of ["Roles", "Where and how you work", "Pay, job type and age", "What to skip", "How Claude searches", "Your search plan"]) {
      expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
    }
    expect(await screen.findByRole("group", { name: "Target roles" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Preferred locations" })).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum salary")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Job types" })).toBeInTheDocument();
    expect(screen.getByLabelText("Only ads posted in the last (days)")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Companies to skip" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Search breadth" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Only ads that offer sponsorship" })).toBeNull();
    unmount();
    renderApp(<SearchSettings />, { bridge: sponsorBridge() });
    expect(await screen.findByRole("heading", { name: "Sponsorship and what to skip" })).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: "Only ads that offer sponsorship" })).not.toBeChecked();
  });
});
