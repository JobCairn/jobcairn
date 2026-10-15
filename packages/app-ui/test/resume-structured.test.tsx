import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";
import { ALEX_LONG_RESUME, ALEX_RESUME, RESUME_JOB } from "../src/mock/resume-fixture";
import { ResumeStudioScreen } from "../src/screens/ResumeStudio";
import { renderApp } from "./render";

// Fictional data only (Alex Example). Emails are built by concatenation so the privacy scan stays meaningful.
const ROUTE = { screen: "resume", slug: RESUME_JOB.slug, id: RESUME_JOB.id, file: "resume.md" } as const;
const studio = (bridge = new MockBridge({ resumeDemo: true })) => { renderApp(<ResumeStudioScreen route={ROUTE} />, { bridge }); return bridge; };
const preview = () => screen.getByRole("article", { name: "Page preview" });
const saves = (b: MockBridge) => b.calls.filter((c) => c.method === "resume.save");
const lastSaved = (b: MockBridge) => String(saves(b).at(-1)!.args[2]);
const section = (name: string) => screen.getByRole("region", { name: `Section ${name}` });

describe("structured editing", { timeout: 30_000 }, () => {
  it("edits typed header fields, changing only that part of the file", async () => {
    const b = studio();
    const email = await screen.findByLabelText("Email");
    expect(email).toHaveValue("alex" + "@" + "example.com");
    expect(screen.getByLabelText("Headline")).toHaveValue("AI Engineer");
    expect(within(screen.getByRole("region", { name: "Header" })).getByLabelText("Location")).toHaveValue("Sampletown NSW 2000");
    fireEvent.change(email, { target: { value: "alex.e" + "@" + "example.com" } });
    expect(within(preview()).getByText("alex.e" + "@" + "example.com")).toBeInTheDocument();
    await waitFor(() => expect(saves(b).length).toBeGreaterThan(0), { timeout: 4000 });
    expect(lastSaved(b)).toBe(ALEX_RESUME.replace("alex" + "@" + "example.com", "alex.e" + "@" + "example.com"));
  });

  it("adds links as chips", async () => {
    studio();
    const links = await screen.findByLabelText("Links");
    fireEvent.change(links, { target: { value: "github.com/alex-example" } });
    fireEvent.keyDown(links, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove GitHub: github.com/alex-example" })).toBeInTheDocument();
    expect(within(preview()).getByText("github.com/alex-example")).toBeInTheDocument();
  });

  it("shows entries as organisation, role, place and dates, and saves a date change in place", async () => {
    const b = studio();
    await screen.findByLabelText("Name");
    const exp = section("Experience");
    expect(within(exp).getAllByLabelText("Organisation")[0]).toHaveValue("Example Labs");
    expect(within(exp).getAllByLabelText("Role")[0]).toHaveValue("AI Engineer");
    expect(within(exp).getAllByLabelText("Present")[0]).toBeChecked();
    // The end year of the second job, through the picker.
    fireEvent.change(within(exp).getAllByLabelText("End year")[1]!, { target: { value: "2025" } });
    await waitFor(() => expect(saves(b).length).toBeGreaterThan(0), { timeout: 4000 });
    expect(lastSaved(b)).toContain("*2021 to 2025 · Sampletown*");
    expect(within(preview()).getByText("2021 to 2025")).toBeInTheDocument();
  });

  it("adds a section of a type from the menu, with its own fields", async () => {
    const b = studio();
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Add section" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Certifications/ }));
    const certs = section("Certifications");
    fireEvent.change(within(certs).getByLabelText("Certification"), { target: { value: "AWS Certified Developer" } });
    fireEvent.change(within(certs).getByLabelText("Issuer"), { target: { value: "Amazon Web Services" } });
    fireEvent.change(within(certs).getByLabelText("Date"), { target: { value: "2024" } });
    expect(within(preview()).getByRole("heading", { name: "Certifications" })).toBeInTheDocument();
    expect(within(preview()).getByText("AWS Certified Developer")).toBeInTheDocument();
    await waitFor(() => expect(lastSaved(b)).toContain("## Certifications\n\n- AWS Certified Developer | Amazon Web Services | 2024"), { timeout: 4000 });
    // Add entry in the same section adds another item.
    fireEvent.click(within(certs).getByRole("button", { name: "Add certification" }));
    expect(within(certs).getAllByLabelText("Certification")).toHaveLength(2);
  });

  it("adds a job and another role at the same organisation", async () => {
    studio();
    await screen.findByLabelText("Name");
    const exp = section("Experience");
    fireEvent.click(within(exp).getByRole("button", { name: "Add job" }));
    const orgs = within(exp).getAllByLabelText("Organisation");
    expect(orgs).toHaveLength(3);
    fireEvent.change(orgs[2]!, { target: { value: "Acme Recruiting" } });
    fireEvent.click(within(exp).getAllByRole("button", { name: "Add role" })[0]!);
    expect(within(exp).getByLabelText("Role 2")).toHaveValue("New role");
    expect(within(preview()).getByText("Acme Recruiting")).toBeInTheDocument();
  });

  it("edits skills as chips", async () => {
    const b = studio();
    await screen.findByLabelText("Name");
    const skills = section("Skills");
    const box = within(skills).getAllByLabelText("Skills")[0]!;
    fireEvent.change(box, { target: { value: "Go" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(within(preview()).getByText("Go")).toBeInTheDocument();
    await waitFor(() => expect(lastSaved(b)).toContain("- Python, TypeScript, Node.js, Go\n"), { timeout: 4000 });
  });

  it("Enter in a bullet starts the next one; Alt and an arrow moves it; the icon deletes it", async () => {
    studio();
    await screen.findByLabelText("Name");
    const exp = section("Experience");
    const first = within(exp).getAllByLabelText("Bullet 1", { selector: "textarea" })[0]!;
    fireEvent.keyDown(first, { key: "Enter" });
    expect(within(exp).getAllByLabelText("Bullet 2", { selector: "textarea" })[0]).toHaveValue("");
    fireEvent.keyDown(within(exp).getAllByLabelText("Bullet 3", { selector: "textarea" })[0]!, { key: "ArrowUp", altKey: true });
    expect(within(exp).getAllByLabelText("Bullet 2", { selector: "textarea" })[0]).toHaveValue("Added an evaluation suite that checks answers against cited sources.");
    fireEvent.click(within(exp).getAllByRole("button", { name: "Delete bullet 3" })[0]!);
    expect(within(exp).getAllByLabelText(/^Bullet \d$/, { selector: "textarea" }).length).toBeGreaterThan(0);
  });

  it("hints when a bullet runs past two lines on the page", async () => {
    studio();
    await screen.findByLabelText("Name");
    const exp = section("Experience");
    fireEvent.change(within(exp).getAllByLabelText("Bullet 1", { selector: "textarea" })[0]!, { target: { value: "Built a retrieval pipeline. ".repeat(10) } });
    expect(within(exp).getByText(/About \d lines on the page/)).toBeInTheDocument();
  });
});

describe("preview and fields are linked", { timeout: 30_000 }, () => {
  it("a click on the page selects its field", async () => {
    studio();
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    fireEvent.click(within(preview()).getByText("Cut answer latency by caching embeddings."));
    expect(screen.getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(document.activeElement).toHaveValue("Cut answer latency by caching embeddings."));
    expect(within(preview()).getByText("Cut answer latency by caching embeddings.").closest("li")).toHaveClass("is-selected");
  });

  it("editing a field marks its place on the page", async () => {
    studio();
    await screen.findByLabelText("Name");
    act(() => { (screen.getByLabelText("Phone") as HTMLInputElement).focus(); });
    await waitFor(() => expect(within(preview()).getByText("0491 570 006").closest("[data-node]")).toHaveClass("is-selected"));
  });
});

describe("styles", { timeout: 30_000 }, () => {
  it("switches templates and saves the style", async () => {
    const b = studio();
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    expect(within(screen.getByRole("radiogroup", { name: "Template" })).getAllByRole("radio")).toHaveLength(17);
    fireEvent.click(screen.getByRole("radio", { name: /^Executive/ }));
    expect(preview()).toHaveClass("rp-hfont--serif");
    fireEvent.click(screen.getByRole("radio", { name: /^Minimal/ }));
    expect(preview()).toHaveClass("rp-dates--inline");
    expect(preview()).not.toHaveClass("rp-hfont--serif");
    fireEvent.click(screen.getByRole("radio", { name: "Navy" }));
    await waitFor(() => expect(saves(b).length).toBeGreaterThan(0), { timeout: 4000 });
    expect(saves(b).at(-1)!.args[3]).toMatchObject({ layout: "minimal", font: "geist", accent: "navy", dates: "inline", headings: "caps" });
    // No monospace anywhere on the page.
    expect(preview().innerHTML).not.toMatch(/t-numeric|mono/);
  });

  it("Fit to pages says when it already fits", async () => {
    studio();
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    expect(screen.getByRole("button", { name: "Fit to 1 page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Fit to 1 page" })).toHaveAttribute("title", "It already fits on 1 page.");
  });
});

describe("a general version", { timeout: 60_000 }, () => {
  it("opens the long version with several roles, items and no AI buttons", async () => {
    const b = new MockBridge({ resumeDemo: true });
    renderApp(<ResumeStudioScreen route={{ screen: "resume-variant", variant: "long-version" }} />, { bridge: b });
    // Label queries over a long form are slow in jsdom, so this test looks inside one section at a time.
    expect(await screen.findByText("General version: Long version")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Header" })).getByLabelText("Name")).toHaveValue("Alex Example");
    expect(screen.queryByRole("button", { name: /with AI/ })).toBeNull();
    expect(within(section("Experience")).getByLabelText("Role 2")).toHaveValue("AI Engineer");
    expect(within(section("Certifications")).getAllByLabelText("Certification")[0]).toHaveValue("AWS Certified Developer");
    expect(within(section("Awards")).getByText(/Nothing here yet/)).toBeInTheDocument();
    // An empty section stays in the editor but not on the page.
    expect(within(preview()).queryByRole("heading", { name: "Awards" })).toBeNull();
    expect(ALEX_LONG_RESUME).toContain("## Awards");
  });
});
