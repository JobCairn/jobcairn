import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, defaults, layout, mergeAgency, readAgency, readApproval, readRecord, slugify, updateRecord, validateWorkspace, writeRecord } from "@careeros/core";
import { agencySlug } from "@careeros/contract";
import { approvalHandlers as AP } from "../src/approvals.js";
import { fakeMailHost } from "../src/fakes.js";
import { mailReadHandlers as MR } from "../src/mail-read.js";
import { approvalDigest } from "../src/read.js";
import { connectMail, GOOD_PASSWORD } from "./mail-helpers.js";
import { handleMcp } from "../src/claude/mcp/server.js";
import { mcpSession, mcpToolsFor } from "../src/claude/mcp/tools.js";
import { webContext } from "../src/claude/context.js";
import { recruiterHandlers as R } from "../src/recruiters.js";
import { openSample, sampleCopy } from "./helpers.js";

// Built by concatenation so the privacy scan stays meaningful.
const at = (local: string) => local + "@" + "example.com";
const PHONE = "0491 570 " + "006";
const AD_PHONE = "0491 570 " + "156";
type Res = { result?: { content: { text: string }[]; isError?: boolean } } | null;
const call = (root: string, name: string, args: unknown) =>
  JSON.parse((handleMcp(mcpSession(root, mcpToolsFor(name === "job_new" ? "find_jobs" : "find_recruiters")), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as Res)!.result!.content[0]!.text);

describe("recruiters", () => {
  it("lists the sample agency with the job it advertised, and saves tracking with a follow-up date", () => {
    const { ctx, root } = openSample();
    const rows = R["recruiters.list"](ctx);
    expect(rows.map((r) => r.slug)).toEqual(["acme-recruiting"]);
    expect(rows[0]!.jobs.map((j) => j.id)).toEqual(["2026-01-12-ai-developer"]);
    expect(rows[0]!.email).toBe(at("jobs"));
    const after = R["recruiters.update"](ctx, "acme-recruiting", { contacted_on: "2026-10-15", notes: "Spoke to the tech team" });
    expect(after.tracking).toEqual({ status: "contacted", contacted_on: "2026-10-15", follow_up_on: "2026-10-22", notes: "Spoke to the tech team" });
    expect(readAgency(root, "acme-recruiting")!.timeline.slice(-2).map((e) => e.event)).toEqual(["Contacted", "Notes updated"]);
    expect(() => R["recruiters.update"](ctx, "no-such-agency", { favourite: true })).toThrow(/isn't in this workspace/);
    expect(validateWorkspace(root).filter((i) => i.file.startsWith("recruiters"))).toEqual([]);
  });

  it("recruiter_add saves only published, sourced details and merges a second call", () => {
    const root = sampleCopy();
    const first = call(root, "recruiter_add", {
      name: "Example Labs Talent", website: "https://talent.example.com", tags: ["Data"], cities: ["Sampletown"],
      contacts: [{ kind: "email", value: at("talent"), source_url: "https://talent.example.com/contact" }, { kind: "email", value: at("guess"), source_url: "http://talent.example.com" }],
      people: [{ name: "Alex Example", source_url: "https://talent.example.com/team", email: at("alex") }],
      linkedin_url: "https://www.linkedin.com/in/alex-example",
    });
    expect(first).toMatchObject({ saved: true, slug: "example-labs-talent", contacts: 1, people: 1 });
    expect(first.left_out).toHaveLength(2);
    call(root, "recruiter_add", { name: "Example Labs Talent", tags: ["AI"], contacts: [{ kind: "phone", value: PHONE, source_url: "https://talent.example.com/contact" }] });
    const a = readAgency(root, "example-labs-talent")!;
    expect(a.tags).toEqual(["Data", "AI"]);
    expect(a.contacts.map((c) => c.value)).toEqual([at("talent"), PHONE]);
    expect(a.linkedin_url).toBe("");
    expect(a.timeline.map((e) => e.event)).toEqual(["Found by Claude", "Found by Claude"]);
  });

  it("a recruiter's job ad saved by Claude links the job and keeps the contacts it publishes, with the ad as source", () => {
    const root = sampleCopy();
    const made = call(root, "job_new", {
      company: "Acme Recruiting (Example Labs)", title: "Data Engineer", url: "https://jobs.example.com/rec/9", site: "Example board",
      jd_text: `Data Engineer for our client.\nContact Alex Example on ${AD_PHONE} or ${at("alex")}.`,
    });
    const a = readAgency(root, "acme-recruiting")!;
    expect(a.job_refs).toContain(`acme-recruiting/${made.id}`);
    expect(a.contacts.filter((c) => c.source_url === "https://jobs.example.com/rec/9").map((c) => c.value)).toEqual([at("alex"), AD_PHONE]);
    expect(a.people[0]).toMatchObject({ name: "Alex Example", source_url: "https://jobs.example.com/rec/9" });
    // An employer's own ad links nothing.
    call(root, "job_new", { company: "Example Labs", title: "ML Engineer", url: "https://jobs.example.com/labs/1", jd_text: `Email ${at("jobs")}` });
    expect(readAgency(root, "example-labs")).toBeNull();
  });

  it("a reply from the agency's domain after contact sets Replied and shows on its timeline", () => {
    const { ctx, root } = openSample();
    R["recruiters.update"](ctx, "acme-recruiting", { contacted_on: "2026-01-14" });
    const dir = layout(root).companyEmailsDir("acme-recruiting");
    fs.mkdirSync(dir, { recursive: true });
    writeRecord("email", path.join(dir, "2026-01-15-re-ai-developer.json"), defaults("email", {
      message_id: "<reply-1@example.com>", direction: "in", subject: "Re: AI Developer", date: "2026-01-15T02:00:00.000Z",
      from: { name: "Acme Recruiting", address: "pat" + "@" + "recruiting.example.com" },
    }));
    buildIndex(root);
    const row = R["recruiters.list"](ctx).find((r) => r.slug === "acme-recruiting")!;
    expect(row.tracking.status).toBe("replied");
    expect(row.activity.map((e) => e.event)).toContain("Reply received");
    expect(readAgency(root, "acme-recruiting")!.tracking.status).toBe("replied");
  });

  it("attachResume copies one of your resumes into the job's application folder, so a draft can attach it", () => {
    const { ctx, root } = openSample();
    const src = path.join(root, "me", "resumes", "alex-resume.md");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "# Alex Example\n");
    const r = R["recruiters.attachResume"](ctx, "acme-recruiting", "2026-01-12-ai-developer", "me/resumes/alex-resume.md");
    expect(r.rel).toBe("companies/acme-recruiting/jobs/2026-01-12-ai-developer/application/alex-resume.md");
    expect(fs.readFileSync(path.join(root, r.rel), "utf8")).toBe("# Alex Example\n");
    expect(() => R["recruiters.attachResume"](ctx, "acme-recruiting", "2026-01-12-ai-developer", "me/identity/passport.pdf")).toThrow(/Pick one of your resumes/);
  });

  it("agencySlug matches the store's company slug, so an agency and its company folder share one", () => {
    for (const n of ["A & B Talent", "Ácme Recruiting Pty Ltd", "  Example Labs -- Talent  ", "!!!"]) expect(agencySlug(n)).toBe(slugify(n, "company"));
  });

  it("an agency with no saved job: mailbox, a general enquiry with your resume, approval, send, and the timeline", async () => {
    const mail = fakeMailHost({ goodPassword: GOOD_PASSWORD });
    const { ctx, root } = openSample({ mail });
    connectMail(ctx, root);
    mergeAgency(root, { slug: "example-labs-talent", name: "Example Labs Talent", website: "https://talent.example.com",
      contacts: [{ kind: "email", value: at("talent"), source_url: "https://talent.example.com/contact" }] }, null);
    expect(() => R["recruiters.mailbox"](ctx, "no-such-agency")).toThrow(/isn't in this workspace/);
    expect(R["recruiters.mailbox"](ctx, "example-labs-talent")).toEqual({ company_slug: "example-labs-talent" });
    const company = readRecord("company", layout(root).companyFile("example-labs-talent"));
    expect(company).toMatchObject({ name: "Example Labs Talent", website: "https://talent.example.com", type: "recruiter" });
    // A second call leaves an existing company alone.
    updateRecord("company", layout(root).companyFile("example-labs-talent"), (c) => { c.notes = "kept"; });
    R["recruiters.mailbox"](ctx, "example-labs-talent");
    expect(readRecord("company", layout(root).companyFile("example-labs-talent")).notes).toBe("kept");

    const src = path.join(root, "me", "resumes", "alex-resume.md");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "# Alex Example\n");
    const copy = R["recruiters.attachResume"](ctx, "example-labs-talent", "", "me/resumes/alex-resume.md");
    expect(copy.rel).toBe("companies/example-labs-talent/emails/outgoing/alex-resume.md");
    const d = MR["mail.drafts.save"](ctx, "example-labs-talent", "", "", {
      to: at("talent"), cc: "", subject: "Enquiry: Data roles – Alex Example", body: "Hi,\n\nI'm looking for data roles.", attach: [copy.rel], in_reply_to: "", references: [], purpose: "",
    });
    expect(MR["mail.drafts.list"](ctx, "example-labs-talent", "").map((v) => v.draft_id)).toEqual([d.view.draft_id]);
    expect(R["recruiters.list"](ctx).find((r) => r.slug === "example-labs-talent")!.activity.map((e) => e.event)).toContain("Email drafted");
    const approval = MR["mail.drafts.propose"](ctx, "example-labs-talent", "", d.view.draft_id);
    expect(approval.payload).toMatchObject({ company_slug: "example-labs-talent" });
    const done = await AP["approvals.approve"](ctx, approval.id, approvalDigest(readApproval(root, approval.id)));
    expect(done).toMatchObject({ status: "done" });
    expect(mail.fake.sent).toHaveLength(1);
    expect(mail.fake.sent[0]!.envelope.to).toEqual([at("talent")]);
    expect(mail.fake.sent[0]!.raw.toString("latin1")).toContain("filename=alex-resume.md");
    const out = MR["mail.list"](ctx, { company_slug: "example-labs-talent", direction: "out" }).rows;
    expect(out.map((r) => r.subject)).toEqual(["Enquiry: Data roles – Alex Example"]);
    expect(MR["mail.drafts.list"](ctx, "example-labs-talent", "").find((v) => v.draft_id === d.view.draft_id)?.status).toBe("sent");
    expect(fs.existsSync(path.join(root, "companies", "example-labs-talent", "jobs"))).toBe(false);
    const row = R["recruiters.list"](ctx).find((r) => r.slug === "example-labs-talent")!;
    expect(row.activity.map((e) => e.event)).toContain("Email sent");
    expect(row.tracking.contacted_on).not.toBe("");
    expect(validateWorkspace(root).filter((i) => i.file.includes("example-labs-talent"))).toEqual([]);
  });

  it("gives Find recruiters the roles, cities and known agencies, and merges through the store", () => {
    const root = sampleCopy();
    const ctx = webContext(root, "find_recruiters", { kind: "workspace" }, new Date("2026-10-15T00:00:00Z"));
    expect(ctx).toMatch(/Target roles: /);
    expect(ctx).toMatch(/Agencies already saved \(add to them rather than repeat them\): Acme Recruiting/);
    mergeAgency(root, { slug: "acme-recruiting", name: "Acme Recruiting", cities: ["Exampleville"] }, null);
    expect(readAgency(root, "acme-recruiting")!.cities).toEqual(["Sampletown", "Exampleville"]);
    fs.writeFileSync(path.join(layout(root).recruitersDir, "acme-recruiting", "agency.json"), "{ broken");
    expect(readAgency(root, "acme-recruiting")).toBeNull();
    expect(validateWorkspace(root).some((i) => i.file.startsWith("recruiters"))).toBe(true);
  });
});
