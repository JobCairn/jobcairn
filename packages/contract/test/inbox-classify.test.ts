import { describe, expect, it } from "vitest";
import { classifyText, DOC_KIND_LABEL, INBOX_SUGGEST_FOLDERS, inboxSuggestArgs, LOCKED_KINDS } from "../src/inbox-classify.js";

const JOB_AD = `# AI Engineer

Acme Corp is hiring an AI Engineer in Brisbane.

## About the role
You will build retrieval pipelines.

## Responsibilities
- Ship LLM features

## Requirements
- 3+ years of Python

Salary: $150,000 - $170,000 per annum plus super.

How to apply: send your resume to careers@example.com.
`;

const RESUME = `Alex Example
alex@example.com | 0491 570 006 | linkedin.com/in/alex-example

Professional summary
AI Engineer with three years of experience.

Experience
Example Labs, AI Engineer, 2023 - Present

Education
Bachelor of Computer Science, 2021

Skills
Python, TypeScript
`;

const COVER = `Dear Hiring Manager,

I am writing to apply for the AI Engineer position at Acme Corp. I am excited to bring my experience.

Kind regards,
Alex Example`;

const OFFER = `Letter of offer

Dear Alex, we are pleased to offer you the position of AI Engineer. Your commencement date is 1 March.
Remuneration: $160,000 including superannuation. A probation period of six months applies. Please sign and return.`;

const VISA = `Visa grant notice
Transaction reference number: EGO0000000
Visa subclass 482. Date of birth: 01 Jan 1990. Nationality: Example.`;

const PAYSLIP = `Payslip
Pay period: 1 Jan to 14 Jan
Gross pay $6,000. Tax withheld $1,500. Net pay $4,500. Superannuation $660. YTD gross $12,000.`;

const NOTES = `Interview prep for Acme Corp
Questions to ask the panel.
Tell me about a time you shipped under pressure: situation, task, action, result.`;

describe("classifying a drop box file by what it says", () => {
  it.each([
    ["job_ad", JOB_AD], ["resume", RESUME], ["cover_letter", COVER], ["offer", OFFER],
    ["identity", VISA], ["employment", PAYSLIP], ["interview_notes", NOTES],
  ] as const)("recognises a %s", (kind, text) => {
    const g = classifyText(text);
    expect(g.kind).toBe(kind);
    expect(g.confidence).not.toBe("low");
    const label = DOC_KIND_LABEL[kind].toLowerCase();
    expect([`Looks like ${label}`, `Looks like a ${label}`, `Looks like an ${label}`].some((p) => g.reason.startsWith(p))).toBe(true);
    // One plain reason, quoting what it found.
    expect(g.reason.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(2);
  });

  it("is unsure about text with no clear signals", () => {
    const g = classifyText("Shopping list: milk, bread, eggs.");
    expect(g).toMatchObject({ kind: "other", confidence: "low" });
  });

  it("reads a job ad's title and company when it can", () => {
    expect(classifyText(JOB_AD)).toMatchObject({ title: "AI Engineer", company: "Acme Corp" });
    expect(classifyText("Job title: Backend Engineer\nCompany: Example Labs\nResponsibilities and requirements. Apply now. Salary $120k.")).toMatchObject({ kind: "job_ad", title: "Backend Engineer", company: "Example Labs" });
  });

  it("marks visa and pay documents as locked kinds", () => {
    expect(LOCKED_KINDS).toEqual(["identity", "employment"]);
  });
});

describe("the inbox_suggest answer", () => {
  it("accepts only the allowed folders and plain text", () => {
    expect(inboxSuggestArgs({ folder: "job_ad", confidence: "high", reason: "It lists responsibilities.", company: "Acme Corp", job_title: "AI Engineer" }, "a"))
      .toEqual({ folder: "job_ad", confidence: "high", reason: "It lists responsibilities.", company: "Acme Corp", job_title: "AI Engineer" });
    expect(() => inboxSuggestArgs({ folder: "identity", confidence: "high", reason: "x" }, "a")).toThrow();
    expect(() => inboxSuggestArgs({ folder: "resumes", confidence: "sure", reason: "x" }, "a")).toThrow();
    expect(() => inboxSuggestArgs({ folder: "resumes", confidence: "high", reason: "line\nbreak" }, "a")).toThrow();
    expect(INBOX_SUGGEST_FOLDERS).not.toContain("identity");
    expect(INBOX_SUGGEST_FOLDERS).not.toContain("employment");
  });
});
