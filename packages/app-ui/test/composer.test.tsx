import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_RULES, buildActionPrompt } from "@careeros/contract";
import { RequestComposer } from "../src/composer";
import { displayPrompt, fileChips } from "../src/composer/labels";
import { MockBridge } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { renderApp } from "./render";

/**
 * What main receives (the renderer sends only {options, note}), and the prompt main builds from it. The mock's
 * engine checks the request like main does; the prompt is rebuilt here with the same contract builder.
 */
async function startedPrompt(b: MockBridge, n = 1): Promise<string> {
  await waitFor(() => expect(b.claudeSim.requests).toHaveLength(n));
  const r = b.claudeSim.requests[n - 1]!;
  expect(Object.keys(r.request).sort()).toEqual(["note", "options"]);
  const v = await b.claude.compose(r.action, r.target);
  return buildActionPrompt(r.action, r.target, v.info, { options: r.request.options ?? {}, note: r.request.note ?? "" }, "0123456789abcdef");
}

const JOB = { kind: "job", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" } as const;
const ACME = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
let clip: string[];

beforeEach(() => {
  clip = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { clip.push(t); } } });
});
afterEach(() => vi.restoreAllMocks());

describe("RequestComposer", () => {
  it("shows a plain sentence, friendly file chips, the options, the note box and the always-on rules", async () => {
    renderApp(<RequestComposer action="tailor_application" target={JOB} />);
    expect(await screen.findByRole("heading", { name: "Claude will write a tailored resume, a cover letter and answers for Backend Engineer (LLM) at Example Labs." })).toBeInTheDocument();
    const files = within(screen.getByLabelText("What Claude will create"));
    for (const f of ["Resume", "Cover letter", "Claim check", "Answers", "Second-pass review"]) expect(files.getByText(f)).toBeInTheDocument();
    expect(files.getByText("if needed")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Professional" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "2 pages" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Write a cover letter" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "RAG" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("radio", { name: "Individual contributor" })).toBeChecked();
    for (const r of ["Only these files", "No made-up claims", "Private folders stay closed", "Nothing gets sent"]) expect(screen.getByText(r)).toBeInTheDocument();
    expect(screen.getByText("0 / 1,000")).toBeInTheDocument();
    // No raw paths or workflow codes outside the collapsed prompt.
    expect(screen.queryByText(/companies\//)).toBeNull();
  });

  it("turning the cover letter off updates the sentence and drops its file chip", async () => {
    renderApp(<RequestComposer action="tailor_application" target={JOB} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Write a cover letter" }));
    expect(screen.getByRole("heading", { name: /tailored resume and answers for/ })).toBeInTheDocument();
    const files = within(screen.getByLabelText("What Claude will create"));
    expect(files.queryByText("Cover letter")).toBeNull();
    expect(files.getByText("Resume")).toBeInTheDocument();
  });

  it("allows a note that names this request's own file, but not other files", async () => {
    renderApp(<RequestComposer action="tailor_application" target={JOB} />);
    const box = await screen.findByRole("textbox", { name: "Anything else?" });
    await userEvent.type(box, "Keep resume.md to 1 page.");
    expect(screen.getByRole("button", { name: "Tailor application" })).toBeEnabled();
    await userEvent.type(box, " Also write notes.md");
    expect(screen.getByText(/can't name files or folders/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tailor application" })).toBeDisabled();
  });

  it("starts Claude with the composed prompt: options, chips and the fenced note, rules last", async () => {
    const { bridge } = renderApp(<RequestComposer action="tailor_application" target={JOB} />);
    await userEvent.click(await screen.findByRole("radio", { name: "1 page" }));
    // The skill chips load from the job and profile after the form: wait for them.
    await userEvent.click(await screen.findByRole("button", { name: "RAG" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add to note: Use Australian spelling." }));
    expect(screen.getByRole("textbox", { name: "Anything else?" })).toHaveValue("Use Australian spelling.");
    await userEvent.click(screen.getByRole("button", { name: "Tailor application" }));
    const p = await startedPrompt(bridge);
    expect(bridge.claudeSim.requests[0]!.request).toEqual({ options: expect.objectContaining({ resume_length: "1", emphasis: ["RAG"] }), note: "Use Australian spelling." });
    expect(p).toContain("- Keep the resume to one page.");
    expect(p).toContain('- Give extra weight to these skills where my evidence supports them: "RAG".');
    expect(p).toMatch(/NOTE-[0-9a-f]{16} START\nUse Australian spelling\.\nNOTE-[0-9a-f]{16} END/);
    expect(p.split("\n\n").at(-1)!.split("\n")[0]).toBe("Rules:");
    expect(p).toContain(ACTION_RULES[3]);
    expect(bridge.calls.find((c) => c.method === "claude.saveOptions")?.args[2]).toMatchObject({ resume_length: "1", emphasis: ["RAG"] });
    expect(await screen.findByText(/^Tailoring your resume and cover letter for/)).toBeInTheDocument();
    // Options are saved before the run, so a one-click request uses them.
    const m = bridge.calls.map((c) => c.method);
    expect(m.indexOf("claude.saveOptions")).toBeLessThan(m.indexOf("claude.run"));
  });

  it("when Claude isn't set up, says so and doesn't start", async () => {
    const bridge = new MockBridge({ claudeEngine: { consent: false } });
    renderApp(<RequestComposer action="tailor_application" target={JOB} />, { bridge });
    expect(await screen.findByText("Set up Claude first. The Claude setup button is just below.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tailor application" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Claude setup" })).toBeInTheDocument();
    expect(bridge.calls.some((c) => c.method === "claude.run")).toBe(false);
  });

  it("Copy prompt (the quiet fallback) copies the same composed prompt, with full paths", async () => {
    renderApp(<RequestComposer action="research_company" target={JOB} />);
    await userEvent.click(await screen.findByRole("radio", { name: "Thorough" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Anything else?" }), "Look for their engineering blog.");
    await userEvent.click(screen.getByText("Full prompt"));
    const view = screen.getByLabelText("Full prompt");
    expect(view.textContent).toContain("Be thorough");
    expect(view.textContent).not.toContain("companies/example-labs");
    await userEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(clip).toHaveLength(1));
    expect(clip[0]).toContain("- Be thorough: read more sources and go deeper on each section.");
    expect(clip[0]).toContain('- Go deeper on: "Visa sponsorship", "Tech stack", "Contacts & careers page".');
    expect(clip[0]).toContain("Look for their engineering blog.");
    expect(clip[0]).toContain("- companies/example-labs/research.md");
    expect(await screen.findByText("Prompt copied")).toBeInTheDocument();
  });

  it("refuses a note that tries to escape, and limits the note to 1,000 characters", async () => {
    renderApp(<RequestComposer action="score_job" target={JOB} />);
    const box = await screen.findByRole("textbox", { name: "Anything else?" });
    expect(box).toHaveAttribute("maxLength", "1000");
    await userEvent.type(box, "Also write to me/identity");
    expect(screen.getByText(/can't open locked folders/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Score" })).toBeDisabled();
    await userEvent.click(screen.getByText("Full prompt"));
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeDisabled();
  });

  it("remembers the options per action and job", async () => {
    const bridge = new MockBridge();
    const first = renderApp(<RequestComposer action="research_company" target={JOB} />, { bridge });
    await userEvent.click(await screen.findByRole("radio", { name: "Thorough" }));
    await userEvent.click(screen.getByRole("button", { name: "Culture" }));
    await userEvent.click(screen.getByRole("button", { name: "Research company" }));
    await waitFor(() => expect(bridge.savedOptions.size).toBe(1));
    first.unmount();
    renderApp(<RequestComposer action="research_company" target={JOB} />, { bridge });
    expect(await screen.findByRole("radio", { name: "Thorough" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Culture" })).toHaveAttribute("aria-pressed", "true");
    // A one-click request on the same job uses them too.
    const r = await bridge.claude.prepare("research_company", JOB, false);
    expect(r.prompt).toContain("- Be thorough");
  });

  it("offers skill chips from the job and the profile", async () => {
    const bridge = new MockBridge();
    renderApp(<RequestComposer action="tailor_application" target={JOB} />, { bridge });
    for (const n of ["agents", "RAG", "TypeScript"]) await userEvent.click(await screen.findByRole("button", { name: n }));
    for (const n of ["agents", "RAG", "TypeScript"]) expect(screen.getByRole("button", { name: n })).toHaveAttribute("aria-pressed", "true");
  });

  it("the Job screen offers the composer for an action in a dialog", async () => {
    renderApp(<JobScreen route={ACME} />);
    await userEvent.click(await screen.findByRole("button", { name: "Choose how: Research company" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("heading", { name: "Claude will research Acme Corp from public pages and cite every fact." })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Quick" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Research company" })).toBeEnabled();
  });
});

describe("composer labels", () => {
  it("names files in plain words and marks optional ones", () => {
    expect(fileChips(["a/resume.md", "a/cover-letter.md", "a/claims.json"], ["a/answers.md"]).map((f) => [f.label, f.optional])).toEqual([
      ["Resume", false], ["Cover letter", false], ["Claim check", false], ["Answers", true],
    ]);
    expect(fileChips(["knowledge/job-searches/2026-01-15.md"], []).map((f) => f.label)).toEqual(["Search report"]);
  });

  it("shortens workspace paths for reading", () => {
    expect(displayPrompt("Job: x (folder companies/acme-corp/jobs/2026-01-12-ai-engineer).\n- companies/acme-corp/jobs/2026-01-12-ai-engineer/application/resume.md\nCompany: y (folder companies/acme-corp)."))
      .toBe("Job: x (folder the job folder).\n- …/application/resume.md\nCompany: y (company folder).");
  });
});

describe("RequestComposer follows the candidate's work rights", () => {
  const WORKSPACE = { kind: "workspace" } as const;
  const COMPANY = { kind: "company", company_slug: "example-labs" } as const;
  async function as(status: string) {
    const b = new MockBridge();
    await b.settings.save("profile", [{ path: "work_rights.status", value: status }]);
    return b;
  }
  const start = async (b: MockBridge, n: number) => {
    await userEvent.click(screen.getByRole("button", { name: /^(Find jobs|Research company)$/ }));
    return startedPrompt(b, n);
  };

  it("citizen: no sponsor-only toggle, no sponsorship chip, and no sponsorship in either prompt", async () => {
    const bridge = await as("citizen");
    const { unmount } = renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} />, { bridge });
    await screen.findByRole("button", { name: /^Breadth: Focused/ });
    expect(screen.queryByRole("switch", { name: "Only ads that offer sponsorship" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Sponsorship: / })).toBeNull();
    expect(await start(bridge, 1)).not.toMatch(/sponsorship/i);
    unmount();
    renderApp(<RequestComposer action="research_company" target={COMPANY} />, { bridge });
    await screen.findByRole("button", { name: "Tech stack" });
    expect(screen.queryByRole("button", { name: "Visa sponsorship" })).toBeNull();
    expect(await start(bridge, 2)).not.toMatch(/sponsorship/i);
  });

  it("needs sponsorship: the toggle shows (as a quick filter), the sponsorship chip is on by default, and both prompts say so", async () => {
    const bridge = await as("needs_sponsorship");
    const { unmount } = renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: /^Sponsorship: .*Change$/ }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Only ads that offer sponsorship" }));
    await userEvent.keyboard("{Escape}");
    const p = await start(bridge, 1);
    expect(p).toContain("Put ads that offer visa sponsorship first in the report.");
    expect(p).toContain("- Keep only ads that say they offer visa sponsorship.");
    unmount();
    renderApp(<RequestComposer action="research_company" target={COMPANY} />, { bridge });
    expect(await screen.findByRole("button", { name: "Visa sponsorship" })).toHaveAttribute("aria-pressed", "true");
    const r = await start(bridge, 2);
    expect(r).toContain("any visa sponsorship evidence with its URL");
    expect(r).toContain('Go deeper on: "Visa sponsorship", "Tech stack", "Contacts & careers page".');
  });

  it("full visa: no sponsor-only toggle; the sponsorship chip is offered but off by default", async () => {
    const bridge = await as("full_visa");
    const { unmount } = renderApp(<RequestComposer action="find_jobs" target={WORKSPACE} />, { bridge });
    await screen.findByRole("button", { name: /^Breadth: Focused/ });
    expect(screen.queryByRole("switch", { name: "Only ads that offer sponsorship" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Sponsorship: / })).toBeNull();
    expect(await start(bridge, 1)).toContain("Note any sponsorship offer, but don't rank by it.");
    unmount();
    renderApp(<RequestComposer action="research_company" target={COMPANY} />, { bridge });
    expect(await screen.findByRole("button", { name: "Visa sponsorship" })).toHaveAttribute("aria-pressed", "false");
    const r = await start(bridge, 2);
    expect(r).toContain("any visa sponsorship evidence with its URL");
    expect(r).toContain('Go deeper on: "Tech stack", "Contacts & careers page".');
  });
});
