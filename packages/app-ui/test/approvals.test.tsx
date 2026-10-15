import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { ApprovalsScreen } from "../src/screens/Approvals";
import { renderApp, cutAndHover } from "./render";

const SLUG = "example-labs";
const ID = "2026-01-12-backend-engineer-llm";

describe("Approvals", () => {
  it("shows what approving will do", async () => {
    renderApp(<ApprovalsScreen />);
    const card = await screen.findByRole("region", { name: "Move Example Labs to Interview" });
    expect(within(card).getByText("From Claude or the command line")).toBeInTheDocument();
    expect(within(card).getByRole("list", { name: "What will happen" })).toHaveTextContent("Set the job status to Interview");
  });

  it("runs an approval exactly once, even on a double click", async () => {
    const b = new MockBridge();
    const real = b.approvals.approve;
    let count = 0;
    b.approvals.approve = (id, d) => { count++; return new Promise((r) => setTimeout(() => r(real(id, d)), 30)); };
    const user = userEvent.setup();
    renderApp(<ApprovalsScreen />, { bridge: b });
    await user.dblClick(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByRole("table", { name: "History" })).toHaveTextContent("Done"));
    expect(count).toBe(1);
    expect((await b.jobs.get(SLUG, ID)).job.status).toBe("Interview");
    expect(screen.queryByText(/can't become approved/)).not.toBeInTheDocument();
  });

  // The `started` guard (not userEvent's own click-sequencing) is what makes a second,
  // truly-synchronous click within the same act() a no-op. Verified by temporarily deleting
  // the `if (started.current.has(id)) return;` line in Approvals.tsx and re-running this
  // test: with the guard removed it fails with `count` at 2, not 1 (see task-28-report.md).
  it("makes exactly one approve call for two native clicks fired inside a single act()", async () => {
    const b = new MockBridge();
    const real = b.approvals.approve;
    let count = 0;
    b.approvals.approve = (id, d) => { count++; return real(id, d); };
    renderApp(<ApprovalsScreen />, { bridge: b });
    const btn = await screen.findByRole("button", { name: "Approve" });
    act(() => { btn.click(); btn.click(); });
    await waitFor(() => expect(screen.getByRole("table", { name: "History" })).toHaveTextContent("Done"));
    expect(count).toBe(1);
  });

  it("declines with a note and changes nothing", async () => {
    const { bridge } = renderApp(<ApprovalsScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await userEvent.type(screen.getByLabelText("Reason (optional)"), "Not yet");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(screen.getByRole("table", { name: "History" })).toHaveTextContent("Declined"));
    expect(screen.getByRole("table", { name: "History" })).toHaveTextContent("Not yet");
    expect((await bridge.jobs.get(SLUG, ID)).job.status).toBe("Found");
  });

  it("lets you retry after a failure", async () => {
    const b = new MockBridge();
    const real = b.approvals.approve;
    let fail = true;
    b.approvals.approve = (id, d) => (fail ? (fail = false, Promise.reject(new Error("disk is full"))) : real(id, d));
    renderApp(<ApprovalsScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("disk is full")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByRole("table", { name: "History" })).toHaveTextContent("Done"));
  });

  // Rejections always get a visible danger toast (not just the retry test's inline banner).
  it("shows a visible danger toast on a rejection, and only a success toast on a real success", async () => {
    const b = new MockBridge();
    const real = b.approvals.approve;
    let fail = true;
    b.approvals.approve = (id, d) => (fail ? (fail = false, Promise.reject(new Error("disk is full"))) : real(id, d));
    renderApp(<ApprovalsScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const danger = await screen.findByText("disk is full");
    expect(danger.closest(".toast")).toHaveClass("toast--danger");
    expect(screen.queryByText("Approved and done")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const success = await screen.findByText("Approved and done");
    expect(success.closest(".toast")).toHaveClass("toast--success");
  });

  // A failed reload must not hide what's already on screen, and it must take away the
  // controls that would act on data we can no longer trust is current.
  it("shows the error over stale cards and hides Approve/Decline when a reload fails", async () => {
    const b = new MockBridge();
    const list = b.approvals.list;
    let calls = 0;
    b.approvals.list = () => { calls += 1; return calls > 1 ? Promise.reject(new Error("approvals file is not readable")) : list(); };
    renderApp(<ApprovalsScreen />, { bridge: b });
    await screen.findByRole("region", { name: "Move Example Labs to Interview" });
    b.emitExternalChange("approvals");
    expect(await screen.findByText("Approvals can't be refreshed")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Move Example Labs to Interview" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
  });

  // Known gap (spec): a crash between the disk write and the action finishing can leave an
  // approval stuck in "approved". It must read as stuck, with no way to approve it again.
  it("shows a crashed approve as stuck, not running, and never offers a second Approve for it", async () => {
    const f = loadFixture();
    f.approvals.push({ ...f.approvals[0]!, id: "20260113t090000-abc999", title: "Move Acme Corp to Applied", status: "approved", result_note: "" });
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    await screen.findByText("Move Acme Corp to Applied");
    expect(screen.getByText("Didn't finish")).toBeInTheDocument();
    expect(screen.getByText("This didn't finish last time. Nothing more will run by itself.")).toBeInTheDocument();
    const row = screen.getByText("Move Acme Corp to Applied").closest("tr")!;
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    // The one real pending approval still gets its Approve button; the crashed one just isn't it.
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
  });

  // spec §5: a hand-off card shows the real host it will open, never a URL string that can
  // hide its true destination behind a userinfo prefix, plus the files it will reveal.
  it("shows the real host (not the raw URL) and the files a hand-off will reveal", async () => {
    const f = loadFixture();
    f.approvals.push({
      ...f.approvals[0]!, id: "20260113t090000-def456", action: "apply_handoff",
      title: "Hand off application to Acme Corp", summary: "2 file(s) ready.",
      steps: ["Open https://jobs.example.com/apply/1 in your browser", "Show the application folder (2 files)"],
      payload: { company_slug: "acme-corp", id: "job-1", url: "https://jobs.example.com/apply/1", files: ["application/resume.md", "application/cover-letter.md"] },
      status: "pending",
    });
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const card = await screen.findByRole("region", { name: "Hand off application to Acme Corp" });
    expect(within(card).getByText("Open jobs.example.com and reveal 2 files")).toBeInTheDocument();
    expect(within(card).getByRole("list", { name: "What will happen" })).toHaveTextContent("resume.md, cover-letter.md");
  });

  it("never shows or uses a userinfo prefix as the host for a hand-off link", async () => {
    const f = loadFixture();
    const trick = "https://real-looking-company.example" + "@evil.example/apply";
    f.approvals.push({
      ...f.approvals[0]!, id: "20260113t090000-aaa111", action: "apply_handoff",
      title: "Hand off application to Shady Co", summary: "1 file(s) ready.",
      steps: [`Open ${trick} in your browser`, "Show the application folder (1 files)"],
      payload: { company_slug: "shady-co", id: "job-2", url: trick, files: ["application/resume.md"] },
      status: "pending",
    });
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const card = await screen.findByRole("region", { name: "Hand off application to Shady Co" });
    expect(within(card).queryByText(/real-looking-company/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/evil\.example/)).not.toBeInTheDocument();
    expect(within(card).getByText("Reveal 1 file")).toBeInTheDocument();
  });

  // A hand-off's url can fail to be a safe link in several ways; none of them may promise
  // a link will open, and none of them may let Approve run.
  it("refuses to promise a link will open, and disables Approve, for every kind of unsafe hand-off url", async () => {
    const cases: [string, string][] = [
      ["bad-http", "http://jobs.example.com/apply/1"],
      ["bad-js", "javascript:alert(1)"],
      ["bad-malformed", "not a url"],
      ["bad-userinfo", "https://" + "ok.example.com" + "@evil.example/apply"],
    ];
    const f = loadFixture();
    for (const [id, url] of cases) {
      f.approvals.push({
        ...f.approvals[0]!, id, action: "apply_handoff", title: `Hand off ${id}`, summary: "",
        payload: { company_slug: "acme-corp", id: "job-1", url, files: ["application/resume.md"] }, status: "pending",
      });
    }
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    for (const [id] of cases) {
      const card = await screen.findByRole("region", { name: `Hand off ${id}` });
      expect(within(card).getByRole("list", { name: "What will happen" })).toHaveTextContent("No link will open: it isn't a plain https address.");
      expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
    }
  });

  // Round 2: a hand-off's url can also be the wrong shape entirely (not just the wrong
  // scheme or a userinfo trick) - a number, an array, an empty string, or missing outright.
  // There is no url-less "reveal only" hand-off by design (core and services both require
  // a url before an apply_handoff can even be proposed), so every one of these must be
  // treated exactly like any other unsafe url: no promised link, no Approve.
  it("refuses to promise a link will open, and disables Approve, for a number, an empty string, an array, or a missing url", async () => {
    const f = loadFixture();
    const base = { ...f.approvals[0]!, action: "apply_handoff" as const, summary: "", status: "pending" as const };
    const { url: _unused, ...payloadWithoutUrl } = f.approvals[0]!.payload as { url?: unknown; company_slug: string; id: string };
    f.approvals.push(
      { ...base, id: "bad-number", title: "Hand off bad-number", payload: { company_slug: "acme-corp", id: "job-1", url: 42, files: ["application/resume.md"] } },
      { ...base, id: "bad-empty", title: "Hand off bad-empty", payload: { company_slug: "acme-corp", id: "job-1", url: "", files: ["application/resume.md"] } },
      { ...base, id: "bad-array", title: "Hand off bad-array", payload: { company_slug: "acme-corp", id: "job-1", url: ["https://ok.example.com/x"], files: ["application/resume.md"] } },
      { ...base, id: "bad-missing", title: "Hand off bad-missing", payload: { ...payloadWithoutUrl, company_slug: "acme-corp", id: "job-1", files: ["application/resume.md"] } },
    );
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    for (const title of ["Hand off bad-number", "Hand off bad-empty", "Hand off bad-array", "Hand off bad-missing"]) {
      const card = await screen.findByRole("region", { name: title });
      expect(within(card).getByRole("list", { name: "What will happen" }), title).toHaveTextContent("No link will open: it isn't a plain https address.");
      expect(within(card).getByRole("button", { name: "Approve" }), title).toBeDisabled();
    }
  });

  // What will happen" for a status change is built from the payload's `status`, not from
  // the free-text `steps` the approval happens to carry.
  it("builds 'What will happen' for a status change from the payload's status, naming the role in the headline", async () => {
    renderApp(<ApprovalsScreen />);
    const card = await screen.findByRole("region", { name: "Move Example Labs to Interview" });
    // The headline names the role, not just the company (which shows separately below it).
    expect(within(card).getByText("Backend Engineer (LLM): Found → Interview")).toBeInTheDocument();
    const steps = within(card).getByRole("list", { name: "What will happen" });
    expect(steps).toHaveTextContent("Set the job status to Interview");
    expect(steps).toHaveTextContent('Add a timeline event "Status: Interview"');
  });

  it("builds 'What will happen' from the payload even when the free-text steps say something else", async () => {
    const f = loadFixture();
    f.approvals[0] = {
      ...f.approvals[0]!, title: "Move Example Labs to Declined",
      steps: ["Set the job status to Declined", 'Add a timeline event "Status: Declined"'],
      payload: { ...f.approvals[0]!.payload, status: "Interview" },
    };
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const card = await screen.findByRole("region", { name: "Move Example Labs to Declined" });
    const steps = within(card).getByRole("list", { name: "What will happen" });
    expect(steps).toHaveTextContent("Set the job status to Interview");
    expect(steps).not.toHaveTextContent("Declined");
  });

  it("names the job (title at company) on a status-change card, linking to the job and its notes", async () => {
    renderApp(<ApprovalsScreen />);
    const card = await screen.findByRole("region", { name: "Move Example Labs to Interview" });
    expect(within(card).getByRole("button", { name: "Backend Engineer (LLM) at Example Labs" })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: /^See timeline/ }));
    expect(window.location.hash).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm?tab=timeline");
  });

  // approve() can resolve (not reject) with a "failed" result when the action itself
  // couldn't finish; that must still surface as a danger toast, never a success one.
  it("shows a danger toast, not a success one, when approve() resolves with a failed result", async () => {
    const b = new MockBridge();
    const real = b.approvals.approve;
    b.approvals.approve = async (id, d) => { const a = await real(id, d); return { ...a, status: "failed", result_note: "disk is full" }; };
    renderApp(<ApprovalsScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const msg = await screen.findByText("It didn't finish: disk is full");
    expect(msg.closest(".toast")).toHaveClass("toast--danger");
    expect(screen.queryByText("Approved and done")).not.toBeInTheDocument();
  });

  // Text's truncate prop sets a native title tooltip to the full string; a long headline
  // must get the same treatment as every other piece of untrusted text on this screen.
  it("truncates a long headline and gives it a title tooltip with the full text", async () => {
    const f = loadFixture();
    const longTitle = `Send follow-up to ${"Acme Corp ".repeat(20)}`.trim();
    f.approvals.push({ ...f.approvals[0]!, id: "20260115t090000-longtitle", action: "email_send", title: longTitle, status: "pending" });
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const heading = await screen.findByText(longTitle, { selector: "h2" });
    cutAndHover(heading);
    expect(heading).toHaveAttribute("title", longTitle);
    expect(heading).toHaveClass("truncate");
  });

  it("shows nothing waiting when there is no pending approval", async () => {
    const f = loadFixture();
    f.approvals = [];
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByText("Nothing is waiting for you.")).toBeInTheDocument();
  });

  // Titles are untrusted payload text: a bidi control character that disguises the real
  // content must never reach the screen unmodified.
  it("shows a bidi-disguised approval title with the hidden control character made visible", async () => {
    const f = loadFixture();
    const name = "Move Example Labs‮ctni.Interview";
    const cleaned = "Move Example Labs�ctni.Interview";
    f.approvals[0]!.title = name;
    renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const card = await screen.findByRole("region", { name: cleaned });
    expect(within(card).getByText(cleaned)).toBeInTheDocument();
    expect(screen.queryByText(name)).toBeNull();
  });

  // Final review I3: the card binds to the record it showed.
  it("refuses, visibly, when the request changed after the card was shown, and runs nothing", async () => {
    const b = new MockBridge();
    renderApp(<ApprovalsScreen />, { bridge: b });
    const card = await screen.findByRole("region", { name: "Move Example Labs to Interview" });
    const [a] = await b.approvals.list();
    b.simulateApprovalEdit(a!.id, { payload: { ...a!.payload, status: "Rejected" } });
    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));
    const msg = await screen.findByText("This request changed after you opened it. Review it again.");
    expect(msg.closest(".toast")).toHaveClass("toast--danger");
    expect(screen.queryByText("Approved and done")).not.toBeInTheDocument();
    expect((await b.jobs.get(SLUG, ID)).job.status).toBe("Found");
  });

  it("says From you only for approvals the app created, whatever created_by says", async () => {
    const f = loadFixture();
    f.approvals.push({ ...f.approvals[0]!, id: "20260115t090000-forged", title: "Forged hand-off", created_by: "app", status: "pending" });
    const b = new MockBridge({ fixture: f });
    b.simulateClaudeOutput("acme-corp", f.jobs.find((j) => j.job.company_slug === "acme-corp")!.job.id);
    await b.apply.requestApproval("acme-corp", f.jobs.find((j) => j.job.company_slug === "acme-corp")!.job.id);
    renderApp(<ApprovalsScreen />, { bridge: b });
    const forged = await screen.findByRole("region", { name: "Forged hand-off" });
    expect(within(forged).getByText("From Claude or the command line")).toBeInTheDocument();
    const mine = await screen.findByRole("region", { name: "Hand off application to Acme Corp" });
    expect(within(mine).getByText("From you")).toBeInTheDocument();
  });

  describe("details drawer", () => {
    it("shows a pending proposal's payload as readable fields, never raw JSON", async () => {
      renderApp(<ApprovalsScreen />);
      await userEvent.click(await screen.findByRole("button", { name: /^Details/ }));
      const d = screen.getByRole("dialog");
      const field = (label: string) => within(d).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
      expect(field("Request")).toHaveTextContent("Change a job's status");
      expect(field("New status")).toHaveTextContent("Interview");
      expect(field("Note")).toHaveTextContent("Invite for Thursday");
      expect(field("Job")).toHaveTextContent("Backend Engineer (LLM) at Example Labs");
      expect(field("Asked")).toHaveTextContent("14 Jan 2026");
      expect(d.textContent).not.toMatch(/[{}]|company_slug|"status"/);
      expect(within(d).getByRole("list", { name: "What will happen" })).toHaveTextContent("Set the job status to Interview");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens a history row in a drawer, with files as names and nested values as plain lines", async () => {
      const f = loadFixture();
      f.approvals.push({
        ...f.approvals[0]!, id: "20260113t090000-def456", action: "apply_handoff", title: "Hand off application to Acme Corp",
        payload: { company_slug: "acme-corp", id: "job-1", url: "https://jobs.example.com/apply/1", files: ["application/resume.md", "application/cover-letter.md"] },
        status: "done", decided_at: "2026-01-14T10:00:00.000Z", result_note: "Opened the page and revealed 2 files",
      });
      f.approvals.push({
        ...f.approvals[0]!, id: "20260113t090000-aaa111", action: "email_send", title: "Send follow-up to Acme Corp",
        payload: { to: "hiring" + "@" + "example.com", subject: "Following up", meta: { tone: "warm", retries: 2 } },
        status: "declined", decided_at: "2026-01-14T11:00:00.000Z", result_note: "",
      });
      renderApp(<ApprovalsScreen />, { bridge: new MockBridge({ fixture: f }) });
      const table = await screen.findByRole("table", { name: "History" });
      await userEvent.click(within(table).getByText("Hand off application to Acme Corp"));
      let d = screen.getByRole("dialog");
      const field = (label: string) => within(d).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
      expect(field("Opens")).toHaveTextContent("jobs.example.com");
      expect(field("Files")).toHaveTextContent("resume.mdcover-letter.md");
      expect(field("Result")).toHaveTextContent("Opened the page and revealed 2 files");
      await userEvent.click(within(d).getByRole("button", { name: "Previous decision" }));
      d = screen.getByRole("dialog");
      expect(field("Subject")).toHaveTextContent("Following up");
      expect(field("Meta").textContent).toBe("Tone: warm\nRetries: 2");
      expect(d.textContent).not.toMatch(/[{}]/);
    });
  });
});
