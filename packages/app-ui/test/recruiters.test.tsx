import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AgencyRecordView } from "@careeros/contract";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { parseHash, toHash } from "../src/router";
import { RecruitersScreen } from "../src/screens/Recruiters";
import { renderApp } from "./render";

const at = (local: string) => local + "@" + "example.com";

/** The sample's Acme Recruiting, plus a second fictional agency with no saved job and a person-named contact. */
function bridgeWith(status = "citizen") {
  const f = loadFixture();
  (f.profile as { work_rights: { status: string } }).work_rights.status = status;
  const base = f.agencies![0]!;
  const other: AgencyRecordView = {
    ...structuredClone(base), name: "Example Labs Talent", slug: "example-labs-talent", since: null, specialties: ["Data"], tags: ["Data"], cities: ["Exampleville"],
    hiring_summary: "", job_refs: [], team_note: { text: "", source_url: "" }, timeline: [],
    best_contact: { name: "Alex Example", source_url: "https://talent.example.com/contact" },
    contacts: [{ kind: "email", value: at("talent"), label: "", source_url: "https://talent.example.com/contact", found_on: "", confirmed: true }],
  };
  f.agencies = [base, other];
  return new MockBridge({ fixture: f });
}
const cardOf = (name: string) => screen.getByRole("article", { name });

afterEach(() => { cleanup(); window.location.hash = ""; });

describe("Recruiters", () => {
  it("has its own route", () => {
    expect(parseHash("#/recruiters")).toEqual({ screen: "recruiters" });
    expect(toHash({ screen: "recruiters" })).toBe("#/recruiters");
  });

  it("shows a card: name, subtitle, tags, hiring summary, team note, contacts and the published-only note", async () => {
    renderApp(<RecruitersScreen />, { bridge: bridgeWith() });
    const card = await screen.findByRole("article", { name: "Acme Recruiting" });
    expect(within(card).getByText("Technology, Government · Sampletown · since 2009")).toBeInTheDocument();
    expect(within(within(card).getByRole("list", { name: "Tags" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["IT specialist", "Government", "AI"]);
    expect(within(card).getByText(/Has a live AI Developer role/)).toBeInTheDocument();
    expect(within(card).getByRole("note")).toHaveTextContent("Team page names a technology recruitment lead");
    expect(within(card).getByText(at("jobs"))).toBeInTheDocument();
    for (const name of ["Website", "About / team", "Sampletown contact"]) expect(within(card).getByRole("button", { name })).toBeInTheDocument();
    expect(within(card).queryByText(/Best reached through/)).toBeNull();
    expect(within(cardOf("Example Labs Talent")).getByText(/Best reached through Alex Example/)).toBeInTheDocument();
    expect(screen.getByText("Only contact details recruiters publish. Check before sending.")).toBeInTheDocument();
    // Email needs only a published address, not a saved job.
    expect(within(cardOf("Example Labs Talent")).getByRole("button", { name: "Email Example Labs Talent" })).toBeEnabled();
  });

  it("filters by search words, tag and city", async () => {
    renderApp(<RecruitersScreen />, { bridge: bridgeWith() });
    await screen.findByRole("article", { name: "Acme Recruiting" });
    await userEvent.type(screen.getByLabelText("Search"), "data");
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-labelledby") && within(a).getByRole("heading").textContent)).toEqual(["Example Labs Talent"]);
    await userEvent.clear(screen.getByLabelText("Search"));
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "AI");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Acme Recruiting"]);
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "");
    await userEvent.selectOptions(screen.getByLabelText("City"), "Exampleville");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Example Labs Talent"]);
    expect(screen.queryByLabelText("Ads open to visa holders")).toBeNull();
  });

  it("saves status, dates, notes and the star, with a follow-up five business days after contact", async () => {
    const b = bridgeWith();
    renderApp(<RecruitersScreen />, { bridge: b });
    const card = await screen.findByRole("article", { name: "Acme Recruiting" });
    fireEvent.change(within(card).getByLabelText("Contacted"), { target: { value: "2026-10-15" } });
    await waitFor(() => expect(within(cardOf("Acme Recruiting")).getByLabelText("Follow up")).toHaveValue("2026-10-22"));
    expect(within(cardOf("Acme Recruiting")).getByLabelText("Status")).toHaveValue("contacted");
    await userEvent.selectOptions(within(cardOf("Acme Recruiting")).getByLabelText("Status"), "replied");
    const notes = within(cardOf("Acme Recruiting")).getByPlaceholderText(/Notes: who you spoke to/);
    await userEvent.type(notes, "Asked about contract roles");
    fireEvent.blur(notes);
    await userEvent.click(within(cardOf("Acme Recruiting")).getByRole("button", { name: "Star Acme Recruiting" }));
    await waitFor(async () => expect((await b.recruiters.list()).find((r) => r.slug === "acme-recruiting")).toMatchObject({
      favourite: true, tracking: { status: "replied", contacted_on: "2026-10-15", follow_up_on: "2026-10-22", notes: "Asked about contract roles" },
    }));
  });

  it("bulk: one templated general enquiry per agency, kept with its company, with the resume chosen once and the sponsorship line", async () => {
    const b = bridgeWith("needs_sponsorship");
    const f = b as unknown as { f: { agencies: AgencyRecordView[] } };
    f.f.agencies.push({ ...structuredClone(f.f.agencies[1]!), name: "Acme Talent", slug: "acme-talent", contacts: [] });
    renderApp(<RecruitersScreen />, { bridge: b });
    await screen.findByRole("article", { name: "Acme Recruiting" });
    for (const n of ["Acme Recruiting", "Example Labs Talent", "Acme Talent"]) await userEvent.click(screen.getByLabelText(`Select ${n}`));
    const bar = screen.getByRole("toolbar", { name: "Selected recruiters" });
    expect(bar).toHaveTextContent("3 selected");
    await userEvent.click(within(bar).getByRole("button", { name: "Email selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Email 3 recruiters" });
    expect(within(dialog).getByText(/1 agency without a published address will be skipped/)).toBeInTheDocument();
    expect(within(dialog).getByRole("note")).toHaveTextContent("Up to 20 at a time.");
    expect(within(dialog).getByLabelText("Resume to attach")).toHaveValue("me/resumes/alex-example-resume.pdf");
    expect(within(dialog).getByLabelText("Ask about sponsorship")).toBeChecked();
    await userEvent.click(await within(dialog).findByRole("button", { name: "Write 2 drafts" }));
    expect(await screen.findByText(/2 drafts saved in Mail › Drafts\. 1 agency skipped: no published address\./)).toBeInTheDocument();
    const saves = b.calls.filter((c) => c.method === "mail.drafts.save").map((c) => c.args as [string, string, string, { to: string; subject: string; body: string; attach: string[] }]);
    expect(saves.map(([s, id, d, x]) => [s, id, d, x.to, x.attach])).toEqual([
      ["acme-recruiting", "", "", at("jobs"), ["companies/acme-recruiting/emails/outgoing/alex-example-resume.pdf"]],
      ["example-labs-talent", "", "", at("talent"), ["companies/example-labs-talent/emails/outgoing/alex-example-resume.pdf"]],
    ]);
    expect(saves[1]![3].subject).toBe("Enquiry: Data roles – Alex Example");
    for (const [, , , x] of saves) expect(x.body).toContain("would need sponsorship");
    expect(b.calls.filter((c) => c.method === "recruiters.mailbox").map((c) => c.args[0])).toEqual(["acme-recruiting", "example-labs-talent"]);
    // The selection is cleared once the drafts are written; select again to mark contacted.
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected recruiters" })).toBeNull());
  });

  it("bulk: never more than 20 drafts in one go", async () => {
    const b = bridgeWith();
    const f = b as unknown as { f: { agencies: AgencyRecordView[] } };
    for (let i = 0; i < 22; i++) f.f.agencies.push({ ...structuredClone(f.f.agencies[1]!), name: `Example Agency ${i}`, slug: `example-agency-${i}` });
    renderApp(<RecruitersScreen />, { bridge: b });
    await screen.findByRole("article", { name: "Acme Recruiting" });
    for (const box of screen.getAllByLabelText(/^Select /)) await userEvent.click(box);
    await userEvent.click(within(screen.getByRole("toolbar", { name: "Selected recruiters" })).getByRole("button", { name: "Email selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Email 24 recruiters" });
    expect(within(dialog).getByRole("note")).toHaveTextContent("4 more selected than that");
    await userEvent.selectOptions(within(dialog).getByLabelText("Resume to attach"), "");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Write 20 drafts" }));
    expect(await screen.findByText(/20 drafts saved in Mail › Drafts\. 4 left for another batch\./)).toBeInTheDocument();
    expect(b.calls.filter((c) => c.method === "recruiters.attachResume")).toEqual([]);
    expect(b.calls.filter((c) => c.method === "mail.drafts.save")).toHaveLength(20);
  }, 30_000);

  it("marks selected agencies contacted", async () => {
    const b = bridgeWith();
    renderApp(<RecruitersScreen />, { bridge: b });
    await screen.findByRole("article", { name: "Acme Recruiting" });
    await userEvent.click(screen.getByLabelText("Select Acme Recruiting"));
    await userEvent.click(screen.getByLabelText("Select Example Labs Talent"));
    const bar = screen.getByRole("toolbar", { name: "Selected recruiters" });
    await userEvent.click(within(bar).getByRole("button", { name: "Mark contacted" }));
    await waitFor(() => expect(b.calls.filter((c) => c.method === "recruiters.update").map((c) => c.args[0])).toEqual(["acme-recruiting", "example-labs-talent"]));
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected recruiters" })).toBeNull());
  });

  it("Email: about a live job, with its tailored resume and the sponsorship question, saved as a draft", async () => {
    const user = userEvent.setup();
    const b = bridgeWith("needs_sponsorship");
    b.simulateClaudeOutput("acme-recruiting", "2026-01-12-ai-developer");
    renderApp(<RecruitersScreen />, { bridge: b });
    await user.click(await screen.findByRole("button", { name: "Email Acme Recruiting" }));
    const dialog = await screen.findByRole("dialog", { name: "Email Acme Recruiting" });
    expect(within(dialog).getByLabelText("What it's about")).toHaveValue("2026-01-12-ai-developer");
    expect(await within(dialog).findByText("Your tailored resume for AI Developer is attached.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Ask about sponsorship")).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Write email" }));
    const editor = await within(dialog).findByRole("form", { name: "Email draft" });
    expect(within(editor).getByLabelText("Subject")).toHaveValue("AI Developer – Alex Example");
    expect((within(editor).getByLabelText("Message") as HTMLTextAreaElement).value).toContain("I hold a subclass 485 visa and would need sponsorship.");
    await user.click(within(editor).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(b.calls.find((c) => c.method === "mail.drafts.save")?.args).toEqual(["acme-recruiting", "2026-01-12-ai-developer", "",
      expect.objectContaining({ to: at("jobs"), attach: ["companies/acme-recruiting/jobs/2026-01-12-ai-developer/application/resume.md"] })]));
    // The draft shows on the agency's timeline.
    await waitFor(async () => expect((await b.recruiters.list()).find((r) => r.slug === "acme-recruiting")!.activity.map((e) => e.event)).toContain("Email drafted"));
  });

  it("Email: a general enquiry, no tailored resume (tailor first is offered), sponsorship turned off", async () => {
    const user = userEvent.setup();
    const b = bridgeWith("needs_sponsorship");
    renderApp(<RecruitersScreen />, { bridge: b });
    await user.click(await screen.findByRole("button", { name: "Email Acme Recruiting" }));
    const dialog = await screen.findByRole("dialog", { name: "Email Acme Recruiting" });
    expect(await within(dialog).findByRole("button", { name: "Tailor first" })).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("What it's about"), "general");
    expect(within(dialog).queryByRole("button", { name: "Tailor first" })).toBeNull();
    await user.click(within(dialog).getByLabelText("Ask about sponsorship"));
    await user.click(within(dialog).getByRole("button", { name: "Write email" }));
    const editor = await within(dialog).findByRole("form", { name: "Email draft" });
    expect(within(editor).getByLabelText("Subject")).toHaveValue("Enquiry: Technology roles – Alex Example");
    expect((within(editor).getByLabelText("Message") as HTMLTextAreaElement).value).not.toMatch(/sponsor/i);
  });

  it("Email: an agency with no saved job gets a company folder and a general enquiry kept there, with one of your resumes", async () => {
    const user = userEvent.setup();
    const b = bridgeWith();
    renderApp(<RecruitersScreen />, { bridge: b });
    await user.click(await screen.findByRole("button", { name: "Email Example Labs Talent" }));
    const dialog = await screen.findByRole("dialog", { name: "Email Example Labs Talent" });
    expect(within(dialog).getByLabelText("What it's about")).toHaveValue("general");
    expect(within(dialog).getByText("Kept with Example Labs Talent in your mail, not with a job.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Tailor first" })).toBeNull();
    await user.click(await within(dialog).findByRole("button", { name: "Attach resume" }));
    expect(await within(dialog).findByText("Your resume is attached.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Write email" }));
    const editor = await within(dialog).findByRole("form", { name: "Email draft" });
    expect(within(editor).getByLabelText("Subject")).toHaveValue("Enquiry: Data roles – Alex Example");
    await user.click(within(editor).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(b.calls.find((c) => c.method === "mail.drafts.save")?.args).toEqual(["example-labs-talent", "", "",
      expect.objectContaining({ to: at("talent"), attach: ["companies/example-labs-talent/emails/outgoing/alex-example-resume.pdf"] })]));
    expect(b.calls.filter((c) => c.method === "recruiters.mailbox").map((c) => c.args[0])).toContain("example-labs-talent");
    expect(b.calls.find((c) => c.method === "recruiters.attachResume")?.args).toEqual(["example-labs-talent", "", "me/resumes/alex-example-resume.pdf"]);
    await waitFor(async () => expect((await b.recruiters.list()).find((r) => r.slug === "example-labs-talent")!.activity.map((e) => e.event)).toContain("Email drafted"));
  });

  it("never offers the sponsorship question to someone who doesn't need sponsorship", async () => {
    const user = userEvent.setup();
    renderApp(<RecruitersScreen />, { bridge: bridgeWith("citizen") });
    await user.click(await screen.findByRole("button", { name: "Email Acme Recruiting" }));
    const dialog = await screen.findByRole("dialog", { name: "Email Acme Recruiting" });
    await within(dialog).findByLabelText("What it's about");
    expect(within(dialog).queryByLabelText("Ask about sponsorship")).toBeNull();
  });

  it("shows a timeline on the card", async () => {
    renderApp(<RecruitersScreen />, { bridge: bridgeWith() });
    const card = await screen.findByRole("article", { name: "Acme Recruiting" });
    await userEvent.click(within(card).getByText("Timeline (1)"));
    expect(within(within(card).getByRole("list", { name: "Acme Recruiting timeline" })).getByText("Advertised a job")).toBeInTheDocument();
  });

  it("shows the sponsorship filter only to people who need sponsorship", async () => {
    renderApp(<RecruitersScreen />, { bridge: bridgeWith("needs_sponsorship") });
    await screen.findByRole("article", { name: "Acme Recruiting" });
    await userEvent.click(screen.getByLabelText("Ads open to visa holders"));
    expect(await screen.findByText("No recruiters match these filters.")).toBeInTheDocument();
  });
});
