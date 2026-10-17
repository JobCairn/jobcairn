import { describe, expect, it } from "vitest";
import { classifyJobHost, jobHostWarning } from "../src/index.js";

const kind = (url: string, company = "", website = "") => classifyJobHost(url, company, website).kind;

describe("classifyJobHost: where a pasted job link is hosted", () => {
  it("knows the job boards and applicant systems, and their subdomains", () => {
    expect(kind("https://www.seek.com.au/job/81234567")).toBe("board");
    expect(kind("https://au.linkedin.com/jobs/view/4012345678")).toBe("board");
    expect(kind("https://boards.greenhouse.io/examplelabs/jobs/4012345")).toBe("board");
    expect(kind("https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/R-1234")).toBe("board");
  });

  it("knows the company's own site from its name or its saved website", () => {
    expect(kind("https://careers.acme.com.au/jobs/123", "Acme Corp")).toBe("company");
    expect(kind("https://examplelabs.com/careers/ai-engineer", "Example Labs")).toBe("company");
    expect(kind("https://jobs.example.org/role/9", "Sample Org", "https://www.example.org")).toBe("company");
    expect(kind("https://jobs.example.org/role/9", "Sample Org", "example.org")).toBe("company");
  });

  it("calls a host that imitates a board a look-alike", () => {
    expect(classifyJobHost("https://seek-jobs.com.au/job/1")).toEqual({ kind: "lookalike", host: "seek-jobs.com.au", board: { name: "SEEK", domain: "seek.com.au" } });
    expect(kind("https://seekjobs.com.au/job/1")).toBe("lookalike");
    expect(kind("https://linkedin.com.example.net/jobs/view/1")).toBe("lookalike");
    expect(kind("https://lnkedin.com/jobs/view/1")).toBe("lookalike");
    expect(kind("https://job-boards.greenhouse.io.example.com/acme/jobs/1")).toBe("lookalike");
    expect(kind("https://evil-greenhouse.io/acme/jobs/1")).toBe("lookalike");
    expect(kind("https://myindeed.com.au/viewjob")).toBe("lookalike");
  });

  it("sees through a board's name put before an @", () => {
    expect(classifyJobHost("https://seek.com.au@example.net/job/1")).toMatchObject({ kind: "lookalike", host: "example.net" });
    expect(kind("https://user@example.net/job/1")).toBe("unknown");
  });

  it("calls anything else unknown, and never a look-alike for everyday words", () => {
    expect(kind("https://example.net/jobs/1", "Acme Corp")).toBe("unknown");
    expect(kind("https://seeking.example.net/jobs/1")).toBe("unknown");
    expect(kind("https://angel.example.net/jobs/1")).toBe("unknown");
    expect(kind("not a link")).toBe("unknown");
  });
});

describe("jobHostWarning: the plain warning in Add job", () => {
  it("says nothing for a board or the company's site", () => {
    expect(jobHostWarning(classifyJobHost("https://www.seek.com.au/job/1"))).toBe("");
    expect(jobHostWarning(classifyJobHost("https://careers.acme.com.au/1", "Acme Corp"), "Acme Corp")).toBe("");
  });

  it("names the board a look-alike imitates and its real address", () => {
    expect(jobHostWarning(classifyJobHost("https://seek-jobs.com.au/job/1"))).toBe(
      "This link is on seek-jobs.com.au, which looks like SEEK but isn't SEEK's own address (seek.com.au). Fake job ads often use look-alike addresses, so check it before you apply or share any details.");
  });

  it("names an unknown host and the company", () => {
    expect(jobHostWarning(classifyJobHost("https://example.net/jobs/1", "Acme Corp"), "Acme Corp")).toBe(
      "This link is on example.net, which isn't a job board we know or Acme Corp's own site. Check the ad is real before you apply or share any details.");
    expect(jobHostWarning(classifyJobHost("https://example.net/jobs/1"))).toMatch(/or the company's own site\./);
    expect(jobHostWarning(classifyJobHost("not a link"))).toBe("");
  });
});
