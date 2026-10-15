import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jobRowFromRecord, SPONSOR_REASONS_SHOWN } from "@careeros/contract";
import { loadFixture } from "../src/mock/MockBridge";
import { SponsorCell, sponsorReasons } from "../src/jobs/cells/cells";

describe("Sponsor reasons on job rows", () => {
  it("a job row carries the top sponsor reasons from the record", () => {
    const f = loadFixture();
    const j = structuredClone(f.jobs[0]!.job);
    j.scores.sponsor = { value: 72, tier: "High", reasons: ["on the accredited sponsor list", "", "hired on a 482 last year", "posted AI roles before", "a fourth reason"] };
    const row = jobRowFromRecord(j, "Acme Corp", true);
    expect(row.sponsor_reasons).toEqual(["on the accredited sponsor list", "hired on a 482 last year", "posted AI roles before"]);
    expect(row.sponsor_reasons).toHaveLength(SPONSOR_REASONS_SHOWN);
  });

  it("the Sponsor chip lists them in its tooltip and its accessible description", () => {
    render(<SponsorCell score={72} label="silent" reasons={["on the accredited sponsor list", "hired on a 482 last year."]} />);
    const chip = screen.getByText("High").closest(".cell-sponsor")!;
    expect(chip.getAttribute("title")).toMatch(/• On the accredited sponsor list\n• Hired on a 482 last year\.$/);
    expect(chip).toHaveAttribute("aria-description", "Why: On the accredited sponsor list. Hired on a 482 last year.");
  });

  it("no reasons means no description", () => {
    render(<SponsorCell score={null} label="silent" />);
    expect(document.querySelector(".cell-sponsor")).not.toHaveAttribute("aria-description");
    expect(sponsorReasons(["  ", "x"])).toEqual(["X"]);
  });
});
