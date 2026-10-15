import { describe, expect, it } from "vitest";
import { adAddress, guessFromText, jobAdKey, jobDraftArg, routeJobLink, scanWorkRights, validateArgs } from "../src/index.js";

describe("routeJobLink: where a pasted link is read from", () => {
  it("sends applicant systems to their public data, job boards to Chrome, and everything else to paste", () => {
    expect(routeJobLink("https://boards.greenhouse.io/examplelabs/jobs/4012345")).toEqual({ kind: "ats", ats: "greenhouse", site: "Greenhouse" });
    expect(routeJobLink("https://job-boards.greenhouse.io/examplelabs/jobs/4012345")).toMatchObject({ kind: "ats", ats: "greenhouse" });
    expect(routeJobLink("https://jobs.lever.co/acme/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b")).toMatchObject({ kind: "ats", ats: "lever" });
    expect(routeJobLink("https://jobs.ashbyhq.com/example-labs/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b")).toMatchObject({ kind: "ats", ats: "ashby" });
    expect(routeJobLink("https://apply.workable.com/acme/j/AB12CD34EF/")).toMatchObject({ kind: "ats", ats: "workable" });
    expect(routeJobLink("https://jobs.smartrecruiters.com/AcmeCorp/744000012345678-ai-engineer")).toMatchObject({ kind: "ats", ats: "smartrecruiters" });
    expect(routeJobLink("https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/Sydney/AI-Engineer_R-1234")).toMatchObject({ kind: "ats", ats: "workday" });
    expect(routeJobLink("https://www.seek.com.au/job/81234567")).toEqual({ kind: "chrome", board: "seek", site: "SEEK" });
    expect(routeJobLink("https://www.linkedin.com/jobs/view/4012345678/")).toMatchObject({ kind: "chrome", board: "linkedin" });
    expect(routeJobLink("https://au.indeed.com/viewjob?jk=0123456789abcdef")).toMatchObject({ kind: "chrome", board: "indeed" });
    expect(routeJobLink("https://www.adzuna.com.au/details/123")).toEqual({ kind: "paste", site: "Adzuna" });
    expect(routeJobLink("https://careers.example.com/jobs/42")).toEqual({ kind: "paste", site: "" });
  });

  it("never matches a look-alike host and refuses anything that isn't https", () => {
    expect(routeJobLink("https://boards.greenhouse.io.evil.example/x/jobs/1")).toEqual({ kind: "paste", site: "" });
    expect(routeJobLink("https://evilseek.com.au/job/1")).toEqual({ kind: "paste", site: "" });
    expect(routeJobLink("http://www.seek.com.au/job/81234567")).toBeNull();
    // A link with a user name and password before the host (built up so it is never one literal).
    expect(routeJobLink(["https://user:pw", "www.seek.com.au/job/1"].join("@"))).toBeNull();
    expect(routeJobLink("javascript:alert(1)")).toBeNull();
    expect(routeJobLink("not a link")).toBeNull();
  });
});

describe("jobAdKey: one key per ad", () => {
  it("keys board ads on their ids, whatever form the link takes", () => {
    expect(jobAdKey("https://www.seek.com.au/job/81234567?type=standout&ref=search#sol=abc")).toBe("seek:81234567");
    expect(jobAdKey("https://au.seek.com/job/81234567")).toBe("seek:81234567");
    expect(jobAdKey("https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=ai")).toBe("linkedin:4012345678");
    expect(jobAdKey("https://www.linkedin.com/jobs/view/senior-ai-engineer-at-acme-4012345678/")).toBe("linkedin:4012345678");
    expect(jobAdKey("https://au.indeed.com/viewjob?jk=0123456789ABCDEF&from=serp")).toBe("indeed:0123456789abcdef");
    expect(jobAdKey("https://boards.greenhouse.io/ExampleLabs/jobs/4012345?gh_src=abc")).toBe("greenhouse:examplelabs:4012345");
    expect(jobAdKey("https://jobs.lever.co/acme/0F1E2D3C-4B5A-6978-8A9B-0C1D2E3F4A5B/apply")).toBe("lever:acme:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
  });

  it("falls back to the address without tracking, fragment or trailing slash", () => {
    expect(jobAdKey("https://careers.example.com/jobs/42/?utm_source=x#top")).toBe("https://careers.example.com/jobs/42");
    expect(jobAdKey("https://careers.example.com/jobs/42")).toBe("https://careers.example.com/jobs/42");
    expect(jobAdKey("nope")).toBe("");
  });

  it("adAddress turns a LinkedIn search link into the ad's own page", () => {
    expect(adAddress("https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=ai")).toBe("https://www.linkedin.com/jobs/view/4012345678/");
    expect(adAddress("https://au.seek.com/job/81234567?ref=x")).toBe("https://au.seek.com/job/81234567");
    expect(adAddress("https://careers.example.com/jobs/42")).toBe("https://careers.example.com/jobs/42");
  });
});

describe("scanWorkRights: what the ad says about work rights", () => {
  it("finds sponsorship, citizens only, clearance and visa holders, with the sentence that says it", () => {
    expect(scanWorkRights("Great team. Visa sponsorship is available for the right candidate.")).toEqual({ label: "sponsorship_offered", quotes: ["Visa sponsorship is available for the right candidate."] });
    expect(scanWorkRights("You must have full working rights in Australia.").label).toBe("citizen_pr_only");
    expect(scanWorkRights("Applicants must be Australian citizens or permanent residents.").label).toBe("citizen_pr_only");
    expect(scanWorkRights("We are unable to offer sponsorship for this role.").label).toBe("citizen_pr_only");
    expect(scanWorkRights("Unfortunately we can't sponsor visas. No sponsorship available.").label).toBe("citizen_pr_only");
    expect(scanWorkRights("You will need a Baseline security clearance.").label).toBe("clearance");
    expect(scanWorkRights("Working holiday visa holders welcome.").label).toBe("visa_ok");
    expect(scanWorkRights("Build LLM features with Python.")).toEqual({ label: "silent", quotes: [] });
  });

  it("ignores EEO lines about citizenship", () => {
    expect(scanWorkRights("All qualified applicants will receive consideration regardless of citizenship or permanent residency status.").label).toBe("silent");
  });

  it("a negated sponsorship sentence never reads as an offer", () => {
    expect(scanWorkRights("Please note we do not offer visa sponsorship.").label).toBe("citizen_pr_only");
  });
});

describe("guessFromText: a first guess from pasted ad text", () => {
  it("reads labelled lines", () => {
    const g = guessFromText("Job title: Senior AI Engineer\nCompany: Acme Corp\nLocation: Sampletown NSW\nSalary: $150,000 - $170,000 + super\nHybrid, full-time\n\nAbout the role...");
    expect(g).toEqual({ title: "Senior AI Engineer", company: "Acme Corp", location: "Sampletown NSW", work_mode: "Hybrid", salary: "$150,000 - $170,000 + super", job_type: "Full time" });
  });

  it("takes the first short line as the title and the next as the company", () => {
    const g = guessFromText("AI Engineer\nExample Labs\nRemote\n\nWe build tools. You will ship features.");
    expect(g.title).toBe("AI Engineer");
    expect(g.company).toBe("Example Labs");
    expect(g.work_mode).toBe("Remote");
  });

  it("splits '<title> at <company>'", () => {
    expect(guessFromText("Backend Engineer at Example Labs\n\nDetails follow.")).toMatchObject({ title: "Backend Engineer", company: "Example Labs" });
  });
});

describe("jobs.add arguments", () => {
  const draft = { url: "", company: "Acme Corp", title: "AI Engineer", location: "", work_mode: "", job_type: "", salary: "", posted: "", apply_via: "", source_site: "", jd_text: "Ad\ntext", rights: "silent", rights_quotes: [] };
  it("accepts a checked draft and refuses a non-https link, an empty title or an unknown status", () => {
    expect(validateArgs("jobs.add", [draft, "Saved"])).toEqual([draft, "Saved"]);
    expect(() => jobDraftArg({ ...draft, url: "http://example.com/x" }, "d")).toThrow(/https/);
    expect(() => jobDraftArg({ ...draft, title: "" }, "d")).toThrow(/required/);
    expect(() => validateArgs("jobs.add", [draft, "Applied"])).toThrow(/one of/);
    expect(() => validateArgs("jobs.preview", [{ url: "file:///etc/passwd" }])).toThrow(/https/);
    expect(validateArgs("jobs.preview", [{ text: "Line one\nLine two" }])).toEqual([{ text: "Line one\nLine two" }]);
  });
});
