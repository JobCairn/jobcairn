import { describe, expect, it } from "vitest";
import { adKey } from "@careeros/core";
import { jobAdKey } from "@careeros/contract";

// Core's adKey (used by the CLI and every add path) and contract's jobAdKey (which also knows applicant systems)
// must agree on job board and plain links, or the same ad could be added twice.
const LINKS = [
  "https://www.seek.com.au/job/90000001",
  "https://www.seek.com.au/job/90000001?type=standard&ref=search#sol=abc",
  "https://www.seek.com.au/ai-engineer-jobs/in-Brisbane?jobId=90000001",
  "https://au.seek.com/job/90000001/",
  "https://www.seek.co.nz/job/90000001",
  "https://www.linkedin.com/jobs/view/4000000001/?trk=public",
  "https://au.linkedin.com/jobs/view/ai-engineer-at-acme-corp-4000000001",
  "https://www.linkedin.com/jobs/search/?currentJobId=4000000001&keywords=ai",
  "https://au.indeed.com/viewjob?jk=0123456789abcdef&from=serp",
  "https://au.indeed.com/jobs?q=ai&vjk=0123456789ABCDEF",
  "https://Jobs.Example.com/ai-engineer/?utm_source=x#apply",
  "https://jobs.example.com/ai-engineer?id=4",
  "not a link",
  "",
];

describe("core adKey and contract jobAdKey", () => {
  it.each(LINKS)("agree on %s", (url) => {
    expect(adKey(url)).toBe(jobAdKey(url));
  });
});
