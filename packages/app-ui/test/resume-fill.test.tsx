import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { MockBridge } from "../src/mock/MockBridge";
import { ResumeFillNotice } from "../src/resumefill";
import { HomeScreen } from "../src/screens/Home";
import { SettingsScreen } from "../src/screens/Settings";
import { TOURS } from "../src/tour/content";
import { renderApp } from "./render";

// Fictional resume only.
const RESUME = "/fictional/alex-example/Downloads/Alex Example resume.pdf";
const calls = (b: MockBridge, m: string) => b.calls.filter((c) => c.method === m).map((c) => c.args);
const pickResume = (b: MockBridge, path = RESUME) => { b.files.pick = async () => path; };
const setContact = (b: MockBridge, contact: Record<string, unknown>) => {
  (b as unknown as { f: { profile: Record<string, unknown> } }).f.profile.contact = contact;
};

// Whole-screen flows with many steps: give them room on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { sessionStorage.clear(); window.location.hash = ""; });

describe("Settings › Profile: Fill from my resume", () => {
  it("fills empty fields, tagged, and saves only after review", async () => {
    const b = new MockBridge();
    setContact(b, { name: "", email: "", phone: "", city: "", links: [] });
    pickResume(b);
    renderApp(<SettingsScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Choose resume" }));
    expect(await screen.findByRole("heading", { name: "Check what we found" })).toHaveFocus();
    const form = within(screen.getByRole("form", { name: "Check what we found" }));
    expect(form.getByLabelText("Full name")).toHaveValue("Alex Example");
    expect(form.getByLabelText("Phone")).toHaveValue("+61 491 570 006");
    expect(form.getAllByText("From your resume")).toHaveLength(5);
    expect(calls(b, "profile.fillFromResume")).toHaveLength(0);
    // Fix a field before saving.
    await userEvent.clear(form.getByLabelText("City"));
    await userEvent.type(form.getByLabelText("City"), "Sampletown, NSW");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("heading", { name: "Profile filled from your resume" })).toBeInTheDocument();
    const [args] = calls(b, "profile.fillFromResume");
    expect(args).toEqual([RESUME, {
      name: "Alex Example", email: "alex@example.com", phone: "+61 491 570 006", city: "Sampletown, NSW",
      links: ["https://www.linkedin.com/in/alex-example", "https://github.com/alexexample"],
    }, []]);
    // Work rights weren't touched.
    expect(calls(b, "settings.save")).toHaveLength(0);
    expect(screen.getByText(/Name, email, phone, city and links filled in\./)).toBeInTheDocument();
    expect(screen.getByText(/Resumes folder/)).toBeInTheDocument();
  });

  it("never overwrites a filled field silently: a conflict needs 'Use resume value'", async () => {
    const b = new MockBridge(); // the fixture profile already has a phone and links
    pickResume(b);
    renderApp(<SettingsScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Choose resume" }));
    await screen.findByRole("heading", { name: "Check what we found" });
    const use = screen.getByRole("checkbox", { name: "Use resume value: +61 491 570 006" });
    expect(use).not.toBeChecked();
    expect(screen.getAllByText("Already in your profile").length).toBeGreaterThan(0);
    await userEvent.click(use);
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByRole("heading", { name: "Profile filled from your resume" });
    const [[, values, overwrite]] = calls(b, "profile.fillFromResume") as [string, Record<string, unknown>, string[]][];
    expect(values.phone).toBe("+61 491 570 006");
    expect(overwrite).toEqual(["phone"]);
    // Links weren't ticked: sent so the record says they were kept, but not replaced.
    expect(overwrite).not.toContain("links");
    expect(screen.getByText(/Kept your own links\./)).toBeInTheDocument();
  });

  it("keeps work rights a one-tap choice, saved only when changed", async () => {
    const b = new MockBridge();
    pickResume(b);
    renderApp(<SettingsScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Choose resume" }));
    const form = await screen.findByRole("form", { name: "Check what we found" });
    expect(within(form).getByText("Never read from a resume. Pick one, or leave it as it is.")).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("radio", { name: "Permanent resident" }));
    await userEvent.click(within(form).getByRole("button", { name: "Save profile" }));
    await screen.findByRole("heading", { name: "Profile filled from your resume" });
    expect(calls(b, "settings.save")).toEqual([["profile", [{ path: "work_rights.status", value: "pr" }]]]);
  });

  it("reads a dropped file through the safe drop path, and shows a refusal in plain words", async () => {
    const b = new MockBridge();
    renderApp(<SettingsScreen />, { bridge: b });
    const zone = await screen.findByRole("group", { name: /Choose resume: drop your resume here/ });
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "old resume.doc")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("older Word file (.doc). Save it as .docx or PDF");
    expect(calls(b, "profile.readResume")).toEqual([["/fictional/alex-example/Downloads/old resume.doc"]]);
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "Alex.md")] } });
    expect(await screen.findByRole("heading", { name: "Check what we found" })).toBeInTheDocument();
  });

  it("asks for one file at a time", async () => {
    renderApp(<SettingsScreen />);
    const zone = await screen.findByRole("group", { name: /drop your resume here/ });
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "a.pdf"), new File(["y"], "b.pdf")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Drop one file: your resume.");
  });

  it("cancel saves nothing", async () => {
    const b = new MockBridge();
    pickResume(b);
    renderApp(<SettingsScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Choose resume" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Choose resume" })).toBeInTheDocument();
    expect(calls(b, "profile.fillFromResume")).toHaveLength(0);
  });
});

describe("Claude suggestions", () => {
  it("runs suggest_targets with a fixed-size status chip, then adds only the picked suggestions", async () => {
    const b = new MockBridge();
    pickResume(b);
    renderApp(<SettingsScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Choose resume" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save profile" }));
    const ask = await screen.findByRole("button", { name: "Suggest targets" });
    await userEvent.click(ask);
    await waitFor(() => expect(document.querySelector(".rfill-chip")).not.toBeNull());
    expect(document.querySelector(".rfill-chip")).toHaveAttribute("role", "status");
    expect(calls(b, "claude.run")[0]?.slice(0, 2)).toEqual(["suggest_targets", { kind: "workspace" }]);
    // No expanding run panel.
    expect(document.querySelector(".crun")).toBeNull();
    const run = b.claudeSim.runs[0]!;
    b.claudeSim.finish(run.id);
    expect(await screen.findByRole("button", { name: "Suggest again" }, { timeout: 5000 })).toBeInTheDocument();
    const chips = await screen.findAllByRole("button", { pressed: true });
    // The fixture already targets "AI Engineer", so it isn't offered again.
    expect(chips.map((c) => c.textContent)).not.toContain("AI Engineer");
    await userEvent.click(screen.getByRole("button", { name: "Data Scientist", pressed: true }));
    await userEvent.click(screen.getByRole("button", { name: "Add selected" }));
    await waitFor(() => expect(calls(b, "settings.save").length).toBe(1));
    const [[, changes]] = calls(b, "settings.save") as [string, { path: string; value: string[] }[]][];
    const roles = changes.find((c) => c.path === "targets.roles")!.value;
    expect(roles).toContain("Machine Learning Engineer");
    expect(roles).not.toContain("Data Scientist");
  });

  it("points to Claude setup instead when Claude isn't ready", async () => {
    const b = new MockBridge({ claudeEngine: { cli: "missing" } });
    pickResume(b);
    renderApp(<SettingsScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Choose resume" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save profile" }));
    await userEvent.click(await screen.findByRole("button", { name: "Claude setup" }));
    expect(window.location.hash).toContain("settings");
    expect(window.location.hash).toContain("claude");
  });
});

describe("Results never vanish", () => {
  it("Home shows 'Profile filled from your resume · Review' until reviewed", async () => {
    const b = new MockBridge();
    await b.profile.fillFromResume(RESUME, { name: "Alex Example" }, []);
    renderApp(<ResumeFillNotice />, { bridge: b });
    expect(await screen.findByText("Profile filled from your resume")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(window.location.hash).toContain("settings");
    await waitFor(() => expect(screen.queryByText("Profile filled from your resume")).not.toBeInTheDocument());
    expect(b.resumeFill?.seen).toBe(true);
  });

  it("is mounted on Home", async () => {
    const b = new MockBridge();
    await b.profile.fillFromResume(RESUME, { name: "Alex Example" }, []);
    renderApp(<HomeScreen />, { bridge: b });
    expect(await screen.findByRole("button", { name: "Review" })).toBeInTheDocument();
  });
});

describe("Onboarding: Fill from my resume", () => {
  it("fills the name (tagged) and saves the other details with Done", async () => {
    const b = new MockBridge({ workspaceOpen: false });
    setContact(b, { name: "", email: "", phone: "", city: "", links: [] });
    pickResume(b);
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
    await screen.findByRole("heading", { name: "A few details" });
    await userEvent.click(screen.getByRole("button", { name: "Choose resume" }));
    expect(await screen.findByLabelText("What's your name?")).toHaveValue("Alex Example");
    expect(screen.getByText("From your resume")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /^Phone:/ })); // untick the phone
    expect(screen.getByRole("radio", { name: "Prefer not to say" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    const [[path, values, overwrite]] = calls(b, "profile.fillFromResume") as [string, Record<string, unknown>, string[]][];
    expect(path).toBe(RESUME);
    expect(values).toEqual({ name: "Alex Example", email: "alex@example.com", city: "Sampletown NSW", links: ["https://www.linkedin.com/in/alex-example", "https://github.com/alexexample"] });
    expect(overwrite).toEqual(["name"]);
    // Work rights stay unanswered.
    expect(JSON.stringify(calls(b, "settings.save"))).not.toContain("work_rights");
    expect(await screen.findByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it("doesn't replace a name the person typed: it offers 'Use resume value'", async () => {
    const b = new MockBridge({ workspaceOpen: false });
    b.mockResume = { ...b.mockResume, name: "Alex J Example" };
    pickResume(b);
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
    const name = await screen.findByLabelText("What's your name?");
    await userEvent.clear(name);
    await userEvent.type(name, "Alex Example");
    await userEvent.click(screen.getByRole("button", { name: "Choose resume" }));
    const use = await screen.findByRole("checkbox", { name: "Use resume value: Alex J Example" });
    expect(name).toHaveValue("Alex Example");
    await userEvent.click(use);
    expect(name).toHaveValue("Alex J Example");
    await userEvent.click(screen.getByRole("checkbox", { name: "Use resume value: Alex J Example" }));
    expect(name).toHaveValue("Alex Example");
  });
});

describe("Guided tour", () => {
  it("has a step for the button in Settings", () => {
    expect(TOURS.settings.steps.map((s) => s.target)).toContain('[data-tour="settings-resume-fill"]');
  });
});
