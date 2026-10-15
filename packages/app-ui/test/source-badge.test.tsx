import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SourceBadge } from "../src/source/SourceBadge";
import { renderApp } from "./render";

describe("SourceBadge", () => {
  it("renders the real, official brand mark for a board one was bundled for, with an accessible name", () => {
    renderApp(<SourceBadge job={{ source: "ats", source_site: "Greenhouse", url: "" }} />);
    const el = screen.getByLabelText("Found on Greenhouse");
    const img = el.querySelector("img.source-badge__mark");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("alt", "");
    expect(el.querySelector(".source-badge__mono")).not.toBeInTheDocument();
  });

  it("renders a letter monogram for a board with no bundled mark (CareerOne)", () => {
    renderApp(<SourceBadge job={{ source: "browser", source_site: "CareerOne", url: "" }} />);
    const el = screen.getByLabelText("Found on CareerOne");
    expect(el.querySelector("img.source-badge__mark")).not.toBeInTheDocument();
    expect(el.querySelector(".source-badge__mono")).toHaveTextContent("C1");
  });

  it("falls back to the 'Pasted by you' board for a hand-pasted job with no recognised site or host", () => {
    renderApp(<SourceBadge job={{ source: "pasted", source_site: "Pasted link", url: "https://jobs.example.com/rec/3" }} showName />);
    expect(screen.getByText("Pasted by you")).toBeInTheDocument();
  });

  it("falls back to 'Company website' when nothing is recognisable", () => {
    renderApp(<SourceBadge job={{ source: "browser", source_site: "", url: "" }} showName />);
    expect(screen.getByText("Company website")).toBeInTheDocument();
  });

  it("shows the board name only when showName is set", () => {
    renderApp(<SourceBadge job={{ source: "browser", source_site: "SEEK", url: "" }} />);
    expect(screen.queryByText("SEEK")).not.toBeInTheDocument();
    renderApp(<SourceBadge job={{ source: "browser", source_site: "SEEK", url: "" }} showName />);
    expect(screen.getByText("SEEK")).toBeInTheDocument();
  });

  it("opens a safe https ad link through the bridge, with a tooltip naming the board", async () => {
    const { bridge } = renderApp(<SourceBadge job={{ source: "browser", source_site: "LinkedIn", url: "https://www.linkedin.com/jobs/view/1/" }} />);
    const btn = screen.getByRole("button", { name: "Open the ad on LinkedIn" });
    expect(btn).toHaveAttribute("title", "Open the ad on LinkedIn");
    await userEvent.click(btn);
    expect(bridge.opened).toEqual(["https://www.linkedin.com/jobs/view/1/"]);
  });

  it.each([
    ["javascript:alert(1)"],
    ["file:///etc/passwd"],
    ["http://www.linkedin.com/jobs/view/1/"],
    ["not a url"],
    ["https://user:secret@example.com/jobs/view/1/"],
  ])("refuses to open an unsafe or non-https link (%s), and renders no button", (url) => {
    renderApp(<SourceBadge job={{ source: "browser", source_site: "LinkedIn", url }} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Found on LinkedIn")).toBeInTheDocument();
  });

  it("is a plain, non-interactive tag when the job has no url at all", () => {
    renderApp(<SourceBadge job={{ source: "browser", source_site: "SEEK" }} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Found on SEEK")).toBeInTheDocument();
  });
});
