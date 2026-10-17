import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ACTIONS, buildActionPrompt } from "@careeros/contract";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { renderApp } from "./render";

const ROUTE = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "outreach" } as const;
const BASE = "companies/acme-corp/jobs/2026-01-12-ai-engineer";
const TARGET = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;

// Fictional note for Alex Example.
const NOTE = [
  "## Note",
  "Subject: AI Engineer role",
  "Hi,",
  "I've applied for the AI Engineer role. At Example Labs I shipped a retrieval assistant used by 40 staff.",
  "Regards,",
  "Alex",
  "## LinkedIn connection note",
  "Hi, I've applied for the AI Engineer role at Acme Corp and built a retrieval assistant at Example Labs. Keen to connect.",
].join("\n");

function bridgeWith(texts: Record<string, string>) {
  const f = loadFixture();
  Object.assign(f.texts, texts);
  return new MockBridge({ fixture: f });
}

describe("outreach_note action", () => {
  it("writes outreach.md in the job folder, names one real result and never sends", () => {
    expect(ACTIONS.outreach_note.target).toBe("job");
    const p = buildActionPrompt("outreach_note", TARGET, { title: "AI Engineer", company: "Acme Corp" }, null, "0123456789abcdef");
    expect(p).toContain(`- ${BASE}/outreach.md`);
    expect(p).toContain("one result from my evidence");
    expect(p).toContain("at most 300 characters");
    expect(p).toContain("Never claim a referral");
    expect(p).toContain("Do not submit anything");
  });
});

describe("Job › Outreach", () => {
  it("offers Draft note, then shows the note with Open in Mail (no address) and the LinkedIn note with its length", async () => {
    const bridge = bridgeWith({ [`${BASE}/outreach.md`]: NOTE });
    renderApp(<JobScreen route={ROUTE} />, { bridge });
    expect(await screen.findByText(/shipped a retrieval assistant used by 40 staff/)).toBeInTheDocument();
    expect(screen.getByText(/of 300 characters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy for LinkedIn" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open in Mail" }));
    expect(await screen.findByDisplayValue("AI Engineer role")).toBeInTheDocument();
    // Nothing was saved or sent: the draft waits in the editor.
    expect(bridge.calls.some((c) => c.method.startsWith("mail.send"))).toBe(false);
  });

  it("says Follow up due a week after applying and opens a ready follow-up draft", async () => {
    const f = loadFixture();
    const j = f.jobs.find((x) => x.job.id === TARGET.id)!.job;
    j.status = "Applied";
    j.timeline.push({ at: new Date(Date.now() - 9 * 86_400_000).toISOString(), event: "Status: Applied", note: "" });
    renderApp(<JobScreen route={ROUTE} />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByText("Follow up due")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open follow-up draft" }));
    expect(await screen.findByDisplayValue("Following up: AI Engineer application")).toBeInTheDocument();
  });

  it("offers a thank-you draft after an interview", async () => {
    const f = loadFixture();
    f.jobs.find((x) => x.job.id === TARGET.id)!.job.status = "Interview";
    renderApp(<JobScreen route={ROUTE} />, { bridge: new MockBridge({ fixture: f }) });
    await userEvent.click(await screen.findByRole("button", { name: "Open thank-you draft" }));
    expect(await screen.findByDisplayValue("Thank you: AI Engineer interview")).toBeInTheDocument();
  });

  it("shows only the Draft note button before there is a note", async () => {
    renderApp(<JobScreen route={ROUTE} />, { bridge: bridgeWith({}) });
    expect(await screen.findByText("Note to the hiring manager")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in Mail" })).toBeNull();
  });
});

describe("Follow-up limit and thank-you prompt", () => {
  const job = (f: ReturnType<typeof loadFixture>) => f.jobs.find((j) => j.job.company_slug === "acme-corp" && j.job.id === "2026-01-12-ai-engineer")!.job;
  it("after two follow-ups, Outreach says why there is no third and offers no draft", async () => {
    const f = loadFixture();
    const j = job(f);
    j.status = "Applied";
    j.timeline.push({ at: "2026-01-20T00:00:00.000Z", event: "Status: Applied", note: "" },
      { at: "2026-01-27T00:00:00.000Z", event: "Email sent", note: "Following up: AI Engineer application" },
      { at: "2026-02-03T00:00:00.000Z", event: "Email sent", note: "Following up: AI Engineer application" });
    renderApp(<JobScreen route={ROUTE} />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByText(/You've followed up twice/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open follow-up draft" })).not.toBeInTheDocument();
  });
  it("once an interview is logged, the job page offers the thank-you note", async () => {
    const f = loadFixture();
    const j = job(f);
    j.status = "Interview";
    j.timeline.push({ at: "2026-02-01T00:00:00.000Z", event: "Status: Interview", note: "" });
    renderApp(<JobScreen route={{ ...ROUTE, tab: "description" }} />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByRole("region", { name: "Thank-you note" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open the thank-you draft in Outreach" }));
    expect(window.location.hash).toContain("outreach");
  });
});
