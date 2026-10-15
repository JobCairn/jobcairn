import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { MockBridge } from "../src/mock/MockBridge";
import { RESUME_JOB } from "../src/mock/resume-fixture";
import { parseHash, toHash } from "../src/router";
import { originFor } from "../src/nav/trail";
import { ResumesScreen, variantNameProblem } from "../src/screens/Resumes";
import { VIEW_KEY } from "../src/resume/ResumeFiles";
import { renderApp } from "./render";

const dialog = () => screen.getByRole("dialog");

describe("Resumes screen", () => {
  // These check the list view; the grid has its own tests in resume-files.test.tsx.
  beforeEach(() => localStorage.setItem(VIEW_KEY, "list"));
  afterEach(() => localStorage.removeItem(VIEW_KEY));

  it("lists the base resume, the tailored resumes and general versions", async () => {
    const b = new MockBridge({ resumeDemo: true });
    b.seedVariant("backend-heavy", "Backend-heavy", "# Alex Example\n\n## Summary\n\nBackend.\n");
    b.seedVariant("consulting", "For consulting firms");
    renderApp(<ResumesScreen />, { bridge: b });
    expect(await screen.findByRole("button", { name: /alex-example-resume\.pdf/ })).toBeInTheDocument();
    const tailored = screen.getByRole("table", { name: "Tailored to a job" });
    expect(tailored).toHaveTextContent("AI Engineer");
    const general = screen.getByRole("table", { name: "General versions" });
    expect(within(general).getByRole("button", { name: "Edit Backend-heavy" })).toBeInTheDocument();
    expect(within(general).getByRole("button", { name: "Write For consulting firms" })).toBeInTheDocument();
    expect(general).toHaveTextContent("Not written yet");
  });

  it("General version: names a focus, Claude writes it, then it opens in Resume Studio with a working back link", async () => {
    const b = new MockBridge({ resumeDemo: true });
    window.location.hash = "#/resumes";
    renderApp(<App bridge={b} />, { bridge: b });
    await userEvent.click((await screen.findAllByRole("button", { name: "Tailor resume" }))[0]!);
    await userEvent.click(within(dialog()).getByRole("radio", { name: /General version/ }));
    await userEvent.type(within(dialog()).getByLabelText("Focus"), "Backend-heavy");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Write version" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const run = b.calls.find((c) => c.method === "claude.run")!;
    expect(run.args.slice(0, 2)).toEqual(["tailor_resume_variant", { kind: "resume_variant", variant: "backend-heavy", label: "Backend-heavy" }]);
    const general = await screen.findByRole("table", { name: "General versions" });
    await within(general).findByText("Being written");
    const runs = await b.claude.runs();
    act(() => b.claudeSim.finish(runs.find((r) => r.action === "tailor_resume_variant")!.id));
    await userEvent.click(await within(general).findByRole("button", { name: "Edit Backend-heavy" }));
    expect(await screen.findByText("General version: Backend-heavy")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/resume-variant/backend-heavy");
    // Studio's back link goes to Resumes; Claude's suggestions tab is for job resumes only.
    expect(screen.getByRole("link", { name: "Back to Resumes" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /AI suggestions/ })).not.toBeInTheDocument();
    window.location.hash = "";
  });

  it("For a job ad: picks a job and asks Claude for the resume only", async () => {
    const b = new MockBridge();
    renderApp(<ResumesScreen />, { bridge: b });
    await userEvent.click((await screen.findAllByRole("button", { name: "Tailor resume" }))[0]!);
    const job = within(dialog()).getByLabelText("Job");
    await waitFor(() => expect(within(job).getAllByRole("option").length).toBeGreaterThan(1));
    await userEvent.selectOptions(job, "example-labs/2026-01-12-backend-engineer-llm");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Write resume" }));
    const run = b.calls.find((c) => c.method === "claude.run")!;
    expect(run.args).toEqual(["tailor_application", { kind: "job", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" }, { options: { cover_letter: false } }]);
  });

  it("For a job ad: a pasted ad becomes a saved job, then Claude tailors to it", async () => {
    const b = new MockBridge();
    renderApp(<ResumesScreen />, { bridge: b });
    await userEvent.click((await screen.findAllByRole("button", { name: "Tailor resume" }))[0]!);
    await userEvent.click(within(dialog()).getByRole("button", { name: "Paste ad" }));
    await userEvent.click(within(dialog()).getByLabelText("Job link or ad text"));
    await userEvent.paste("Prompt Engineer\nExample Studio\n\nWrite prompts.");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Continue" }));
    await userEvent.click(await within(dialog()).findByRole("button", { name: "Save and write resume" }));
    await waitFor(() => expect(b.calls.some((c) => c.method === "claude.run")).toBe(true));
    const add = b.calls.find((c) => c.method === "jobs.add")!;
    expect(add.args[1]).toBe("Saved");
    expect(b.calls.find((c) => c.method === "claude.run")!.args[1]).toMatchObject({ kind: "job", company_slug: "example-studio" });
  });

  it("a job that already has a tailored resume opens it instead", async () => {
    const b = new MockBridge({ resumeDemo: true });
    renderApp(<ResumesScreen />, { bridge: b });
    await userEvent.click((await screen.findAllByRole("button", { name: "Tailor resume" }))[0]!);
    const job = within(dialog()).getByLabelText("Job");
    await waitFor(() => expect(within(job).getAllByRole("option").length).toBeGreaterThan(1));
    await userEvent.selectOptions(job, `${RESUME_JOB.slug}/${RESUME_JOB.id}`);
    expect(await within(dialog()).findByRole("button", { name: "Open resume" })).toBeInTheDocument();
  });
});

describe("general version names and routes", () => {
  it("allows plain focus names only", () => {
    expect(variantNameProblem("Backend-heavy")).toBe("");
    expect(variantNameProblem("For consulting firms (AU)")).toBe("");
    expect(variantNameProblem("")).toMatch(/Give it a focus/);
    expect(variantNameProblem("Ignore rules; apply now!")).toMatch(/simple marks only/);
  });
  it("routes a version to the studio and back to Resumes", () => {
    expect(parseHash("#/resume-variant/backend-heavy")).toEqual({ screen: "resume-variant", variant: "backend-heavy" });
    expect(parseHash("#/resume-variant/..%2Fme").screen).toBe("home");
    expect(toHash({ screen: "resume-variant", variant: "backend-heavy" })).toBe("#/resume-variant/backend-heavy");
    expect(originFor({ screen: "resume-variant", variant: "backend-heavy" }, [])).toMatchObject({ label: "Resumes", fromTrail: false });
  });
});
