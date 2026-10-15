import { describe, expect, it } from "vitest";
import type { CompanyInfo } from "../src/match.js";
import { recheckFiled, type FiledEmail } from "../src/recheck.js";
import { addr, ALEX } from "../src/testing.js";

const job = (id: string, title: string) => ({ id, title, status: "Applied", last_activity: "2026-01-12T09:00:00.000Z" });
const ACME: CompanyInfo = { slug: "acme-corp", name: "Acme Corp", aliases: [], website: "https://acme.example.com", recruiter_email: "", email_match: [], jobs: [job("2026-01-12-ai-engineer", "AI Engineer")] };
const LABS: CompanyInfo = { slug: "example-labs", name: "Example Labs", aliases: [], website: "https://examplelabs.example.net", recruiter_email: "", email_match: [], jobs: [] };
const ALL = [ACME, LABS];
const mail = (from: string, subject: string, over: Partial<FiledEmail> = {}): FiledEmail =>
  ({ direction: "in", from: { name: "", address: from }, to: [{ name: "", address: ALEX }], cc: [], subject, matched_by: "domain", ...over });

describe("recheckFiled", () => {
  it("keeps mail that still matches where it's filed", () => {
    expect(recheckFiled(mail(addr("jordan.lee", "acme.example.com"), "Next steps"), "acme-corp", ALL, ALEX)).toBe("keep");
  });
  it("never touches mail you filed or moved yourself", () => {
    expect(recheckFiled(mail(addr("noreply-accounts", "acme.example.com"), "Review your Acme Account settings", { matched_by: "user" }), "acme-corp", ALL, ALEX)).toBe("keep");
  });
  it("unfiles a platform account notice that is not job mail, or sorts it when it names another tracked company", () => {
    expect(recheckFiled(mail(addr("noreply-accounts", "acme.example.com"), "You shared some Acme Account data with Example Labs"), "acme-corp", ALL, ALEX)).toBe("sort");
    expect(recheckFiled(mail(addr("noreply-accounts", "acme.example.com"), "Review your Acme Account settings"), "acme-corp", ALL, ALEX)).toBe("unfile");
  });
  it("sends a board's welcome mail to Mail to sort", () => {
    expect(recheckFiled(mail(addr("noreply", "seek.com.au"), "Welcome to SEEK", { matched_by: "subject" }), "acme-corp", ALL, ALEX)).toBe("sort");
  });
  it("sends mail that now matches a different company to Mail to sort, so you choose", () => {
    expect(recheckFiled(mail(addr("people", "examplelabs.example.net"), "Hello"), "acme-corp", ALL, ALEX)).toBe("sort");
  });
});
