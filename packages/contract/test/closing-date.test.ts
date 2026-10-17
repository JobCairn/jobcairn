import { describe, expect, it } from "vitest";
import { closingDateFromAd, closingState, parseClosingDate, storedClosing, CLOSING_SOON_DAYS } from "../src/index.js";

const FOUND = "2026-10-17T01:00:00.000Z";

describe("parseClosingDate", () => {
  it("reads ISO dates and Australian day-first dates", () => {
    expect(parseClosingDate("2026-10-31", FOUND)).toBe("2026-10-31");
    expect(parseClosingDate("31/10/2026", FOUND)).toBe("2026-10-31");
    expect(parseClosingDate("7/11/2026", FOUND)).toBe("2026-11-07");
    expect(parseClosingDate("07.11.26", FOUND)).toBe("2026-11-07");
  });

  it("reads month-first only when the first number can't be a month", () => {
    expect(parseClosingDate("11/27/2026", FOUND)).toBe("2026-11-27");
  });

  it("reads written dates, with or without the weekday, ordinal and year", () => {
    expect(parseClosingDate("31 October 2026", FOUND)).toBe("2026-10-31");
    expect(parseClosingDate("Friday 7th Nov 2026", FOUND)).toBe("2026-11-07");
    expect(parseClosingDate("October 31, 2026", FOUND)).toBe("2026-10-31");
    expect(parseClosingDate("5pm AEDT, Sunday 2 November", FOUND)).toBe("2026-11-02");
    expect(parseClosingDate("Nov 2", FOUND)).toBe("2026-11-02");
  });

  it("places a yearless date in the next year when it would be long before the ad was found", () => {
    expect(parseClosingDate("15 January", FOUND)).toBe("2027-01-15");
    // A month back is still this year: an ad found just after it closed.
    expect(parseClosingDate("20 September", FOUND)).toBe("2026-09-20");
  });

  it("never guesses: no date, a date that doesn't exist, or a bad found time gives null", () => {
    expect(parseClosingDate("ASAP", FOUND)).toBeNull();
    expect(parseClosingDate("when the right person is found", FOUND)).toBeNull();
    expect(parseClosingDate("31/02/2026", FOUND)).toBeNull();
    expect(parseClosingDate("2026-02-30", FOUND)).toBeNull();
    expect(parseClosingDate("31 October", "not a time")).toBeNull();
  });
});

describe("closingDateFromAd", () => {
  it("reads a Closes line in the saved ad's header first", () => {
    const jd = "# Data Analyst — Acme Corp\n- Source: SEEK https://www.seek.com.au/job/1\n- Closes: 31 October 2026\n---\nApply by 5 November.";
    expect(closingDateFromAd(jd, FOUND)).toBe("2026-10-31");
  });

  it("reads the ad's own closing words", () => {
    expect(closingDateFromAd("Join Acme Corp.\n\nApplications close 5pm Friday 31 October 2026.", FOUND)).toBe("2026-10-31");
    expect(closingDateFromAd("Closing date: 7/11/2026", FOUND)).toBe("2026-11-07");
    expect(closingDateFromAd("Please apply by 3 November.", FOUND)).toBe("2026-11-03");
    expect(closingDateFromAd("Applications are due by 2026-11-10 at midnight.", FOUND)).toBe("2026-11-10");
  });

  it("ignores dates that aren't about closing, and ads that state none", () => {
    expect(closingDateFromAd("Start date: 1 December 2026. Posted 10 October 2026.", FOUND)).toBeNull();
    expect(closingDateFromAd("Applications close when we find the right person.\n\nStart date 1 December 2026.", FOUND)).toBeNull();
    expect(closingDateFromAd("", FOUND)).toBeNull();
    expect(closingDateFromAd("Applications close when we find the right person. Start date 1 December 2026.", FOUND)).toBeNull();
    expect(closingDateFromAd("Applications close soon. Interviews on 5 November.", FOUND)).toBeNull();
    expect(closingDateFromAd("You will deliver projects by the deadline of 30 June 2027.", FOUND)).toBeNull();
  });

  it("reads a deadline only when it is about applications", () => {
    expect(closingDateFromAd("Deadline: 7 Nov 2026", FOUND)).toBe("2026-11-07");
    expect(closingDateFromAd("The application deadline is Fri. 31 Oct 2026.", FOUND)).toBe("2026-10-31");
  });
});

describe("storedClosing", () => {
  it("prefers the value given, then the ad text, else nothing", () => {
    expect(storedClosing("2026-11-01", "Applications close 31 October 2026", FOUND)).toBe("2026-11-01");
    expect(storedClosing("soon", "Applications close 31 October 2026", FOUND)).toBe("2026-10-31");
    expect(storedClosing(undefined, "No closing date here.", FOUND)).toBe("");
  });
});

describe("closingState", () => {
  const now = new Date(2026, 9, 17, 15, 0);
  const at = (closes_on: string, status = "Found" as const) => closingState({ closes_on, status }, now);

  it("counts local days, with today and tomorrow in words", () => {
    expect(at("2026-10-17")).toMatchObject({ days: 0, closed: false, soon: true, text: "Closes today" });
    expect(at("2026-10-18")).toMatchObject({ days: 1, soon: true, text: "Closes tomorrow" });
    expect(at(`2026-10-${17 + CLOSING_SOON_DAYS}`)).toMatchObject({ days: 7, soon: true, text: "Closes in 7 days" });
    expect(at("2026-10-25")).toMatchObject({ days: 8, soon: false, text: "Closes in 8 days" });
    expect(at("2027-01-30")).toMatchObject({ soon: false, text: "Closes 30 Jan 2027" });
  });

  it("is Closed from the day after, with the date in the reason", () => {
    expect(at("2026-10-16")).toMatchObject({ days: -1, closed: true, soon: false, text: "Closed", why: "The ad said applications closed on 16 Oct 2026." });
  });

  it("shows nothing once applied for, or without a readable date", () => {
    expect(closingState({ closes_on: "2026-10-20", status: "Applied" }, now)).toBeNull();
    expect(closingState({ status: "Found" }, now)).toBeNull();
    expect(at("")).toBeNull();
    expect(at("2026-13-01")).toBeNull();
  });
});
