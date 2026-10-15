import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { DEMO_SCORE, DEMO_SCORE_MD } from "../src/score/demo";
import { gapsOf } from "../src/score/tiers";
import { renderApp } from "./render";

const ACME = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "score" } as const;
const BASE = "companies/acme-corp/jobs/2026-01-12-ai-engineer";

function bridgeWith(texts: Record<string, string>) {
  const f = loadFixture();
  Object.assign(f.texts, texts);
  return new MockBridge({ fixture: f });
}

describe("Job › Score card", () => {
  it("shows the structured score: fit, tier, odds, checklist, what would change it, and the write-up folded away", async () => {
    const bridge = bridgeWith({
      [`${BASE}/score.json`]: JSON.stringify({ ...DEMO_SCORE, scored_at: "2026-01-14T09:00:00.000Z" }),
      [`${BASE}/score.md`]: `${DEMO_SCORE_MD}\nEvidence from me/resumes/alex-example.pdf (Workflow 2, job evaluation).\n`,
    });
    const { container } = renderApp(<JobScreen route={ACME} />, { bridge });
    expect(await screen.findByRole("meter", { name: "Fit score" })).toHaveAttribute("aria-valuenow", "72");
    const tier = container.querySelector(".score-card .pill")!;
    expect(tier).toHaveTextContent("Good Fit");
    expect(tier.className).toContain("pill--success");
    expect(screen.getByText("Interview odds").nextElementSibling).toHaveTextContent("64%");
    expect(screen.getByText("Scored").nextElementSibling).toHaveTextContent("14 Jan 2026");
    expect(screen.getByText(DEMO_SCORE.recommendation)).toBeInTheDocument();

    const must = screen.getByRole("region", { name: "Must-haves" });
    expect(within(must).getByText("2 of 4 met")).toBeInTheDocument();
    expect(within(must).getAllByText("Met")).toHaveLength(2);
    expect(within(must).getByText("Partial")).toBeInTheDocument();
    expect(within(must).getByText("Not met")).toBeInTheDocument();
    expect(within(must).getByText("Your profile lists Kubernetes basics only.")).toBeInTheDocument();

    // Long evidence opens on click.
    const toggle = within(must).getByRole("button", { name: /Built LLM or RAG features/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const changes = screen.getByRole("region", { name: "What would change this" });
    expect(within(changes).getAllByRole("listitem")).toHaveLength(3);

    const writeup = container.querySelector("details.score-writeup") as HTMLDetailsElement;
    expect(writeup.open).toBe(false);
    expect(within(writeup).getByText("Full write-up")).toBeInTheDocument();
    // The write-up's table is a table, and no path or internal label is shown anywhere.
    expect(within(writeup).getByRole("table")).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\|\s*#\s*\|/);
    expect(text).not.toMatch(/me\/resumes|\.pdf|Workflow 2/);
    expect(screen.queryByText(/not set/i)).toBeNull();
  });

  it("reads an older write-up's fit, with no tier invented, and says scoring again adds the checklist", async () => {
    const bridge = bridgeWith({ [`${BASE}/score.md`]: "# Score\n\n**Fit score: 52 / 100**\n\n| # | Must-have | Status |\n|---|---|---|\n| 1 | Python | Met |\n" });
    renderApp(<JobScreen route={ACME} />, { bridge });
    expect(await screen.findByRole("meter", { name: "Fit score" })).toHaveAttribute("aria-valuenow", "52");
    expect(screen.queryByText(/Fit not set/)).toBeNull();
    for (const t of ["Definite No Go", "Nah", "Meh", "Good Fit", "Freaking Apply Now"]) expect(screen.queryByText(t)).toBeNull();
    expect(screen.getByText(/Score again to see each must-have/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Score again" })).toBeInTheDocument();
  });

  it("shows an empty state with Score this job when unscored", async () => {
    renderApp(<JobScreen route={ACME} />, { bridge: bridgeWith({}) });
    expect(await screen.findByText(/Not scored yet/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Score" })).toBeInTheDocument();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("Study these gaps starts a topic with the gaps offered, the first one filled in", async () => {
    const bridge = bridgeWith({ [`${BASE}/score.json`]: JSON.stringify(DEMO_SCORE) });
    renderApp(<JobScreen route={ACME} />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "Study gaps" }));
    const dialog = await screen.findByRole("dialog", { name: "Start a topic" });
    expect(within(dialog).getByLabelText("What do you want to learn?")).toHaveValue("Kafka or another event streaming platform");
    expect(within(dialog).getByRole("button", { name: "Kubernetes in production" })).toBeInTheDocument();
  });

  it("Tailor resume opens Resume Studio when there is a tailored resume", async () => {
    const f = loadFixture();
    f.texts[`${BASE}/score.json`] = JSON.stringify(DEMO_SCORE);
    const acme = f.jobs.find((x) => x.job.company_slug === "acme-corp")!;
    acme.job.files.push({ path: "application/resume.md", label: "Resume", at: "2026-01-14T09:00:00.000Z" });
    renderApp(<JobScreen route={ACME} />, { bridge: new MockBridge({ fixture: f }) });
    await userEvent.click(await screen.findByRole("button", { name: "Tailor resume" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/resume/acme-corp/2026-01-12-ai-engineer/resume.md`));
  });

  it("Score again asks Claude to score the job again, even though a score is saved", async () => {
    const bridge = bridgeWith({ [`${BASE}/score.json`]: JSON.stringify(DEMO_SCORE), [`${BASE}/score.md`]: DEMO_SCORE_MD });
    renderApp(<JobScreen route={ACME} />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "Score again" }));
    await waitFor(() => expect(bridge.claudeSim.requests).toHaveLength(1));
    expect(bridge.claudeSim.requests[0]).toMatchObject({ action: "score_job", target: { kind: "job", company_slug: "acme-corp" } });
  });

  it("a score run in the preview saves a structured score that the card and the Jobs list read", async () => {
    const bridge = bridgeWith({});
    bridge.simulateActionOutput("score_job", { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" });
    renderApp(<JobScreen route={ACME} />, { bridge });
    expect(await screen.findByRole("meter", { name: "Fit score" })).toHaveAttribute("aria-valuenow", String(DEMO_SCORE.fit));
    const list = await bridge.jobs.list({});
    expect(list.rows.find((r) => r.company_slug === "acme-corp")?.fit).toBe(DEMO_SCORE.fit);
  });
});

describe("gapsOf", () => {
  it("puts not-met before partial, else falls back to the job's gaps", () => {
    expect(gapsOf({ ...DEMO_SCORE, must_haves: [...DEMO_SCORE.must_haves], nice_to_haves: [], changes: [], scored_at: "", source: "structured" } as never, ["X"]))
      .toEqual(["Kafka or another event streaming platform", "Kubernetes in production"]);
    expect(gapsOf(null, ["Kafka"])).toEqual(["Kafka"]);
  });
});
