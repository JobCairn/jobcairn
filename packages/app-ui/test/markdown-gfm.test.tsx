import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";
import { splitRow } from "../src/components/markdown-gfm";
import { renderApp } from "./render";

const TABLE = [
  "Must-haves for Acme Corp:",
  "| # | Must-have | Status |",
  "|---|:---|--:|",
  "| 1 | **Python** | Met |",
  "| 2 | `Kafka` \\| streams | ~~Met~~ Not met |",
  "",
  "After the table.",
].join("\n");

describe("Markdown: GitHub tables, task lists, strikethrough", () => {
  it("renders a pipe table as a real table, in a scrollable region, with the text before and after kept", () => {
    const { container } = renderApp(<Markdown text={TABLE} />);
    const region = screen.getByRole("region", { name: "Table" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.className).toContain("md-table");
    const table = within(region).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["#", "Must-have", "Status"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("Python").tagName).toBe("STRONG");
    expect(rows[2]!.textContent).toContain("Kafka | streams");
    expect(container.querySelector("del")?.textContent).toBe("Met");
    expect(container.textContent).not.toMatch(/\|\s*#\s*\|/);
    expect(screen.getByText("Must-haves for Acme Corp:")).toBeInTheDocument();
    expect(screen.getByText("After the table.")).toBeInTheDocument();
    const cells = table.querySelectorAll("th");
    expect(cells[1]!.getAttribute("style") ?? cells[1]!.getAttribute("align")).toMatch(/left/);
    expect(cells[2]!.getAttribute("style") ?? cells[2]!.getAttribute("align")).toMatch(/right/);
  });

  it("pads short rows and ignores extra cells", () => {
    renderApp(<Markdown text={"| A | B |\n| - | - |\n| only |\n| x | y | z |"} />);
    const rows = screen.getAllByRole("row");
    expect(rows[1]!.querySelectorAll("td")).toHaveLength(2);
    expect(rows[2]!.textContent).toBe("xy");
  });

  it("leaves pipes that aren't a table alone, and never reads a table inside code", () => {
    const { container } = renderApp(<Markdown text={"Pick A | B today.\n\n```\n| a | b |\n|---|---|\n```"} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Pick A | B today.")).toBeInTheDocument();
    expect(container.querySelector("pre")?.textContent).toContain("|---|---|");
  });

  it("renders task lists as checked and unchecked boxes", () => {
    renderApp(<Markdown text={"- [x] Python\n- [ ] Kafka\n- plain item"} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[0]).toBeDisabled();
    expect(screen.getByText("Kafka")).toBeInTheDocument();
    expect(screen.queryByText(/\[ \]/)).toBeNull();
  });

  it("renders ~~strikethrough~~ but not inside code", () => {
    const { container } = renderApp(<Markdown text={"Was ~~Meh~~ now Good Fit. `~~kept~~`"} />);
    expect(container.querySelector("del")?.textContent).toBe("Meh");
    expect(container.querySelector("code")?.textContent).toBe("~~kept~~");
  });

  it("splits rows on unescaped pipes only", () => {
    expect(splitRow("| a | b \\| c |")).toEqual(["a", "b | c"]);
    expect(splitRow("a|b")).toEqual(["a", "b"]);
  });
});

describe("Markdown: plain words for Claude output", () => {
  const md = "Evidence: `me/resumes/alex-example.pdf` and me/history/profile.md. The ad is in jd.md (Workflow 2, job evaluation). See [the ad](https://jobs.example.com/me/history/x.md).";
  it("shows friendly names instead of workspace paths and internal labels", () => {
    const { container } = renderApp(<Markdown text={md} plain />);
    const text = container.textContent ?? "";
    expect(text).toContain("Evidence: your resume and your profile. The ad is in the job ad.");
    expect(text).not.toMatch(/me\/|\.pdf|jd\.md|Workflow/);
    expect(container.querySelector("code")).toBeNull();
    // Link targets are not rewritten.
    expect(screen.getByRole("link", { name: /the ad/ })).toBeInTheDocument();
  });
  it("leaves paths alone when not asked (a study guide may name real files)", () => {
    const { container } = renderApp(<Markdown text={md} />);
    expect(container.textContent).toContain("me/history/profile.md");
  });
});
