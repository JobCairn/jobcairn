import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { loadFixture, MockBridge } from "../src/mock/MockBridge";
import { ApprovalsScreen } from "../src/screens/Approvals";
import { renderApp } from "./render";

const TALENT = "talent" + "@" + "example.org";
const draft = { to: `Acme Talent <${TALENT}>`, cc: "", subject: "Re: Interview", body: "Friday works.", attach: [] as string[], in_reply_to: "", references: [], purpose: "" as const };

describe("Approvals: email sends", () => {
  it("shows the exact message and sends it once on Approve", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge();
    const d = await bridge.mail.drafts.save("acme-corp", "2026-01-12-ai-engineer", "", draft);
    await bridge.mail.drafts.propose("acme-corp", "2026-01-12-ai-engineer", d.view.draft_id);
    renderApp(<ApprovalsScreen />, { bridge });
    const card = await screen.findByRole("region", { name: 'Send "Re: Interview"' });
    const preview = within(card).getByRole("region", { name: "Email preview" });
    expect(preview).toHaveTextContent(`Acme Talent <${TALENT}>`);
    expect(within(preview).getByLabelText("Message as sent")).toHaveTextContent(/Friday works\.\s*Alex Example\s*AI Engineer/);
    expect(within(card).getByText("This exact message will be sent.")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Approve" }));
    // History is a table on this screen (the brief's test asked for a list).
    await waitFor(() => expect(screen.getByRole("table", { name: "History" })).toHaveTextContent("Sent to 1 recipient"));
    expect((await bridge.mail.list({ direction: "out" })).total).toBe(2);
    expect(bridge.calls.filter((c) => c.method === "approvals.approve")).toHaveLength(1);
    // The result doesn't vanish: a link opens the sent email in the job's Mail tab.
    const done = screen.getByRole("status", { name: "Email sent" });
    await user.click(within(done).getByRole("button", { name: "Open mail" }));
    expect(window.location.hash).toBe("#/job/acme-corp/2026-01-12-ai-engineer?tab=mail");
  });
  it("never takes an attachment from me/, and says so in plain words", async () => {
    const bridge = new MockBridge();
    await expect(bridge.mail.drafts.save("acme-corp", "2026-01-12-ai-engineer", "", { ...draft, attach: ["me/identity/visa-letter.pdf"] }))
      .rejects.toThrow("Files from your private me/ folder can't be attached to an email. If you want to send one, copy it into this job's folder first, then attach it from there.");
  });
  it("can't approve an email whose draft changed", async () => {
    const f = loadFixture();
    f.approvals.push({
      ...f.approvals[0]!, id: "20260115t090000-abc123", action: "email_send", title: "Send follow-up to Acme Corp", status: "pending",
      email: {
        account: "alex" + "@" + "example.com", from: { name: "Alex Example", address: "alex" + "@" + "example.com" }, to: [{ name: "", address: TALENT }], cc: [],
        subject: "Follow-up", text: "Hi\n", in_reply_to: "", attachments: [], locked: false, current: false, problem: "The draft changed. Review it again.",
        job: { company_slug: "acme-corp", id: "2026-01-12-ai-engineer", title: "AI Engineer", company_name: "Acme Corp" },
      },
    });
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const card = await screen.findByRole("region", { name: "Send follow-up to Acme Corp" });
    expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(card).getAllByText("The draft changed. Review it again.").length).toBeGreaterThan(0);
    expect(within(card).queryByText("This exact message will be sent.")).not.toBeInTheDocument();
  });
  it("can't approve an email it can't preview, and says why", async () => {
    const f = loadFixture();
    f.approvals.push({ ...f.approvals[0]!, id: "20260115t090000-abc124", action: "email_send", title: "Send follow-up to Acme Corp", status: "pending" });
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const card = await screen.findByRole("region", { name: "Send follow-up to Acme Corp" });
    expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(card).getByText("This email can't be previewed. Decline it and propose it again.")).toBeInTheDocument();
  });
  it("keeps internal ids out of the full details", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge();
    const d = await bridge.mail.drafts.save("acme-corp", "2026-01-12-ai-engineer", "", draft);
    await bridge.mail.drafts.propose("acme-corp", "2026-01-12-ai-engineer", d.view.draft_id);
    renderApp(<ApprovalsScreen />, { bridge });
    await user.click(await screen.findByRole("button", { name: 'Details: Send "Re: Interview"' }));
    const drawer = await screen.findByRole("dialog");
    expect(drawer).not.toHaveTextContent(d.view.draft_id);
    expect(within(drawer).getByRole("region", { name: "Email preview" })).toHaveTextContent("Friday works.");
  });

  it("offers Mark as sent, after a confirm, when a send ended not sure", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge({ mailSendUnsure: true });
    const d = await bridge.mail.drafts.save("acme-corp", "2026-01-12-ai-engineer", "", draft);
    const a = await bridge.mail.drafts.propose("acme-corp", "2026-01-12-ai-engineer", d.view.draft_id);
    await bridge.approvals.approve(a.id, a.digest);
    renderApp(<ApprovalsScreen />, { bridge });
    const card = await screen.findByRole("region", { name: 'Check: Send "Re: Interview"' });
    expect(within(card).getByText("Not sure this email went out")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Mark sent" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark this email as sent?" });
    expect(bridge.calls.filter((c) => c.method === "mail.send.markSent")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Mark sent" }));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "mail.send.markSent")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("region", { name: 'Check: Send "Re: Interview"' })).not.toBeInTheDocument());
    expect(bridge.calls.filter((c) => c.method === "mail.send.again")).toHaveLength(0);
  });
  it("Send again shows the exact message again and sends it with the digest the person saw", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge({ mailSendUnsure: true });
    const d = await bridge.mail.drafts.save("acme-corp", "2026-01-12-ai-engineer", "", draft);
    const a = await bridge.mail.drafts.propose("acme-corp", "2026-01-12-ai-engineer", d.view.draft_id);
    await bridge.approvals.approve(a.id, a.digest);
    renderApp(<ApprovalsScreen />, { bridge });
    const card = await screen.findByRole("region", { name: 'Check: Send "Re: Interview"' });
    await user.click(within(card).getByRole("button", { name: "Send again" }));
    const dialog = await screen.findByRole("dialog", { name: "Send this email again?" });
    expect(within(dialog).getByText(/they will get it twice/)).toBeInTheDocument();
    expect(within(within(dialog).getByRole("region", { name: "Email preview" })).getByLabelText("Message as sent")).toHaveTextContent("Friday works.");
    await user.click(within(dialog).getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "mail.send.again")).toHaveLength(1));
    expect(bridge.calls.find((c) => c.method === "mail.send.again")!.args).toEqual([a.id, a.digest, true]);
    await waitFor(() => expect(screen.getByRole("status", { name: "Email sent" })).toHaveTextContent("Sent to 1 recipient"));
  });
});
