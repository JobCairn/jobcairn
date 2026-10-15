import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RequestComposer } from "../src/composer";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 15_000 });
const WORKSPACE = { kind: "workspace" } as const;
const empty = async (b: MockBridge, city = "Sampletown NSW") => {
  await b.settings.save("profile", [{ path: "targets.roles", value: [] }, { path: "contact.city", value: city }]);
  (b as unknown as { f: { profile: Record<string, unknown> } }).f.profile.locations = [];
};
const chip = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}: .*Change$`) });
const places = async (b: MockBridge) => ((await b.settings.get("profile")).values.locations as { place: string }[]).map((p) => p.place);
const runs = (b: MockBridge) => b.calls.filter((c) => c.method === "claude.run").map((c) => c.args[2] as Record<string, unknown>);
function sponsorBridge(): MockBridge {
  const f = loadFixture();
  (f.profile as { work_rights: { status: string } }).work_rights.status = "needs_sponsorship";
  return new MockBridge({ fixture: f });
}

describe("Find jobs › What you're looking for", () => {
  it("shows the search as chips, prefilled from Settings: roles, places in order, pay", async () => {
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: new MockBridge() });
    await screen.findByRole("region", { name: "What you're looking for" });
    expect(chip("Roles")).toHaveAccessibleName("Roles: AI Engineer, Software Engineer (LLM). Change");
    expect(chip("Where")).toHaveAccessibleName("Where: Sampletown NSW, Remote Australia. Change");
    expect(chip("Pay")).toHaveAccessibleName("Pay: $100k+. Change");
    expect(screen.getByText(/Claude searches Sampletown NSW, then Remote Australia first, and skips jobs outside Australia/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Find jobs" })).toBeEnabled());
    // The gear-menu links are gone: one Search settings link, the filters are right here.
    expect(screen.getByRole("button", { name: "Search settings" })).toBeInTheDocument();
  });

  it("won't search blind: asks for a role and a place, and fills them in one click, saved to the search settings", async () => {
    const b = new MockBridge();
    await empty(b);
    (b as unknown as { suggested: unknown }).suggested = { roles: ["Data Engineer"], keywords: [], seniority: "", at: "2026-01-15T09:00:00.000Z" };
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    await screen.findByRole("region", { name: "What you're looking for" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Find jobs" })).toBeDisabled());
    expect(screen.getAllByText(/Set what you're looking for first: add a role and a location/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Use defaults" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Find jobs" })).toBeEnabled());
    expect(chip("Roles")).toHaveAccessibleName("Roles: Data Engineer. Change");
    await waitFor(async () => expect((await b.settings.get("profile")).values.locations).toEqual([{ place: "Sampletown NSW", modes: ["onsite", "hybrid", "remote"], will_relocate: false }]));
    expect(((await b.settings.get("profile")).values.targets as { roles: string[] }).roles).toEqual(["Data Engineer"]);
    // There's no second copy to keep in step: no "this search only", Save default or Undo.
    expect(screen.queryByText(/changed for this search/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save default" })).toBeNull();
    expect(screen.getByText("Saved to your search settings. Changes here show there too.")).toBeInTheDocument();
  });

  it("a chip change saves straight to the search settings, and the run sends no separate copy", async () => {
    const b = new MockBridge();
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    await screen.findByRole("region", { name: "What you're looking for" });
    await userEvent.click(chip("Posted"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Posted" })).getByRole("radio", { name: "Last 7 days" }));
    await waitFor(async () => expect(((await b.settings.get("search")).values.filters as Record<string, unknown>).posted_within_days).toBe(7));
    await userEvent.click(chip("Where"));
    const where = await screen.findByRole("dialog", { name: "Where" });
    await userEvent.type(within(where).getByRole("combobox", { name: "Add place" }), "Brisbane{Enter}");
    await userEvent.click(within(where).getByRole("button", { name: "Move Brisbane up" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(async () => expect((await places(b))).toEqual(["Sampletown NSW", "Brisbane", "Remote Australia"]));
    // Work modes are per place, as in Settings: each place has its own three choices.
    await userEvent.click(chip("Work mode"));
    const modes = await screen.findByRole("dialog", { name: "Work mode" });
    await userEvent.click(within(modes).getByRole("checkbox", { name: "On site in Brisbane" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(async () => expect(((await b.settings.get("profile")).values.locations as { modes: string[] }[])[1]!.modes).toEqual(["hybrid", "remote"]));
    expect(((await b.settings.get("profile")).values.locations as { modes: string[] }[])[0]!.modes).toEqual(["onsite", "hybrid", "remote"]);
    await userEvent.click(screen.getByRole("button", { name: "Find jobs" }));
    await waitFor(() => expect(runs(b)).toHaveLength(1));
    expect(runs(b)[0]!.search).toBeUndefined();
  });

  it("breadth is a saved setting too, and the run uses it", async () => {
    const b = new MockBridge();
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    await screen.findByRole("region", { name: "What you're looking for" });
    // The search's filters are saved settings; only "If it fails, try again" is left under "This search only".
    expect(screen.queryByRole("radio", { name: "Focused" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Twice" })).toBeChecked();
    await userEvent.click(chip("Breadth"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Breadth" })).getByRole("radio", { name: /^Broad/ }));
    await waitFor(async () => expect(((await b.settings.get("search")).values.filters as Record<string, unknown>).breadth).toBe("broad"));
    expect(chip("Breadth")).toHaveAccessibleName("Breadth: Broad. Change");
    await userEvent.click(screen.getByRole("button", { name: "Find jobs" }));
    await waitFor(() => expect(runs(b)).toHaveLength(1));
    expect((runs(b)[0]!.options as Record<string, unknown>).breadth).toBe("broad");
  });

  it("how many jobs to find: 100 by default, any whole number from 1 to 200, saved, and the run uses it", async () => {
    const b = new MockBridge();
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    await screen.findByRole("region", { name: "What you're looking for" });
    expect(screen.queryByRole("slider")).toBeNull();
    expect(chip("Jobs")).toHaveAccessibleName("Jobs: Up to 100. Change");
    await userEvent.click(chip("Jobs"));
    const panel = await screen.findByRole("dialog", { name: "Jobs" });
    const box = within(panel).getByRole("spinbutton", { name: "Jobs to find" });
    expect(box).toHaveValue(100);
    expect(within(panel).getByText("Bigger searches take longer and use more of your Claude plan.")).toBeInTheDocument();
    for (const bad of ["0", "201", "2.5"]) {
      await userEvent.clear(box);
      await userEvent.type(box, bad);
      expect(within(panel).getByText("Type a whole number from 1 to 200.")).toBeInTheDocument();
      expect(within(panel).getByRole("button", { name: "Apply" })).toBeDisabled();
    }
    await userEvent.clear(box);
    await userEvent.type(box, "40");
    await userEvent.click(within(panel).getByRole("button", { name: "Apply" }));
    await waitFor(async () => expect(((await b.settings.get("search")).values.filters as Record<string, unknown>).max_jobs).toBe(40));
    expect(chip("Jobs")).toHaveAccessibleName("Jobs: Up to 40. Change");
    await userEvent.click(screen.getByRole("button", { name: "Find jobs" }));
    await waitFor(() => expect(runs(b)).toHaveLength(1));
    expect((runs(b)[0]!.options as Record<string, unknown>).max_jobs).toBe(40);
  });

  it("sponsorship-only is a quick filter here, not a second control under Your choices", async () => {
    const b = sponsorBridge();
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    await screen.findByRole("region", { name: "What you're looking for" });
    expect(screen.queryAllByText("Only ads that offer sponsorship", { exact: false })).toHaveLength(0);
    await userEvent.click(chip("Sponsorship"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Sponsorship" })).getByRole("checkbox", { name: "Only ads that offer sponsorship" }));
    await userEvent.keyboard("{Escape}");
    expect(chip("Sponsorship")).toHaveAccessibleName("Sponsorship: Offered in the ad. Change");
    await userEvent.click(screen.getByRole("button", { name: "Find jobs" }));
    await waitFor(() => expect(runs(b)).toHaveLength(1));
    expect((runs(b)[0]!.options as Record<string, unknown>).sponsor_only).toBe(true);
  });

  it("posted: the last 2 weeks, this week (since Monday), or any number of days", async () => {
    const b = new MockBridge();
    renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} label="Find jobs" />, { bridge: b });
    await screen.findByRole("region", { name: "What you're looking for" });
    const filters = async () => (await b.settings.get("search")).values.filters as Record<string, unknown>;
    await userEvent.click(chip("Posted"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Posted" })).getByRole("radio", { name: "This week" }));
    await waitFor(async () => expect((await filters()).posted_this_week).toBe(true));
    await waitFor(() => expect(chip("Posted")).toHaveAccessibleName("Posted: This week. Change"));
    await userEvent.click(chip("Posted"));
    const d = await screen.findByRole("dialog", { name: "Posted" });
    expect(within(d).getByRole("radio", { name: "Last 2 weeks" })).toBeInTheDocument();
    await userEvent.type(within(d).getByRole("textbox", { name: "Or the last (days)" }), "10");
    await userEvent.click(within(d).getByRole("button", { name: "Apply" }));
    await waitFor(async () => expect(await filters()).toMatchObject({ posted_within_days: 10, posted_this_week: false }));
    await waitFor(() => expect(chip("Posted")).toHaveAccessibleName("Posted: Last 10 days. Change"));
  });
});
