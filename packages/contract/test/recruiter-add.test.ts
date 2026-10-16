import { describe, expect, it } from "vitest";
import {
  ADDED_BY_YOU, addRecruiterArgs, agencyActivity, agencyAddresses, agencyThreads, ArgError, buildActionPrompt, PUBLISHED_CONTACT_RULES, parseAgencyLines,
  RECRUITER_SEARCH_RULE, type AgencyRecordView, type DraftView, type MailRow,
} from "../src/index.js";

// Built by concatenation so the privacy scan stays meaningful.
const at = (local: string, domain = "example.com") => local + "@" + domain;
const SITE = "https://acmerecruiting.example.com";

describe("Add recruiter: one agency", () => {
  it("takes a website: the stand-in name comes from its host, and the source is Added by you", () => {
    const a = addRecruiterArgs({ text: `${SITE}/about-us` }, "2026-10-17");
    expect(a).toMatchObject({ name: "Acmerecruiting", slug: "acmerecruiting", website: SITE, rename: true, contacts: [] });
    expect(a.sources).toEqual([{ name: ADDED_BY_YOU, url: `${SITE}/about-us` }]);
  });

  it("a bare site and a name work too, and a name given wins", () => {
    expect(addRecruiterArgs({ text: "acmerecruiting.example.com", name: "Acme Recruiting" })).toMatchObject({ name: "Acme Recruiting", slug: "acme-recruiting", website: SITE, rename: false });
  });

  it("a job board link is the source, named after the board, never the website, and needs a name", () => {
    const ad = "https://www.seek.com.au/job/12345678";
    expect(() => addRecruiterArgs({ text: ad })).toThrow(/SEEK ad\. Add the agency's name/);
    const a = addRecruiterArgs({ text: ad, name: "Acme Recruiting" });
    expect(a.website).toBe("");
    expect(a.sources).toEqual([{ name: "SEEK", url: ad }]);
  });

  it("a name with details and an email keeps the email as your own contact, with no page", () => {
    const a = addRecruiterArgs({ text: `Acme Recruiting\nTalked to Sam at the expo. ${at("sam", "acmerecruiting.example.com")}` }, "2026-10-17");
    expect(a.name).toBe("Acme Recruiting");
    expect(a.website).toBe("");
    expect(a.contacts).toEqual([{ kind: "email", value: at("sam", "acmerecruiting.example.com"), label: ADDED_BY_YOU, source_url: "", found_on: "2026-10-17", confirmed: false }]);
    expect(a.sources).toEqual([{ name: ADDED_BY_YOU, url: "" }]);
  });

  it("refuses an empty box", () => {
    expect(() => addRecruiterArgs({ text: "  " })).toThrow(ArgError);
  });
});

describe("Add recruiter: a list", () => {
  it("reads name, website and email per line, skips a header and blank lines, and says why a line was left out", () => {
    const text = [
      "Name,Website,Email",
      `Acme Recruiting, acmerecruiting.example.com, ${at("jobs", "acmerecruiting.example.com")}`,
      "",
      "\"Example Labs, Talent\",https://examplelabs.example.org",
      "https://www.seek.com.au/job/1",
      `Sample Staffing,,${at("hello", "example.net")}`,
      "Bad Site, not a site at all, also bad",
    ].join("\n");
    const { rows, skipped } = parseAgencyLines(text, "2026-10-17");
    expect(rows.map((r) => [r.line, r.name, r.website, r.contacts.map((c) => c.value)])).toEqual([
      [2, "Acme Recruiting", SITE, [at("jobs", "acmerecruiting.example.com")]],
      [4, "Example Labs, Talent", "https://examplelabs.example.org", []],
      [6, "Sample Staffing", "", [at("hello", "example.net")]],
    ]);
    expect(skipped.map((s) => s.line)).toEqual([5, 7]);
  });
});

describe("recruiter mail", () => {
  const agency = (over: Partial<AgencyRecordView> = {}): AgencyRecordView => ({
    name: "Acme Recruiting", slug: "acme-recruiting", website: SITE, since: null, specialties: [], tags: [], cities: [], hiring_summary: "", about_url: "",
    city_links: [], linkedin_url: "", team_note: { text: "", source_url: "" }, best_contact: { name: "", source_url: "" }, contacts: [], people: [], job_refs: [],
    favourite: false, tracking: { status: "contacted", contacted_on: "2026-10-01", follow_up_on: "", notes: "" }, timeline: [], ...over,
  });

  it("linked addresses match exactly and linked domains with their subdomains", () => {
    const m = agencyAddresses(agency({ email_match: [at("sam.recruiter", "gmail.com"), "acme-talent.example.net"] }));
    expect([...m.addresses]).toEqual([at("sam.recruiter", "gmail.com")]);
    expect([...m.domains].sort()).toEqual(["acme-talent.example.net", "acmerecruiting.example.com"]);
  });

  it("a reply from a linked address shows on the timeline, linking to Emails, and sets Replied", () => {
    const r = agencyActivity(agency({ email_match: [at("sam.recruiter", "gmail.com")] }), [], [{ from: at("sam.recruiter", "gmail.com"), date: "2026-10-05T01:00:00Z", subject: "Re: roles" }], "2026-10-17");
    expect(r.events[0]).toEqual({ at: "2026-10-05T01:00:00Z", event: "Reply received", note: "Re: roles", tab: "emails" });
    expect(r.patch).toEqual({ status: "replied" });
  });

  it("groups the conversation by thread, oldest first inside, newest thread first, and Reply answers the newest received", () => {
    const row = (ref: string, direction: "in" | "out", date: string, subject: string, thread: string): MailRow => ({
      ref, company_slug: "acme-recruiting", company_name: "Acme Recruiting", job_id: "", job_title: "", direction, date, subject,
      from: direction === "in" ? { name: "Sam", address: at("sam", "acmerecruiting.example.com") } : { name: "Alex", address: at("alex") }, thread_key: thread,
      attachments: 0, opened: true, matched_by: "domain",
    });
    const draft = (draft_id: string, subject: string, status: DraftView["status"], updated: string): DraftView => ({
      draft_id, company_slug: "acme-recruiting", id: "", company_name: "", job_title: "", rel: "", subject, to: at("sam", "acmerecruiting.example.com"), status, updated, approval_id: "", note: "",
    });
    const out = agencyThreads([
      row("m2", "in", "2026-10-03T00:00:00Z", "Re: Data roles", "t1"),
      { ...row("m1", "out", "2026-10-02T00:00:00Z", "Data roles", "t1"), to: [{ name: "", address: at("sam", "acmerecruiting.example.com") }] },
      row("m3", "in", "2026-10-01T00:00:00Z", "Contract role", "t2"),
    ], [draft("d1", "Re: Data roles", "draft", "2026-10-04T00:00:00Z"), draft("d0", "Data roles", "sent", "2026-10-02T00:00:00Z")]);
    expect(out.threads.map((t) => t.messages.map((m) => m.ref || m.draft_id))).toEqual([["m1", "m2", "d1"], ["m3"]]);
    expect(out.threads[0]!.messages[0]!.who.address).toBe(at("sam", "acmerecruiting.example.com"));
    expect(out.total).toBe(4);
    expect(out.latest_in).toBe("m2");
  });
});

describe("Check recruiters", () => {
  it("is a web run with the published-contact and read-only rules", () => {
    const p = buildActionPrompt("check_recruiters", { kind: "workspace" }, { now: "2026-10-17T00:00:00Z" });
    for (const r of [...PUBLISHED_CONTACT_RULES, RECRUITER_SEARCH_RULE]) expect(p).toContain(r);
    expect(p).toContain("knowledge/recruiter-checks/");
    expect(p).toContain("recruiter_add");
  });
});
