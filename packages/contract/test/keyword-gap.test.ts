import { describe, expect, it } from "vitest";
import { adTerms, keywordGap, ngramTerms, requirementsSection, resumeSpots, MAX_GAP_TERMS } from "../src/index.js";

// Fictional ad and resume only (Acme Corp, Alex Example).
const JD = [
  "# Senior Data Engineer at Acme Corp",
  "",
  "## About us",
  "Acme Corp builds tools for Example Labs. We value Teamwork and Ownership.",
  "",
  "## What you'll bring",
  "- 5+ years with Python and SQL",
  "- Experience building ETL pipelines on AWS with Airflow",
  "- Hands-on with Power Apps and HL7 messaging",
  "- Kubernetes is a plus",
  "",
  "## Benefits",
  "- Free lunch on Friday and a NSW office in Sampletown",
].join("\n");

const RESUME = [
  "# Alex Example",
  "Data engineer: Python, SQL and AWS",
  "",
  "## Experience",
  "### Data Engineer, Example Labs",
  "- Built Airflow jobs that load 2 TB a day",
  "- Cut warehouse costs by 30%",
  "- Ran a small Kubernetes cluster for batch jobs",
  "",
  "## Skills",
  "Docker, Terraform",
].join("\n");

describe("requirementsSection", () => {
  it("takes the lines under a requirements heading and stops at the next other heading", () => {
    const r = requirementsSection(JD);
    expect(r).toContain("Python and SQL");
    expect(r).toContain("Kubernetes is a plus");
    expect(r).not.toContain("Free lunch");
    expect(r).not.toContain("Teamwork");
  });
  it("knows plain-text headings with a colon", () => {
    const r = requirementsSection("The role:\nYou will build things.\nAbout you:\n- Go and Rust\nPerks:\n- Snacks");
    expect(r).toBe("- Go and Rust");
  });
  it("is empty when the ad has no requirements heading", () => {
    expect(requirementsSection("We need someone great with Python.")).toBe("");
  });
});

describe("ngramTerms", () => {
  it("finds tech-looking words and capitalised product names, not sentence starts", () => {
    const t = ngramTerms("- Hands-on with Power Apps and HL7 messaging\n- Strong PowerShell and C++ skills\n- Excellent communication");
    expect(t).toEqual(expect.arrayContaining(["Power Apps", "HL7", "PowerShell", "C++"]));
    expect(t).not.toContain("Hands-on");
    expect(t).not.toContain("Excellent");
    expect(t).not.toContain("Strong PowerShell");
  });
  it("skips place names, legal words and short filler in capitals", () => {
    expect(ngramTerms("- Based in NSW, Australia\n- Must hold PR or be a citizen\n- AEST hours")).toEqual([]);
  });
  it("is deterministic and keeps first-seen order without repeats", () => {
    const text = "- SAP and HL7\n- More HL7 and SAP";
    expect(ngramTerms(text)).toEqual(["SAP", "HL7"]);
    expect(ngramTerms(text)).toEqual(ngramTerms(text));
  });
});

describe("adTerms", () => {
  it("puts requirements-section dictionary skills first, then n-grams", () => {
    const t = adTerms(JD);
    expect(t.slice(0, 6)).toEqual(expect.arrayContaining(["Python", "SQL", "AWS", "ETL", "Airflow", "Kubernetes"]));
    expect(t.indexOf("Power Apps")).toBeGreaterThan(5);
    expect(t).toContain("Kubernetes");
    expect(t).toContain("Power Apps");
    expect(t).toContain("HL7");
    // An alias of a known skill never comes back as a separate n-gram.
    expect(adTerms("## Requirements\n- CI/CD with GitHub Actions")).toEqual(["CI/CD", "Git"]);
  });
  it("never lists more than the cap", () => {
    const many = "## Requirements\n" + Array.from({ length: 60 }, (_x, i) => `- TOOL${i}X`).join("\n");
    expect(adTerms(many).length).toBe(MAX_GAP_TERMS);
  });
  it("uses dictionary skills from the whole ad when there is no requirements heading", () => {
    expect(adTerms("We use Python and Terraform every day.")).toEqual(["Python", "Terraform"]);
  });
});

describe("resumeSpots", () => {
  it("treats the top, summary, role titles and the first two bullets of a role as strong", () => {
    const s = resumeSpots(RESUME);
    expect(s.strong).toContain("Python, SQL and AWS");
    expect(s.strong).toContain("Data Engineer, Example Labs");
    expect(s.strong).toContain("Airflow jobs");
    expect(s.strong).toContain("warehouse costs");
    expect(s.weak).toContain("Kubernetes cluster");
    expect(s.weak).toContain("Docker, Terraform");
  });
  it("reads plain-text resumes with bare section names", () => {
    const s = resumeSpots("Alex Example\nSummary\nBackend engineer with Go\nExperience\nEngineer, Acme Corp\n• Shipped Kafka consumers\n• Wrote docs\n• Tuned Redis\nSkills\nSnowflake");
    expect(s.strong).toContain("Go");
    expect(s.strong).toContain("Kafka");
    expect(s.weak).toContain("Redis");
    expect(s.weak).toContain("Snowflake");
  });
  it("restarts the bullet count for each role", () => {
    const s = resumeSpots("## Experience\n### Role A\n- a1\n- a2\n- a3\n### Role B\n- b1\n- b2\n- b3");
    expect(s.strong.split("\n")).toEqual(["### Role A", "- a1", "- a2", "### Role B", "- b1", "- b2"]);
    expect(s.weak.split("\n")).toEqual(["## Experience", "- a3", "- b3"]);
  });
});

describe("keywordGap", () => {
  it("splits the ad's terms into present, weak and missing, with a match share", () => {
    const g = keywordGap(JD, RESUME);
    expect(g.present).toEqual(expect.arrayContaining(["Python", "SQL", "AWS", "Airflow"]));
    expect(g.weak).toEqual(["Kubernetes"]);
    expect(g.missing).toEqual(expect.arrayContaining(["ETL", "Power Apps", "HL7"]));
    expect(g.present.length + g.weak.length + g.missing.length).toBe(g.terms.length);
    expect(g.match).toBe(Math.round(((g.present.length + g.weak.length) / g.terms.length) * 100));
  });
  it("matches aliases and whole words only", () => {
    expect(keywordGap("## Requirements\n- Kubernetes", "Ran k8s clusters").present).toEqual(["Kubernetes"]);
    expect(keywordGap("## Requirements\n- Java", "JavaScript developer").missing).toEqual(["Java"]);
  });
  it("counts an ambiguous word in the resume (the person's own words)", () => {
    expect(keywordGap("## Requirements\n- React and TypeScript for the web", "React developer\n").present).toContain("React");
  });
  it("gives a null match when the ad has no terms", () => {
    expect(keywordGap("A friendly team.", RESUME)).toEqual({ match: null, present: [], weak: [], missing: [], terms: [] });
  });
  it("finds everything missing against an empty resume", () => {
    const g = keywordGap(JD, "");
    expect(g.match).toBe(0);
    expect(g.missing).toEqual(g.terms);
  });
});
