import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JobDetail, SalaryBenchmarkRow } from "@careeros/contract";
import { PayBenchmark, PayBenchmarkCard } from "../src/jobs/PayBenchmark";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { renderApp } from "./render";

const detail = (text: string, bench: JobDetail["salaryBenchmark"]) => ({ job: { salary: { text } }, salaryBenchmark: bench }) as unknown as JobDetail;
const BENCH = { family: "data analyst", label: "Data analyst", city: "Sydney", count: 14, p25: 110_000, p50: 120_000, p75: 135_000, pay: 150_000, position: "above" as const, text: "Above the median of 14 similar ads you've saved" };

describe("PayBenchmark on the job page", () => {
  it("shows the stated pay with how it compares, and explains the numbers in a tooltip", () => {
    renderApp(<PayBenchmark d={detail("$140k - $160k + super", BENCH)} />);
    expect(screen.getByText("$140k - $160k + super")).toBeInTheDocument();
    const b = screen.getByText("Above the median of 14 similar ads you've saved");
    expect(b.getAttribute("title")).toMatch(/^Data analyst in Sydney: middle half \$110k to \$135k, median \$120k\. This ad works out at about \$150k a year\./);
    expect(b.getAttribute("title")).toMatch(/× 220 and hourly rates × 1,760/);
  });

  it("shows the pay alone without enough similar ads, and nothing without pay", () => {
    const { unmount } = renderApp(<PayBenchmark d={detail("$90k", null)} />);
    expect(screen.getByText("$90k")).toBeInTheDocument();
    expect(screen.queryByText(/median/)).toBeNull();
    unmount();
    const { container } = renderApp(<PayBenchmark d={detail("", BENCH)} />);
    expect(container.querySelector(".pay-line")).toBeNull();
  });

  it("the mock bridge works it out from its saved jobs", async () => {
    const f = loadFixture();
    const base = f.jobs[0]!;
    // Six more made-up ads for the same role and city, with pay.
    for (let i = 0; i < 6; i++) {
      const job = structuredClone(base);
      job.job = { ...job.job, id: `${base.job.id}-copy-${i}`, title: base.job.title, location: "Sydney NSW", salary: { ...job.job.salary, min: 100_000 + i * 10_000, max: 100_000 + i * 10_000, text: "" } };
      f.jobs.push(job);
    }
    base.job.location = "Sydney NSW";
    base.job.salary = { ...base.job.salary, min: 200_000, max: 200_000, text: "$200k" };
    const b = new MockBridge({ fixture: f });
    const d = await b.jobs.get(base.job.company_slug, base.job.id);
    expect(d.salaryBenchmark).toMatchObject({ count: 6, p50: 125_000, position: "above" });
  });
});

describe("PayBenchmarkCard on Home", () => {
  const rows: SalaryBenchmarkRow[] = [{ family: "data analyst", label: "Data analyst", city: "Sydney", count: 6, p25: 112_500, p50: 125_000, p75: 131_500 }];

  it("lists each role and city with its percentiles", () => {
    renderApp(<PayBenchmarkCard rows={rows} />);
    const table = screen.getByRole("table", { name: "Pay percentiles by role and city" });
    const cells = within(table).getAllByRole("row")[1]!;
    expect(cells).toHaveTextContent("Data analystSydney6$113k$125k$132k");
  });

  it("stays hidden until a bucket has enough ads", () => {
    const { container } = renderApp(<PayBenchmarkCard rows={[]} />);
    expect(container.querySelector(".bench-table")).toBeNull();
  });
});
