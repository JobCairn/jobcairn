import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { parseResearchReport, type ResearchReport } from "@careeros/contract";
import { MockBridge } from "../src/mock/MockBridge";
import { EXPRESS_ENTRY_REPORT, EXPRESS_ENTRY_SLUG } from "../src/mock/research-demo";
import { ReportView } from "../src/research/ReportView";
import { ResearchScreen } from "../src/screens/Research";
import { renderApp } from "./render";

const seeded = () => { const b = new MockBridge(); b.seedResearchDemo(); return b; };

describe("Research: the report", () => {
  it("the example report passes the report.json check", () => {
    expect(parseResearchReport(JSON.parse(JSON.stringify(EXPRESS_ENTRY_REPORT))).problems).toEqual([]);
  });

  it("draws tiles, steps, a comparison table, bars and numbered sources from report.json", () => {
    renderApp(<ReportView report={EXPRESS_ENTRY_REPORT} />);
    const article = screen.getByRole("article", { name: EXPRESS_ENTRY_REPORT.title });
    expect(within(article).getByRole("heading", { name: EXPRESS_ENTRY_REPORT.title })).toBeInTheDocument();
    expect(screen.getByText("Up to 1,200 points")).toBeInTheDocument();
    // Step timeline, in order.
    const steps = screen.getByRole("heading", { name: "Steps" }).parentElement!.querySelectorAll(".rr-step__title");
    expect([...steps].map((s) => s.firstChild?.textContent)).toEqual(EXPRESS_ENTRY_REPORT.steps!.map((s) => s.title));
    // The comparison table: header cells and a row header.
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Federal Skilled Worker" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Proof of funds" })).toBeInTheDocument();
    // Bars scaled to the largest value.
    const fills = [...document.querySelectorAll<HTMLElement>(".rr-bar__fill")].map((f) => f.style.width);
    expect(fills).toEqual(["50%", "67.6%", "85.3%", "100%"]);
    expect(screen.getByText("136 points")).toBeInTheDocument();
    // Sources: numbered, official ones marked, footnotes point at them.
    const sources = screen.getByRole("heading", { name: "Sources" }).parentElement!;
    expect(within(sources).getAllByRole("listitem")).toHaveLength(5);
    expect(within(sources).getAllByText("Official")).toHaveLength(5);
    expect(screen.getAllByRole("link", { name: "Source 1" }).length).toBeGreaterThan(1);
    expect(screen.getByText(/not legal, migration, tax or financial advice/)).toBeInTheDocument();
  });

  it("shows Claude's text as text, never as HTML", () => {
    const evil: ResearchReport = {
      ...EXPRESS_ENTRY_REPORT, title: "<img src=x onerror=alert(1)>", summary: "<script>window.hacked = true</script>",
      key_facts: [{ label: "<b>bold</b>", value: "<a href='javascript:alert(1)'>x</a>" }],
    };
    const { container } = renderApp(<ReportView report={evil} />);
    expect(container.querySelector("script, img, b")).toBeNull();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
    expect(screen.getByText("<script>window.hacked = true</script>")).toBeInTheDocument();
    expect((window as { hacked?: boolean }).hacked).toBeUndefined();
  });
});

describe("Research: the screen", () => {
  it("lists topics with their date, staleness and depth", async () => {
    const bridge = seeded();
    renderApp(<ResearchScreen route={{ screen: "research" }} />, { bridge });
    const card = await screen.findByRole("article", { name: EXPRESS_ENTRY_REPORT.title });
    expect(within(card).getByText("As of 10 Oct 2026")).toBeInTheDocument();
    expect(within(card).getByText("Thorough")).toBeInTheDocument();
    bridge.setNow(new Date("2026-12-01T00:00:00.000Z"));
    bridge.emitExternalChange("learn");
    expect(await within(await screen.findByRole("article", { name: EXPRESS_ENTRY_REPORT.title })).findByText("Needs refresh")).toBeInTheDocument();
  });

  it("opens a report, and falls back to report.md when report.json is missing", async () => {
    const bridge = seeded();
    const { unmount } = renderApp(<ResearchScreen route={{ screen: "research", topic: EXPRESS_ENTRY_SLUG }} />, { bridge });
    expect(await screen.findByText("Key figures")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Refresh:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Make video:/ })).toBeInTheDocument();
    unmount();
    renderApp(<ResearchScreen route={{ screen: "research", topic: "skilled-visa-482-vs-186" }} />, { bridge });
    expect(await screen.findByText(/shown as plain text/)).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("starts new research: saves the topic, asks Claude with the questions and depth, and shows the report when done", async () => {
    const bridge = new MockBridge();
    renderApp(<ResearchScreen route={{ screen: "research" }} />, { bridge });
    expect(await screen.findByText("Nothing researched yet")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "New research" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New research" });
    await userEvent.type(within(dialog).getByLabelText("What do you want to know about?"), "Skilled visa 482 vs 186");
    await userEvent.type(within(dialog).getByLabelText("Questions to answer (optional)"), "Which is faster?");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Thorough" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Research" }));
    await waitFor(() => expect(bridge.claudeSim.requests.at(-1)).toMatchObject({
      action: "research_topic", target: { kind: "research", topic: "skilled-visa-482-vs-186", label: "Skilled visa 482 vs 186" },
      request: { options: { depth: "thorough" }, note: "Which is faster?" },
    }));
    expect(window.location.hash).toBe("#/research?topic=skilled-visa-482-vs-186");
    const topics = await bridge.research.list();
    expect(topics[0]).toMatchObject({ title: "Skilled visa 482 vs 186", questions: "Which is faster?", depth: "thorough", at: "" });

    renderApp(<ResearchScreen route={{ screen: "research", topic: "skilled-visa-482-vs-186" }} />, { bridge });
    const run = bridge.claudeSim.runs[0]!;
    act(() => bridge.claudeSim.finish(run.id));
    expect(await screen.findAllByText("Key figures")).not.toHaveLength(0);
  });

  it("makes a research briefing video from the report", async () => {
    const bridge = seeded();
    renderApp(<ResearchScreen route={{ screen: "research", topic: EXPRESS_ENTRY_SLUG }} />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: /^Make video:/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Research briefing")).toBeInTheDocument();
    expect(await bridge.video.sources("research-briefing", { kind: "research", topic: EXPRESS_ENTRY_SLUG })).toMatchObject({
      ready: true, folder: `research/${EXPRESS_ENTRY_SLUG}/videos/1`, files: [{ resolver: "research.report", untrusted: true }],
    });
  });

  it("exports HTML and deletes to Recently deleted", async () => {
    const bridge = seeded();
    renderApp(<ResearchScreen route={{ screen: "research", topic: EXPRESS_ENTRY_SLUG }} />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "Export HTML" }));
    expect(await screen.findByText("Saved report.html in the topic's folder.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Show report.html in its folder" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More research actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete research" }));
    const confirm = await screen.findByRole("dialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete research" }));
    await waitFor(async () => expect((await bridge.trash.list())[0]).toMatchObject({ kind: "research", title: EXPRESS_ENTRY_REPORT.title }));
  });
});
