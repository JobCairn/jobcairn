import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgencyRecordView } from "@careeros/contract";
import { App } from "../src/App";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { parseHash, toHash } from "../src/router";
import { RecruiterScreen } from "../src/screens/Recruiter";
import { RecruitersScreen } from "../src/screens/Recruiters";
import { renderApp } from "./render";

const at = (local: string) => local + "@" + "example.com";

/**
 * The sample's Acme Recruiting (found on SEEK and a web search), plus a second fictional agency with no saved job, a
 * named recruiter and one source.
 */
function bridgeWith(status = "citizen") {
  const f = loadFixture();
  (f.profile as { work_rights: { status: string } }).work_rights.status = status;
  const base: AgencyRecordView = {
    ...f.agencies![0]!,
    sources: [
      { name: "SEEK", url: "https://www.seek.com.au/job/1", found_at: "2026-01-12" },
      { name: "Web search", url: "https://recruiting.example.com/about", found_at: "2026-01-13" },
    ],
  };
  const other: AgencyRecordView = {
    ...structuredClone(base), name: "Example Labs Talent", slug: "example-labs-talent", since: null, specialties: ["Data"], tags: ["Data"], cities: ["Exampleville"],
    hiring_summary: "", job_refs: [], team_note: { text: "", source_url: "" }, timeline: [],
    best_contact: { name: "Alex Example", source_url: "https://talent.example.com/contact" },
    contacts: [{ kind: "email", value: at("talent"), label: "", source_url: "https://talent.example.com/contact", found_on: "", confirmed: true }],
    people: [{ name: "Alex Example", title: "Data recruiter", email: at("alex"), phone: "", source_url: "https://talent.example.com/team", specialties: ["Data"], job_refs: [] }],
    sources: [{ name: "RCSA directory", url: "https://directory.example.org/agencies/example-labs-talent", found_at: "2026-01-10" }],
  };
  f.agencies = [base, other];
  return new MockBridge({ fixture: f });
}
const agencies = (b: MockBridge) => (b as unknown as { f: { agencies: AgencyRecordView[] } }).f.agencies;
/** The agencies in the table, top to bottom, read from each row's tick box. */
const shownNames = () => within(screen.getByRole("table", { name: "Recruiters" })).queryAllByRole("checkbox").map((c) => c.getAttribute("aria-label")!.replace(/^Select /, ""));
const rowOf = (name: string) => screen.getByRole("checkbox", { name: `Select ${name}` }).closest("tr")!;
const listed = async () => { await screen.findByRole("table", { name: "Recruiters" }); await screen.findByRole("checkbox", { name: "Select Acme Recruiting" }); };

afterEach(() => { cleanup(); window.location.hash = ""; });

describe("Recruiters routes", () => {
  it("has a list route with a page and an agency route with a tab", () => {
    expect(parseHash("#/recruiters")).toEqual({ screen: "recruiters" });
    expect(toHash({ screen: "recruiters" })).toBe("#/recruiters");
    expect(parseHash("#/recruiters?p=2")).toEqual({ screen: "recruiters", page: 2 });
    expect(parseHash("#/recruiter/acme-recruiting")).toEqual({ screen: "recruiter", slug: "acme-recruiting" });
    expect(parseHash("#/recruiter/acme-recruiting?tab=contacts")).toEqual({ screen: "recruiter", slug: "acme-recruiting", tab: "contacts" });
    expect(toHash({ screen: "recruiter", slug: "acme-recruiting", tab: "jobs" })).toBe("#/recruiter/acme-recruiting?tab=jobs");
    expect(parseHash("#/recruiter/Not A Slug").screen).toBe("home");
  });
});

describe("Recruiters list", () => {
  it("shows one row per agency: name, cities, tags, what it's hiring for, where it was found, status and follow-up", async () => {
    renderApp(<RecruitersScreen />, { bridge: bridgeWith() });
    await listed();
    expect(shownNames()).toEqual(["Acme Recruiting", "Example Labs Talent"]);
    const row = within(rowOf("Acme Recruiting"));
    expect(row.getByText("Acme Recruiting")).toBeInTheDocument();
    expect(row.getByText("recruiting.example.com · since 2009")).toBeInTheDocument();
    expect(row.getByText("Sampletown")).toBeInTheDocument();
    // The narrow Tags column shows the first tag and a count; all of them stay in its label.
    expect(row.getByText("IT specialist")).toBeInTheDocument();
    expect(row.getByText("+2")).toBeInTheDocument();
    expect(row.getByLabelText("Tags: IT specialist, Government, AI")).toBeInTheDocument();
    expect(row.getByText(/Has a live AI Developer role/)).toBeInTheDocument();
    expect(row.getByText("SEEK")).toBeInTheDocument();
    expect(row.getByText("+1")).toBeInTheDocument();
    expect(row.getByText("To contact")).toBeInTheDocument();
    // No agency has a follow-up date, so the Follow up column steps aside.
    expect(screen.queryByRole("columnheader", { name: /Follow up/ })).toBeNull();
    expect(row.getByRole("button", { name: "Star Acme Recruiting" })).toHaveAttribute("aria-pressed", "false");
    expect(within(rowOf("Example Labs Talent")).getByText("RCSA directory")).toBeInTheDocument();
    expect(screen.getByText("Only contact details recruiters publish. Check before sending.")).toBeInTheDocument();
    expect(screen.getByText("2 agencies")).toBeInTheDocument();
    // The tick box is named for screen readers only: no visible "Select ..." text anywhere.
    expect(screen.queryByText(/^Select Acme Recruiting$/)).toBeNull();
    expect(screen.getByRole("button", { name: "Find recruiters" })).toBeInTheDocument();
  });

  it("filters by search words, tag, city and where it was found, and clears them", async () => {
    renderApp(<RecruitersScreen />, { bridge: bridgeWith() });
    await listed();
    await userEvent.type(screen.getByLabelText("Search"), "data");
    expect(shownNames()).toEqual(["Example Labs Talent"]);
    expect(screen.getByText("1 of 2 agencies")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Search"));
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "AI");
    expect(shownNames()).toEqual(["Acme Recruiting"]);
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "");
    await userEvent.selectOptions(screen.getByLabelText("City"), "Exampleville");
    expect(shownNames()).toEqual(["Example Labs Talent"]);
    await userEvent.selectOptions(screen.getByLabelText("City"), "");
    expect(within(screen.getByLabelText("Found on")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Anywhere", "RCSA directory", "SEEK", "Web search"]);
    await userEvent.selectOptions(screen.getByLabelText("Found on"), "SEEK");
    expect(shownNames()).toEqual(["Acme Recruiting"]);
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(shownNames()).toEqual(["Acme Recruiting", "Example Labs Talent"]);
    expect(screen.queryByLabelText("Ads open to visa holders")).toBeNull();
  });

  it("leaves out the Found on filter when no agency records where it was found", async () => {
    const b = bridgeWith();
    for (const a of agencies(b)) delete a.sources;
    renderApp(<RecruitersScreen />, { bridge: b });
    await listed();
    expect(screen.queryByLabelText("Found on")).toBeNull();
    expect(within(rowOf("Acme Recruiting")).getByText("Not recorded")).toBeInTheDocument();
  });

  it("sorts by name, status and follow-up from the column headings", async () => {
    const b = bridgeWith();
    const [acme, labs] = agencies(b);
    acme!.tracking = { ...acme!.tracking, status: "replied", follow_up_on: "2026-11-02" };
    labs!.tracking = { ...labs!.tracking, status: "contacted", follow_up_on: "2026-10-20" };
    renderApp(<RecruitersScreen />, { bridge: b });
    await listed();
    const table = screen.getByRole("table", { name: "Recruiters" });
    await userEvent.click(within(table).getByRole("button", { name: "Agency" }));
    expect(shownNames()).toEqual(["Acme Recruiting", "Example Labs Talent"]);
    await userEvent.click(within(table).getByRole("button", { name: "Agency" }));
    expect(shownNames()).toEqual(["Example Labs Talent", "Acme Recruiting"]);
    await userEvent.click(within(table).getByRole("button", { name: "Status" }));
    expect(shownNames()).toEqual(["Example Labs Talent", "Acme Recruiting"]);
    await userEvent.click(within(table).getByRole("button", { name: "Follow up" }));
    expect(shownNames()).toEqual(["Example Labs Talent", "Acme Recruiting"]);
    await userEvent.click(within(table).getByRole("button", { name: "Follow up" }));
    expect(shownNames()).toEqual(["Acme Recruiting", "Example Labs Talent"]);
  });

  it("stars an agency from its row without opening it", async () => {
    const b = bridgeWith();
    renderApp(<RecruitersScreen />, { bridge: b, hash: "#/recruiters" });
    await listed();
    await userEvent.click(screen.getByRole("button", { name: "Star Example Labs Talent" }));
    await waitFor(async () => expect((await b.recruiters.list()).find((r) => r.slug === "example-labs-talent")!.favourite).toBe(true));
    expect(window.location.hash).toBe("#/recruiters");
    // Favourites come first until a heading is clicked.
    await waitFor(() => expect(shownNames()).toEqual(["Example Labs Talent", "Acme Recruiting"]));
  });

  it("shows the sponsorship filter only to people who need sponsorship", async () => {
    renderApp(<RecruitersScreen />, { bridge: bridgeWith("needs_sponsorship") });
    await listed();
    await userEvent.click(screen.getByLabelText("Ads open to visa holders"));
    expect(await screen.findByText("No recruiters match these filters.")).toBeInTheDocument();
  });
});

describe("Recruiters selection", () => {
  it("bulk: one templated general enquiry per agency, kept with its company, with the resume chosen once and the sponsorship line", async () => {
    const b = bridgeWith("needs_sponsorship");
    agencies(b).push({ ...structuredClone(agencies(b)[1]!), name: "Acme Talent", slug: "acme-talent", contacts: [], people: [] });
    renderApp(<RecruitersScreen />, { bridge: b });
    await listed();
    for (const n of ["Acme Recruiting", "Example Labs Talent", "Acme Talent"]) await userEvent.click(screen.getByRole("checkbox", { name: `Select ${n}` }));
    // Ticking a box never opens the agency.
    expect(window.location.hash).not.toMatch(/recruiter\//);
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
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected recruiters" })).toBeNull());
  });

  it("bulk: Select all ticks every agency shown, and never more than 20 drafts go in one go", async () => {
    const b = bridgeWith();
    for (let i = 0; i < 22; i++) agencies(b).push({ ...structuredClone(agencies(b)[1]!), name: `Example Agency ${i}`, slug: `example-agency-${i}` });
    renderApp(<RecruitersScreen />, { bridge: b });
    await listed();
    await userEvent.click(screen.getByRole("button", { name: "Tick all 24 agencies shown" }));
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
    await listed();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Acme Recruiting" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Example Labs Talent" }));
    const bar = screen.getByRole("toolbar", { name: "Selected recruiters" });
    await userEvent.click(within(bar).getByRole("button", { name: "Mark contacted" }));
    await waitFor(() => expect(b.calls.filter((c) => c.method === "recruiters.update").map((c) => c.args[0])).toEqual(["acme-recruiting", "example-labs-talent"]));
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected recruiters" })).toBeNull());
  });
});

describe("Recruiter page", () => {
  it("opens from a row, and Back returns to the list with its filters kept", async () => {
    window.location.hash = "#/recruiters";
    render(<App bridge={bridgeWith()} />);
    await listed();
    const filters = () => within(screen.getByRole("search", { name: "Filter recruiters" }));
    await userEvent.selectOptions(filters().getByLabelText("City"), "Sampletown");
    await userEvent.type(filters().getByLabelText("Search"), "acme");
    expect(shownNames()).toEqual(["Acme Recruiting"]);
    await userEvent.click(within(rowOf("Acme Recruiting")).getByText(/Has a live AI Developer role/));
    await waitFor(() => expect(window.location.hash).toBe("#/recruiter/acme-recruiting"));
    expect(await screen.findByRole("heading", { name: "Acme Recruiting", level: 1 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: /Back to Recruiters/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/recruiters"));
    await listed();
    expect(filters().getByLabelText("City")).toHaveValue("Sampletown");
    expect(filters().getByLabelText("Search")).toHaveValue("acme");
    expect(shownNames()).toEqual(["Acme Recruiting"]);
  });

  it("overview: what it's hiring for, the facts, where it was found and your tracking", async () => {
    const b = bridgeWith();
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting" }} />, { bridge: b });
    expect(await screen.findByRole("heading", { name: "Acme Recruiting", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Sampletown · since 2009 · 1 open job")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "recruiting.example.com" })).toBeInTheDocument();
    expect(within(screen.getByRole("tablist", { name: "Recruiter sections" })).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Contacts2", "Emails", "Jobs1", "Timeline1"]);
    expect(screen.getByText(/Has a live AI Developer role/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Team page names a technology recruitment lead");
    expect(within(screen.getByRole("list", { name: "Tags" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["IT specialist", "Government", "AI"]);
    expect(screen.getByText("Technology, Government")).toBeInTheDocument();
    const found = screen.getByRole("list", { name: "Found on" });
    expect(within(found).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["SEEK12 Jan 2026", "Web search13 Jan 2026"]);
    await userEvent.click(within(found).getByRole("button", { name: "Open where Acme Recruiting was found on SEEK" }));
    await waitFor(() => expect(b.calls.find((c) => c.method === "links.open")?.args).toEqual(["https://www.seek.com.au/job/1"]));
    expect(screen.queryByText(/visa/i)).toBeNull();
  });

  it("saves status, star, dates and notes from the page, with a follow-up five business days after contact", async () => {
    const b = bridgeWith();
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting" }} />, { bridge: b });
    await screen.findByRole("heading", { name: "Acme Recruiting", level: 1 });
    fireEvent.change(screen.getByLabelText("Contacted"), { target: { value: "2026-10-15" } });
    await waitFor(() => expect(screen.getByLabelText("Follow up")).toHaveValue("2026-10-22"));
    expect(screen.getByLabelText("Status")).toHaveValue("contacted");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "replied");
    await waitFor(() => expect(screen.getByLabelText("Status")).toHaveValue("replied"));
    const notes = screen.getByLabelText("Notes");
    await userEvent.type(notes, "Asked about contract roles");
    await userEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await userEvent.click(screen.getByRole("button", { name: "Star Acme Recruiting" }));
    await waitFor(async () => expect((await b.recruiters.list()).find((r) => r.slug === "acme-recruiting")).toMatchObject({
      favourite: true, tracking: { status: "replied", contacted_on: "2026-10-15", follow_up_on: "2026-10-22", notes: "Asked about contract roles" },
    }));
    expect(screen.getByRole("button", { name: "Unstar Acme Recruiting" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Save notes" })).toBeDisabled();
  });

  it("contacts: emails and phones with their source pages, people, and the agency's pages; phones copy", async () => {
    const b = bridgeWith();
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting", tab: "contacts" }} />, { bridge: b });
    const emails = await screen.findByRole("region", { name: "Emails" });
    expect(within(emails).getByText(at("jobs"))).toBeInTheDocument();
    expect(within(emails).getByText("Technology team")).toBeInTheDocument();
    expect(within(emails).getByRole("button", { name: "Found on recruiting.example.com" })).toBeInTheDocument();
    const phones = screen.getByRole("region", { name: "Phones" });
    const number = "0491" + " 570 006";
    expect(within(phones).getByText(number)).toBeInTheDocument();
    expect(within(phones).getByText("Sampletown office")).toBeInTheDocument();
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    await userEvent.click(within(phones).getByRole("button", { name: `Copy phone number ${number}` }));
    expect(write).toHaveBeenCalledWith(number);
    expect(within(screen.getByRole("region", { name: "People" })).getByText("No named recruiters published yet.")).toBeInTheDocument();
    const links = screen.getByRole("region", { name: "Links" });
    for (const l of ["website", "about / team", "sampletown contact"]) expect(within(links).getByRole("button", { name: `Open Acme Recruiting's ${l}` })).toBeInTheDocument();
  });

  it("contacts: a named recruiter, with their title and source, and the best person to reach", async () => {
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "example-labs-talent", tab: "contacts" }} />, { bridge: bridgeWith() });
    const people = await screen.findByRole("region", { name: "People" });
    expect(within(people).getByText("Alex Example")).toBeInTheDocument();
    expect(within(people).getByText("Data recruiter · Data")).toBeInTheDocument();
    expect(within(people).getByRole("button", { name: "Found on talent.example.com" })).toBeInTheDocument();
    expect(within(people).getByRole("button", { name: `Email ${at("alex")}` })).toBeInTheDocument();
    expect(screen.getByText(/Best reached through Alex Example/)).toBeInTheDocument();
  });

  it("jobs: the live jobs saved from the agency open the job", async () => {
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting", tab: "jobs" }} />, { bridge: bridgeWith() });
    const table = await screen.findByRole("table", { name: "Jobs from Acme Recruiting" });
    await userEvent.click(within(table).getByText("AI Developer"));
    await waitFor(() => expect(window.location.hash).toBe("#/job/acme-recruiting/2026-01-12-ai-developer"));
  });

  it("timeline: the agency's events, newest first", async () => {
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting", tab: "timeline" }} />, { bridge: bridgeWith() });
    expect(within(await screen.findByRole("list", { name: "Acme Recruiting timeline" })).getByText("Advertised a job")).toBeInTheDocument();
  });

  it("says so for an agency that isn't there", async () => {
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "example-nowhere" }} />, { bridge: bridgeWith() });
    expect(await screen.findByText("This recruiter isn't in your workspace.")).toBeInTheDocument();
  });
});

describe("Recruiter page: Email", () => {
  it("about a live job, with its tailored resume and the sponsorship question, saved as a draft", async () => {
    const user = userEvent.setup();
    const b = bridgeWith("needs_sponsorship");
    b.simulateClaudeOutput("acme-recruiting", "2026-01-12-ai-developer");
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting" }} />, { bridge: b });
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

  it("a general enquiry, no tailored resume (tailor first is offered), sponsorship turned off", async () => {
    const user = userEvent.setup();
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting" }} />, { bridge: bridgeWith("needs_sponsorship") });
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

  it("to a named recruiter from Contacts: an agency with no saved job gets a general enquiry kept with its company, with one of your resumes", async () => {
    const user = userEvent.setup();
    const b = bridgeWith();
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "example-labs-talent", tab: "contacts" }} />, { bridge: b });
    await user.click(await screen.findByRole("button", { name: `Email ${at("alex")}` }));
    const dialog = await screen.findByRole("dialog", { name: "Email Example Labs Talent" });
    expect(within(dialog).getByLabelText("What it's about")).toHaveValue("general");
    expect(within(dialog).getByText("Kept with Example Labs Talent in your mail, not with a job.")).toBeInTheDocument();
    await user.click(await within(dialog).findByRole("button", { name: "Attach resume" }));
    expect(await within(dialog).findByText("Your resume is attached.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Write email" }));
    const editor = await within(dialog).findByRole("form", { name: "Email draft" });
    expect(within(editor).getByLabelText("Subject")).toHaveValue("Enquiry: Data roles – Alex Example");
    await user.click(within(editor).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(b.calls.find((c) => c.method === "mail.drafts.save")?.args).toEqual(["example-labs-talent", "", "",
      expect.objectContaining({ to: at("alex"), attach: ["companies/example-labs-talent/emails/outgoing/alex-example-resume.pdf"] })]));
    expect(b.calls.filter((c) => c.method === "recruiters.mailbox").map((c) => c.args[0])).toContain("example-labs-talent");
    expect(b.calls.find((c) => c.method === "recruiters.attachResume")?.args).toEqual(["example-labs-talent", "", "me/resumes/alex-example-resume.pdf"]);
  });

  it("is off, and says why, without a published address", async () => {
    const b = bridgeWith();
    agencies(b)[1]!.contacts = [];
    agencies(b)[1]!.people = [];
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "example-labs-talent" }} />, { bridge: b });
    const btn = await screen.findByRole("button", { name: "Email Example Labs Talent" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "No published email address yet.");
  });

  it("never offers the sponsorship question to someone who doesn't need sponsorship", async () => {
    const user = userEvent.setup();
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting" }} />, { bridge: bridgeWith("citizen") });
    await user.click(await screen.findByRole("button", { name: "Email Acme Recruiting" }));
    const dialog = await screen.findByRole("dialog", { name: "Email Acme Recruiting" });
    await within(dialog).findByLabelText("What it's about");
    expect(within(dialog).queryByLabelText("Ask about sponsorship")).toBeNull();
  });
});
