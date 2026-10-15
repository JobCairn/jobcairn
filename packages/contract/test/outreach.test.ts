import { describe, expect, it } from "vitest";
import { fitLinkedIn, followUpTemplate, LINKEDIN_NOTE_MAX, parseOutreach, thankYouTemplate } from "../src/outreach.js";
import { followUpIsDue, followUpOn, localDate } from "../src/index.js";

describe("follow-up timing", () => {
  const applied = (at: string, extra: { event: string; at: string }[] = [], custom?: Record<string, unknown>) => ({
    status: "Applied" as const, timeline: [{ at, event: "Status: Applied", note: "" }, ...extra.map((e) => ({ ...e, note: "" }))], custom,
  });
  it("is 7 days after applying by default, or the saved day", () => {
    expect(followUpOn(applied("2026-10-01T02:00:00.000Z"))).toBe(localDate(new Date("2026-10-08T02:00:00.000Z")));
    expect(followUpOn(applied("2026-10-01T02:00:00.000Z", [], { follow_up_on: "2026-10-05" }))).toBe("2026-10-05");
    // A saved day before the application (left over from an earlier round) is ignored.
    expect(followUpOn(applied("2026-10-01T02:00:00.000Z", [], { follow_up_on: "2026-09-01" }))).toBe(localDate(new Date("2026-10-08T02:00:00.000Z")));
  });
  it("is gone once they reply, or when the job isn't Applied", () => {
    expect(followUpOn(applied("2026-10-01T02:00:00.000Z", [{ event: "Email received", at: "2026-10-03T00:00:00.000Z" }]))).toBe("");
    expect(followUpOn({ status: "Interview", timeline: [] })).toBe("");
    expect(followUpOn({ status: "Applied", timeline: [] })).toBe("");
  });
  it("is due on and after the day", () => {
    expect(followUpIsDue("2026-10-08", new Date(2026, 9, 8, 9))).toBe(true);
    expect(followUpIsDue("2026-10-08", new Date(2026, 9, 7, 23))).toBe(false);
    expect(followUpIsDue(undefined, new Date())).toBe(false);
  });
  it("fills polite follow-up and thank-you templates with no address and no placeholders", () => {
    const f = followUpTemplate({ title: "AI Engineer", company: "Acme Corp", appliedOn: "2026-10-01" });
    expect(f.subject).toBe("Following up: AI Engineer application");
    expect(f.body).toContain("AI Engineer role at Acme Corp on 1 October");
    const t = thankYouTemplate({ title: "AI Engineer", company: "Acme Corp" });
    expect(t.subject).toBe("Thank you: AI Engineer interview");
    for (const b of [f.body, t.body]) { expect(b).not.toMatch(/[[\]{}!]/); expect(b.endsWith("Regards,")).toBe(true); }
  });
});

const MD = [
  "## Note",
  "Subject: AI Engineer application, Alex Example",
  "",
  "Hi,",
  "",
  "I've applied for the **AI Engineer** role. At Example Labs I built a retrieval assistant that cut support tickets by 20%.",
  "",
  "Regards,",
  "Alex",
  "",
  "## LinkedIn connection note",
  "Hi, I've applied for the AI Engineer role at Acme Corp.",
  "I built a retrieval assistant at Example Labs. Keen to connect.",
].join("\n");

describe("parseOutreach", () => {
  it("reads the subject, the note and the LinkedIn note as plain text", () => {
    const n = parseOutreach(MD)!;
    expect(n.subject).toBe("AI Engineer application, Alex Example");
    expect(n.body.startsWith("Hi,\n\nI've applied for the AI Engineer role.")).toBe(true);
    expect(n.body.endsWith("Regards,\nAlex")).toBe(true);
    expect(n.linkedin).toBe("Hi, I've applied for the AI Engineer role at Acme Corp. I built a retrieval assistant at Example Labs. Keen to connect.");
  });
  it("copes with no subject line, a BOM, CRLF and no LinkedIn section", () => {
    const n = parseOutreach("﻿# Outreach\r\n## Note\r\nHi,\r\nShort note.\r\n")!;
    expect(n).toEqual({ subject: "", body: "Hi,\nShort note.", linkedin: "" });
  });
  it("is null when there is no note", () => {
    expect(parseOutreach("## LinkedIn connection note\nHi")).toBeNull();
    expect(parseOutreach("## Note\nSubject: x\n")).toBeNull();
    expect(parseOutreach("")).toBeNull();
  });
});

describe("fitLinkedIn", () => {
  it("keeps a short note as it is", () => {
    expect(fitLinkedIn("Hi  there,\nkeen to connect.")).toBe("Hi there, keen to connect.");
  });
  it("cuts a long note at a word break within the limit", () => {
    const long = "word ".repeat(100);
    const out = fitLinkedIn(long);
    expect(out.length).toBeLessThanOrEqual(LINKEDIN_NOTE_MAX);
    expect(out.endsWith("word")).toBe(true);
  });
});
