import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EXPORT_FORMATS, EXPORT_SOURCES, exportRel, type ApplyState, type ExportState } from "@careeros/contract";
import { loadFixture, MockBridge } from "../src/mock/MockBridge";
import { ApplyScreen, applicationAttachments, emailApplicationDraft, textOnlyNote } from "../src/screens/Apply";
import { renderApp } from "./render";

const SLUG = "example-labs";
const ID = "2026-01-12-backend-engineer-llm";
const JOBS = "jobs" + "@" + "example.org";

const primaries = () => screen.getAllByRole("button").filter((b) => b.classList.contains("btn--primary"));

describe("Apply: email application", () => {
  it("pre-fills an email to apply_via with the application files, then waits for approval, then confirms", async () => {
    const user = userEvent.setup();
    const f = loadFixture();
    f.jobs.find((j) => j.job.id === ID)!.job.apply_via = JOBS;
    const bridge = new MockBridge({ fixture: f });
    bridge.simulateClaudeOutput(SLUG, ID);
    renderApp(<ApplyScreen route={{ screen: "apply", slug: SLUG, id: ID }} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Email application" }));
    const editor = await screen.findByRole("form", { name: "Email draft" });
    expect(within(editor).getByRole("button", { name: `Remove ${JOBS}` })).toBeInTheDocument();
    expect(within(editor).getByLabelText("Subject")).toHaveValue("Application for Backend Engineer (LLM)");
    // Attachment labels name the file, never its folder path. No export yet: the text file, with a note.
    expect(within(editor).getByRole("button", { name: "Tailored resume · resume.md" })).toHaveAttribute("aria-pressed", "true");
    expect(await within(editor).findByText("Your resume and cover letter will be sent as text files. Export PDFs first for a cleaner look.")).toBeInTheDocument();
    expect(within(editor).getByRole("button", { name: "Claim check · claims.json" })).toHaveAttribute("aria-pressed", "false");
    expect(editor).not.toHaveTextContent("application/");
    await user.click(within(editor).getByRole("button", { name: "Review and send" }));
    expect(await screen.findByRole("region", { name: "Email preview" })).toHaveTextContent(JOBS);
    expect(screen.getByText("The email is waiting for your approval. Approving sends exactly this:")).toBeInTheDocument();
    const a = (await bridge.approvals.list()).find((x) => x.action === "email_send" && x.status === "pending")!;
    expect(a.payload.purpose).toBe("apply");
    await bridge.approvals.approve(a.id, a.digest);
    expect(await screen.findByText("The email was sent. Did the employer get everything they asked for?")).toBeInTheDocument();
    expect(bridge.calls.some((c) => c.method === "apply.markApplied")).toBe(false);
    await user.click(screen.getByRole("button", { name: "I applied" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === "apply.markApplied")).toBe(true));
  });
  it("when the email may not have gone, offers Mark as sent and Send again right on the hand-off", async () => {
    const user = userEvent.setup();
    const f = loadFixture();
    f.jobs.find((j) => j.job.id === ID)!.job.apply_via = JOBS;
    const bridge = new MockBridge({ fixture: f, mailSendUnsure: true });
    bridge.simulateClaudeOutput(SLUG, ID);
    renderApp(<ApplyScreen route={{ screen: "apply", slug: SLUG, id: ID }} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Email application" }));
    await user.click(within(await screen.findByRole("form", { name: "Email draft" })).getByRole("button", { name: "Review and send" }));
    await screen.findByRole("region", { name: "Email preview" });
    const a = (await bridge.approvals.list()).find((x) => x.action === "email_send" && x.status === "pending")!;
    await bridge.approvals.approve(a.id, a.digest);
    expect(await screen.findByText(/The email may not have gone out\. Look in Gmail's Sent folder/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send again" }));
    const dialog = await screen.findByRole("dialog", { name: "Send this email again?" });
    expect(within(dialog).getByRole("region", { name: "Email preview" })).toHaveTextContent(JOBS);
    await user.click(within(dialog).getByRole("button", { name: "Send again" }));
    expect(await screen.findByText("The email was sent. Did the employer get everything they asked for?")).toBeInTheDocument();
    expect(bridge.calls.find((c) => c.method === "mail.send.again")!.args).toEqual([a.id, a.digest, true]);
  });
  it("doesn't offer email when apply_via is a link", async () => {
    const bridge = new MockBridge();
    bridge.simulateClaudeOutput(SLUG, ID);
    renderApp(<ApplyScreen route={{ screen: "apply", slug: SLUG, id: ID }} />, { bridge });
    await screen.findByRole("button", { name: "Request approval" });
    expect(screen.queryByRole("button", { name: "Email application" })).not.toBeInTheDocument();
  });
  it("has one primary button on Review: the hand-off when there is an apply link", async () => {
    const f = loadFixture();
    f.jobs.find((j) => j.job.id === ID)!.job.apply_via = JOBS;
    const bridge = new MockBridge({ fixture: f });
    bridge.simulateClaudeOutput(SLUG, ID);
    renderApp(<ApplyScreen route={{ screen: "apply", slug: SLUG, id: ID }} />, { bridge });
    await screen.findByRole("button", { name: "Email application" });
    expect(primaries().map((b) => b.textContent)).toEqual(["Request approval"]);
    expect(screen.getByText(`This job takes applications by email at ${JOBS}.`)).toBeInTheDocument();
  });
  it("makes Email application the primary when email is the only way to apply", async () => {
    const f = loadFixture();
    const j = f.jobs.find((x) => x.job.id === ID)!;
    j.job.apply_via = `mailto:${JOBS}`;
    j.job.url = "";
    const bridge = new MockBridge({ fixture: f });
    bridge.simulateClaudeOutput(SLUG, ID);
    renderApp(<ApplyScreen route={{ screen: "apply", slug: SLUG, id: ID }} />, { bridge });
    await screen.findByRole("button", { name: "Email application" });
    expect(primaries().map((b) => b.textContent)).toEqual(["Email application"]);
    expect(screen.queryByRole("button", { name: "Request approval" })).not.toBeInTheDocument();
  });
  it("builds the draft from the sendable application files only", () => {
    const file = (path: string, exists = true) => ({ path, rel: `companies/x/jobs/y/${path}`, label: path.split("/").pop()!, at: "", exists, size: 1, kind: "markdown" as const });
    const s = { title: "AI Engineer", company_name: "Acme Corp", apply_email: JOBS, files: [file("application/resume.md"), file("application/cover-letter.md"), file("application/claims.json"), file("application/PREPARE.md"), file("application/old.md", false), file("notes/x.md")] } as unknown as ApplyState;
    expect(emailApplicationDraft(s)).toMatchObject({
      to: JOBS, subject: "Application for AI Engineer", purpose: "apply",
      attach: ["companies/x/jobs/y/application/resume.md", "companies/x/jobs/y/application/cover-letter.md"],
    });
  });
  it("attaches the exported PDF instead of the Markdown, labelled by file name only", async () => {
    const user = userEvent.setup();
    const f = loadFixture();
    f.jobs.find((j) => j.job.id === ID)!.job.apply_via = JOBS;
    const bridge = new MockBridge({ fixture: f });
    bridge.simulateClaudeOutput(SLUG, ID);
    await bridge.docs.export(SLUG, ID, ["resume"], ["pdf", "docx"], false);
    await bridge.docs.export(SLUG, ID, ["cover-letter"], ["pdf"], false);
    renderApp(<ApplyScreen route={{ screen: "apply", slug: SLUG, id: ID }} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Email application" }));
    const editor = await screen.findByRole("form", { name: "Email draft" });
    expect(await within(editor).findByRole("button", { name: "Tailored resume · resume.pdf" })).toHaveAttribute("aria-pressed", "true");
    expect(within(editor).getByRole("button", { name: "Tailored resume · resume.docx" })).toHaveAttribute("aria-pressed", "false");
    expect(within(editor).getByRole("button", { name: "Tailored resume · resume.md" })).toHaveAttribute("aria-pressed", "false");
    expect(within(editor).getByRole("button", { name: "Cover letter · cover-letter.pdf" })).toHaveAttribute("aria-pressed", "true");
    expect(within(editor).queryByText(/will be sent as a text file/)).not.toBeInTheDocument();
    expect(editor).not.toHaveTextContent("application/");
  });
  it("offers to export a PDF from the note, then swaps it in without losing what was typed", async () => {
    const user = userEvent.setup();
    const f = loadFixture();
    f.jobs.find((j) => j.job.id === ID)!.job.apply_via = JOBS;
    const bridge = new MockBridge({ fixture: f });
    bridge.simulateClaudeOutput(SLUG, ID);
    await bridge.docs.export(SLUG, ID, ["cover-letter"], ["pdf"], false);
    renderApp(<ApplyScreen route={{ screen: "apply", slug: SLUG, id: ID }} />, { bridge });
    await user.click(await screen.findByRole("button", { name: "Email application" }));
    const editor = await screen.findByRole("form", { name: "Email draft" });
    await within(editor).findByText("Your resume will be sent as a text file. Export a PDF first for a cleaner look.");
    await user.type(within(editor).getByLabelText("Message"), " Thank you.");
    await user.click(within(editor).getByRole("button", { name: "Export PDF" }));
    expect(await within(editor).findByRole("button", { name: "Tailored resume · resume.pdf" })).toHaveAttribute("aria-pressed", "true");
    expect(within(editor).getByRole("button", { name: "Tailored resume · resume.md" })).toHaveAttribute("aria-pressed", "false");
    expect(within(editor).queryByText(/will be sent as a text file/)).not.toBeInTheDocument();
    expect((within(editor).getByLabelText("Message") as HTMLTextAreaElement).value).toContain("Thank you.");
    expect(bridge.calls.filter((c) => c.method === "docs.export").at(-1)?.args.slice(2)).toEqual([["resume"], ["pdf"], false]);
  });
  it("prefers PDF, then Word, and falls back to the Markdown only when nothing was exported", () => {
    const file = (path: string) => ({ path, rel: `companies/x/jobs/y/${path}`, label: path.split("/").pop()!, at: "", exists: true, size: 1, kind: "markdown" as const });
    const s = { company_slug: "x", id: "y", title: "AI Engineer", company_name: "Acme Corp", apply_email: JOBS, files: [file("application/resume.md"), file("application/cover-letter.md"), file("application/answers.md")] } as unknown as ApplyState;
    const exp = (made: string[]): ExportState => ({
      sources: EXPORT_SOURCES.map((source) => ({ source, path: `companies/x/jobs/y/application/${source}.md`, exists: true })),
      files: EXPORT_SOURCES.flatMap((source) => EXPORT_FORMATS.map((format) => ({ source, format, name: `${source}.${format}`, path: exportRel("x", "y", source, format), exists: made.includes(`${source}.${format}`), size: 1, at: "", problem: null }))),
    });
    const pick = (made: string[]) => applicationAttachments(s, exp(made));
    expect(pick(["resume.pdf", "resume.docx", "cover-letter.docx"])).toMatchObject({
      attach: [exportRel("x", "y", "resume", "pdf"), exportRel("x", "y", "cover-letter", "docx"), "companies/x/jobs/y/application/answers.md"], textOnly: [],
    });
    expect(pick([])).toMatchObject({ attach: ["companies/x/jobs/y/application/resume.md", "companies/x/jobs/y/application/cover-letter.md", "companies/x/jobs/y/application/answers.md"], textOnly: ["resume", "cover-letter"] });
    // A missing export state (still loading, or it failed) never blocks the draft: the Markdown is used.
    expect(emailApplicationDraft(s, null).attach).toEqual(pick([]).attach);
    expect(pick(["cover-letter.pdf"]).files.map((x) => x.path)).toEqual(["application/resume.md", "application/export/cover-letter.pdf", "application/cover-letter.md", "application/answers.md"]);
  });
  it("never sends an export older than the resume it was made from: the text goes, and the note asks for a new PDF", () => {
    const md = (path: string, at: string) => ({ path, rel: `companies/x/jobs/y/${path}`, label: path.split("/").pop()!, at, exists: true, size: 1, kind: "markdown" as const });
    const s = { files: [md("application/resume.md", "2026-01-15T10:00:00.000Z"), md("application/cover-letter.md", "2026-01-14T10:00:00.000Z")] } as unknown as ApplyState;
    const exp: ExportState = {
      sources: EXPORT_SOURCES.map((source) => ({ source, path: `companies/x/jobs/y/application/${source}.md`, exists: true })),
      files: EXPORT_SOURCES.map((source) => ({ source, format: "pdf" as const, name: `${source}.pdf`, path: exportRel("x", "y", source, "pdf"), exists: true, size: 1, at: "2026-01-15T09:00:00.000Z", problem: null })),
    };
    const p = applicationAttachments(s, exp);
    expect(p.attach).toEqual(["companies/x/jobs/y/application/resume.md", exportRel("x", "y", "cover-letter", "pdf")]);
    expect(p).toMatchObject({ textOnly: ["resume"], stale: ["resume"] });
    expect(textOnlyNote(p.textOnly, p.stale)).toBe("Your resume changed after its PDF was made, so it will be sent as a text file. Export a new PDF first for a cleaner look.");
  });
});
