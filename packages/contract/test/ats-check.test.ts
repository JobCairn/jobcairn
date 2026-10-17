import { describe, expect, it } from "vitest";
import { atsCheck, atsUnreadable, missingSections, unicodeDashDates, type AtsCheckItem } from "../src/index.js";

// Fictional data only (Alex Example, Acme Corp). Contact strings are built by concatenation for the privacy scan.
const EMAIL = "alex" + "@" + "example.com";
const PHONE = "0491 570 " + "006";
const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);
const FI = String.fromCharCode(0xfb01);
const BAD = String.fromCharCode(0xfffd);

/** About 200 words of filler bullets, so the length check passes. */
const BULLETS = Array.from({ length: 20 }, (_, i) => `- Built and ran data pipeline number ${i + 1} for Acme Corp teams`).join("\n");

function resume(over: { dates?: string; contact?: string; extra?: string; headings?: string[] } = {}): string {
  const [exp, edu, skills] = over.headings ?? ["Experience", "Education", "Skills"];
  return [
    "Alex Example",
    over.contact ?? `${EMAIL} | ${PHONE} | Sampletown NSW 2000`,
    "Summary",
    "Data engineer who builds reliable pipelines.",
    exp,
    "Senior Data Engineer, Acme Corp",
    over.dates ?? "Jan 2022 - Present",
    BULLETS,
    edu,
    "Bachelor of Computing, Example University, 2015 - 2018",
    skills,
    "Python, SQL, Airflow",
    over.extra ?? "",
  ].join("\n");
}

const byId = (items: AtsCheckItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));
const check = (text: string, pages: number | null = 1, email = EMAIL, phone = PHONE) => byId(atsCheck({ text, pages, email, phone }));

describe("atsCheck", () => {
  it("passes a clean one-page resume on every row", () => {
    const r = atsCheck({ text: resume(), pages: 1, email: EMAIL, phone: PHONE });
    expect(r.map((i) => i.id)).toEqual(["text", "length", "email", "phone", "dates", "pages", "headings"]);
    expect(r.filter((i) => i.status === "warn")).toEqual([]);
  });

  it("leaves the page row out for a Word file", () => {
    expect(check(resume(), null).pages).toBeUndefined();
  });

  it("warns about garbled text: replacement characters, font codes, ligatures and spaced letters", () => {
    expect(check(resume({ extra: `Bad ${BAD} glyph` })).text!.status).toBe("warn");
    expect(check(resume({ extra: "Odd (cid:12) code" })).text!.detail).toContain("font codes");
    expect(check(resume({ extra: `Led ${FI}nance reporting` })).text!.detail).toContain("joined letters");
    expect(check(resume({ extra: "S U M M A R Y" })).text!.detail).toContain("letter-spaced");
  });

  it("warns when too little or too much text comes out", () => {
    expect(check(`Alex Example\n${EMAIL}\n${PHONE}\nExperience\nEducation\nSkills`).length!.status).toBe("warn");
    const long = resume({ extra: Array.from({ length: 400 }, () => "more words here today").join(" ") });
    expect(check(long).length!.detail).toContain("long for a resume");
    // Enough words in total, but spread over many pages: some text is probably in images.
    expect(check(resume(), 3).length!.detail).toContain("words a page");
  });

  it("finds the profile's email in any case, and the phone by its digits", () => {
    expect(check(resume({ contact: `${EMAIL.toUpperCase()} | +61 491 570 006` })).email!.status).toBe("pass");
    expect(check(resume({ contact: "+61 491 570 006" })).phone!.status).toBe("pass");
    const r = check(resume({ contact: "Sampletown NSW 2000" }));
    expect(r.email!.status).toBe("warn");
    expect(r.phone!.status).toBe("warn");
  });

  it("with no profile contact, any email and phone number will do", () => {
    const r = check(resume(), 1, "", "");
    expect(r.email!.status).toBe("pass");
    expect(r.phone!.status).toBe("pass");
    expect(check(resume({ contact: "Sampletown NSW 2000" }), 1, "", "").email!.detail).toContain("No email address");
  });

  it("warns about a year joined to an en or em dash, and passes ASCII hyphens and words", () => {
    const en = check(resume({ dates: `Jan 2022 ${EN} Present` })).dates!;
    expect(en.status).toBe("warn");
    expect(en.detail).toContain("an en dash");
    expect(en.detail).toContain("Jan 2022");
    expect(check(resume({ dates: `2019${EM}2022` })).dates!.detail).toContain("an em dash");
    expect(check(resume({ dates: "Jan 2022 to Present" })).dates!.status).toBe("pass");
    expect(check(resume({ dates: "Jan 2022 - Present" })).dates!.status).toBe("pass");
  });

  it("doesn't read a dash bullet before a year, or a number range, as a date range", () => {
    expect(unicodeDashDates(`${EN} 2019 award for Acme Corp`)).toEqual([]);
    expect(unicodeDashDates(`Budgets of 120000${EN}150000`)).toEqual([]);
    expect(unicodeDashDates(`Mar 2016 ${EN} Jul 2016\nMar 2016 ${EN} Jul 2016`)).toHaveLength(1);
  });

  it("warns above two pages", () => {
    expect(check(resume(), 2).pages!.status).toBe("pass");
    const r = check(resume({ extra: BULLETS + "\n" + BULLETS }), 3).pages!;
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("3 pages. Keep it to 2 pages or fewer.");
  });

  it("names the required section headings that are missing", () => {
    expect(missingSections(resume())).toEqual([]);
    expect(missingSections(resume({ headings: ["Work History", "Qualifications", "Technical Skills"] }))).toEqual([]);
    const r = check(resume({ headings: ["Where I've Made Impact", "Education", "What I Know"] })).headings!;
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("No Experience or Skills heading");
  });

  it("gives one unreadable row when no text came out", () => {
    expect(atsCheck({ text: " \n ", pages: 1, email: EMAIL, phone: PHONE })).toEqual([atsUnreadable("No text came out of the file. It may be an image or a scan.")]);
  });
});
