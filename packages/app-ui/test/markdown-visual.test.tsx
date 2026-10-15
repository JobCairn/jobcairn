import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/components/Markdown";
import { calloutKind, sectionIcon } from "../src/components/markdown-callouts";
import { cleanSvg, diagramKind, naturalWidth, opaque, toTopDown } from "../src/components/Diagram";
import { listenParts } from "../src/listen/blocks";
import { renderApp } from "./render";

// jsdom can't lay out SVG, so the real Mermaid can't draw here: a stand-in that "fails" on text containing BROKEN.
const calls: { init: Record<string, unknown>[]; render: string[] } = { init: [], render: [] };
vi.mock("../src/components/mermaid-load", () => ({
  loadMermaid: async () => ({
    initialize: (c: Record<string, unknown>) => { calls.init.push(c); },
    parse: async (t: string) => { if (t.includes("BROKEN")) throw new Error("Parse error on line 2"); return true; },
    render: async (id: string) => ({
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" style="max-width: 300px;" onload="alert(1)"><style>#${id} .node rect{fill:#123456}</style>`
        + `<script>alert(1)</script><a href="https://evil.example"><text>link</text></a><g class="node"><rect style="fill: red"/><text>Query</text></g>`
        + `<foreignObject><div>html</div></foreignObject></svg>`,
    }),
  }),
}));

beforeEach(() => { calls.init.length = 0; calls.render.length = 0; });

const GUIDE = [
  "# RAG",
  "",
  "> **TL;DR**",
  "> - Fetch facts, then answer",
  "",
  "## Key terms",
  "",
  "| Term | Meaning |",
  "|---|---|",
  "| Chunk | A slice of a document |",
  "",
  "> **Tip:** Start small.",
  "",
  "> **Interview tip**: Say what you measured.",
  "",
  "> **Watch out:** Stale indexes.",
  "",
  "> [!NOTE]",
  "> GitHub style works too.",
  "",
  "> Just a quote.",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Query] --> B[Retriever]",
  "```",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

describe("Markdown: callouts", () => {
  it("turns labelled quotes into callouts with their label as a title, and leaves other quotes alone", () => {
    const { container } = renderApp(<Markdown text={GUIDE} />);
    const tldr = screen.getByRole("complementary", { name: "TL;DR" });
    expect(tldr.className).toContain("callout--tldr");
    expect(within(tldr).getByText("Fetch facts, then answer").tagName).toBe("LI");
    const tip = screen.getByRole("complementary", { name: "Tip" });
    expect(tip.querySelector(".callout__body")!.textContent!.trim()).toBe("Start small.");
    expect(tip.querySelector(".callout__title svg")).not.toBeNull();
    expect(screen.getByRole("complementary", { name: "Interview tip" }).querySelector(".callout__body")!.textContent!.trim()).toBe("Say what you measured.");
    expect(screen.getByRole("complementary", { name: "Watch out" }).className).toContain("callout--watch");
    expect(screen.getByRole("complementary", { name: "Note" }).textContent).toContain("GitHub style works too.");
    expect(screen.getByRole("complementary", { name: "Note" }).textContent).not.toContain("[!NOTE]");
    expect(container.querySelector("blockquote")!.textContent!.trim()).toBe("Just a quote.");
  });

  it("names the labels the guide prompt asks for", () => {
    expect(calloutKind("Tip:")).toBe("tip");
    expect(calloutKind("Interview tip")).toBe("interview");
    expect(calloutKind("Watch out:")).toBe("watch");
    expect(calloutKind("TL;DR")).toBe("tldr");
    expect(calloutKind("Fun fact")).toBeNull();
  });
});

describe("Markdown: tables and section icons", () => {
  it("renders the Key terms table and gives known sections an icon", () => {
    const { container } = renderApp(<Markdown text={GUIDE} />);
    const table = within(screen.getByRole("region", { name: "Table" })).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Term", "Meaning"]);
    const h2 = screen.getByRole("heading", { level: 2, name: "Key terms" });
    expect(h2.querySelector("svg.md-section-icon")).not.toBeNull();
    expect(container.querySelectorAll(".md-section-icon")).toHaveLength(1);
  });

  it("picks icons by what the heading says", () => {
    expect(sectionIcon("Why employers ask")).toBe("target");
    expect(sectionIcon("Practice this week")).toBe("calendar");
    expect(sectionIcon("Worked example")).toBe("example");
    expect(sectionIcon("RAG vs fine-tuning")).toBe("compare");
    expect(sectionIcon("Self-check")).toBe("checklist");
    expect(sectionIcon("Anything else")).toBeNull();
  });
});

describe("Markdown: Mermaid diagrams", () => {
  it("draws a mermaid block as a diagram in the app theme, strict and with no HTML labels; other code stays code", async () => {
    const { container } = renderApp(<Markdown text={GUIDE} />);
    const fig = await waitFor(() => { const f = container.querySelector("figure.diagram[data-diagram=ready]"); expect(f).not.toBeNull(); return f!; });
    expect(within(fig as HTMLElement).getByRole("img", { name: "A flowchart. Its text is below." }).querySelector("svg")).not.toBeNull();
    expect(calls.init[0]).toMatchObject({ securityLevel: "strict", htmlLabels: false, startOnLoad: false, theme: "base", flowchart: { htmlLabels: false } });
    expect(container.querySelector("pre code.language-ts")!.textContent).toContain("const x = 1;");
    // The source stays available as text, and isn't read aloud.
    expect(within(fig as HTMLElement).getByText("Show text")).toBeInTheDocument();
    expect(listenParts(container).map((p) => p.text).join(" ")).not.toMatch(/flowchart|Retriever/);
  });

  it("falls back to the code block when Mermaid can't parse it", async () => {
    const { container } = renderApp(<Markdown text={"```mermaid\nflowchart LR\n  BROKEN -->\n```"} />);
    await waitFor(() => expect(container.querySelector("figure[data-diagram=failed]")).not.toBeNull());
    expect(screen.getByText("This diagram couldn't be drawn, so here is its text.")).toBeInTheDocument();
    expect(container.querySelector("figure[data-diagram=failed] pre code")!.textContent).toContain("BROKEN -->");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("cleans the SVG for the CSP: no scripts, handlers, outside links or HTML; styles moved to the CSSOM", () => {
    const { node, css } = cleanSvg(`<svg xmlns="http://www.w3.org/2000/svg" style="max-width: 300px;" onload="x()"><style>.a{fill:red}</style>`
      + `<script>x()</script><a href="https://evil.example"><text>t</text></a><a href="#n1"><text>in</text></a><rect style="fill: blue" onclick="x()"/>`
      + `<foreignObject><div>h</div></foreignObject></svg>`);
    expect(css).toContain(".a{fill:red}");
    expect(node.querySelector("style, script, foreignObject")).toBeNull();
    expect(node.getAttribute("onload")).toBeNull();
    expect(node.querySelector("rect")!.getAttribute("onclick")).toBeNull();
    expect(node.querySelectorAll("a")[0]!.getAttribute("href")).toBeNull();
    expect(node.querySelectorAll("a")[1]!.getAttribute("href")).toBe("#n1");
    expect(node.style.maxWidth).toBe("300px");
    expect(node.querySelector("rect")!.style.fill).toBe("blue");
    expect(node.querySelector("[data-style]")).toBeNull();
  });

  it("redraws a too-wide left-to-right flowchart top-down, and leaves other diagrams alone", () => {
    expect(naturalWidth('<svg viewBox="-8 -8 914.2 120" style="x">')).toBe(914.2);
    expect(naturalWidth("<svg>")).toBe(0);
    expect(toTopDown("flowchart LR\n  A --> B")).toBe("flowchart TD\n  A --> B");
    expect(toTopDown("%% x\ngraph RL\n A-->B")).toBe("%% x\ngraph TD\n A-->B");
    expect(toTopDown("flowchart TD\n A-->B")).toBeNull();
    expect(toTopDown("sequenceDiagram\n A->>B: LR")).toBeNull();
  });

  it("reads the diagram kind and turns token colours into plain hex", () => {
    expect(diagramKind("%% note\nsequenceDiagram\n  A->>B: hi")).toBe("sequence diagram");
    expect(diagramKind("mindmap\n  root")).toBe("mind map");
    expect(diagramKind("graph TD")).toBe("flowchart");
    expect(opaque("rgba(255, 255, 255, 0.5)", "#000000", "#fff")).toBe("#808080");
    expect(opaque("#abc", "#000", "#fff")).toBe("#aabbcc");
    expect(opaque("var(--x)", "#000", "#fff")).toBe("#fff");
  });
});
