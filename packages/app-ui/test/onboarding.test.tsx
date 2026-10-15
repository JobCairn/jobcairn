import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { MockBridge, type MockOptions } from "../src/mock/MockBridge";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const fresh = (o: MockOptions = {}) => new MockBridge({ workspaceOpen: false, ...o });
const called = (b: MockBridge, m: string) => b.calls.filter((c) => c.method === m);
const DIR = "/fictional/alex-example/CareerOS";

describe("Onboarding", () => {
  beforeEach(() => { sessionStorage.clear(); window.location.hash = ""; });

  it("reaches Home in two clicks: Get started, then Done, with no folder picker", async () => {
    const b = fresh();
    render(<App bridge={b} />);
    expect(await screen.findByText(`~/${brand.name}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(await screen.findByRole("heading", { name: "A few details" })).toBeInTheDocument();
    expect(screen.getByLabelText("What's your name?")).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(called(b, "workspace.pickFolder")).toHaveLength(0);
    // Main picks the folder: the suggested path is shown, never sent back.
    expect(called(b, "workspace.start")).toHaveLength(1);
    expect(called(b, "workspace.create")).toHaveLength(0);
    expect(b.calls.some((c) => JSON.stringify(c.args).includes(DIR))).toBe(false);
    // Nothing answered, so nothing is saved: "Prefer not to say" is the default.
    expect(called(b, "settings.save")).toHaveLength(0);
  });

  it("saves the name, the jobs wanted and the work rights from the one details page", async () => {
    const b = fresh({ suggestName: "Alex Example" });
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
    expect(await screen.findByLabelText("What's your name?")).toHaveValue("Alex Example");
    await userEvent.type(screen.getByLabelText("What jobs are you looking for?"), "AI Engineer, Backend Engineer");
    await userEvent.click(screen.getByRole("radio", { name: "I need visa sponsorship" }));
    await userEvent.type(screen.getByLabelText("When does your visa end?"), "2028-06-30");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(called(b, "workspace.start")).toHaveLength(1);
    expect(called(b, "settings.save").map((c) => c.args)).toEqual([
      ["profile", [
        { path: "contact.name", value: "Alex Example" },
        { path: "work_rights.status", value: "needs_sponsorship" }, { path: "work_rights.visa_expiry", value: "2028-06-30" },
        { path: "targets.roles", value: ["AI Engineer", "Backend Engineer"] },
      ]],
    ]);
  });

  it("only shows the visa end date for a status that has a visa, and omits it from the save otherwise", async () => {
    const b = fresh();
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "A few details" });
    expect(screen.getByRole("radio", { name: "Prefer not to say" })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: "Citizen" }));
    expect(screen.queryByLabelText("When does your visa end?")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Visa with limited work rights" }));
    expect(screen.getByLabelText("When does your visa end?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Citizen" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("navigation", { name: "Main" });
    expect(called(b, "settings.save").map((c) => c.args)).toEqual([["profile", [{ path: "work_rights.status", value: "citizen" }]]]);
  });

  it("goes back to the welcome page with Esc before anything is made", async () => {
    const b = fresh();
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "A few details" });
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { name: /Welcome to/ })).toBeInTheDocument();
    expect(called(b, "workspace.create")).toHaveLength(0);
  });

  it("opens the CareerOS folder that's already in the home folder in one click", async () => {
    const b = fresh({ suggestExisting: true });
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open folder" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(called(b, "workspace.start")).toHaveLength(1);
    expect(called(b, "workspace.open")).toHaveLength(0);
    expect(called(b, "workspace.create")).toHaveLength(0);
  });

  it("falls back to the folder picker on a bridge without the planned folder calls, and then needs a name", async () => {
    const b = fresh({ folderApi: false });
    render(<App bridge={b} />);
    expect(await screen.findByText(/Next, you choose a folder/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try example/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "A few details" });
    expect(called(b, "workspace.pickFolder").map((c) => c.args)).toEqual([["create"]]);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Add your name. It's needed to set up your folder.")).toBeInTheDocument();
    expect(called(b, "workspace.create")).toHaveLength(0);
    await userEvent.type(screen.getByLabelText("What's your name?"), "Alex Example");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(called(b, "workspace.create")[0]?.args).toEqual([DIR, "Alex Example"]);
  });

  it("opens an existing folder", async () => {
    const b = fresh();
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: /Open existing/ }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(called(b, "workspace.open")).toHaveLength(1);
  });

  it("previews old job-search files before copying anything, into a folder the person picks", async () => {
    const b = fresh();
    render(<App bridge={b} />);
    await screen.findByText(`~/${brand.name}`);
    await userEvent.click(screen.getByRole("button", { name: /Import files/ }));
    expect(await screen.findByText("companies/acme-corp/jobs/2026-01-12-ai-engineer")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(called(b, "workspace.importLegacy")).toHaveLength(0);
    // The destination comes from the folder picker, not from the suggestion.
    expect(called(b, "workspace.pickFolder").map((c) => c.args)).toEqual([["legacy"], ["create"]]);
    expect(called(b, "workspace.previewLegacy")[0]?.args).toEqual(["/fictional/alex-example/OldCareerFolder", DIR]);
    await userEvent.click(screen.getByRole("button", { name: "Copy files" }));
    await waitFor(() => expect(called(b, "workspace.importLegacy")).toHaveLength(1));
    expect(await screen.findByRole("heading", { name: "A few details" })).toBeInTheDocument();
    // The folder exists now, so there's no Back; Done goes Home without overwriting brought-in answers.
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(called(b, "settings.save")).toHaveLength(0);
  });

  it("explores the made-up example with a banner, then leaves it without touching a real folder", async () => {
    const b = fresh();
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: /Try example/ }));
    expect(await screen.findByText("You're exploring an example job search. Nothing here is real.")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(called(b, "workspace.openSample")).toHaveLength(1);
    expect(called(b, "workspace.create")).toHaveLength(0);
    expect(called(b, "workspace.open")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Leave example" }));
    expect(await screen.findByRole("heading", { name: /Welcome to/ })).toBeInTheDocument();
    expect(called(b, "workspace.close")).toHaveLength(1);
  });

  it("starts the person's own setup straight from the example banner", async () => {
    const b = fresh();
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: /Try example/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Start fresh" }));
    expect(await screen.findByRole("heading", { name: "A few details" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.queryByText(/exploring an example/)).not.toBeInTheDocument();
    expect(called(b, "workspace.start")).toHaveLength(1);
  });

  describe("with workspaces already on this computer", () => {
    it("leads with Continue, preferring one with files in it over an empty one", async () => {
      const b = fresh({ otherWorkspaces: [
        { name: "Jordan Demo", folder: "CareerOS Jordan", companies: 0, empty: true },
        { name: "Sam Sample", folder: "CareerOS Sam", companies: 52, created: "2026-10-10" },
      ] });
      render(<App bridge={b} />);
      expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Get started" })).not.toBeInTheDocument();
      expect(screen.getByText("CareerOS Sam · 52 companies · created 10 Oct 2026")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Continue with Sam Sample's workspace" }));
      expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
      expect(called(b, "workspace.switchTo")).toHaveLength(1);
      expect(called(b, "workspace.start")).toHaveLength(0);
      expect(called(b, "workspace.startNew")).toHaveLength(0);
    });

    it("shows neither Get started nor Continue until the list is in", async () => {
      const b = fresh({ otherWorkspaces: [{ name: "Sam Sample", folder: "CareerOS Sam", companies: 3 }] });
      render(<App bridge={b} />);
      await screen.findByRole("heading", { level: 1 });
      expect(screen.queryByRole("button", { name: "Get started" })).not.toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Continue with Sam Sample's workspace" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Get started" })).not.toBeInTheDocument();
    });

    it("makes a new workspace only after the explicit choice, in a new folder", async () => {
      const b = fresh({ otherWorkspaces: [{ name: "Sam Sample", folder: "CareerOS Sam", companies: 3 }] });
      render(<App bridge={b} />);
      await userEvent.click(await screen.findByRole("button", { name: /New workspace/ }));
      expect(await screen.findByRole("heading", { name: "Start a new workspace" })).toBeInTheDocument();
      await userEvent.clear(screen.getByLabelText("What's your name?"));
      await userEvent.type(screen.getByLabelText("What's your name?"), "Jordan Demo");
      await userEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
      expect(called(b, "workspace.startNew").map((c) => c.args)).toEqual([["Jordan Demo"]]);
      // Never the suggested folder, which could be an existing workspace.
      expect(called(b, "workspace.start")).toHaveLength(0);
      expect(called(b, "workspace.switchTo")).toHaveLength(0);
    });

    it("Back from the new-workspace page returns to the welcome screen with nothing made", async () => {
      const b = fresh({ otherWorkspaces: [{ name: "Sam Sample", folder: "CareerOS Sam", companies: 3 }] });
      render(<App bridge={b} />);
      await userEvent.click(await screen.findByRole("button", { name: /New workspace/ }));
      await userEvent.click(await screen.findByRole("button", { name: "Back" }));
      expect(await screen.findByRole("button", { name: "Continue with Sam Sample's workspace" })).toBeInTheDocument();
      expect(called(b, "workspace.startNew")).toHaveLength(0);
    });

    it("says where the lead one is when two would read the same, and lists the other", async () => {
      const b = fresh({ otherWorkspaces: [
        { name: "Sam Sample", folder: "CareerOS", parent: "personal-workspace", companies: 52 },
        { name: "Sam Sample", folder: "CareerOS", parent: "old-laptop", companies: 1 },
      ] });
      render(<App bridge={b} />);
      expect(await screen.findByRole("button", { name: "Continue with Sam Sample's workspace" })).toBeInTheDocument();
      expect(screen.getByText(/^personal-workspace › CareerOS · 52 companies/)).toBeInTheDocument();
      const others = screen.getByRole("region", { name: "Your other workspaces" });
      await userEvent.click(within(others).getByRole("button", { name: "Open Sam Sample (old-laptop › CareerOS)" }));
      expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
      expect(called(b, "workspace.switchTo")).toHaveLength(1);
    });

    it("shows a folder that can't be found, with Locate and Remove, and never makes one in its place", async () => {
      const b = fresh({ otherWorkspaces: [{ name: "Riley Test", folder: "CareerOS Riley", available: false }] });
      render(<App bridge={b} />);
      // Nothing else to continue with: the usual first run, plus the missing folder.
      expect(await screen.findByRole("button", { name: "Get started" })).toBeInTheDocument();
      const known = screen.getByRole("region", { name: "Your workspaces" });
      expect(within(known).getByText("CareerOS Riley · Can't find this folder")).toBeInTheDocument();
      expect(within(known).getByText(/Nothing is made in its place/)).toBeInTheDocument();
      expect(called(b, "workspace.start")).toHaveLength(0);
      expect(within(known).queryByRole("button", { name: /Trash/ })).not.toBeInTheDocument();
      b.workspace.pickFolder = async (): Promise<string | null> => "/fictional/alex-example/Moved/CareerOS Riley";
      await userEvent.click(within(known).getByRole("button", { name: "Locate Riley Test's folder" }));
      // Found: it's the one to continue with now.
      expect(await screen.findByRole("button", { name: "Continue with Riley Test's workspace" })).toBeInTheDocument();
      expect(called(b, "workspace.locate")).toHaveLength(1);
    });

    it("removes a missing folder from the list", async () => {
      const b = fresh({ otherWorkspaces: [{ name: "Riley Test", folder: "CareerOS Riley", available: false }] });
      render(<App bridge={b} />);
      await userEvent.click(await screen.findByRole("button", { name: "Remove: Riley Test" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Your workspaces" })).not.toBeInTheDocument());
      expect(called(b, "workspace.forget")).toHaveLength(1);
    });
  });
});
