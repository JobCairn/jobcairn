import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";
import { mockPreview } from "../src/mock/viewer-demo";
import { JobScreen } from "../src/screens/Job";
import { FileViewer } from "../src/viewer";
import { noticeFor, viewerMeta } from "../src/viewer/model";
import { renderApp } from "./render";

const ACME = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer", tab: "files" } as const;
const JOB = "companies/acme-corp/jobs/2026-01-12-ai-engineer";
const viewerDialog = () => screen.findByRole("dialog");

describe("file viewer model", () => {
  it("names a file by type, size and date only, never a time or a path", () => {
    const p = mockPreview(`${JOB}/research.md`, { [`${JOB}/research.md`]: "# Notes" }, [], "2026-10-08T03:00:00.000Z");
    expect(viewerMeta({ rel: `${JOB}/research.md`, at: "2026-10-07T22:00:00.000Z" }, p)).toMatch(/^Text · 7 B · [78] Oct 2026$/);
    expect(viewerMeta({ rel: "me/identity/passport.pdf" }, { state: "locked", kind: "pdf", folder: "me/identity" })).toBe("PDF · locked");
  });

  it("explains each state in plain words, with a way out", () => {
    const f = { rel: "inbox/notes.pages" };
    expect(noticeFor({ rel: "me/identity/p.pdf" }, { state: "locked", kind: "pdf", folder: "me/identity" })).toMatchObject({ title: "This file is locked", privacy: true, open: false });
    expect(noticeFor(f, { state: "unsupported", kind: "other", size: 10, at: "", reason: "kind" })).toMatchObject({ open: true });
    expect(noticeFor({ rel: "inbox/run.command" }, { state: "unsupported", kind: "other", size: 10, at: "", reason: "kind" })).toMatchObject({ open: false });
    expect(noticeFor({ rel: "a/b.md" }, { state: "too_large", kind: "markdown", size: 3_000_000, at: "", limit: 2_097_152 })?.text).toContain("2.9 MB");
    for (const n of [noticeFor(f, { state: "missing", kind: "other" })!]) expect(`${n.title} ${n.text}`).not.toMatch(/[\\/]/);
  });
});

describe("Job › Files opens the viewer", () => {
  it("renders Markdown with tables, and steps with the arrow keys", async () => {
    const bridge = new MockBridge({ viewerDemo: true });
    renderApp(<JobScreen route={ACME} />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "View Company research" }));
    const dlg = await viewerDialog();
    expect(within(dlg).getByRole("heading", { name: "Company research", level: 2 })).toBeInTheDocument();
    expect(await within(dlg).findByRole("table")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Copy text" })).toBeInTheDocument();
    expect(within(dlg).getByText(/of \d+$/)).toBeInTheDocument();
    // No raw path anywhere in the panel.
    expect(dlg.textContent).not.toMatch(/companies\//);
    await userEvent.keyboard("{ArrowRight}");
    expect(await within(dlg).findByRole("heading", { name: "Cover letter notes", level: 2 })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowLeft}");
    expect(await within(dlg).findByRole("heading", { name: "Company research", level: 2 })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a PDF in a frame from the app's own file URL, a Word file as text, and opens files in their app", async () => {
    const bridge = new MockBridge({ viewerDemo: true });
    renderApp(<JobScreen route={ACME} />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "View Tailored resume (PDF)" }));
    const dlg = await viewerDialog();
    const frame = await within(dlg).findByTitle("PDF: Tailored resume (PDF)");
    expect(frame.getAttribute("src")).not.toMatch(/^https?:/);
    await userEvent.click(within(dlg).getByRole("button", { name: "Open externally" }));
    await waitFor(() => expect(bridge.openedFiles).toEqual([`${JOB}/application/resume-2026-10-08.pdf`]));
    await userEvent.keyboard("{ArrowRight}");
    expect(await within(dlg).findByText(/Dear hiring team at Acme Corp/)).toBeInTheDocument();
    expect(within(dlg).getByText(/A text preview of the Word file/)).toBeInTheDocument();
  });

  it("offers Open in default app for a kind it can't show", async () => {
    const bridge = new MockBridge({ viewerDemo: true });
    renderApp(<JobScreen route={ACME} />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "View Portfolio slides" }));
    const dlg = await viewerDialog();
    expect(await within(dlg).findByText("No preview for this kind of file")).toBeInTheDocument();
    expect(within(dlg).getAllByRole("button", { name: "Open externally" })).toHaveLength(1);
  });
});

describe("locked files", () => {
  it("shows the locked state and never asks for the file's text", async () => {
    const bridge = new MockBridge();
    renderApp(<FileViewer files={[{ rel: "me/identity/passport.pdf", title: "Passport" }]} index={0} onIndex={() => undefined} onClose={() => undefined} />, { bridge });
    const dlg = await viewerDialog();
    expect(await within(dlg).findByText("This file is locked")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Open Privacy" })).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "Open externally" })).toBeNull();
    expect(within(dlg).queryByTitle(/PDF:/)).toBeNull();
    expect(bridge.calls.some((c) => c.method === "files.readText")).toBe(false);
    expect(bridge.calls.filter((c) => c.method === "files.preview").map((c) => c.args)).toEqual(expect.arrayContaining([["me/identity/passport.pdf"]]));
  });

  it("refuses to open an app or a script from the mock, like main does", async () => {
    const bridge = new MockBridge();
    await expect(bridge.files.open("inbox/run.command")).rejects.toThrow(/can't be opened/);
    await expect(bridge.files.open("me/identity/passport.pdf")).rejects.toThrow(/locked/);
  });
});
