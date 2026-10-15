import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { termChip } from "../src/score/KeywordGap";
import { renderApp } from "./render";

const ACME = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "score" } as const;
const BASE = "companies/acme-corp/jobs/2026-01-12-ai-engineer";
const TARGET = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;

// A fictional tailored resume for Alex Example.
const RESUME = [
  "# Alex Example",
  "AI engineer: Python and LLMs",
  "## Experience",
  "### Engineer, Example Labs",
  "- Shipped a RAG assistant",
  "- Wrote evals",
  "- Some TypeScript on the side",
].join("\n");

function bridgeWith(texts: Record<string, string>) {
  const f = loadFixture();
  Object.assign(f.texts, texts);
  if (texts[`${BASE}/application/resume.md`]) {
    f.jobs.find((j) => j.job.id === TARGET.id)!.job.files.push({ path: "application/resume.md", label: "Tailored resume", at: "2026-01-14T09:00:00.000Z" });
  }
  return new MockBridge({ fixture: f });
}

describe("Job › Score › Keyword check", () => {
  it("compares the ad with the tailored resume and hands only ticked terms to tailoring", async () => {
    const bridge = bridgeWith({ [`${BASE}/application/resume.md`]: RESUME });
    renderApp(<JobScreen route={ACME} />, { bridge });
    expect(await screen.findByText(/% match$/)).toBeInTheDocument();
    const card = screen.getByLabelText("Keyword check");
    expect(within(card).getByText(/compared with your tailored resume/)).toBeInTheDocument();
    expect(within(card).getByText("Python")).toBeInTheDocument();
    // TypeScript sits only in a third bullet: a weak spot.
    expect(within(card).getByText(/Only in a weak spot/)).toBeInTheDocument();
    expect(within(card).getByText("TypeScript")).toBeInTheDocument();
    expect(within(card).getByText("Only add skills you really have.")).toBeInTheDocument();

    const use = within(card).getByRole("button", { name: "Use in tailoring" });
    expect(use).toBeDisabled();
    const pg = within(card).getByRole("checkbox", { name: "SQL" });
    await userEvent.click(pg);
    expect(use).toBeEnabled();
    await userEvent.click(use);
    const view = await bridge.claude.compose("tailor_application", TARGET);
    expect(view.options.ad_terms).toEqual(["SQL"]);
    expect(window.location.hash).toBe("#/apply/acme-corp/2026-01-12-ai-engineer?step=prepare");
  });

  it("asks for a readable resume when there is none", async () => {
    const bridge = bridgeWith({});
    renderApp(<JobScreen route={ACME} />, { bridge });
    expect(await screen.findByText(/to compare it with this ad/)).toBeInTheDocument();
  });

  it("turns terms into safe chips", () => {
    expect(termChip("CI/CD")).toBe("CI CD");
    expect(termChip("Node.js")).toBe("Node.js");
    expect(termChip("C++")).toBe("C++");
  });
});
