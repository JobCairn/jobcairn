import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";
import { ALEX_RESUME } from "../src/mock/resume-fixture";
import { GROUP_OVER, middleEllipsis, VIEW_KEY } from "../src/resume/ResumeFiles";
import { ResumesScreen } from "../src/screens/Resumes";
import { renderApp } from "./render";

// Fictional data only (Alex Example).
const COMPANIES = ["Acme Corp", "Example Labs", "Acme Recruiting"];
/** n fictional jobs spread over three companies. */
const addJobs = async (b: MockBridge, n: number) => {
  const out: { company_slug: string; id: string }[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await b.jobs.add({
      url: "", company: COMPANIES[i % 3]!, title: `AI Engineer ${i + 1}`, location: "Sampletown NSW", work_mode: "", job_type: "", salary: "", posted: "",
      apply_via: "", source_site: "", jd_text: "A fictional ad.", rights: "silent", rights_quotes: [],
    }, "Saved"));
  }
  return out;
};
const grid = (name: string) => screen.getByRole("list", { name });
const tailoredSection = () => screen.getByRole("region", { name: /Tailored to a job/ });

afterEach(() => { localStorage.removeItem(VIEW_KEY); window.location.hash = ""; });

describe("Resumes as files", { timeout: 30_000 }, () => {
  it("shows tiles by default and remembers the list view", async () => {
    const b = new MockBridge({ resumeDemo: true });
    b.seedVariant("backend-heavy", "Backend-heavy", ALEX_RESUME);
    const { unmount } = renderApp(<ResumesScreen />, { bridge: b });
    const general = await screen.findByRole("list", { name: "General versions" });
    expect(within(general).getByRole("button", { name: "Edit Backend-heavy" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("radio", { name: "List" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Grid" }), { key: "ArrowRight" });
    expect(screen.getByRole("table", { name: "General versions" })).toBeInTheDocument();
    expect(localStorage.getItem(VIEW_KEY)).toBe("list");
    unmount();
    renderApp(<ResumesScreen />, { bridge: b });
    expect(await screen.findByRole("table", { name: "General versions" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
  });

  it("folds a section and shows its count", async () => {
    const b = new MockBridge({ resumeDemo: true });
    renderApp(<ResumesScreen />, { bridge: b });
    const fold = await screen.findByRole("button", { name: /Tailored to a job/ });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(within(fold).getByLabelText("1 item")).toBeInTheDocument();
    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Tailored to a job" })).toBeNull();
  });

  it("duplicates a resume as a general version from the tile menu", async () => {
    const b = new MockBridge({ resumeDemo: true });
    b.seedVariant("backend-heavy", "Backend-heavy", ALEX_RESUME);
    renderApp(<ResumesScreen />, { bridge: b });
    const general = await screen.findByRole("list", { name: "General versions" });
    await userEvent.click(within(general).getByRole("button", { name: "Actions for Backend-heavy" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Backend-heavy copy");
    await userEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(b.calls.some((c) => c.method === "resumes.duplicate")).toBe(true));
    expect(b.calls.find((c) => c.method === "resumes.duplicate")!.args).toEqual([{ kind: "variant", variant: "backend-heavy" }, "Backend-heavy copy"]);
    expect(await within(grid("General versions")).findByRole("button", { name: "Edit Backend-heavy copy" })).toBeInTheDocument();
  });

  it("asks before deleting a resume, and Undo brings it back", async () => {
    const b = new MockBridge({ resumeDemo: true });
    b.seedVariant("backend-heavy", "Backend-heavy", ALEX_RESUME);
    renderApp(<ResumesScreen />, { bridge: b });
    const general = await screen.findByRole("list", { name: "General versions" });
    await userEvent.click(within(general).getByRole("button", { name: "Actions for Backend-heavy" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(b.calls.some((c) => c.method === "trash.move")).toBe(false);
    const dialog = await screen.findByRole("dialog", { name: "Delete Backend-heavy?" });
    expect(within(dialog).getByText("The whole version goes, with its versions and style.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete version" }));
    await waitFor(() => expect(b.calls.find((c) => c.method === "trash.move")?.args).toEqual([[{ kind: "resume", ref: { kind: "variant", variant: "backend-heavy" } }]]));
    await waitFor(() => expect(within(grid("General versions")).queryByRole("button", { name: "Edit Backend-heavy" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Undo deleting Backend-heavy" }));
    expect(await within(grid("General versions")).findByRole("button", { name: "Edit Backend-heavy" })).toBeInTheDocument();
  });

  it("warns harder before deleting the copy sent for an Applied job, and only then", async () => {
    const b = new MockBridge();
    const applied = await b.jobs.add({
      url: "", company: "Acme Corp", title: "AI Engineer", location: "Sampletown NSW", work_mode: "", job_type: "", salary: "", posted: "",
      apply_via: "", source_site: "", jd_text: "A fictional ad.", rights: "silent", rights_quotes: [],
    }, "Saved");
    await b.jobs.setStatus(applied.company_slug, applied.id, "Applied", "");
    const saved = await b.jobs.add({
      url: "", company: "Example Labs", title: "ML Engineer", location: "Sampletown NSW", work_mode: "", job_type: "", salary: "", posted: "",
      apply_via: "", source_site: "", jd_text: "A fictional ad.", rights: "silent", rights_quotes: [],
    }, "Saved");
    b.seedResume(applied.company_slug, applied.id, ALEX_RESUME);
    b.seedResume(saved.company_slug, saved.id, ALEX_RESUME);
    renderApp(<ResumesScreen />, { bridge: b });
    const list = await screen.findByRole("list", { name: "Tailored to a job" });

    await userEvent.click(await within(list).findByRole("button", { name: "Actions for ML Engineer, Example Labs" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    let dialog = await screen.findByRole("dialog", { name: "Delete Tailored resume for ML Engineer at Example Labs?" });
    expect(within(dialog).getByRole("button", { name: "Delete resume" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/copy you sent/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await userEvent.click(within(list).getByRole("button", { name: "Actions for AI Engineer, Acme Corp" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    dialog = await screen.findByRole("dialog", { name: "Delete Tailored resume for AI Engineer at Acme Corp?" });
    expect(within(dialog).getByText("This is the copy you sent with your application.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete resume" }));
    await waitFor(() => expect(b.calls.find((c) => c.method === "trash.move")?.args).toEqual([[{ kind: "resume", ref: { kind: "job", company_slug: applied.company_slug, id: applied.id } }]]));
  });

  it("offers Write it for a version Claude hasn't written yet", async () => {
    const b = new MockBridge({ resumeDemo: true });
    b.seedVariant("consulting", "For consulting firms");
    renderApp(<ResumesScreen />, { bridge: b });
    const general = await screen.findByRole("list", { name: "General versions" });
    expect(within(general).getByText("Not written yet")).toBeInTheDocument();
    await userEvent.click(within(general).getByRole("button", { name: "Actions for For consulting firms" }));
    expect(screen.getByRole("menuitem", { name: "Write version" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Download PDF" })).toBeNull();
  });

  it("arrow keys move between tiles", async () => {
    const b = new MockBridge({ resumeDemo: true });
    b.seedVariant("a-one", "One", ALEX_RESUME);
    b.seedVariant("b-two", "Two", ALEX_RESUME);
    renderApp(<ResumesScreen />, { bridge: b });
    const general = await screen.findByRole("list", { name: "General versions" });
    const opens = within(general).getAllByRole("button", { name: /^Edit / });
    expect(opens[0]).toHaveAttribute("tabindex", "0");
    expect(opens[1]).toHaveAttribute("tabindex", "-1");
    act(() => opens[0]!.focus());
    fireEvent.keyDown(opens[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(opens[1]);
    fireEvent.keyDown(opens[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(opens[1]);
    fireEvent.keyDown(opens[1]!, { key: "Home" });
    expect(document.activeElement).toBe(opens[0]);
  });

  it("keeps a company's only resume as a tile when grouping", async () => {
    const b = new MockBridge();
    const jobs = await addJobs(b, 12);
    // Two companies get four each and the third only one: nine in all.
    jobs.forEach((j, i) => { if (i % 3 !== 2 || i === 2) b.seedResume(j.company_slug, j.id, ALEX_RESUME); });
    renderApp(<ResumesScreen />, { bridge: b });
    const grid = await screen.findByRole("list", { name: "Tailored to a job" });
    await waitFor(() => expect(within(grid).getAllByRole("button", { name: /folder/ })).toHaveLength(2));
    expect(within(grid).getByRole("button", { name: "Edit the resume for AI Engineer 3" })).toBeInTheDocument();
  });

  it(`groups tailored resumes by company once there are more than ${GROUP_OVER}`, async () => {
    const b = new MockBridge();
    const jobs = await addJobs(b, GROUP_OVER + 1);
    jobs.slice(0, GROUP_OVER).forEach((j) => b.seedResume(j.company_slug, j.id, ALEX_RESUME));
    const first = renderApp(<ResumesScreen />, { bridge: b });
    expect(await within(await screen.findByRole("list", { name: "Tailored to a job" })).findAllByRole("listitem")).toHaveLength(GROUP_OVER);
    first.unmount();

    const j = jobs[GROUP_OVER]!;
    b.seedResume(j.company_slug, j.id, ALEX_RESUME);
    renderApp(<ResumesScreen />, { bridge: b });
    // Three companies with three resumes each: three folders.
    const folders = await screen.findByRole("list", { name: "Tailored to a job" });
    await waitFor(() => expect(within(folders).getAllByRole("listitem")).toHaveLength(3));
    const folder = within(folders).getAllByRole("button", { name: /^Open the .* folder, 3 resumes/ })[0]!;
    await userEvent.click(folder);
    const inside = within(tailoredSection()).getByRole("list", { name: /^Tailored resumes for / });
    expect(within(inside).getAllByRole("listitem")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "All companies" }));
    expect(within(screen.getByRole("list", { name: "Tailored to a job" })).getAllByRole("button", { name: /folder/ })).toHaveLength(3);
  });

  it("shortens long names in the middle, keeping the extension", () => {
    const n = middleEllipsis("Alex Example - Senior Applied AI Engineer - Acme Corp - final version 3 for the portal.pdf");
    expect(n.length).toBeLessThanOrEqual(40);
    expect(n).toMatch(/^Alex Example.*….*\.pdf$/);
    expect(middleEllipsis("short.pdf")).toBe("short.pdf");
  });
});
