import { describe, expect, it } from "vitest";
import { METHODS, validateArgs } from "../src/index.js";

const REF = "companies/acme-corp/jobs/2026-01-12-ai-engineer/emails/2026-01-14-interview-for-ai-engineer-a1b2c3.json";
const input = { to: "talent" + "@" + "example.org", cc: "", subject: "Hi", body: "Hello\n\nAlex", attach: ["companies/acme-corp/jobs/2026-01-12-ai-engineer/application/resume.pdf"], in_reply_to: "", references: [], purpose: "" };

describe("mail methods", () => {
  it("lists every mail method", () => {
    expect(Object.keys(METHODS).filter((m) => m.startsWith("mail.")).sort()).toEqual([
      "mail.background.set", "mail.background.status", "mail.disconnect", "mail.drafts.all", "mail.drafts.assist", "mail.drafts.get", "mail.drafts.list", "mail.drafts.propose",
      "mail.drafts.save", "mail.get", "mail.list", "mail.loadImages", "mail.move", "mail.prune", "mail.recheck.apply", "mail.recheck.dismiss", "mail.recheck.preview", "mail.saveAccount", "mail.saveAttachment",
      "mail.send.again", "mail.send.markSent",
      "mail.setSignature", "mail.status", "mail.syncNow", "mail.testConnection", "mail.triage.assign", "mail.triage.createCompany", "mail.triage.ignore", "mail.triage.list",
    ]);
  });
  it("takes only a 64-character token to apply a re-check", () => {
    expect(validateArgs("mail.recheck.apply", ["a".repeat(64)])).toEqual(["a".repeat(64)]);
    expect(() => validateArgs("mail.recheck.apply", ["short"])).toThrow();
    expect(() => validateArgs("mail.recheck.apply", [])).toThrow();
  });
  it("accepts good arguments", () => {
    expect(validateArgs("mail.get", [REF])).toEqual([REF]);
    expect(validateArgs("mail.saveAttachment", [REF, "2"])).toEqual([REF, "2"]);
    expect(validateArgs("mail.move", [REF, { company_slug: "acme-corp" }])).toEqual([REF, { company_slug: "acme-corp" }]);
    expect(validateArgs("mail.list", [{ company_slug: "acme-corp", unread: true, text: "interview" }])).toHaveLength(1);
    expect(validateArgs("mail.drafts.save", ["acme-corp", "2026-01-12-ai-engineer", "", input])).toHaveLength(4);
    expect(validateArgs("mail.triage.ignore", ["2026-01-14-new-jobs-d4e5f6", "domain"])).toHaveLength(2);
    expect(validateArgs("mail.background.set", [true, 60])).toEqual([true, 60]);
    expect(validateArgs("mail.send.markSent", ["20260115t090000-aaaaaa"])).toEqual(["20260115t090000-aaaaaa"]);
    expect(validateArgs("mail.send.again", ["20260115t090000-aaaaaa", "a".repeat(64), true])).toEqual(["20260115t090000-aaaaaa", "a".repeat(64), true]);
  });
  it("refuses paths that aren't stored emails, and bad shapes", () => {
    for (const bad of ["settings/profile.json", "companies/acme-corp/emails/../../workspace.json", "companies/acme-corp/emails/x.eml", "/etc/passwd"]) {
      expect(() => validateArgs("mail.get", [bad]), bad).toThrow(/invalid format/);
    }
    expect(() => validateArgs("mail.saveAttachment", [REF, "../x"])).toThrow(/invalid format/);
    expect(() => validateArgs("mail.drafts.save", ["acme-corp", "2026-01-12-ai-engineer", "", { ...input, attach: ["../secret.pdf"] }])).toThrow(/segments/);
    expect(() => validateArgs("mail.drafts.save", ["acme-corp", "2026-01-12-ai-engineer", "", { ...input, bcc: "x" }])).toThrow(/not allowed/);
    expect(() => validateArgs("mail.drafts.propose", ["acme-corp", "2026-01-12-ai-engineer", ""])).toThrow(/is required/);
    expect(() => validateArgs("mail.background.set", [true, 5])).toThrow(/15 to 1440/);
    expect(() => validateArgs("mail.background.set", [true, 60.5])).toThrow(/whole number from 15 to 1440/);
    expect(() => validateArgs("mail.background.set", [true, 1441])).toThrow(/15 to 1440/);
    expect(() => validateArgs("mail.prune", [0])).toThrow(/1 to 120/);
    expect(() => validateArgs("mail.triage.ignore", ["x", "everyone"])).toThrow(/sender, domain/);
    expect(() => validateArgs("mail.list", [{ company_slug: "acme-corp", __proto__x: 1 }])).toThrow(/not allowed/);
    expect(() => validateArgs("mail.send.markSent", ["../x"])).toThrow(/invalid format/);
    expect(() => validateArgs("mail.send.again", ["20260115t090000-aaaaaa", "a".repeat(64), "yes"])).toThrow(/true or false/);
    expect(() => validateArgs("mail.send.again", ["20260115t090000-aaaaaa", true])).toThrow(/expected 3/);
    expect(() => validateArgs("mail.send.again", ["20260115t090000-aaaaaa", "not-a-digest", true])).toThrow();
  });
  it("never takes a filesystem path from the renderer", () => {
    // Attachments are workspace-relative; a draft can't name an absolute path.
    expect(() => validateArgs("mail.drafts.save", ["acme-corp", "2026-01-12-ai-engineer", "", { ...input, attach: ["/etc/passwd"] }])).toThrow(/workspace-relative/);
    expect(() => validateArgs("mail.move", [REF, { company_slug: "../x" }])).toThrow(/invalid format/);
  });
});
