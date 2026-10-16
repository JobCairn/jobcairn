import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AgencyRecordView, TriageItem } from "@careeros/contract";
import { App } from "../src/App";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { RecruiterScreen } from "../src/screens/Recruiter";
import { MailScreen } from "../src/screens/Mail";
import { renderApp } from "./render";

// Add recruiter, import, recruiter mail and the Emails tab (spec 2026-10-17-add-recruiter-and-mail).
const at = (local: string, domain = "example.com") => local + "@" + domain;
const agencies = (b: MockBridge) => (b as unknown as { f: { agencies: AgencyRecordView[] } }).f.agencies;
const mailApi = (b: MockBridge) => (b as unknown as { mailMock: { api: { triage: { list: () => Promise<TriageItem[]> } } } }).mailMock.api;

afterEach(() => { cleanup(); window.location.hash = ""; });

describe("Add recruiter", () => {
  it("saves a pasted website, says it's added, and starts Check recruiters", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/recruiters";
    const b = new MockBridge({ fixture: loadFixture() });
    render(<App bridge={b} />);
    await user.click(await screen.findByRole("button", { name: "Add a recruiter you know" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a recruiter" });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Website, job ad link, or name and email"), "https://sampletalent.example.org/contact");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const done = await screen.findByRole("dialog", { name: "Recruiter added" });
    expect(within(done).getByText("Sampletalent is in your recruiters.")).toBeInTheDocument();
    expect(b.calls.find((c) => c.method === "recruiters.add")?.args).toEqual([{ text: "https://sampletalent.example.org/contact" }]);
    await waitFor(() => expect(b.calls.find((c) => c.method === "claude.run")?.args.slice(0, 2)).toEqual(["check_recruiters", { kind: "workspace" }]));
    expect(agencies(b).find((a) => a.slug === "sampletalent")).toMatchObject({ website: "https://sampletalent.example.org", needs_check: true, sources: [{ name: "Added by you" }] });
  });

  it("asks for a name with a job board link", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/recruiters";
    render(<App bridge={new MockBridge({ fixture: loadFixture() })} />);
    await user.click(await screen.findByRole("button", { name: "Add a recruiter you know" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a recruiter" });
    await user.type(within(dialog).getByLabelText("Website, job ad link, or name and email"), "https://www.seek.com.au/job/1");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/That's a SEEK ad\. Add the agency's name too/)).toBeInTheDocument();
  });

  it("imports a list and lists the lines it left out", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/recruiters";
    const b = new MockBridge({ fixture: loadFixture() });
    render(<App bridge={b} />);
    await user.click(await screen.findByRole("button", { name: "Add a recruiter you know" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a recruiter" });
    await user.click(within(dialog).getByRole("tab", { name: "A list" }));
    await user.type(within(dialog).getByLabelText("One agency per line"), `Sample Talent, sampletalent.example.org{enter}https://www.seek.com.au/job/2{enter}Example Search,,${at("hi", "example.net")}`);
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    const done = await screen.findByRole("dialog", { name: "Recruiters imported" });
    expect(within(done).getByText("2 agencies added.")).toBeInTheDocument();
    expect(within(within(done).getByRole("region", { name: "Lines left out" })).getByText(/Line 2: .*SEEK ad/)).toBeInTheDocument();
  });
});

describe("Recruiter mail", () => {
  it("links a sender's domain to an agency from Mail to sort; the agency shows the link and the email", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailScreen />);
    await user.click(await screen.findByRole("tab", { name: /Mail to sort/ }));
    const item = await screen.findByRole("region", { name: "Your application" });
    await user.click(within(item).getByRole("button", { name: "This is from a recruiter: link the sender to an agency" }));
    const dialog = await screen.findByRole("dialog", { name: "This is from a recruiter" });
    await within(dialog).findByLabelText("Recruiter");
    await user.click(within(dialog).getByLabelText("Anyone at examplelabs-mail.example.org"));
    await user.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Your application" })).not.toBeInTheDocument());
    expect(bridge.calls.find((c) => c.method === "mail.triage.linkAgency")?.args).toEqual(["2026-01-14-your-application-e1e2e3", "acme-recruiting", "domain"]);
    cleanup();

    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting", tab: "contacts" }} />, { bridge });
    const linked = await screen.findByRole("region", { name: "Linked email addresses" });
    expect(within(linked).getByText("Anyone at examplelabs-mail.example.org")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Emails/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/recruiter/acme-recruiting?tab=emails"));
    cleanup();
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting", tab: "emails" }} />, { bridge });
    expect(await screen.findByRole("tab", { name: /^Emails\s*[1-9]/ })).toBeInTheDocument();
    const thread = await screen.findByRole("region", { name: "Conversation: Your application" });
    const msg = within(thread).getByRole("button", { name: /Them → you, .*examplelabs-mail\.example\.org.*Your application/ });
    await user.click(msg);
    expect(await within(thread).findByRole("region", { name: "Message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reply to .*Your application/ })).toBeInTheDocument();
    cleanup();
    renderApp(<RecruiterScreen route={{ screen: "recruiter", slug: "acme-recruiting", tab: "contacts" }} />, { bridge });
    await user.click(within(await screen.findByRole("region", { name: "Linked email addresses" })).getByRole("button", { name: "Unlink examplelabs-mail.example.org" }));
    await waitFor(() => expect(agencies(bridge).find((a) => a.slug === "acme-recruiting")?.email_match).toEqual([]));
  });

  it("offers only the exact address for a free-mail sender", async () => {
    const user = userEvent.setup();
    const b = new MockBridge({ fixture: loadFixture() });
    const api = mailApi(b);
    const real = api.triage.list;
    api.triage.list = async () => (await real()).map((t, i) => (i === 0 ? { ...t, from: { name: "Sam", address: at("sam.r", "gmail.com") }, free_mail: true } : t));
    renderApp(<MailScreen />, { bridge: b });
    await user.click(await screen.findByRole("tab", { name: /Mail to sort/ }));
    const item = await screen.findByRole("region", { name: "Your application" });
    await user.click(within(item).getByRole("button", { name: "This is from a recruiter: link the sender to an agency" }));
    const dialog = await screen.findByRole("dialog", { name: "This is from a recruiter" });
    expect(within(dialog).getByText(/gmail\.com is a mail service many people share/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Anyone at/)).toBeNull();
    expect(within(dialog).getByLabelText(`Only ${at("sam.r", "gmail.com")}`)).toBeChecked();
  });
});
