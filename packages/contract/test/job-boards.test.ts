import { describe, expect, it } from "vitest";
import { BOARD_NAMES, BROWSABLE_BOARD_IDS, DEFAULT_BOARDS, JOB_BOARDS, boardRank, compareBoardSites, hostMatches, jobBoardBySite, jobBoardByUrl, sortBoardIds } from "../src/index.js";

describe("shared job boards", () => {
  it("every board Search in my Chrome can browse is a shared job board, with its shared name", () => {
    const ids = JOB_BOARDS.map((b) => b.id);
    for (const id of BROWSABLE_BOARD_IDS) {
      expect(ids).toContain(id);
      expect(BOARD_NAMES[id]).toBe(JOB_BOARDS.find((b) => b.id === id)!.name);
    }
    for (const id of DEFAULT_BOARDS) expect(BROWSABLE_BOARD_IDS).toContain(id);
  });

  it("ids are unique and every board has a name", () => {
    expect(new Set(JOB_BOARDS.map((b) => b.id)).size).toBe(JOB_BOARDS.length);
    for (const b of JOB_BOARDS) expect(b.name.trim()).not.toBe("");
  });

  it("matches hosts by dot-bounded suffix only", () => {
    expect(hostMatches("www.linkedin.com", "linkedin.com")).toBe(true);
    expect(hostMatches("www.linkedin.com.", "linkedin.com")).toBe(true);
    expect(hostMatches("linkedin.com.evil.example", "linkedin.com")).toBe(false);
    expect(hostMatches("evillinkedin.com", "linkedin.com")).toBe(false);
  });

  it("resolves Glassdoor's .com.au, CareerOne and Workforce Australia", () => {
    expect(jobBoardByUrl("https://www.glassdoor.com.au/job-listing/x")?.id).toBe("glassdoor");
    expect(jobBoardByUrl("https://www.careerone.com.au/jobview/1")?.id).toBe("careerone");
    expect(jobBoardByUrl("https://www.workforceaustralia.gov.au/individuals/jobs/details/1")?.id).toBe("workforce");
    expect(jobBoardBySite(" Workforce Australia ")?.id).toBe("workforce");
    expect(jobBoardBySite("CareerOne")?.id).toBe("careerone");
  });
});

describe("canonical board order (owner, 2026-10-11)", () => {
  it("is LinkedIn, SEEK, Indeed, Glassdoor, Jora, other boards, ATS sources, then company site and pasted", () => {
    expect(JOB_BOARDS.map((b) => b.id)).toEqual([
      "linkedin", "seek", "indeed", "glassdoor", "jora", "careerone", "workforce", "adzuna", "wellfound",
      "greenhouse", "lever", "ashby", "workable", "smartrecruiters", "workday", "company-website", "pasted",
    ]);
  });
  it("sorts site names and ids the same way, unknown sites after ATS and before company site and pasted", () => {
    const sites = ["Pasted", "Greenhouse", "Example Jobs Board", "SEEK", "lever", "Company website", "LinkedIn", "jora", "Ashby"];
    expect([...sites].sort(compareBoardSites)).toEqual(["LinkedIn", "SEEK", "jora", "Greenhouse", "lever", "Ashby", "Example Jobs Board", "Company website", "Pasted"]);
    expect(sortBoardIds(["jora", "seek", "linkedin"] as const)).toEqual(["linkedin", "seek", "jora"]);
    expect(boardRank("linkedin")).toBe(0);
    expect(boardRank("unknown site")).toBeLessThan(boardRank("company-website"));
  });
  it("Search in my Chrome's boards follow it", () => {
    const order = JOB_BOARDS.map((b) => b.id as string);
    const idx = BROWSABLE_BOARD_IDS.map((id) => order.indexOf(id));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
});
