import { describe, expect, it } from "vitest";
import { bodyHead, mailSignals, statusAdvice } from "../src/signals.js";

describe("mailSignals", () => {
  it("reads an acknowledgement from the subject or the first lines", () => {
    expect(mailSignals("Thank you for applying to Acme Corp", "")).toEqual(["acknowledged"]);
    expect(mailSignals("AI Engineer", "Hi Alex,\n\nWe’ve received your application for the AI Engineer role.")).toEqual(["acknowledged"]);
    expect(mailSignals("Application received: AI Engineer", "")).toEqual(["acknowledged"]);
  });
  it("reads interview, rejection and offer, and an outcome hides the polite opening", () => {
    expect(mailSignals("AI Engineer", "Thank you for applying. We'd like to invite you to an interview next week.")).toEqual(["interview"]);
    expect(mailSignals("Your application", "Thank you for your application. We regret to inform you that we won't be moving forward with your application.")).toEqual(["rejected"]);
    expect(mailSignals("Letter of offer", "We're delighted to offer you the role.")).toEqual(["offer"]);
  });
  it("never reads a footer or a quoted earlier email", () => {
    const footer = ["Hi Alex,", "Quick question about your availability.", "", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
      "Thank you for applying through our careers site. We have received your application."].join("\n");
    expect(mailSignals("Availability", footer)).toEqual([]);
    expect(mailSignals("Re: AI Engineer", "Sounds good.\n\nOn Tue, 13 Jan 2026 at 9:00, Acme Talent wrote:\n> We regret to inform you")).toEqual([]);
    expect(bodyHead("Line one\n> quoted")).toBe("Line one");
  });
  it("reads an HTML-only body", () => {
    expect(mailSignals("Update", "", "<p>Hi Alex,</p><p>We have received your application.</p><style>p{}</style>")).toEqual(["acknowledged"]);
  });
  it("keeps two different outcomes, so the email can be checked", () => {
    expect(mailSignals("Update", "We'd like to invite you to an interview. We regret to inform you the other role has been filled.").sort()).toEqual(["interview", "rejected"]);
  });
});

describe("statusAdvice", () => {
  const DATE = "2026-01-14T12:00:00.000Z";
  it("moves only Applying to Applied on an acknowledgement, with a dated note", () => {
    const a = statusAdvice("Applying", ["acknowledged"], DATE);
    expect(a).toEqual({ kind: "move", to: "Applied", note: "Moved to Applied: the employer acknowledged your application (email of 14 January 2026)." });
    expect(statusAdvice("Saved", ["acknowledged"], DATE)).toMatchObject({ kind: "suggest", to: "Applied" });
    expect(statusAdvice("Applied", ["acknowledged"], DATE)).toEqual({ kind: "none" });
    expect(statusAdvice("Interview", ["acknowledged"], DATE)).toEqual({ kind: "none" });
  });
  it("never decides an outcome: interview, rejection and offer are suggestions", () => {
    expect(statusAdvice("Applied", ["interview"])).toMatchObject({ kind: "suggest", to: "Interview" });
    expect(statusAdvice("Applied", ["rejected"])).toMatchObject({ kind: "suggest", to: "Rejected" });
    expect(statusAdvice("Interview", ["offer"])).toMatchObject({ kind: "suggest", to: "Offer" });
    expect(statusAdvice("Offer", ["interview"])).toEqual({ kind: "none" });
    expect(statusAdvice("Applied", [])).toEqual({ kind: "none" });
  });
  it("sends conflicts to a check: two outcomes, a signal against a final status, a no after an offer", () => {
    expect(statusAdvice("Applied", ["interview", "rejected"])).toMatchObject({ kind: "check" });
    expect(statusAdvice("Rejected", ["interview"])).toMatchObject({ kind: "check", reason: expect.stringContaining("The job is Rejected") });
    expect(statusAdvice("Withdrawn", ["offer"])).toMatchObject({ kind: "check" });
    expect(statusAdvice("Skipped", ["acknowledged"])).toMatchObject({ kind: "check" });
    expect(statusAdvice("Offer", ["rejected"])).toMatchObject({ kind: "check" });
  });
  it("lets a no agree with a closed job, and suggests Rejected after No response", () => {
    expect(statusAdvice("Rejected", ["rejected"])).toEqual({ kind: "none" });
    expect(statusAdvice("Withdrawn", ["rejected"])).toEqual({ kind: "none" });
    expect(statusAdvice("No response", ["rejected"])).toMatchObject({ kind: "suggest", to: "Rejected" });
  });
});
