import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseHash, toHash } from "../src/router";
import { MockBridge } from "../src/mock/MockBridge";
import { ALEX_RESUME, RESUME_JOB } from "../src/mock/resume-fixture";
import { record, redo, startHistory, undo } from "../src/resume/history";
import { EditResumeButton } from "../src/resume/EditResumeButton";
import { JobScreen } from "../src/screens/Job";
import { ResumeStudioScreen } from "../src/screens/ResumeStudio";
import { renderApp } from "./render";

const ROUTE = { screen: "resume", slug: RESUME_JOB.slug, id: RESUME_JOB.id, file: "resume.md" } as const;
const studio = (bridge = new MockBridge({ resumeDemo: true })) => renderApp(<ResumeStudioScreen route={ROUTE} />, { bridge });
const preview = () => screen.getByRole("article", { name: "Page preview" });
const saved = (b: MockBridge) => b.calls.filter((c) => c.method === "resume.save");

describe("resume route", () => {
  it("parses and writes #/resume/<slug>/<id>/<file>, refusing paths", () => {
    expect(parseHash(toHash(ROUTE))).toEqual(ROUTE);
    expect(parseHash("#/resume/acme-corp/x/..%2Fjd.md")).toEqual({ screen: "home" });
    expect(parseHash("#/resume/acme-corp/x/resume.txt")).toEqual({ screen: "home" });
  });
});

describe("undo history", () => {
  it("records, coalesces typing in one field, undoes and redoes", () => {
    let h = startHistory("a");
    h = record(h, "ab", "f1");
    h = record(h, "abc", "f1");
    h = record(h, "abcd", "f2");
    expect(h.past).toEqual(["a", "abc"]);
    h = undo(h);
    expect(h.present).toBe("abc");
    h = undo(h);
    expect(h.present).toBe("a");
    h = redo(h);
    expect(h.present).toBe("abc");
  });
});

describe("Resume Studio", { timeout: 20_000 }, () => {
  it("shows the structured editor and a live page preview", async () => {
    studio();
    expect(await screen.findByLabelText("Name")).toHaveValue("Alex Example");
    expect(within(preview()).getByRole("heading", { level: 1, name: "Alex Example" })).toBeInTheDocument();
    expect(within(preview()).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Summary", "Experience", "Projects", "Skills", "Education"]);
    expect(screen.getByText("1 page")).toBeInTheDocument();
  });

  it("edits a bullet, shows it in the preview, autosaves, and undoes", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    const bullet = await screen.findByLabelText("Bullet 3", { selector: "textarea" }) as HTMLTextAreaElement;
    expect(bullet.value).toBe("Cut answer latency by caching embeddings.");
    fireEvent.change(bullet, { target: { value: "Cut answer latency by caching embeddings and results." } });
    expect(within(preview()).getByText("Cut answer latency by caching embeddings and results.")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await waitFor(() => expect(saved(b)).toHaveLength(1), { timeout: 4000 });
    expect(String(saved(b)[0]!.args[2])).toContain("- Cut answer latency by caching embeddings and results.\n");
    expect(String(saved(b)[0]!.args[2])).toBe(ALEX_RESUME.replace("caching embeddings.", "caching embeddings and results."));
    await screen.findByText(/^Saved/);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(within(preview()).getByText("Cut answer latency by caching embeddings.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(within(preview()).getByText("Cut answer latency by caching embeddings and results.")).toBeInTheDocument();
  });

  it("moves sections and bullets, hides a section, and adds and removes bullets", async () => {
    studio();
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Move Skills up" }));
    expect(within(preview()).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Summary", "Experience", "Skills", "Projects", "Education"]);
    fireEvent.click(screen.getByRole("button", { name: "Hide Projects from the resume" }));
    expect(within(preview()).queryByRole("heading", { name: "Projects" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Section Projects" })).getByText("Hidden")).toBeInTheDocument();
    const exp = screen.getByRole("region", { name: "Section Experience" });
    // Keyboard reordering on the bullet's handle.
    fireEvent.keyDown(within(exp).getAllByRole("button", { name: /^Move bullet 2 of 3/ })[0]!, { key: "ArrowUp" });
    expect(within(exp).getAllByLabelText("Bullet 1", { selector: "textarea" })[0]).toHaveValue("Added an evaluation suite that checks answers against cited sources.");
    expect(screen.getByText("Bullet moved to 1 of 3")).toBeInTheDocument();
    fireEvent.click(within(exp).getAllByRole("button", { name: "Delete bullet 1" })[0]!);
    expect(within(preview()).queryByText("Added an evaluation suite that checks answers against cited sources.")).toBeNull();
    fireEvent.click(within(exp).getAllByRole("button", { name: "Add bullet" })[0]!);
    expect(within(exp).getAllByLabelText("Bullet 3", { selector: "textarea" })[0]).toHaveValue("");
  });

  it("shows Claude's suggested resume as a diff, as text only, and accepts it", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: /AI suggestions/ }));
    expect(screen.getByText("Claude's suggested resume")).toBeInTheDocument();
    expect(screen.getByLabelText("Differences")).toHaveTextContent("Added: Built a retrieval pipeline (RAG)");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(within(preview()).getByText(/Built a retrieval pipeline \(RAG\)/)).toBeInTheDocument());
    expect(screen.queryByText("Claude's suggested resume")).toBeNull();
    expect(b.calls.find((c) => c.method === "resume.suggestion")!.args[2]).toBe("accept");
    fireEvent.click(screen.getByRole("tab", { name: /Versions/ }));
    expect(screen.getByText("Claude's rewrite accepted")).toBeInTheDocument();
    expect(screen.getByText("Original")).toBeInTheDocument();
  });

  it("renders suggestion text as text, never as HTML", async () => {
    const b = new MockBridge({ resumeDemo: true });
    b.simulateSuggestion(RESUME_JOB.slug, RESUME_JOB.id, `${ALEX_RESUME}\n<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n`);
    studio(b);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: /AI suggestions/ }));
    expect(screen.getByLabelText("Differences")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(document.querySelector("script, img")).toBeNull();
  });

  it("Keep my edits saves Claude's version under Versions; Reject just removes it", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: /AI suggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await screen.findByText("Kept your edits. Claude's version is under Versions.");
    expect(within(preview()).queryByText(/\(RAG\)/)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Versions/ }));
    const row = screen.getByText("Claude's rewrite (replaced)").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Compare" }));
    expect(await screen.findByLabelText("Differences")).toHaveTextContent("(RAG)");
    act(() => b.simulateSuggestion(RESUME_JOB.slug, RESUME_JOB.id, ALEX_RESUME.replace("Python, TypeScript", "Python, TypeScript, Go")));
    fireEvent.click(screen.getByRole("tab", { name: /AI suggestions/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await screen.findByText("Suggestion rejected");
    expect(screen.queryByText("Claude's suggested resume")).toBeNull();
  });

  it("asks Claude through the engine: positions only, mapped in main, with a live run panel", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    await screen.findByLabelText("Name");
    const exp = screen.getByRole("region", { name: "Section Experience" });
    fireEvent.click(within(exp).getAllByRole("button", { name: "Rewrite bullet 2 with AI" })[0]!);
    await waitFor(() => expect(b.calls.some((c) => c.method === "claude.run")).toBe(true));
    const call = b.calls.find((c) => c.method === "claude.run")!;
    expect(call.args[0]).toBe("rewrite_resume");
    expect(call.args[1]).toEqual({ kind: "job", company_slug: RESUME_JOB.slug, id: RESUME_JOB.id });
    expect(call.args[2]).toEqual({ options: { scope: "bullet", section_id: "s1", bullet_id: "b1" }, note: "" });
    expect(JSON.stringify(call.args)).not.toContain("evaluation suite");
    expect(b.claudeSim.requests[0]!.request.options).toEqual({ scope: "bullet", section_id: "experience", bullet_id: "experience-2" });
    expect(await screen.findByRole("tab", { name: /AI suggestions/, selected: true })).toBeInTheDocument();
    const run = b.claudeSim.runs[0]!;
    act(() => b.claudeSim.finish(run.id));
    await waitFor(() => expect(screen.getByText("Claude's suggested resume")).toBeInTheDocument());
  });

  it("sends the person's note with a whole-resume rewrite", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: /AI suggestions/ }));
    fireEvent.change(screen.getByLabelText(/How you want it/), { target: { value: "Lead with evaluation work." } });
    fireEvent.click(screen.getByRole("button", { name: "Rewrite all" }));
    await waitFor(() => expect(b.calls.some((c) => c.method === "claude.run")).toBe(true));
    expect(b.calls.find((c) => c.method === "claude.run")!.args[2]).toEqual({ options: { scope: "resume" }, note: "Lead with evaluation work." });
  });

  it("says hidden sections still apply after a restore", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Hide Projects from the resume" }));
    await waitFor(() => expect(saved(b).length).toBeGreaterThan(0), { timeout: 4000 });
    fireEvent.click(screen.getByRole("tab", { name: /Versions/ }));
    expect(await screen.findByText(/1 hidden section still applies after a restore/)).toBeInTheDocument();
  });

  it("restores a version after confirming", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: /AI suggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(within(preview()).getByText(/evaluation built in/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /Versions/ }));
    const original = screen.getByText("Original").closest("li")!;
    fireEvent.click(within(original).getByRole("button", { name: "Compare" }));
    expect(await screen.findByLabelText("Differences")).toHaveTextContent("evaluation built in");
    fireEvent.click(within(original).getByRole("button", { name: "Restore" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(within(preview()).queryByText(/evaluation built in/)).toBeNull());
    expect(screen.getByText("Restored")).toBeInTheDocument();
  });

  it("downloads ATS-safe text and copies Markdown", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: "Download" }));
    fireEvent.click(screen.getByRole("button", { name: "Download Plain text" }));
    await screen.findByText("Saved the Plain text file");
    expect(b.downloads[0]!.text).toContain("- Built a retrieval pipeline");
    expect(b.downloads[0]!.text).not.toMatch(/[•*#]/);
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(b.copied.at(-1)).toContain("## Experience"));
  });

  it("warns above two pages", async () => {
    const b = new MockBridge({ resumeDemo: true });
    const long = ALEX_RESUME + Array.from({ length: 30 }, (_x, i) => `\n## Extra ${i}\n\n- ${"Long line of fictional detail. ".repeat(12)}\n`).join("");
    b.seedResume(RESUME_JOB.slug, RESUME_JOB.id, long);
    // jsdom has no layout: give the page body a height so the page count is measurable (an A4 sheet is about 1150 px with its gap).
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
      const h = this.classList.contains("rp-body") ? 3600 : 0;
      return { x: 0, y: 0, top: 0, left: 0, bottom: h, right: 0, width: 0, height: h, toJSON: () => ({}) } as DOMRect;
    };
    try {
      studio(b);
      expect(await screen.findByText("4 pages")).toBeInTheDocument();
      expect(screen.getByText(/Longer than 2 pages/)).toBeInTheDocument();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig;
    }
  });

  it("shows a plain message when the job has no resume yet", async () => {
    renderApp(<ResumeStudioScreen route={ROUTE} />);
    expect(await screen.findByText("This resume can't be opened")).toBeInTheDocument();
    expect(screen.getByText("This job has no tailored resume yet. Prepare the application first.")).toBeInTheDocument();
  });

  it("offers to reload when the file changes under unsaved edits", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "Alex Q. Example" } });
    act(() => b.simulateExternalEdit(RESUME_JOB.slug, RESUME_JOB.id, "# Alex Example\n\n## Summary\n\nClaude rewrote this.\n"));
    expect(await screen.findByText(/changed outside the studio/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load new" }));
    expect(await within(preview()).findByText("Claude rewrote this.")).toBeInTheDocument();
  });

  it("keeps my edits over Claude's rewrite and saves the rewrite as a version", async () => {
    const b = new MockBridge({ resumeDemo: true });
    studio(b);
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "Alex Q. Example" } });
    act(() => b.simulateExternalEdit(RESUME_JOB.slug, RESUME_JOB.id, "# Alex Example\n\n## Summary\n\nClaude rewrote this.\n"));
    fireEvent.click(await screen.findByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(saved(b).at(-1)!.args[5]).toBe(true));
    expect(String(saved(b).at(-1)!.args[2])).toContain("# Alex Q. Example");
    fireEvent.click(screen.getByRole("tab", { name: /Versions/ }));
    const row = (await screen.findByText("Claude's rewrite (replaced)")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Compare" }));
    expect(await screen.findByLabelText("Differences")).toHaveTextContent("Claude rewrote this.");
  });
});

describe("entry points", () => {
  it("Edit resume appears only when the job has application/resume.md", async () => {
    const { unmount } = renderApp(<EditResumeButton slug="acme-corp" id="x" files={[{ path: "application/cover-letter.md", exists: true }]} />);
    expect(screen.queryByRole("button", { name: "Edit resume" })).toBeNull();
    unmount();
    renderApp(<JobScreen route={{ screen: "job", slug: RESUME_JOB.slug, id: RESUME_JOB.id, tab: "files" }} />, { bridge: new MockBridge({ resumeDemo: true }) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit resume" }));
    expect(window.location.hash).toBe("#/resume/acme-corp/2026-01-12-ai-engineer/resume.md");
  });
});
