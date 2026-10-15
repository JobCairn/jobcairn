import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ExportPanel } from "../src/components/ExportPanel";
import { MockBridge } from "../src/mock/MockBridge";
import { ApplyScreen } from "../src/screens/Apply";
import { renderApp } from "./render";

const LABS = { slug: "example-labs", id: "2026-01-12-backend-engineer-llm" } as const;
const EXPORT_DIR = `companies/${LABS.slug}/jobs/${LABS.id}/application/export`;
function prepared(): MockBridge {
  const b = new MockBridge();
  b.simulateClaudeOutput(LABS.slug, LABS.id);
  return b;
}
const exportCalls = (b: MockBridge) => b.calls.filter((c) => c.method === "docs.export");

describe("ExportPanel", () => {
  it("says what is missing before Claude has written the files", async () => {
    renderApp(<ExportPanel {...LABS} />);
    expect(await screen.findByText(/Nothing to export yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
  });

  it("exports PDF and Word, lists the files and reveals one in its folder", async () => {
    const b = prepared();
    renderApp(<ExportPanel {...LABS} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Export" }));
    const list = await screen.findByRole("list", { name: "Exported files" });
    for (const n of ["resume.pdf", "resume.docx", "cover-letter.pdf", "cover-letter.docx"]) expect(within(list).getByText(n)).toBeInTheDocument();
    expect(exportCalls(b)[0]?.args).toEqual([LABS.slug, LABS.id, ["resume", "cover-letter"], ["pdf", "docx"], false]);
    await userEvent.click(screen.getByRole("button", { name: "Show file: resume.pdf" }));
    expect(b.revealed).toEqual([`${EXPORT_DIR}/resume.pdf`]);
  });

  it("opens an exported file in the viewer, and steps to the next one", async () => {
    const b = prepared();
    renderApp(<ExportPanel {...LABS} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Export" }));
    await userEvent.click(await screen.findByRole("button", { name: "View Resume (PDF)" }));
    const dlg = await screen.findByRole("dialog", { name: "Resume (PDF)" });
    expect(within(dlg).getByText(/of 4$/)).toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("dialog", { name: "Resume (Word)" })).toBeInTheDocument();
    expect(b.calls.filter((c) => c.method === "files.preview").map((c) => c.args[0])).toEqual(expect.arrayContaining([`${EXPORT_DIR}/resume.pdf`, `${EXPORT_DIR}/resume.docx`]));
  });

  it("asks before replacing files", async () => {
    const b = prepared();
    renderApp(<ExportPanel {...LABS} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Export" }));
    await screen.findByRole("list", { name: "Exported files" });
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("resume.pdf, resume.docx, cover-letter.pdf, cover-letter.docx");
    expect(exportCalls(b)).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(exportCalls(b).map((c) => c.args[4])).toEqual([false, true]));
  });

  it("sits in Apply's review and hand-off steps", async () => {
    const b = prepared();
    renderApp(<ApplyScreen route={{ screen: "apply", ...LABS }} />, { bridge: b });
    expect(await screen.findByRole("region", { name: "Export" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Request approval" }));
    await waitFor(() => expect(document.querySelector('[aria-current="step"] .stepper__label')?.textContent).toBe("Hand off"));
    expect(await screen.findByRole("region", { name: "Export" })).toBeInTheDocument();
  });

  it("says so when the export state can't be loaded", async () => {
    const b = prepared();
    b.docs.state = async () => { throw new Error("The job can't be found."); };
    renderApp(<ExportPanel {...LABS} />, { bridge: b });
    expect(await screen.findByText(/Export isn't available: The job can't be found\./)).toBeInTheDocument();
  });

  it("shows a failed replace as a danger toast and keeps the dialog open", async () => {
    const b = prepared();
    renderApp(<ExportPanel {...LABS} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Export" }));
    await screen.findByRole("list", { name: "Exported files" });
    b.docs.export = async () => { throw new Error("application/resume.md is too complex to export. Simplify its formatting and try again."); };
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    const toast = await screen.findByText("application/resume.md is too complex to export. Simplify its formatting and try again.");
    expect(toast.closest(".toast")).toHaveClass("toast--danger");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes the replace dialog on Cancel without exporting again", async () => {
    const b = prepared();
    renderApp(<ExportPanel {...LABS} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Export" }));
    await screen.findByRole("list", { name: "Exported files" });
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(exportCalls(b)).toHaveLength(1);
  });

  it("names a folder or link sitting at an export name", async () => {
    const b = prepared();
    const real = b.docs.state.bind(b.docs);
    const problem = "application/export/resume.pdf is a folder or link. Move it and try again.";
    b.docs.state = async (slug, id) => {
      const s = await real(slug, id);
      return { ...s, files: s.files.map((f) => (f.name === "resume.pdf" ? { ...f, problem } : f)) };
    };
    renderApp(<ExportPanel {...LABS} />, { bridge: b });
    expect(await screen.findByText(problem)).toBeInTheDocument();
  });
});

