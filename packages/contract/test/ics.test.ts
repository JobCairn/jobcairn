import { describe, expect, it } from "vitest";
import { addDays, buildIcs, foldLine, followUpDate, icsText, jobCalendarEvent, METHODS, validateArgs, type JobRecord } from "../src/index.js";

const STAMP = new Date("2026-10-15T09:05:07.000Z");
const enc = new TextEncoder();

describe("icsText", () => {
  it("escapes backslash, semicolon, comma and line breaks", () => {
    expect(icsText("a\\b; c, d\ne\r\nf")).toBe("a\\\\b\\; c\\, d\\ne\\nf");
  });
  it("drops control characters but keeps tabs", () => {
    expect(icsText("a\u0007b\tc")).toBe("ab\tc");
  });
});

describe("foldLine", () => {
  it("leaves lines of 75 octets or fewer alone", () => {
    const s = "X".repeat(75);
    expect(foldLine(s)).toBe(s);
  });

  it("folds at 75 octets with CRLF and a space, and every part fits", () => {
    const folded = foldLine("SUMMARY:" + "a".repeat(200));
    const parts = folded.split("\r\n");
    expect(parts.length).toBe(3);
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(parts.every((p) => enc.encode(p).length <= 75)).toBe(true);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe("SUMMARY:" + "a".repeat(200));
  });

  it("never splits a multi-byte character", () => {
    const text = "DESCRIPTION:" + "é".repeat(60) + "日本語".repeat(10);
    const parts = foldLine(text).split("\r\n");
    expect(parts.every((p) => enc.encode(p).length <= 75)).toBe(true);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(text);
  });
});

describe("buildIcs", () => {
  it("writes a timed interview as floating local time with a UID, DTSTAMP and end", () => {
    const ics = buildIcs({ uid: "interview-acme-corp-2026-10-01-data-analyst.jobcairn", stamp: STAMP, summary: "Interview: Data Analyst, Acme Corp; round 2", description: "Line one\nLine two", location: "1 Example Street, Sampletown NSW 2000", start: "2026-10-21T14:30", minutes: 60 });
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "").includes("\n")).toBe(false);
    const lines = ics.split("\r\n");
    expect(lines.slice(0, 6)).toEqual(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//jobcairn//Calendar export//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT"]);
    expect(lines).toContain("UID:interview-acme-corp-2026-10-01-data-analyst.jobcairn");
    expect(lines).toContain("DTSTAMP:20261015T090507Z");
    expect(lines).toContain("DTSTART:20261021T143000");
    expect(lines).toContain("DTEND:20261021T153000");
    expect(lines).toContain("SUMMARY:Interview: Data Analyst\\, Acme Corp\\; round 2");
    expect(lines).toContain("DESCRIPTION:Line one\\nLine two");
    expect(lines).toContain("LOCATION:1 Example Street\\, Sampletown NSW 2000");
    expect(lines.slice(-4)).toEqual(["TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR", ""]);
    expect(ics).not.toMatch(/TZID/);
  });

  it("rolls an end past midnight into the next day", () => {
    const ics = buildIcs({ uid: "x", stamp: STAMP, summary: "Late", start: "2026-12-31T23:30", minutes: 60 });
    expect(ics).toContain("DTEND:20270101T003000");
  });

  it("writes an all-day follow-up with an exclusive end date", () => {
    const ics = buildIcs({ uid: "follow-up-x", stamp: STAMP, summary: "Follow up", date: "2026-10-22" });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261022\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20261023\r\n");
  });

  it("refuses a malformed time or a missing date, and keeps the UID to plain characters", () => {
    expect(() => buildIcs({ uid: "x", stamp: STAMP, summary: "x", start: "2026-10-21 14:30" })).toThrow(/date and time/);
    expect(() => buildIcs({ uid: "x", stamp: STAMP, summary: "x" })).toThrow(/needs a date/);
    expect(buildIcs({ uid: "a b\nc", stamp: STAMP, summary: "x", date: "2026-10-22" })).toContain("UID:abc\r\n");
  });
});

const job = (over: Partial<JobRecord> & { interview_at?: string }): JobRecord => ({
  id: "2026-10-01-data-analyst", company_slug: "acme-corp", title: "Data Analyst", status: "Applied", location: "Sampletown NSW", url: "https://example.com/jobs/1",
  timeline: [{ at: "2026-10-01T00:00:00.000Z", event: "Found", note: "" }, { at: "2026-10-08T03:00:00.000Z", event: "Status: Applied", note: "" }],
  ...over,
} as JobRecord);

describe("dates from a job", () => {
  it("follow up 7 days after the latest application, only while Applied", () => {
    expect(addDays("2026-10-28", 7)).toBe("2026-11-04");
    expect(followUpDate(job({}))).toMatch(/^2026-10-1[45]$/);
    expect(followUpDate(job({ status: "Interview" }))).toBeNull();
    expect(followUpDate(job({ timeline: [] }))).toBeNull();
  });

  it("makes the interview and follow-up events, or null without a date", () => {
    const iv = jobCalendarEvent(job({ status: "Interview", interview_at: "2026-10-21T14:30" }), "Acme Corp", "interview", STAMP)!;
    expect(iv).toMatchObject({ uid: "interview-acme-corp-2026-10-01-data-analyst.jobcairn", summary: "Interview: Data Analyst at Acme Corp", start: "2026-10-21T14:30", location: "Sampletown NSW" });
    expect(iv.uid).not.toContain("@");
    expect(iv.description).toContain("The ad: https://example.com/jobs/1");
    expect(jobCalendarEvent(job({ status: "Interview" }), "Acme Corp", "interview", STAMP)).toBeNull();
    const fu = jobCalendarEvent(job({}), "Acme Corp", "follow_up", STAMP)!;
    expect(fu).toMatchObject({ uid: "follow-up-acme-corp-2026-10-01-data-analyst.jobcairn", summary: "Follow up: Data Analyst at Acme Corp" });
    expect(fu.date).toBeTruthy();
    expect(jobCalendarEvent(job({ status: "Offer" }), "Acme Corp", "follow_up", STAMP)).toBeNull();
  });

  it("the IPC check takes a local date and time or empty, nothing else", () => {
    expect(() => validateArgs("jobs.setInterview", ["acme-corp", "x", "2026-10-21T14:30"])).not.toThrow();
    expect(() => validateArgs("jobs.setInterview", ["acme-corp", "x", ""])).not.toThrow();
    expect(() => validateArgs("jobs.setInterview", ["acme-corp", "x", "2026-13-21T14:30"])).toThrow();
    expect(() => validateArgs("jobs.setInterview", ["acme-corp", "x", "tomorrow"])).toThrow();
    expect(() => validateArgs("jobs.addToCalendar", ["acme-corp", "x", "birthday"])).toThrow();
    expect(METHODS).toHaveProperty(["jobs.addToCalendar"]);
  });
});
