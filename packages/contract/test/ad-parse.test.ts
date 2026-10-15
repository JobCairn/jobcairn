import { describe, expect, it } from "vitest";
import { findSalary, fromJsonLd, fromPageTitle, guessFromAd, guessFromText, postedFrom } from "../src/index.js";

/** Every ad here is fictional, laid out the way each board's page text reads. */
const NOW = new Date(2026, 9, 11, 10, 0); // 11 Oct 2026, 10 am local

const LINKEDIN = [
  "Acme Corp", "", "AI Engineer", "", "Sampletown NSW · 3 days ago · 12 people clicked apply", "",
  "Promoted by hirer · Responses managed off LinkedIn", "On-site", "Full-time", "", "Easy Apply", "Save",
  "Try Premium for A$0", "", "About the job", "We build agents for builders. You will ship LLM features.", "",
  "Similar jobs", "Remote AI Engineer", "Example Labs", "Remote · 1 day ago",
].join("\n");

const LINKEDIN_NO_PILLS = [
  "Example Labs", "Share", "Show more options", "Solution Engineer", "Sampletown QLD · Reposted 1 week ago · Over 100 applicants",
  "Retry Premium for A$0", "About the job", "Talk to customers and show them the product.",
].join("\n");

const SEEK = [
  "Senior AI Engineer", "Acme Corp", "View all jobs", "Sampletown NSW (Hybrid)",
  "Developers/Programmers (Information & Communication Technology)", "Full time", "$140,000 – $160,000 per year", "Posted 3d ago",
  "Quick apply", "Save", "", "About the role", "Build retrieval and agent features.",
].join("\n");

const SEEK_NO_PAY = [
  "Machine Learning Engineer", "Example Labs", "4.2", "· 18 reviews", "View all jobs", "Sampletown VIC",
  "Engineering - Software (Information & Communication Technology)", "Contract/Temp", "Posted 12d ago", "Add expected salary to your profile for insights",
  "Quick apply", "", "We are hiring an ML engineer.",
].join("\n");

const INDEED = [
  "Backend Engineer (GenAI) - job post", "Acme Corp", "4.0 out of 5 stars", "Sampletown NSW 2000", "Remote",
  "$120,000–$135,000 a year - Full-time", "Apply now", "", "Job details", "Pay", "$120,000–$135,000 a year", "Job type", "Full-time", "",
  "Full job description", "Build LLM services in Python.", "Posted 5 days ago",
].join("\n");

describe("LinkedIn: company first, then title, then 'Place · posted · applicants'", () => {
  it("reads title, company, place, posted day and the pills, and never a pay of A$0", () => {
    expect(guessFromAd(LINKEDIN, { site: "LinkedIn", now: NOW })).toEqual({
      title: "AI Engineer", company: "Acme Corp", location: "Sampletown NSW", work_mode: "On-site", job_type: "Full time",
      salary: "", posted: "2026-10-08",
    });
  });

  it("reads LinkedIn's layout from pasted text without a link", () => {
    expect(guessFromAd(LINKEDIN, { now: NOW })).toMatchObject({ title: "AI Engineer", company: "Acme Corp", location: "Sampletown NSW" });
  });

  it("leaves work mode and pay unset when the ad doesn't state them", () => {
    const g = guessFromAd(LINKEDIN_NO_PILLS, { site: "LinkedIn", now: NOW });
    expect(g).toMatchObject({ title: "Solution Engineer", company: "Example Labs", location: "Sampletown QLD", salary: "", work_mode: "", job_type: "", posted: "2026-10-04" });
  });

  it("the old generic guess swapped title and company on this layout (the bug)", () => {
    const old = guessFromText(LINKEDIN);
    expect(old.title).toBe("Acme Corp");
  });

  it("a page title beats the loose text", () => {
    const g = guessFromAd("Example Labs\nWrong Line\nSampletown NSW · 2 weeks ago · 5 applicants", {
      site: "LinkedIn", now: NOW, meta: { pageTitle: "AI Engineer | Acme Corp | LinkedIn" },
    });
    expect(g).toMatchObject({ title: "AI Engineer", company: "Acme Corp", location: "Sampletown NSW", posted: "2026-09-27" });
  });

  it("a pay pill is read", () => {
    const g = guessFromAd("Acme Corp\nAI Engineer\nSampletown NSW · 1 day ago · 3 applicants\nA$150K/yr - A$170K/yr\nHybrid\nAbout the job\nText.", { site: "LinkedIn", now: NOW });
    expect(g).toMatchObject({ salary: "A$150K/yr - A$170K/yr", work_mode: "Hybrid" });
  });
});

describe("SEEK: title, advertiser, place '(Hybrid)', type, pay, 'Posted 3d ago'", () => {
  it("reads every stated field", () => {
    expect(guessFromAd(SEEK, { site: "SEEK", now: NOW })).toEqual({
      title: "Senior AI Engineer", company: "Acme Corp", location: "Sampletown NSW", work_mode: "Hybrid", job_type: "Full time",
      salary: "$140,000 – $160,000 per year", posted: "2026-10-08",
    });
  });

  it("an ad without pay or mode leaves them empty", () => {
    expect(guessFromAd(SEEK_NO_PAY, { site: "SEEK", now: NOW })).toEqual({
      title: "Machine Learning Engineer", company: "Example Labs", location: "Sampletown VIC", work_mode: "", job_type: "Contract",
      salary: "", posted: "2026-09-29",
    });
  });
});

describe("Indeed: '<title> - job post', company, rating, place, setting, 'pay - type'", () => {
  it("reads every stated field", () => {
    expect(guessFromAd(INDEED, { site: "Indeed", now: NOW })).toEqual({
      title: "Backend Engineer (GenAI)", company: "Acme Corp", location: "Sampletown NSW 2000", work_mode: "Remote", job_type: "Full time",
      salary: "$120,000–$135,000 a year", posted: "2026-10-06",
    });
  });
});

describe("a board ad's description never sets its mode, type or pay", () => {
  const TRAP = "You'll work with remote teams on contract negotiations. Enjoy a $500 learning budget.";
  it.each([
    ["LinkedIn", `Acme Corp\nAI Engineer\nSampletown NSW · 2 days ago · 9 applicants\nAbout the job\n${TRAP}`],
    ["SEEK", `AI Engineer\nAcme Corp\nView all jobs\nSampletown NSW\nPosted 2d ago\nAbout the role\n${TRAP}`],
    ["Indeed", `AI Engineer - job post\nAcme Corp\nSampletown NSW\nApply now\nFull job description\n${TRAP}`],
  ])("%s", (site, text) => {
    const g = guessFromAd(text, { site, now: NOW });
    expect(g).toMatchObject({ title: "AI Engineer", company: "Acme Corp", location: "Sampletown NSW", work_mode: "", job_type: "", salary: "" });
  });
});

describe("other sites keep the generic guess", () => {
  it("labelled lines still work", () => {
    const g = guessFromAd("Job title: AI Engineer\nCompany: Example Labs\nLocation: Sampletown NSW\n\nAbout the role.", { now: NOW });
    expect(g).toEqual({ title: "AI Engineer", company: "Example Labs", location: "Sampletown NSW", work_mode: "", job_type: "", salary: "", posted: "" });
  });
});

describe("pieces", () => {
  it("pay is never zero and never the site's own offer", () => {
    expect(findSalary("Try Premium for A$0")).toBe("");
    expect(findSalary("Pay $0")).toBe("");
    expect(findSalary("Salary: $95k - $110k + super")).toBe("$95k - $110k + super");
  });

  it("posted days count back from now", () => {
    expect(postedFrom("Just posted", NOW)).toBe("2026-10-11");
    expect(postedFrom("Posted 2h ago", NOW)).toBe("2026-10-11");
    expect(postedFrom("1 month ago", NOW)).toBe("2026-09-11");
    expect(postedFrom("no date here", NOW)).toBe("");
  });

  it("page titles from each board", () => {
    expect(fromPageTitle("Acme Corp hiring AI Engineer in Sampletown, NSW | LinkedIn")).toEqual({ company: "Acme Corp", title: "AI Engineer", location: "Sampletown, NSW" });
    expect(fromPageTitle("AI Engineer Job in Sampletown NSW - SEEK")).toEqual({ title: "AI Engineer", location: "Sampletown NSW" });
  });

  it("a JobPosting JSON-LD block", () => {
    expect(fromJsonLd({
      "@context": "https://schema.org", "@type": "JobPosting", title: "AI Engineer", hiringOrganization: { name: "Acme Corp" },
      jobLocation: { address: { addressLocality: "Sampletown", addressRegion: "NSW" } }, employmentType: "FULL_TIME",
      baseSalary: { currency: "AUD", value: { minValue: 140000, maxValue: 160000, unitText: "YEAR" } }, datePosted: "2026-10-01",
    })).toEqual({ title: "AI Engineer", company: "Acme Corp", location: "Sampletown, NSW", job_type: "Full time", salary: "$140,000 – $160,000 per year", posted: "2026-10-01" });
    expect(fromJsonLd({ "@type": "JobPosting", title: "X", baseSalary: { value: { value: 0 } } }).salary).toBeUndefined();
  });
});
