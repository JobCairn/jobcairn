import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { replyInput } from "../src/components/DraftEditor";
import { MockBridge } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { renderApp } from "./render";

const ACME = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "mail" } as const;
const LABS = { screen: "job", slug: "example-labs", id: "2026-01-12-backend-engineer-llm", tab: "mail" } as const;
const TALENT = "talent" + "@" + "example.org";

describe("replyInput", () => {
  it("replies to Reply-To when present, threads, and adds Re: once", () => {
    const base = {
      ref: "x", company_slug: "acme-corp", company_name: "Acme Corp", job_id: "j", job_title: "AI Engineer", triage: false, direction: "in" as const,
      from: { name: "Acme Talent", address: TALENT }, to: [], cc: [], reply_to: [], subject: "Interview", date: "", message_id: "<m2@example.org>",
      references: ["<m1@example.org>"], thread_key: "", auth: "pass" as const, warnings: [], images_allowed: false, remote_images: 0, too_large: false,
      has_raw: true, attachments: [], opened_at: "",
    };
    expect(replyInput(base)).toMatchObject({ to: `Acme Talent <${TALENT}>`, subject: "Re: Interview", in_reply_to: "<m2@example.org>", references: ["<m1@example.org>", "<m2@example.org>"] });
    expect(replyInput({ ...base, subject: "RE: Interview", reply_to: [{ name: "", address: "jobs" + "@" + "example.org" }] })).toMatchObject({ to: "jobs" + "@" + "example.org", subject: "RE: Interview" });
  });
});

describe("Job > Mail", () => {
  it("shows the job's threads and company mail, and opens one", async () => {
    const user = userEvent.setup();
    renderApp(<JobScreen route={ACME} />);
    const threads = await screen.findByRole("list", { name: "Threads" });
    expect(within(threads).getAllByRole("button").map((b) => b.querySelector(".mail-row__subject")?.textContent)).toEqual(["Interview for AI Engineer", "Re: AI Engineer application"]);
    await user.click(within(threads).getByRole("button", { name: /Interview for AI Engineer/ }));
    expect(await screen.findByRole("region", { name: "Message" })).toBeInTheDocument();
  });

  it("replies with threading headers and a live preview with the signature", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<JobScreen route={ACME} />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    await user.click(await screen.findByRole("button", { name: "Reply" }));
    const editor = await screen.findByRole("form", { name: "Email draft" });
    expect(within(editor).getByRole("button", { name: `Remove Acme Talent <${TALENT}>` })).toBeInTheDocument();
    expect(within(editor).getByLabelText("Subject")).toHaveValue("Re: Interview for AI Engineer");
    await user.type(within(editor).getByLabelText("Message"), "Friday works.");
    await user.click(within(editor).getByRole("tab", { name: "Preview" }));
    expect(within(editor).getByLabelText("Message preview")).toHaveTextContent(/Friday works\.\s*Alex Example\s*AI Engineer/);
    await user.click(within(editor).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "mail.drafts.save")?.args[3]).toMatchObject({
      to: `Acme Talent <${TALENT}>`, in_reply_to: "<2026-01-14-interview-for-ai-engineer-a1b2c3@example.org>", body: "Friday works.",
    }));
  });

  it("writes a new email with an attachment from the job folder and sends it to Approvals", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge();
    bridge.simulateClaudeOutput("acme-corp", "2026-01-12-ai-engineer");
    renderApp(<JobScreen route={ACME} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "New email" }));
    const editor = await screen.findByRole("form", { name: "Email draft" });
    await user.type(within(editor).getByLabelText("To"), TALENT);
    await user.type(within(editor).getByLabelText("Subject"), "Application for AI Engineer");
    await user.type(within(editor).getByLabelText("Message"), "Please find my resume attached.");
    await user.click(within(editor).getByRole("button", { name: "Tailored resume · resume.md" }));
    await user.click(within(editor).getByRole("button", { name: "Review and send" }));
    expect(await screen.findByText("The email is waiting in Approvals. Nothing is sent until you approve it.")).toBeInTheDocument();
    const pending = (await bridge.approvals.list()).filter((a) => a.action === "email_send" && a.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.email?.attachments.map((a) => a.rel)).toEqual(["companies/acme-corp/jobs/2026-01-12-ai-engineer/application/resume.md"]);
  });

  it("opens an existing draft and refuses a bad address", async () => {
    const user = userEvent.setup();
    renderApp(<JobScreen route={LABS} />);
    const drafts = await screen.findByRole("list", { name: "Drafts" });
    await user.click(within(drafts).getByRole("button", { name: "Edit Following up" }));
    const editor = await screen.findByRole("form", { name: "Email draft" });
    expect(within(editor).getByLabelText("Subject")).toHaveValue("Following up");
    const to = within(editor).getByLabelText("To");
    await user.clear(to);
    await user.type(to, "not an address");
    await user.click(within(editor).getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText('"not an address" isn\'t an email address.')).toBeInTheDocument();
  });

  it("doesn't offer a link to the job page you're already on", async () => {
    const user = userEvent.setup();
    renderApp(<JobScreen route={ACME} />);
    await user.click(await screen.findByRole("button", { name: /Interview for AI Engineer/ }));
    const viewer = await screen.findByRole("region", { name: "Message" });
    expect(within(viewer).getByText("AI Engineer · Acme Corp")).toBeInTheDocument();
    expect(within(viewer).queryByRole("button", { name: "AI Engineer · Acme Corp" })).toBeNull();
  });

  it("says why Review and send is off until there is an address and a subject", async () => {
    const user = userEvent.setup();
    renderApp(<JobScreen route={ACME} />);
    await user.click(await screen.findByRole("button", { name: "New email" }));
    const editor = await screen.findByRole("form", { name: "Email draft" });
    expect(within(editor).getByRole("button", { name: "Review and send" })).toHaveAccessibleDescription("Add who it goes to first.");
    await user.type(within(editor).getByLabelText("To"), TALENT);
    expect(within(editor).getByRole("button", { name: "Review and send" })).toHaveAccessibleDescription("Add a subject first.");
    await user.type(within(editor).getByLabelText("Subject"), "Hello");
    expect(within(editor).getByRole("button", { name: "Review and send" })).toBeEnabled();
  });

  it("shows the exact saved message after Save draft", async () => {
    const user = userEvent.setup();
    renderApp(<JobScreen route={ACME} />);
    await user.click(await screen.findByRole("button", { name: "New email" }));
    const editor = await screen.findByRole("form", { name: "Email draft" });
    await user.type(within(editor).getByLabelText("To"), TALENT);
    await user.type(within(editor).getByLabelText("Subject"), "Hello");
    await user.type(within(editor).getByLabelText("Message"), "Hi there.");
    await user.click(within(editor).getByRole("button", { name: "Save draft" }));
    const preview = await within(editor).findByRole("region", { name: "Email preview" });
    expect(within(preview).getByLabelText("Message as sent")).toHaveTextContent(/Hi there\.\s*Alex Example/);
    expect(preview).not.toHaveTextContent("companies/");
  });

  it("is a tab on the job page", async () => {
    renderApp(<JobScreen route={ACME} />);
    const tab = await screen.findByRole("tab", { name: /Mail/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
  });
});

describe("Job > Mail reader", () => {
  it("uses the dense list and the full-height reader, with a tag only on company mail", async () => {
    const user = userEvent.setup();
    renderApp(<JobScreen route={ACME} />, { bridge: new MockBridge({ mailDemo: true }) });
    const list = await screen.findByRole("list", { name: "Threads" });
    const rows = within(list).getAllByRole("button");
    const coffee = rows.find((r) => r.querySelector(".mail-row__subject")?.textContent === "Coffee chat about the AI team?")!;
    expect(coffee.querySelector(".mail-tag")?.textContent).toBe("Company mail");
    const interview = rows.find((r) => r.querySelector(".mail-row__subject")?.textContent === "Interview for AI Engineer")!;
    expect(interview.querySelector(".mail-tag")).toBeNull();
    await user.click(interview);
    const viewer = await screen.findByRole("region", { name: "Message" });
    expect(viewer).toHaveClass("mail-viewer--fill");
    expect(within(viewer).getByRole("button", { name: "Plain text" })).toBeInTheDocument();
    expect(within(viewer).getByRole("button", { name: "Reply" })).toBeInTheDocument();
  });
});
