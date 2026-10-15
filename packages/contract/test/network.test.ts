import { describe, expect, it } from "vitest";
import { normaliseCompany, parseCsv, parseLinkedInConnections, peopleAt, referralTemplate } from "../src/index.js";

// Fictional rows only. Emails are built by concatenation so the privacy scan stays meaningful.
const AT = "@";
const EMAIL = "alex" + AT + "example.com";
const CSV = [
  "Notes:",
  "\"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email\"",
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  `Alex,Example,https://www.linkedin.com/in/alex-example,${EMAIL},Acme Corp,"Engineering Manager, Platform",14 Jan 2026`,
  "Sam,Sample,https://www.linkedin.com/in/sam-sample,,Example Labs Pty Ltd,Recruiter,02 Feb 2025",
  "Jo,Placeholder,javascript:alert(1),not-an-email,\"Acme Corporation\",\"Data \"\"Lead\"\"\",01 Mar 2024",
  ",,,,,,",
].join("\r\n");

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, commas and line breaks inside quotes", () => {
    expect(parseCsv("a,\"b,c\",\"d \"\"e\"\"\"\n\"f\ng\",h")).toEqual([["a", "b,c", "d \"e\""], ["f\ng", "h"]]);
  });
  it("drops a byte order mark", () => {
    expect(parseCsv("﻿a,b")).toEqual([["a", "b"]]);
  });
});

describe("parseLinkedInConnections", () => {
  it("finds the header below LinkedIn's Notes preamble and reads the six columns", () => {
    const p = parseLinkedInConnections(CSV);
    expect(p).toHaveLength(3);
    expect(p[0]).toEqual({ first: "Alex", last: "Example", url: "https://www.linkedin.com/in/alex-example", email: EMAIL, company: "Acme Corp", position: "Engineering Manager, Platform" });
    expect(p[1]!.email).toBe("");
  });
  it("keeps only https links and real-looking emails", () => {
    const jo = parseLinkedInConnections(CSV)[2]!;
    expect(jo.url).toBe("");
    expect(jo.email).toBe("");
    expect(jo.position).toBe("Data \"Lead\"");
  });
  it("reads columns by name, in any order", () => {
    const p = parseLinkedInConnections("Company,Last Name,First Name\nAcme Corp,Example,Alex\n");
    expect(p).toEqual([{ first: "Alex", last: "Example", url: "", email: "", company: "Acme Corp", position: "" }]);
  });
  it("refuses a file that isn't a connections export", () => {
    expect(() => parseLinkedInConnections("Date,Amount\n2026-01-01,5")).toThrow(/Connections\.csv/);
  });
  it("strips control and invisible characters", () => {
    expect(parseLinkedInConnections("First Name,Last Name\nAl​ex,Ex\u0007ample")[0]).toMatchObject({ first: "Alex", last: "Ex ample" });
  });
});

describe("company matching", () => {
  it("normalises legal suffixes, case, accents and punctuation", () => {
    expect(normaliseCompany("Acme Corp")).toBe("acme");
    expect(normaliseCompany("ACME Corporation Pty Ltd")).toBe("acme");
    expect(normaliseCompany("Example Labs (Australia)")).toBe("example labs");
    expect(normaliseCompany("Café Example & Co.")).toBe("cafe example and");
    expect(normaliseCompany("Group")).toBe("group");
  });
  it("finds the people at a company, by name", () => {
    const people = parseLinkedInConnections(CSV);
    expect(peopleAt(people, ["Acme Corp"]).map((p) => p.first)).toEqual(["Alex", "Jo"]);
    expect(peopleAt(people, ["Example Labs"]).map((p) => p.first)).toEqual(["Sam"]);
    expect(peopleAt(people, ["Acme Recruiting"])).toEqual([]);
    expect(peopleAt(people, [""])).toEqual([]);
  });
});

describe("referralTemplate", () => {
  it("asks plainly and makes it easy to say no", () => {
    const t = referralTemplate({ first: "Sam" }, { title: "AI Engineer", company: "Acme Corp" });
    expect(t.subject).toBe("AI Engineer role at Acme Corp");
    expect(t.body.startsWith("Hi Sam,")).toBe(true);
    expect(t.body).toContain("No worries at all");
    expect(referralTemplate({ first: "" }, { title: "AI Engineer", company: "Acme Corp" }).body.startsWith("Hi,")).toBe(true);
  });
});
