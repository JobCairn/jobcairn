import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mailUrlFor } from "@careeros/contract";
import { describe, expect, it } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";
import { MailScreen } from "../src/screens/Mail";
import { parseHash, toHash } from "../src/router";
import { renderApp } from "./render";

const INTERVIEW = "companies/acme-corp/jobs/2026-01-12-ai-engineer/emails/2026-01-14-interview-for-ai-engineer-a1b2c3.json";

describe("Mail screen", { timeout: 20_000 }, () => {
  it("lists job mail newest first and filters it", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    const list = await screen.findByRole("list", { name: "Job mail" });
    expect(within(list).getAllByRole("button").map((b) => b.querySelector(".mail-row__subject")?.textContent)).toEqual([
      "Interview for AI Engineer", "Urgent: confirm your details", "Re: AI Engineer application",
    ]);
    await user.click(screen.getByRole("button", { name: "Unread only" }));
    expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Job mail" })).getAllByRole("button")).toHaveLength(2));
    await user.type(screen.getByLabelText("Search mail"), "urgent");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Job mail" })).getAllByRole("button")).toHaveLength(1));
  });

  it("opens a message in a sandboxed frame with images blocked until asked", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    const viewer = await screen.findByRole("region", { name: "Message" });
    const frame = within(viewer).getByTitle("Email body");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("src", mailUrlFor(INTERVIEW));
    expect(within(viewer).getByText("Acme Talent")).toBeInTheDocument();
    expect(within(viewer).getByText("talent" + "@" + "example.org")).toBeInTheDocument();
    expect(within(viewer).getByText("Images are blocked to protect your privacy.")).toBeInTheDocument();
    await user.click(within(viewer).getByRole("button", { name: "Load images" }));
    await waitFor(() => expect(within(viewer).queryByText("Images are blocked to protect your privacy.")).not.toBeInTheDocument());
    expect(bridge.calls.some((c) => c.method === "mail.loadImages")).toBe(true);
  });

  it("reads like a mail client: an open email gets the page, Back or Esc returns, and the reading pane is a choice", async () => {
    localStorage.removeItem("jobcairn.mail.pane");
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    const page = () => document.querySelector(".mail-screen")!;
    const split = () => document.querySelector(".mail-split")!;
    const first = await screen.findByRole("button", { name: /Interview for AI Engineer/ });
    expect(split()).toHaveClass("mail-split--nopane");
    await user.click(first);
    const viewer = await screen.findByRole("region", { name: "Message" });
    // The subject sits on the toolbar row with Back and the actions; the page title, tabs and filters step aside.
    expect(within(screen.getByRole("toolbar", { name: "Message actions" })).getByText("Interview for AI Engineer")).toBeInTheDocument();
    expect(page()).toHaveClass("mail-screen--reading");
    await user.click(within(viewer).getByRole("button", { name: "Back to mail" }));
    expect(page()).not.toHaveClass("mail-screen--reading");
    expect(screen.queryByRole("region", { name: "Message" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Interview for AI Engineer/ }));
    await screen.findByRole("region", { name: "Message" });
    await user.keyboard("{Escape}");
    expect(page()).not.toHaveClass("mail-screen--reading");
    // Reading pane: list and email side by side, remembered, with "Read at full width" on demand.
    await user.click(screen.getByRole("button", { name: "Reading pane" }));
    expect(localStorage.getItem("jobcairn.mail.pane")).toBe("right");
    await user.click(screen.getByRole("button", { name: /Interview for AI Engineer/ }));
    const paneViewer = await screen.findByRole("region", { name: "Message" });
    expect(page()).not.toHaveClass("mail-screen--reading");
    await user.click(within(paneViewer).getByRole("button", { name: "Read at full width" }));
    expect(page()).toHaveClass("mail-screen--reading");
    await user.keyboard("{Escape}");
    expect(page()).not.toHaveClass("mail-screen--reading");
    expect(screen.getByRole("region", { name: "Message" })).toBeInTheDocument();
    localStorage.removeItem("jobcairn.mail.pane");
  });

  it("warns about a sender whose name claims another domain", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: /Urgent: confirm your details/ }));
    const viewer = await screen.findByRole("region", { name: "Message" });
    const alerts = within(viewer).getAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual([
      "Gmail couldn't confirm this email really came from evil.example.net. Be careful with its links and attachments.",
      `The sender's name shows examplelabs.example.net, but the email came from ${"x" + "@" + "evil.example.net"}.`,
    ]);
  });

  it("saves an attachment to the job folder, then shows it, and flags risky files", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    const chip = await screen.findByRole("group", { name: "Interview details.pdf" });
    await user.click(within(chip).getByRole("button", { name: "Save to job folder" }));
    await user.click(await within(chip).findByRole("button", { name: /^Show file/ }));
    expect(bridge.revealed).toEqual(["companies/acme-corp/jobs/2026-01-12-ai-engineer/emails/attachments/interview-details.pdf"]);
    expect(within(screen.getByRole("group", { name: "setup.exe" })).getByText(/can run programs/)).toBeInTheDocument();
  });

  it("views a saved attachment in the file viewer, and Esc closes only the viewer", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    const chip = await screen.findByRole("group", { name: "Interview details.pdf" });
    expect(within(chip).queryByRole("button", { name: "View Interview details.pdf" })).toBeNull();
    await user.click(within(chip).getByRole("button", { name: "Save to job folder" }));
    await user.click(await within(chip).findByRole("button", { name: "View Interview details.pdf" }));
    const dlg = await screen.findByRole("dialog", { name: "Interview details.pdf" });
    expect(await within(dlg).findByTitle("PDF: Interview details.pdf")).toBeInTheDocument();
    expect(bridge.calls.some((c) => c.method === "files.preview" && c.args[0] === "companies/acme-corp/jobs/2026-01-12-ai-engineer/emails/attachments/interview-details.pdf")).toBe(true);
    // A risky attachment never gets View.
    expect(within(screen.getByRole("group", { name: "setup.exe" })).queryByRole("button", { name: /^View/ })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("region", { name: "Message" })).toBeInTheDocument();
  });

  it("sorts mail: assigns with always-match, or ignores a domain", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailScreen />);
    await user.click(await screen.findByRole("tab", { name: /Mail to sort/ }));
    const item = await screen.findByRole("region", { name: "Your application" });
    expect(within(item).getByText("The subject names Example Labs.")).toBeInTheDocument();
    await user.selectOptions(within(item).getByLabelText("File under"), "example-labs/2026-01-12-backend-engineer-llm");
    await user.click(within(item).getByLabelText("Always match this sender"));
    await user.click(within(item).getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Your application" })).not.toBeInTheDocument());
    expect(bridge.calls.find((c) => c.method === "mail.triage.assign")?.args).toEqual(["2026-01-14-your-application-e1e2e3", { company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" }, true]);
    const other = screen.getByRole("region", { name: "New jobs for you" });
    await user.click(within(other).getByRole("button", { name: "Ignore domain" }));
    expect(await screen.findByText("Nothing to sort.")).toBeInTheDocument();
  });

  it("lists drafts with their status and opens one on its job", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    await user.click(await screen.findByRole("tab", { name: /Drafts/ }));
    const row = await screen.findByRole("region", { name: "Following up" });
    expect(within(row).getByText("Draft")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(window.location.hash).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm?tab=mail"));
  });

  it("shows sync times, syncs on request and removes old originals", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === "mail.syncNow")).toBe(true));
    // Cleanup lives in the reader's "⋯" menu, behind a confirmation, not in the reading flow.
    expect(screen.queryByRole("button", { name: "Remove originals" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Interview for AI Engineer/ }));
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Free space…" }));
    const dialog = await screen.findByRole("dialog", { name: "Free up space" });
    expect(within(dialog).getByText(/Original emails use/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove originals" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "mail.prune")?.args).toEqual([6]));
  });

  it("sends people to Settings when Gmail isn't connected", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />, { bridge: new MockBridge({ mailConnected: false }) });
    await user.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(window.location.hash).toBe("#/settings?tab=connections"));
  });
  it("links the job a message is filed under to that job's Mail tab", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    const viewer = await screen.findByRole("region", { name: "Message" });
    await user.click(within(viewer).getByRole("button", { name: "AI Engineer · Acme Corp" }));
    await waitFor(() => expect(window.location.hash).toBe("#/job/acme-corp/2026-01-12-ai-engineer?tab=mail"));
  });
  it("gives the reason Move is off as a tooltip, not as text on the page", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    const viewer = await screen.findByRole("region", { name: "Message" });
    await user.click(within(viewer).getByRole("button", { name: "More actions" }));
    await user.click(within(viewer).getByRole("menuitem", { name: "Move…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to another job" });
    const move = within(dialog).getByRole("button", { name: "Move" });
    expect(move).toBeDisabled();
    expect(move).toHaveAccessibleDescription("Choose a different job to move it.");
    expect(move.parentElement).toHaveAttribute("title", "Choose a different job to move it.");
    expect(within(dialog).getByText("Choose a different job to move it.")).toHaveClass("sr-only");
  });
  it("has its own route", () => {
    expect(parseHash("#/mail")).toEqual({ screen: "mail" });
    expect(toHash({ screen: "mail" })).toBe("#/mail");
  });

  it("offers the job filter once a company is chosen, says when nothing matches, and clears filters", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    await screen.findByRole("list", { name: "Job mail" });
    expect(screen.queryByLabelText("Job")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Company"), "acme-corp");
    expect(screen.getByLabelText("Job")).toBeEnabled();
    await user.type(screen.getByLabelText("Search mail"), "nothing like this");
    expect(await screen.findByText("No job mail matches.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Job mail" })).getAllByRole("button")).toHaveLength(3));
    expect(screen.getByLabelText("Search mail")).toHaveValue("");
  });

  it("shows sender, subject, a snippet and where each email is filed, with unread marked", async () => {
    renderApp(<MailScreen />);
    const list = await screen.findByRole("list", { name: "Job mail" });
    const first = within(list).getAllByRole("button")[0]!;
    expect(first.querySelector(".mail-row__from")?.textContent).toBe("Acme Talent");
    expect(first.querySelector(".mail-row__snippet")?.textContent).toMatch(/^Hi Alex, thanks for applying/);
    expect(first.querySelector(".mail-tag")).toHaveAttribute("title", "AI Engineer · Acme Corp");
    expect(first).toHaveClass("is-unread");
    expect(within(first).getByText("Unread.", { exact: false })).toHaveClass("sr-only");
    const sent = within(list).getAllByRole("button")[2]!;
    expect(sent.querySelector(".mail-row__from")?.textContent).toBe("You");
    expect(sent).not.toHaveClass("is-unread");
  });

  it("moves through the list with the arrow keys or j and k, and opens with Enter", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    const list = await screen.findByRole("list", { name: "Job mail" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    rows[0]!.focus();
    await user.keyboard("j");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(rows[2]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(rows[2]).toHaveFocus();
    await user.keyboard("k");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    const viewer = await screen.findByRole("region", { name: "Message" });
    expect(await within(viewer).findByText("Urgent: confirm your details")).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute("aria-current", "true");
  });

  it("switches the reader between the original and plain text, and opens the email in Gmail", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    const viewer = await screen.findByRole("region", { name: "Message" });
    expect(within(viewer).getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(viewer).getByRole("button", { name: "Plain text" }));
    const frame = within(viewer).getByTitle("Email body, plain text");
    expect(frame).toHaveAttribute("src", `${mailUrlFor(INTERVIEW)}/text`);
    expect(frame).toHaveAttribute("sandbox", "");
    // No remote images in plain text, so no images bar either.
    expect(within(viewer).queryByText("Images are blocked to protect your privacy.")).not.toBeInTheDocument();
    await user.click(within(viewer).getByRole("button", { name: "Open Gmail" }));
    const opened = bridge.calls.find((c) => c.method === "links.open")?.args[0] as string;
    expect(opened).toBe(`https://mail.google.com/mail/?authuser=${encodeURIComponent("alex" + "@" + "example.com")}#search/${encodeURIComponent("rfc822msgid:2026-01-14-interview-for-ai-engineer-a1b2c3" + "@" + "example.org")}`);
  });

  it("links to Settings › Email from the reader's menu", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    const viewer = await screen.findByRole("region", { name: "Message" });
    const more = within(viewer).getByRole("button", { name: "More actions" });
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(within(viewer).queryByRole("menu")).not.toBeInTheDocument();
    expect(more).toHaveFocus();
    await user.click(more);
    await user.click(within(viewer).getByRole("menuitem", { name: "Email settings" }));
    await waitFor(() => expect(window.location.hash).toBe("#/settings?tab=connections&c=email"));
  });

  it("says why Assign is off until a job is chosen", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    await user.click(await screen.findByRole("tab", { name: /Mail to sort/ }));
    const item = await screen.findByRole("region", { name: "New jobs for you" });
    expect(within(item).getByText("No company matched.")).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: "Assign" })).toBeDisabled();
    expect(within(item).getByText("Choose a job first.")).toBeInTheDocument();
  });

  it("shows no file paths or internal names on screen", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    await screen.findByRole("region", { name: "Message" });
    expect(document.body.textContent).not.toMatch(/companies\/|\.json|acme-corp|careeros-mail:/);
  });
});
