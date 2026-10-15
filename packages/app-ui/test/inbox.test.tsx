import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { identity } from "@careeros/brand";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { InboxScreen, decodeTarget, encodeTarget } from "../src/screens/Inbox";
import { ResumeFillPanel } from "../src/resumefill";
import { App } from "../src/App";
import { renderApp } from "./render";

const fileCalls = (b: MockBridge) => b.calls.filter((c) => c.method === "inbox.file").map((c) => c.args);

describe("Inbox", () => {
  it("round-trips targets", () => {
    for (const t of [{ kind: "me", dir: "identity", sub: "visa" }, { kind: "me", dir: "resumes" }] as const) expect(decodeTarget(encodeTarget(t), "")).toEqual(t);
    expect(decodeTarget("job:acme-corp:2026-01-12-ai-engineer", "application")).toEqual({ kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer", subdir: "application" });
    expect(decodeTarget("", "")).toBeNull();
  });

  it("round-trips a job target whose id itself contains a colon", () => {
    const t = { kind: "job", company_slug: "acme-corp", id: "2026-01-12:ai-engineer", subdir: "interview" } as const;
    expect(decodeTarget(encodeTarget(t), "interview")).toEqual(t);
  });

  it("shows each file with its suggestion and files it there", async () => {
    const { bridge } = renderApp(<InboxScreen />);
    const visa = await screen.findByRole("region", { name: "Visa_Grant_Notice.pdf" });
    expect(within(visa).getByText("The name mentions a visa.")).toBeInTheDocument();
    expect(within(visa).getByLabelText("Destination")).toHaveValue("me:identity:visa");
    // me/identity is a locked folder: filing into it must be clearly labelled as such.
    expect(within(visa).getByText("Locked folder")).toBeInTheDocument();
    await userEvent.click(within(visa).getByRole("button", { name: "File it" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Visa_Grant_Notice.pdf" })).not.toBeInTheDocument());
    expect(fileCalls(bridge)).toEqual([["Visa_Grant_Notice.pdf", { kind: "me", dir: "identity", sub: "visa" }, ""]]);
  });

  it("lets you pick a job and a job folder instead", async () => {
    const { bridge } = renderApp(<InboxScreen />);
    const cl = await screen.findByRole("region", { name: "acme-corp-cover-letter.pdf" });
    await waitFor(() => expect(within(cl).getByRole("option", { name: /Backend Engineer \(LLM\)/ })).toBeInTheDocument());
    await userEvent.selectOptions(within(cl).getByLabelText("Destination"), "job:example-labs:2026-01-12-backend-engineer-llm");
    await userEvent.selectOptions(within(cl).getByLabelText("Job folder"), "interview");
    await userEvent.type(within(cl).getByLabelText("Note (optional)"), "Prep pack");
    await userEvent.click(within(cl).getByRole("button", { name: "File it" }));
    await waitFor(() => expect(fileCalls(bridge)).toEqual([[
      "acme-corp-cover-letter.pdf", { kind: "job", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm", subdir: "interview" }, "Prep pack",
    ]]));
  });

  it("adds dropped files and needs a folder when no rule matches", async () => {
    const { bridge } = renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: [] }) });
    const zone = await screen.findByLabelText("Drop files here");
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "offer.pdf")] } });
    const item = await screen.findByRole("region", { name: "offer.pdf" });
    expect(bridge.calls.find((c) => c.method === "inbox.add")?.args).toEqual([["/fictional/alex-example/Downloads/offer.pdf"]]);
    expect(within(item).getByText("No rule matched. Choose a folder.")).toBeInTheDocument();
    const fileIt = within(item).getByRole("button", { name: "File it" });
    expect(fileIt).toBeDisabled();
    // A disabled button says why, in text it points at.
    expect(fileIt).toHaveAccessibleDescription("Choose where this file goes, then File it.");
  });

  it("says when a dropped file has no path", async () => {
    const b = new MockBridge({ inbox: [] });
    b.pathForFile = () => null;
    renderApp(<InboxScreen />, { bridge: b });
    fireEvent.drop(await screen.findByLabelText("Drop files here"), { dataTransfer: { files: [new File(["x"], "clip.txt")] } });
    expect(await screen.findByText(/couldn't be added/)).toBeInTheDocument();
    expect(b.calls.some((c) => c.method === "inbox.add")).toBe(false);
  });

  it("shows an empty state when there is nothing to file", async () => {
    renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: [] }) });
    expect(await screen.findByText("Your drop box is empty")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${identity.name} will suggest where it belongs`))).toBeInTheDocument();
  });

  it("renders an untrusted file name as plain text and truncates it with a tooltip", async () => {
    const name = "<img src=x onerror=alert(1)>-very-long-suspicious-file-name-indeed.pdf";
    renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: [name] }) });
    const region = await screen.findByRole("region", { name });
    expect(within(region).queryByRole("img")).toBeNull();
    const label = within(region).getByTitle(name);
    // Truncated in the middle, so the end of the name (and its extension) stays visible; the text is the whole name once.
    expect(label.className).toMatch(/mid-trunc/);
    expect(label.textContent).toBe(name);
    expect(label.lastElementChild?.textContent?.endsWith("indeed.pdf")).toBe(true);
  });

  it("says nothing when the file picker is cancelled, but toasts once a picked file is really added", async () => {
    const b = new MockBridge({ inbox: [] });
    b.files.pick = async () => null;
    renderApp(<InboxScreen />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose file" })).not.toBeDisabled());
    expect(b.calls.some((c) => c.method === "inbox.add")).toBe(false);
    expect(screen.queryByText("Added to your drop box")).toBeNull();

    b.files.pick = async () => "/fictional/alex-example/Downloads/alex-example-cover-letter.pdf";
    await userEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(await screen.findByText("Added to your drop box")).toBeInTheDocument();
  });

  it("disables the File it button while filing is in flight, as a double-click guard", async () => {
    const b = new MockBridge();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const file = b.inbox.file;
    b.inbox.file = async (name, target, note) => { await held; return file(name, target, note); };
    renderApp(<InboxScreen />, { bridge: b });
    const visa = await screen.findByRole("region", { name: "Visa_Grant_Notice.pdf" });
    const button = within(visa).getByRole("button", { name: "File it" });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    release();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Visa_Grant_Notice.pdf" })).not.toBeInTheDocument());
  });

  it("shows the error and hides every mutating control when the inbox can't be refreshed, instead of trusting the stale list", async () => {
    const b = new MockBridge();
    const list = b.inbox.list;
    let calls = 0;
    b.inbox.list = async () => {
      calls += 1;
      if (calls > 1) throw new Error("the inbox folder is not readable");
      return list();
    };
    renderApp(<InboxScreen />, { bridge: b });
    const visa = await screen.findByRole("region", { name: "Visa_Grant_Notice.pdf" });
    b.emitExternalChange("inbox");
    expect(await screen.findByText("The drop box can't be refreshed")).toBeInTheDocument();
    // The stale item can stay on screen so the candidate knows what was there, but nothing
    // that mutates (adding, choosing a destination, filing) should still be available.
    expect(screen.queryByRole("region", { name: "Visa_Grant_Notice.pdf" })).toBe(visa);
    expect(screen.queryByLabelText("Drop files here")).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose file" })).toBeNull();
    expect(within(visa).queryByLabelText("Destination")).toBeNull();
    expect(within(visa).queryByRole("button", { name: "File it" })).toBeNull();
  });

  it("shows a clear error when the inbox fails to load at all", async () => {
    const b = new MockBridge();
    b.inbox.list = async () => { throw new Error("the inbox folder is not readable"); };
    renderApp(<InboxScreen />, { bridge: b });
    expect(await screen.findByText("The drop box can't be shown")).toBeInTheDocument();
    expect(screen.queryByLabelText("Drop files here")).toBeNull();
  });

  it("says when job folders can't be listed, and marks every row's Destination as missing them", async () => {
    const b = new MockBridge();
    b.jobs.list = async () => { throw new Error("jobs index is corrupt"); };
    renderApp(<InboxScreen />, { bridge: b });
    expect(await screen.findByText("Job folders can't be listed right now.")).toBeInTheDocument();
    const visa = await screen.findByRole("region", { name: "Visa_Grant_Notice.pdf" });
    expect(within(visa).getByText(/Job folders aren't available right now/)).toBeInTheDocument();
    const cl = await screen.findByRole("region", { name: "acme-corp-cover-letter.pdf" });
    expect(within(cl).getByText(/Job folders aren't available right now/)).toBeInTheDocument();
    // Filing into a non-job destination still works: the gap is isolated to job folders.
    expect(within(visa).getByRole("button", { name: "File it" })).not.toBeDisabled();
  });

  it("adds the files that resolve and names the one that didn't, when dropping several at once", async () => {
    const b = new MockBridge({ inbox: [] });
    const resolve = b.pathForFile;
    b.pathForFile = (f) => (f.name === "bad.txt" ? null : resolve(f));
    renderApp(<InboxScreen />, { bridge: b });
    const zone = await screen.findByLabelText("Drop files here");
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["a"], "good1.pdf"), new File(["b"], "bad.txt"), new File(["c"], "good2.pdf")] } });
    expect(await screen.findByText("1 file(s) couldn't be added. Drag them from Finder or File Explorer.")).toBeInTheDocument();
    await waitFor(() => expect(b.calls.find((c) => c.method === "inbox.add")?.args).toEqual([[
      "/fictional/alex-example/Downloads/good1.pdf", "/fictional/alex-example/Downloads/good2.pdf",
    ]]));
    expect(await screen.findByRole("region", { name: "good1.pdf" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "good2.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "bad.txt" })).toBeNull();
  });

  it("shows a bidi-disguised file name with the hidden control character made visible, in both the label and its tooltip", async () => {
    const name = "invoice‮fdp.exe";
    const cleaned = "invoice�fdp.exe";
    renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: [name] }) });
    const region = await screen.findByRole("region", { name: cleaned });
    const label = within(region).getByTitle(cleaned);
    expect(label.textContent).toBe(cleaned);
    expect(screen.queryByText(name)).toBeNull();
  });
});

describe("Drop box hub", () => {
  it("shows a tile per workspace section, with locked folders shown as Locked and never counted", async () => {
    renderApp(<InboxScreen />);
    const identity = await screen.findByRole("button", { name: /^Identity documents: locked/ });
    expect(identity).toHaveTextContent("Locked");
    expect(identity).toHaveTextContent("Not read while locked");
    expect(screen.getByRole("button", { name: /^Companies and jobs: \d+ files/ })).toBeInTheDocument();
    await userEvent.click(identity);
    expect(window.location.hash).toBe("#/privacy");
  });
  it("lists what was filed, and a newly filed file joins the history", async () => {
    const { bridge } = renderApp(<InboxScreen />);
    expect(await screen.findByText("alex-example-resume.pdf")).toBeInTheDocument();
    expect(screen.getByText(/to Resumes · Sample resume/)).toBeInTheDocument();
    const cl = await screen.findByRole("region", { name: "acme-corp-cover-letter.pdf" });
    await userEvent.click(within(cl).getByRole("button", { name: "File it" }));
    expect(await screen.findByText(/to Companies and jobs/)).toBeInTheDocument();
    const history = screen.getByRole("list", { name: /history/i });
    await userEvent.click(within(history).getAllByRole("button", { name: /^Show in folder: / })[0]!);
    expect(bridge.revealed.at(-1)).toMatch(/^companies\/acme-corp\/jobs\/.*acme-corp-cover-letter\.pdf$/);
  });
  it("says history starts now when nothing was filed, and keeps the drop zone large in an empty workspace", async () => {
    const f = loadFixture();
    f.texts = {};
    renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: [], filed: [], fixture: f }) });
    expect(await screen.findByText(/History starts from now/)).toBeInTheDocument();
    expect(screen.getByLabelText("Drop files here")).not.toHaveClass("dropzone--strip");
  });
});

describe("Inbox waiting file", () => {
  it("shows a waiting file in the file manager and names job folders in words", async () => {
    const { bridge } = renderApp(<InboxScreen />);
    const cl = await screen.findByRole("region", { name: "acme-corp-cover-letter.pdf" });
    await userEvent.click(within(cl).getByRole("button", { name: /: acme-corp-cover-letter\.pdf$/ }));
    await waitFor(() => expect(bridge.revealed).toContain("inbox/acme-corp-cover-letter.pdf"));
    await userEvent.selectOptions(within(cl).getByLabelText("Destination"), within(cl).getAllByRole("option").find((o) => o.textContent?.startsWith("Job:"))!);
    expect(cl).toHaveTextContent("Job: AI Engineer · Application documents");
    const sub = within(cl).getByLabelText("Job folder") as HTMLSelectElement;
    expect([...sub.options].map((o) => o.textContent)).toEqual(["Main job folder", "Application documents", "Emails", "Interview prep"]);
  });
});

describe("Removing and putting back waiting files", () => {
  const calls = (b: MockBridge, m: string) => b.calls.filter((c) => c.method === m).map((c) => c.args);

  it("moves one file to the Trash after a confirm, and Cancel keeps it", async () => {
    const { bridge } = renderApp(<InboxScreen />);
    const cl = await screen.findByRole("region", { name: "acme-corp-cover-letter.pdf" });
    await userEvent.click(within(cl).getByRole("button", { name: "Remove acme-corp-cover-letter.pdf" }));
    let dialog = await screen.findByRole("dialog", { name: "Remove acme-corp-cover-letter.pdf?" });
    expect(dialog).toHaveTextContent("It goes to the Trash, so you can still get it back.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls(bridge, "inbox.remove")).toEqual([]);
    await userEvent.click(within(cl).getByRole("button", { name: "Remove acme-corp-cover-letter.pdf" }));
    dialog = await screen.findByRole("dialog", { name: "Remove acme-corp-cover-letter.pdf?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Trash file" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "acme-corp-cover-letter.pdf" })).not.toBeInTheDocument());
    expect(calls(bridge, "inbox.remove")).toEqual([[["acme-corp-cover-letter.pdf"]]]);
  });

  it("removes all with one confirm that lists the files, sending exactly the names shown", async () => {
    const { bridge } = renderApp(<InboxScreen />);
    await screen.findByRole("region", { name: "Visa_Grant_Notice.pdf" });
    await userEvent.click(screen.getByRole("button", { name: "Remove all" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove all 2 files?" });
    expect(dialog).toHaveTextContent("acme-corp-cover-letter.pdf");
    expect(dialog).toHaveTextContent("Visa_Grant_Notice.pdf");
    await userEvent.click(within(dialog).getByRole("button", { name: "Trash 2 files" }));
    expect(await screen.findByText("Your drop box is empty")).toBeInTheDocument();
    expect(calls(bridge, "inbox.remove")).toEqual([[["acme-corp-cover-letter.pdf", "Visa_Grant_Notice.pdf"]]]);
  });

  it("hides Remove all when nothing is waiting", async () => {
    renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: [] }) });
    await screen.findByText("Your drop box is empty");
    expect(screen.queryByRole("button", { name: "Remove all" })).toBeNull();
  });

  it("offers Put back only for files the app added, and says where the file went", async () => {
    const { bridge } = renderApp(<InboxScreen />);
    const cl = await screen.findByRole("region", { name: "acme-corp-cover-letter.pdf" });
    expect(within(cl).queryByRole("button", { name: /Put back/ })).toBeNull();
    fireEvent.drop(screen.getByLabelText("Drop files here"), { dataTransfer: { files: [new File(["x"], "offer.pdf")] } });
    const offer = await screen.findByRole("region", { name: "offer.pdf" });
    expect(offer).toHaveTextContent("from Downloads");
    await userEvent.click(within(offer).getByRole("button", { name: "Put back in Downloads" }));
    expect(await screen.findByText("Moved offer.pdf back to Downloads.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "offer.pdf" })).not.toBeInTheDocument());
    expect(calls(bridge, "inbox.putBack")).toEqual([["offer.pdf"]]);
  });

  it("puts helper text under the whole form row, so the controls share one baseline", async () => {
    renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: ["notes.txt"] }) });
    const item = await screen.findByRole("region", { name: "notes.txt" });
    const help = within(item).getByText("Choose where this file goes, then File it.");
    expect(help.closest(".field")).toBeNull();
    expect(within(item).getByLabelText("Destination")).toHaveAccessibleDescription(/Choose where this file goes/);
  });
});

describe("Smart drop box", () => {
  const AD = "# Applied AI Engineer\n\nExample Robotics is hiring.\n\n## About the role\nAgents.\n\n## Responsibilities\n- Ship\n\n## Requirements\n- Python\n\nSalary: $140,000 per annum. How to apply: use the form.\n";
  const RESUME = "Alex Example\n\nProfessional summary\nAI Engineer.\n\nExperience\nExample Labs, 2023 - Present\n\nEducation\nBSc\n";
  const calls = (b: MockBridge, m: string) => b.calls.filter((c) => c.method === m).map((c) => c.args);

  it("recognises a saved job ad by its text and adds it as a job in one step", async () => {
    const b = new MockBridge({ inbox: ["saved-ad.md"], inboxTexts: { "saved-ad.md": AD } });
    renderApp(<InboxScreen />, { bridge: b });
    const row = await screen.findByRole("region", { name: "saved-ad.md" });
    expect(within(row).getByText("Job ad")).toBeInTheDocument();
    expect(within(row).getByText("Looks like a job ad from Example Robotics. Add it as a job, or choose a folder.")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Add job" }));
    const dialog = await screen.findByRole("dialog", { name: "Add this job ad as a job" });
    expect(within(dialog).getByLabelText("Company")).toHaveValue("Example Robotics");
    expect(within(dialog).getByLabelText("Job title")).toHaveValue("Applied AI Engineer");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add job" }));
    expect(await screen.findByText("Added Applied AI Engineer at Example Robotics.")).toBeInTheDocument();
    expect(calls(b, "inbox.addAsJob")).toEqual([["saved-ad.md", { company: "Example Robotics", title: "Applied AI Engineer" }]]);
    await waitFor(() => expect(screen.queryByRole("region", { name: "saved-ad.md" })).not.toBeInTheDocument());
  });

  it("hands that exact resume to Fill from my resume: no file picker, and the file stays waiting", async () => {
    const b = new MockBridge({ inbox: ["alex.md"], inboxTexts: { "alex.md": RESUME } });
    const first = renderApp(<InboxScreen />, { bridge: b });
    const row = await screen.findByRole("region", { name: "alex.md" });
    expect(within(row).getByLabelText("Destination")).toHaveValue("me:resumes");
    expect(within(row).getByRole("button", { name: "File it" })).not.toBeDisabled();
    await userEvent.click(within(row).getByRole("button", { name: "Fill profile" }));
    expect(window.location.hash).toBe("#/settings?tab=profile");
    first.unmount();

    renderApp(<ResumeFillPanel visible />, { bridge: b });
    expect(await screen.findByRole("heading", { name: "Check what we found" })).toBeInTheDocument();
    expect(calls(b, "inbox.readResume")).toEqual([["alex.md"]]);
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Profile filled from your resume")).toBeInTheDocument();
    expect(calls(b, "inbox.fillProfile").map((c) => c[0])).toEqual(["alex.md"]);
    expect(calls(b, "files.pick")).toEqual([]);
    expect(calls(b, "profile.readResume")).toEqual([]);
    expect(calls(b, "profile.fillFromResume")).toEqual([]);
    // The copy now lives in Resumes, so the drop box file is gone rather than left as a second copy.
    expect(await screen.findByText("alex.md is saved in your Resumes folder.")).toBeInTheDocument();
    expect((await b.inbox.list()).map((i) => i.name)).not.toContain("alex.md");
  });

  it("opens the review in Settings › Profile through the real app routes", async () => {
    const b = new MockBridge({ inbox: ["alex.md"], inboxTexts: { "alex.md": RESUME } });
    await b.tour.setOff(true);
    window.location.hash = "#/inbox";
    render(<App bridge={b} />);
    const row = await screen.findByRole("region", { name: "alex.md" });
    await userEvent.click(within(row).getByRole("button", { name: "Fill profile" }));
    expect(await screen.findByRole("heading", { name: "Check what we found" })).toBeInTheDocument();
    expect(calls(b, "inbox.readResume")).toEqual([["alex.md"]]);
  });

  it("says plainly when the handed-over file can't be read, and keeps the normal picker", async () => {
    const b = new MockBridge({ inbox: ["alex.md"], inboxTexts: { "alex.md": RESUME } });
    const first = renderApp(<InboxScreen />, { bridge: b });
    const row = await screen.findByRole("region", { name: "alex.md" });
    await userEvent.click(within(row).getByRole("button", { name: "Fill profile" }));
    first.unmount();
    await b.inbox.remove(["alex.md"]);
    renderApp(<ResumeFillPanel visible />, { bridge: b });
    expect(await screen.findByRole("alert")).toHaveTextContent('"alex.md" is not in the drop box.');
    expect(screen.getByRole("button", { name: "Choose resume" })).toBeInTheDocument();
  });

  it("doesn't offer to fill the profile once a locked folder is chosen for the file", async () => {
    renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: ["alex.md"], inboxTexts: { "alex.md": RESUME } }) });
    const row = await screen.findByRole("region", { name: "alex.md" });
    fireEvent.change(within(row).getByLabelText("Destination"), { target: { value: "me:identity" } });
    expect(within(row).queryByRole("button", { name: "Fill profile" })).toBeNull();
  });

  it("with an API key, Claude looks only when asked, and the screen says why", async () => {
    for (const [auth, line] of [
      ["api_key", "Claude looks at an unsure file only when you ask, because each check uses API credit."],
      ["unknown", "Claude looks at an unsure file only when you ask, because each check may use API credit."],
    ] as const) {
      const v = renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: ["thing.txt"], inboxTexts: { "thing.txt": "Notes about a weekend robot build." }, claudeEngine: { auth } }) });
      const row = await screen.findByRole("region", { name: "thing.txt" });
      expect(within(row).getByRole("button", { name: "Ask Claude" })).toBeInTheDocument();
      expect(await screen.findByText(line)).toBeInTheDocument();
      v.unmount();
    }
    renderApp(<InboxScreen />, { bridge: new MockBridge({ inbox: ["thing.txt"], inboxTexts: { "thing.txt": "Notes about a weekend robot build." } }) });
    await screen.findByRole("region", { name: "thing.txt" });
    expect(screen.queryByText(/only when you ask/)).toBeNull();
  });

  it("asks Claude about an unsure file, with a fixed-size status chip, then shows Claude's suggestion", async () => {
    const b = new MockBridge({ inbox: ["thing.txt"], inboxTexts: { "thing.txt": "Notes about a weekend robot build." } });
    renderApp(<InboxScreen />, { bridge: b });
    const row = await screen.findByRole("region", { name: "thing.txt" });
    const slot = row.querySelector(".inbox-claude");
    expect(slot).not.toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Ask Claude" }));
    const chip = await within(row).findByRole("status");
    expect(chip).toHaveTextContent("Claude is reading it");
    // The chip replaces the button inside the same fixed slot: no layout jump.
    expect(chip.closest(".inbox-claude")).toBe(row.querySelector(".inbox-claude"));
    expect(calls(b, "inbox.ask")).toEqual([["thing.txt"]]);
    b.finishInboxAsk("thing.txt", { target: { kind: "me", dir: "projects" }, reason: "It reads like a project write-up.", confidence: "medium" });
    expect(await within(row).findByText("Suggested by Claude")).toBeInTheDocument();
    expect(within(row).getByText("It reads like a project write-up.")).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByLabelText("Destination")).toHaveValue("me:projects"));
  });

  it("never offers Ask Claude for a file meant for a locked folder", async () => {
    renderApp(<InboxScreen />);
    const visa = await screen.findByRole("region", { name: "Visa_Grant_Notice.pdf" });
    expect(within(visa).queryByRole("button", { name: "Ask Claude" })).toBeNull();
  });

  it("files every suggested file after one confirm that says where each goes", async () => {
    const { bridge } = renderApp(<InboxScreen />);
    await screen.findByRole("region", { name: "Visa_Grant_Notice.pdf" });
    await userEvent.click(screen.getByRole("button", { name: "File all (2)" }));
    const dialog = await screen.findByRole("dialog", { name: "File 2 suggested files?" });
    expect(dialog).toHaveTextContent("acme-corp-cover-letter.pdf");
    expect(dialog).toHaveTextContent("Job: AI Engineer · Application documents");
    expect(dialog).toHaveTextContent("Identity documents · visa (locked)");
    await userEvent.click(within(dialog).getByRole("button", { name: "File 2 files" }));
    expect(await screen.findByText("Filed 2 files.")).toBeInTheDocument();
    expect(fileCalls(bridge).map((c) => c[0])).toEqual(["acme-corp-cover-letter.pdf", "Visa_Grant_Notice.pdf"]);
  });
});
