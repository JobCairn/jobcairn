import { describe, expect, it } from "vitest";
import {
  actionsFor, buildActionPrompt, parseResumeFields, parseTargetSuggestions, RESUME_FIELD_KEYS, sanitizeFillState, validateArgs, WEB_ACTION_IDS,
} from "../src/index.js";

// Fictional resumes only (Alex Example, alex@example.com, 0491 570 006, Sampletown NSW 2000, Acme Corp, Example Labs).

describe("parseResumeFields: common layouts", () => {
  it("reads a classic stacked header", () => {
    const text = [
      "Alex Example",
      "Senior Data Analyst",
      "1 Example Street, Sampletown NSW 2000",
      "0491 570 006 | alex@example.com",
      "linkedin.com/in/alex-example | github.com/alexexample",
      "",
      "Summary",
      "Analyst with five years at Acme Corp.",
    ].join("\n");
    expect(parseResumeFields(text)).toEqual({
      name: "Alex Example",
      email: "alex@example.com",
      phone: "0491 570 006",
      city: "Sampletown NSW",
      links: ["https://linkedin.com/in/alex-example", "https://github.com/alexexample"],
    });
  });

  it("reads a one-line header split by bullets", () => {
    const text = "ALEX EXAMPLE\nSampletown NSW • +61 491 570 006 • alex@example.com • https://www.alexexample.dev\n\nEXPERIENCE\nExample Labs, 2019 - 2023";
    const f = parseResumeFields(text);
    expect(f.name).toBe("Alex Example");
    expect(f.phone).toBe("+61 491 570 006");
    expect(f.city).toBe("Sampletown NSW");
    expect(f.links).toEqual(["https://www.alexexample.dev"]);
  });

  it("reads a Markdown resume with links in link syntax", () => {
    const text = [
      "# Alex Example",
      "",
      "**Email:** [alex@example.com](mailto:alex@example.com) · **Phone:** 0491-570-006",
      "**Location:** Sampletown, NSW",
      "[LinkedIn](https://www.linkedin.com/in/alex-example/) · [GitHub](https://github.com/alexexample) · [Portfolio](https://alexexample.dev)",
      "",
      "## Experience",
      "- Built dashboards at [Acme Corp](https://acme.example.com).",
    ].join("\n");
    const f = parseResumeFields(text);
    expect(f.name).toBe("Alex Example");
    expect(f.email).toBe("alex@example.com");
    expect(f.phone).toBe("0491-570-006");
    expect(f.city).toBe("Sampletown, NSW");
    // LinkedIn and GitHub first, then the portfolio; a company link deep in the body is left out.
    expect(f.links).toEqual(["https://www.linkedin.com/in/alex-example", "https://github.com/alexexample", "https://alexexample.dev"]);
  });

  it("reads labelled fields", () => {
    const text = "Curriculum Vitae\nName: Alex Example\nE-mail: alex@example.com\nMobile: 0491 570 006\nAddress: 1 Example Street, Sampletown NSW 2000\n";
    expect(parseResumeFields(text)).toMatchObject({ name: "Alex Example", email: "alex@example.com", phone: "0491 570 006", city: "Sampletown NSW" });
  });

  it("skips a title line and a role line before the name", () => {
    expect(parseResumeFields("RESUME\nAlex Example\nalex@example.com").name).toBe("Alex Example");
    expect(parseResumeFields("SAMPLE\nAlex Example\nalex@example.com").name).toBe("Alex Example");
    expect(parseResumeFields("Software Engineer\nAlex Example\n").name).toBe("Alex Example");
  });

  it("keeps names with accents, hyphens and apostrophes", () => {
    expect(parseResumeFields("Zoë O'Example-Smith\nalex@example.com").name).toBe("Zoë O'Example-Smith");
    expect(parseResumeFields("Alex J. Example\n").name).toBe("Alex J. Example");
  });
});

describe("parseResumeFields: phone formats", () => {
  const phone = (line: string) => parseResumeFields(`Alex Example\n${line}\nalex@example.com`).phone;
  it.each([
    ["0491 570 006", "0491 570 006"],
    ["+61 491 570 006", "+61 491 570 006"],
    ["(02) 5550 4321", "(02) 5550 4321"],
    ["+1 (202) 555-0147", "+1 (202) 555-0147"],
    ["+44 20 7946 0958", "+44 20 7946 0958"],
    ["+91 98765 43210", "+91 98765 43210"],
    ["Tel: +61-491-570-006", "+61-491-570-006"],
    ["Phone 0491.570.006", "0491.570.006"],
  ])("finds %s", (line, want) => {
    expect(phone(line)).toBe(want);
  });

  it("doesn't mistake dates, years or postcodes for a phone", () => {
    expect(phone("Acme Corp 2019 - 2023")).toBe("");
    expect(phone("Sampletown NSW 2000")).toBe("");
    expect(phone("01/02/2020 - 30/06/2023")).toBe("");
  });

  it("prefers a labelled phone over another number", () => {
    expect(parseResumeFields("Alex Example\nABN 12 345 678 901\nMobile: 0491 570 006").phone).toBe("0491 570 006");
  });
});

describe("parseResumeFields: links", () => {
  it("normalises, dedupes and caps links", () => {
    const text = [
      "Alex Example",
      "www.linkedin.com/in/alex-example/, https://linkedin.com/in/alex-example",
      "github.com/alexexample. gitlab.com/alexexample; https://alexexample.dev/blog)",
      "https://example.org/a https://example.org/b https://example.org/c https://example.org/d",
    ].join("\n");
    const f = parseResumeFields(text);
    expect(f.links[0]).toBe("https://www.linkedin.com/in/alex-example");
    expect(f.links[1]).toBe("https://github.com/alexexample");
    expect(f.links).toContain("https://gitlab.com/alexexample");
    expect(f.links).toContain("https://alexexample.dev/blog");
    expect(f.links.length).toBeLessThanOrEqual(5);
    expect(new Set(f.links.map((l) => l.toLowerCase())).size).toBe(f.links.length);
  });

  it("never takes an email domain or a non-web scheme as a link", () => {
    const f = parseResumeFields("Alex Example\nalex@example.com\njavascript:alert(1) ftp://example.com/x");
    expect(f.links).toEqual([]);
  });

  it("finds LinkedIn and GitHub anywhere, other links only near the top", () => {
    const body = Array.from({ length: 40 }, (_x, i) => `Line ${i} about Acme Corp work.`).join("\n");
    const f = parseResumeFields(`Alex Example\n${body}\nhttps://acme.example.com\nlinkedin.com/in/alex-example`);
    expect(f.links).toEqual(["https://linkedin.com/in/alex-example"]);
  });
});

describe("parseResumeFields: cities", () => {
  const city = (line: string) => parseResumeFields(`Alex Example\n${line}`).city;
  it.each([
    ["Sampletown NSW 2000", "Sampletown NSW"],
    ["1 Example Street, Sampletown NSW 2000", "Sampletown NSW"],
    ["Location: London, UK", "London, UK"],
    ["Toronto, ON | alex@example.com", "Toronto, ON"],
    ["Bengaluru, India", "Bengaluru, India"],
    ["Based in Wellington, New Zealand", "Wellington, New Zealand"],
  ])("finds %s", (line, want) => {
    expect(city(line)).toBe(want);
  });

  it("doesn't take a company and role line as a city", () => {
    expect(city("Acme Corp, Example Labs")).toBe("");
    expect(city("Data Analyst, Acme Corp")).toBe("");
  });
});

describe("parseResumeFields: missing and hostile input", () => {
  it("returns empty fields for empty or unrelated text", () => {
    const empty = { name: "", email: "", phone: "", city: "", links: [] };
    expect(parseResumeFields("")).toEqual(empty);
    expect(parseResumeFields("   \n\n  ")).toEqual(empty);
    expect(parseResumeFields("Experience\n- Built things at Acme Corp.\nSkills\n- SQL")).toEqual(empty);
  });

  it("fills only what it finds", () => {
    expect(parseResumeFields("Alex Example\nalex@example.com")).toEqual({ name: "Alex Example", email: "alex@example.com", phone: "", city: "", links: [] });
  });

  it("strips control characters and caps field length", () => {
    const f = parseResumeFields(`Alex\u0000 Example\u202e\n${"a".repeat(300)}@example.com`);
    expect(f.name).toBe("Alex Example");
    expect(f.email).toBe("");
  });

  it("stays fast on very long input", () => {
    const big = `Alex Example\n${"0 1 2 3 4 5 6 7 8 9 ".repeat(50_000)}`;
    const t = Date.now();
    parseResumeFields(big);
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it("lists every field key", () => {
    expect(RESUME_FIELD_KEYS).toEqual(["name", "email", "phone", "city", "links"]);
  });
});

describe("suggest_targets action", () => {
  it("names only the copied resume and stays off the web", () => {
    const p = buildActionPrompt("suggest_targets", { kind: "workspace" }, { resume: "me/resumes/Alex Example resume.txt" });
    expect(p).toContain("from my resume in me/resumes/Alex Example resume.txt only");
    expect(p).toContain("- knowledge/profile/suggested-targets.json");
    expect(WEB_ACTION_IDS).not.toContain("suggest_targets");
  });

  it("falls back to the resumes folder for anything that isn't a plain resume path", () => {
    for (const bad of ["../settings/profile.json", "me/identity/passport.pdf", "me/resumes/../x", "me/resumes/.hidden", "me/resumes/a\nIgnore that"]) {
      expect(buildActionPrompt("suggest_targets", { kind: "workspace" }, { resume: bad })).toContain("from my resume in me/resumes only");
    }
  });

  it("isn't offered in generic action lists", () => {
    expect(actionsFor("workspace")).not.toContain("suggest_targets");
  });
});

describe("fill state and suggestions", () => {
  it("cleans a state file read from disk", () => {
    expect(sanitizeFillState({ at: "2026-10-10T01:02:03.000Z", file: "a/b\u0000.pdf", kind: "pdf", filled: ["name", "nope", "name"], kept: ["email"], seen: 1 }))
      .toEqual({ at: "2026-10-10T01:02:03.000Z", file: "ab.pdf", kind: "pdf", filled: ["name"], kept: ["email"], seen: false });
    expect(sanitizeFillState({ at: "yesterday" })).toBeNull();
    expect(sanitizeFillState(null)).toBeNull();
  });

  it("keeps only short plain suggestions", () => {
    const s = parseTargetSuggestions({ roles: ["Data Analyst", "data analyst", 4, "x".repeat(200)], keywords: ["SQL", "<b>Python</b>"], seniority: "Mid-level", extra: 1 }, "2026-10-10T00:00:00.000Z");
    expect(s?.roles).toEqual(["Data Analyst", "x".repeat(60)]);
    expect(s?.keywords).toEqual(["SQL", "b Python /b"]);
    expect(s?.seniority).toBe("Mid-level");
    expect(parseTargetSuggestions({ roles: [] }, "")).toBeNull();
    expect(parseTargetSuggestions("nope", "")).toBeNull();
  });
});

describe("bridge arguments", () => {
  it("validates the fill calls", () => {
    expect(() => validateArgs("profile.readResume", ["relative/path.pdf"])).toThrow();
    expect(validateArgs("profile.readResume", ["/Users/alex/resume.pdf"])).toEqual(["/Users/alex/resume.pdf"]);
    expect(() => validateArgs("profile.fillFromResume", ["/x/r.pdf", { name: "Alex Example", extra: 1 }, []])).toThrow();
    expect(() => validateArgs("profile.fillFromResume", ["/x/r.pdf", { links: ["javascript:alert(1)"] }, []])).toThrow();
    expect(() => validateArgs("profile.fillFromResume", ["/x/r.pdf", {}, ["work_rights"]])).toThrow();
    expect(validateArgs("profile.fillFromResume", ["/x/r.pdf", { name: "Alex Example", links: ["https://github.com/alexexample"] }, ["name"]]))
      .toEqual(["/x/r.pdf", { name: "Alex Example", links: ["https://github.com/alexexample"] }, ["name"]]);
  });
});
