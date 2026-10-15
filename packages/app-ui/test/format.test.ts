import { describe, expect, it } from "vitest";
import { dateView, fmtDate, fmtDateTime, fmtTime, leadingNumber, sponsorStatus, workRightsStatusOf } from "../src/format";

// Local-time constructors keep these tests independent of the machine's time zone.
const NOW = new Date(2026, 9, 10, 15, 0); // 10 Oct 2026, 3:00 pm local

describe("dateView", () => {
  it("shows a date-only value as a date, with no invented time and no timestamp tooltip", () => {
    const v = dateView("2026-09-17", NOW)!;
    expect(v.text).toBe("17 Sep 2026");
    expect(v.dateOnly).toBe(true);
    expect(v.title).toBeUndefined();
    expect(v.hint).toBe("3 weeks ago");
  });

  it("treats a migrated midnight value without a zone as date-only", () => {
    const v = dateView("2026-10-08T00:00:00", NOW)!;
    expect(v.text).toBe("8 Oct 2026");
    expect(v.dateOnly).toBe(true);
    expect(v.title).toBeUndefined();
    expect(v.hint).toBe("2 days ago");
  });

  it("shows a real timestamp as a date, with the full time in the tooltip", () => {
    const at = new Date(2026, 9, 10, 9, 5).toISOString();
    const v = dateView(at, NOW)!;
    expect(v.text).toBe("10 Oct 2026");
    expect(v.dateOnly).toBe(false);
    expect(v.title).toBe("10 Oct 2026, 9:05 am");
    expect(v.hint).toBe("today");
  });

  it("writes '~' as 'about'", () => {
    const v = dateView("~2026-09-17", NOW)!;
    expect(v.text).toBe("about 17 Sep 2026");
    expect(v.approx).toBe(true);
  });

  it("P8: keeps the 'about' prefix for values already written that way", () => {
    const v = dateView("about 2026-09-17", NOW)!;
    expect(v.text).toBe("about 17 Sep 2026");
    expect(v.approx).toBe(true);
  });

  it("P8: a date-only value with a space instead of 'T' before midnight shows no invented time", () => {
    const v = dateView("2026-10-08 00:00:00", NOW)!;
    expect(v.text).toBe("8 Oct 2026");
    expect(v.dateOnly).toBe(true);
    expect(v.title).toBeUndefined();
  });

  it("P8: a slash-separated date-only value shows no invented time", () => {
    const v = dateView("2026/10/08", NOW)!;
    expect(v.text).toBe("8 Oct 2026");
    expect(v.dateOnly).toBe(true);
    expect(v.title).toBeUndefined();
  });

  it("P8: a value that cannot be parsed safely (no explicit time marker) shows the original text rather than a guessed time", () => {
    const v = dateView("10/08/2026", NOW)!;
    expect(v.text).toBe("10/08/2026");
    expect(v.dateOnly).toBe(true);
    expect(v.title).toBeUndefined();
  });

  it("gives relative hints for days, weeks, months, years and the future", () => {
    expect(dateView("2026-10-09", NOW)!.hint).toBe("yesterday");
    expect(dateView("2026-10-05", NOW)!.hint).toBe("5 days ago");
    expect(dateView("2026-10-03", NOW)!.hint).toBe("1 week ago");
    expect(dateView("2026-07-01", NOW)!.hint).toBe("3 months ago");
    expect(dateView("2024-10-01", NOW)!.hint).toBe("2 years ago");
    expect(dateView("2026-10-11", NOW)!.hint).toBe("tomorrow");
    expect(dateView("2026-10-14", NOW)!.hint).toBe("in 4 days");
  });

  it("returns null for empty or unreadable values", () => {
    expect(dateView("", NOW)).toBeNull();
    expect(dateView("not a date", NOW)).toBeNull();
  });
});

describe("legacy formatters never invent a time", () => {
  it("fmtDateTime and fmtTime drop the time for date-only values", () => {
    expect(fmtDateTime("2026-10-08")).toBe("8 Oct 2026");
    expect(fmtDateTime("2026-10-08T00:00:00")).toBe("8 Oct 2026");
    expect(fmtTime("2026-10-08")).toBe("");
    expect(fmtDate("2026-10-08")).toBe("8 Oct 2026");
  });
  it("fmtDateTime keeps the time when there is one", () => {
    expect(fmtDateTime(new Date(2026, 0, 12, 19, 0).toISOString())).toBe("12 Jan 2026, 7:00 pm");
  });
});

describe("sponsorStatus", () => {
  it("maps every known status, in hyphen or underscore form, to one plain label", () => {
    expect(sponsorStatus("verified")).toEqual({ text: "Verified sponsor", tone: "success" });
    expect(sponsorStatus("to-verify").text).toBe("To verify");
    expect(sponsorStatus("to_verify").text).toBe("To verify");
    expect(sponsorStatus("checked-none").text).toBe("No evidence found");
    expect(sponsorStatus("checked_none").text).toBe("No evidence found");
    expect(sponsorStatus("sanctioned")).toEqual({ text: "Sanctioned", tone: "danger" });
  });
  it("never shows a slug: anything else reads 'Not checked'", () => {
    for (const s of ["unknown", "", undefined, null, "pending-review", "toString", "__proto__"]) {
      expect(sponsorStatus(s as string).text).toBe("Not checked");
    }
  });
});

describe("leadingNumber", () => {
  it("reads the leading number from free-text results", () => {
    expect(leadingNumber("81 (c. 30 relevant)")).toBe(81);
    expect(leadingNumber("2,000+ results")).toBe(2000);
    expect(leadingNumber("12")).toBe(12);
    expect(leadingNumber("~40")).toBe(40);
    expect(leadingNumber("none")).toBeNull();
    expect(leadingNumber("")).toBeNull();
  });

  it("P9: reads a 'k' shorthand as thousands", () => {
    expect(leadingNumber("1.5k")).toBe(1500);
    expect(leadingNumber("2k")).toBe(2000);
    expect(leadingNumber("2K results")).toBe(2000);
  });
});

describe("workRightsStatusOf (round 2: candidate-aware sponsorship)", () => {
  it("reads work_rights.status out of the generic settings.get('profile') values, defaulting to unknown", () => {
    expect(workRightsStatusOf({ work_rights: { status: "needs_sponsorship" } })).toBe("needs_sponsorship");
    expect(workRightsStatusOf({ work_rights: { status: "citizen" } })).toBe("citizen");
    expect(workRightsStatusOf({ work_rights: { status: "full_visa" } })).toBe("full_visa");
  });
  it("never trusts an unrecognised or missing status", () => {
    expect(workRightsStatusOf({ work_rights: { status: "not-a-real-status" } })).toBe("unknown");
    expect(workRightsStatusOf({})).toBe("unknown");
    expect(workRightsStatusOf(undefined)).toBe("unknown");
    expect(workRightsStatusOf({ work_rights: null })).toBe("unknown");
  });
});
