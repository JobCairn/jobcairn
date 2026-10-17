import { describe, expect, it } from "vitest";
import {
  followUpLimitText, followUpOn, followUpsSent, isFollowUpEvent, localDate, MAX_FOLLOW_UPS, quietApplications, quietText, thankYouDue,
  type JobRow,
} from "../src/index.js";

const row = (id: string, status: JobRow["status"], last: string): JobRow => ({ company_slug: "acme-corp", id, status, last_activity: last } as JobRow);

describe("quiet applications", () => {
  const now = new Date("2026-10-17T00:00:00.000Z");
  it("offers only Applied jobs with no activity for 60 days, oldest first", () => {
    const rows = [
      row("a", "Applied", "2026-08-01T00:00:00.000Z"),
      row("b", "Applied", "2026-07-01T00:00:00.000Z"),
      row("c", "Applied", "2026-09-01T00:00:00.000Z"), // 46 days: not yet
      row("d", "Applying", "2026-01-01T00:00:00.000Z"), // a draft never sent is never quiet
      row("e", "Interview", "2026-01-01T00:00:00.000Z"),
      row("f", "Applied", "not a date"),
    ];
    expect(quietApplications(rows, now).map((r) => r.id)).toEqual(["b", "a"]);
    expect(quietApplications(rows, now, 30).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
  it("says how many in plain words", () => {
    expect(quietText(5)).toBe("5 applications have had no reply for 60 days. Mark them No response?");
    expect(quietText(1)).toBe("1 application has had no reply for 60 days. Mark it No response?");
  });
});

describe("follow-up limit", () => {
  const ev = (event: string, at: string, note = "") => ({ event, at, note });
  it("counts sent follow-up emails and Followed up events, never received mail or other sent mail", () => {
    expect(isFollowUpEvent(ev("Email sent", "2026-10-01T00:00:00Z", "Following up: AI Engineer application"))).toBe(true);
    expect(isFollowUpEvent(ev("Email sent", "2026-10-01T00:00:00Z", "Re: Follow-up on my application"))).toBe(true);
    expect(isFollowUpEvent(ev("Email sent", "2026-10-01T00:00:00Z", "Checking in on the AI Engineer role"))).toBe(true);
    expect(isFollowUpEvent(ev("Followed up", "2026-10-01T00:00:00Z"))).toBe(true);
    expect(isFollowUpEvent(ev("Email received", "2026-10-01T00:00:00Z", "Following up: AI Engineer application"))).toBe(false);
    expect(isFollowUpEvent(ev("Email sent", "2026-10-01T00:00:00Z", "Application: AI Engineer"))).toBe(false);
    expect(followUpsSent([ev("Followed up", "2026-10-01T00:00:00Z"), ev("Email sent", "2026-10-09T00:00:00Z", "Following up: x")])).toBe(2);
  });
  it("moves the next follow-up a week after the last one, and stops after two", () => {
    const applied = "2026-10-01T02:00:00.000Z";
    const base = [ev("Status: Applied", applied)];
    const one = [...base, ev("Email sent", "2026-10-10T02:00:00.000Z", "Following up: AI Engineer application")];
    expect(followUpOn({ status: "Applied", timeline: one })).toBe(localDate(new Date("2026-10-17T02:00:00.000Z")));
    const two = [...one, ev("Email sent", "2026-10-18T02:00:00.000Z", "Following up: AI Engineer application")];
    expect(followUpOn({ status: "Applied", timeline: two })).toBe("");
    expect(MAX_FOLLOW_UPS).toBe(2);
  });
  it("explains why Follow up is off only once the limit is reached", () => {
    expect(followUpLimitText(1)).toBe("");
    expect(followUpLimitText(2)).toMatch(/followed up twice/);
  });
});

describe("thank-you prompt", () => {
  const now = new Date(2026, 9, 17, 12);
  const at = new Date(2026, 9, 10, 9).toISOString();
  const interview = [{ at, event: "Status: Interview", note: "" }];
  it("is offered at Interview once the interview time has come", () => {
    expect(thankYouDue({ status: "Interview", timeline: interview }, now)).toBe(true);
    expect(thankYouDue({ status: "Interview", timeline: interview, interview_at: "2026-10-17T09:00" }, now)).toBe(true);
    expect(thankYouDue({ status: "Interview", timeline: interview, interview_at: "2026-10-20T09:00" }, now)).toBe(false);
    expect(thankYouDue({ status: "Applied", timeline: [] }, now)).toBe(false);
  });
  it("goes away once a thank-you email is sent after the job moved to Interview", () => {
    const sent = [...interview, { at: new Date(2026, 9, 11).toISOString(), event: "Email sent", note: "Thank you: AI Engineer interview" }];
    expect(thankYouDue({ status: "Interview", timeline: sent }, now)).toBe(false);
    const before = [{ at: new Date(2026, 9, 1).toISOString(), event: "Email sent", note: "Thanks for the call" }, ...interview];
    expect(thankYouDue({ status: "Interview", timeline: before }, now)).toBe(true);
  });
});
