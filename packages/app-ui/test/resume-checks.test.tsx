import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ExportPanel } from "../src/components/ExportPanel";
import { MockBridge } from "../src/mock/MockBridge";
import { ApplyScreen } from "../src/screens/Apply";
import { renderApp } from "./render";

// Fictional data only (Alex Example, Example Labs). Spec: docs/specs/2026-10-17-resume-checks.md.
const LABS = { slug: "example-labs", id: "2026-01-12-backend-engineer-llm" } as const;
const ROUTE = { screen: "apply", ...LABS } as const;

describe("ATS check in the Export card", () => {
  it("asks for an export first, then lists pass and check rows for the exported resume", async () => {
    const b = new MockBridge();
    b.simulateClaudeOutput(LABS.slug, LABS.id);
    renderApp(<ExportPanel {...LABS} />, { bridge: b });
    expect(await screen.findByText("Export your resume to see how an applicant tracking system reads it.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    const list = await screen.findByLabelText("ATS check");
    expect(within(list).getByText("Text reads cleanly")).toBeInTheDocument();
    // The mock resume is short and has no Experience heading, so those rows ask for a look.
    expect(within(list).getByText(/No Experience, Education or Skills heading/)).toBeInTheDocument();
    expect(b.calls.some((c) => c.method === "docs.check")).toBe(true);
  });
});

const REVIEW = {
  edits: [{ file: "resume.md", old: "Led retrieval work", new: "Built retrieval pipelines", reason: "grounding", why: "No source says led." }],
  stretch: [{ file: "resume.md", text: "AI Engineer. Built retrieval pipelines (fictional).", why: "The title isn't in your history.", soften: "Engineer. Built retrieval pipelines (fictional)." }],
  facts: [{ fact: "Mentored 2 graduates in 2025", source: "your note" }],
  notes: "One stretch to answer.",
};

describe("Claude's review on the Apply screen", () => {
  it("shows stretches and facts; It's true and Save confirm them", async () => {
    const b = new MockBridge();
    b.simulateClaudeOutput(LABS.slug, LABS.id);
    b.simulateReview(LABS.slug, LABS.id, REVIEW);
    renderApp(<ApplyScreen route={ROUTE} />, { bridge: b });
    const card = await screen.findByLabelText("Claude's review");
    expect(within(card).getByText("One stretch to answer.")).toBeInTheDocument();
    expect(within(card).getByText("Could you defend these in an interview? (1 to answer)")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: /It's true/ }));
    expect(await within(card).findByText("Kept: saved to your history")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Save to my work history: Mentored 2 graduates in 2025" }));
    expect(await within(card).findByText("Saved")).toBeInTheDocument();
    expect(b.calls.filter((c) => c.method === "apply.stretch" || c.method === "apply.saveFact").map((c) => c.method)).toEqual(["apply.stretch", "apply.saveFact"]);
  });

  it("has no review card before Claude's second pass", async () => {
    const b = new MockBridge();
    b.simulateClaudeOutput(LABS.slug, LABS.id);
    renderApp(<ApplyScreen route={ROUTE} />, { bridge: b });
    await screen.findByText("Built retrieval pipelines");
    expect(screen.queryByLabelText("Claude's review")).toBeNull();
  });
});
