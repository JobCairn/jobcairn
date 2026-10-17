import { describe, expect, it } from "vitest";
import { boardCounts, boardHealth, boardKey, junkReason, resultsCount, type HealthJob } from "../src/index.js";

const job = (over: Partial<HealthJob> = {}): HealthJob => ({ site: "SEEK", title: "Data Analyst", company: "Acme Corp", ...over });

describe("board counts", () => {
  it("keys known boards by id and others by name", () => {
    expect(boardKey("SEEK")).toBe("seek");
    expect(boardKey(" Workforce Australia ")).toBe("workforce");
    expect(boardKey("Example  Jobs")).toBe("example jobs");
  });

  it("reads only whole-number results, never a blank as zero", () => {
    expect(resultsCount("12")).toBe(12);
    expect(resultsCount("0")).toBe(0);
    expect(resultsCount("")).toBeNull();
    expect(resultsCount("about 20")).toBeNull();
  });

  it("sums each board's searches and leaves out boards with no numbers", () => {
    expect(boardCounts([
      { site: "SEEK", results: "12" }, { site: "seek", results: "8" }, { site: "LinkedIn", results: "" }, { site: "Indeed", results: "0" },
    ])).toEqual({ seek: 20, indeed: 0 });
  });
});

describe("returned nothing", () => {
  const past: Record<string, number>[] = [{ seek: 22 }, { seek: 18, indeed: 4 }, { seek: 20 }];

  it("warns when every search returned 0 where past runs usually found some", () => {
    const w = boardHealth({ searches: [{ site: "SEEK", results: "0" }, { site: "SEEK", results: "0" }], jobs: [], past });
    expect(w).toEqual([{
      board: "seek", name: "SEEK", kind: "nothing",
      message: "SEEK returned nothing this time, it usually finds about 20. Its pages may have changed.",
      suggestion: expect.stringMatching(/^Try the same search on SEEK yourself\./),
    }]);
  });

  it("says nothing when one search found some, results weren't logged, or there's little history", () => {
    expect(boardHealth({ searches: [{ site: "SEEK", results: "0" }, { site: "SEEK", results: "3" }], jobs: [], past })).toEqual([]);
    expect(boardHealth({ searches: [{ site: "SEEK", results: "" }], jobs: [], past })).toEqual([]);
    expect(boardHealth({ searches: [{ site: "SEEK", results: "0" }], jobs: [], past: [{ seek: 20 }] })).toEqual([]);
    expect(boardHealth({ searches: [{ site: "Indeed", results: "0" }], jobs: [], past: [{ indeed: 1 }, { indeed: 2 }] })).toEqual([]);
  });

  it("never calls a blocked or stopped board broken", () => {
    const searches = [{ site: "SEEK", results: "0", notes: "SEEK showed a security check" }];
    expect(boardHealth({ searches, jobs: [], past })).toEqual([]);
    expect(boardHealth({ searches: [{ site: "SEEK", results: "0" }], jobs: [], past, stopped: ["seek"] })).toEqual([]);
    expect(boardHealth({ searches: [{ site: "SEEK", results: "0", notes: "429 too many requests" }], jobs: [], past })).toEqual([]);
  });
});

describe("looks wrong", () => {
  it("spots web-page code, very long titles and missing companies", () => {
    expect(junkReason(job({ title: "Data &amp; Analytics Lead" }))).toBe("code");
    expect(junkReason(job({ title: "<span>Data Analyst</span>" }))).toBe("code");
    expect(junkReason(job({ title: "x".repeat(151) }))).toBe("long");
    expect(junkReason(job({ title: "1234" }))).toBe("empty");
    expect(junkReason(job({ company: "Unknown" }))).toBe("company");
    expect(junkReason(job({ company: "" }))).toBe("company");
    expect(junkReason(job({ title: "Data & Analytics Lead (C++)" }))).toBeNull();
  });

  it("warns when most of a board's saved jobs are junk", () => {
    const jobs = [job({ title: "<div>Analyst</div>" }), job({ title: "Data &amp; AI" }), job({ title: "<b>Lead</b>" }), job()];
    expect(boardHealth({ searches: [{ site: "SEEK", results: "4" }], jobs, past: [] })).toEqual([{
      board: "seek", name: "SEEK", kind: "junk",
      message: "Most of what SEEK returned this time looked wrong (3 of 4 jobs had web-page code in the title). Its pages may have changed.",
      suggestion: expect.stringMatching(/^Check the jobs saved from SEEK today/),
    }]);
  });

  it("stays quiet for a few jobs or a little junk", () => {
    expect(boardHealth({ searches: [], jobs: [job({ title: "<b>x</b>" }), job({ title: "<b>y</b>" })], past: [] })).toEqual([]);
    expect(boardHealth({ searches: [], jobs: [job({ title: "<b>x</b>" }), job(), job(), job()], past: [] })).toEqual([]);
  });
});
