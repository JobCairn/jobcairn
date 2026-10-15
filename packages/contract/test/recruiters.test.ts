import { describe, expect, it } from "vitest";
import {
  ACTIONS, actionsFor, adContacts, addBusinessDays, agencyActivity, agencyFacets, recruiterEmailDraft, sponsorshipLine, agencyPatchArgs, applyAgencyPatch, buildActionPrompt, buildAgencyRows, cleanAgencyInput,
  filterAgencies, PUBLISHED_CONTACT_RULES, type AgencyRecordView, type JobRow,
} from "../src/index.js";

// Built by concatenation so the privacy scan stays meaningful.
const at = (local: string) => local + "@" + "example.com";
const SRC = "https://recruiting.example.com/contact";
const PHONE = "0491 570 " + "006";

const record = (over: Partial<AgencyRecordView> = {}): AgencyRecordView => ({
  name: "Acme Recruiting", slug: "acme-recruiting", website: "", since: null, specialties: [], tags: [], cities: [], hiring_summary: "", about_url: "",
  city_links: [], linkedin_url: "", team_note: { text: "", source_url: "" }, best_contact: { name: "", source_url: "" }, contacts: [], people: [], job_refs: [],
  favourite: false, tracking: { status: "to_contact", contacted_on: "", follow_up_on: "", notes: "" }, timeline: [], ...over,
});
const job = (id: string, over: Partial<JobRow> = {}): JobRow => ({
  company_slug: "acme-recruiting", id, company_name: "Acme Recruiting", client: null, title: "AI Developer", location: "Sampletown", work_mode: "", salary_text: "",
  salary_min: null, salary_max: null, wr_label: "silent", fit: null, sponsor: null, status: "Found", source: "pasted", source_site: "", posted: "", found_at: "",
  eligible: true, pinned: false, last_activity: "", job_type: "Contract", ...over,
});

describe("cleanAgencyInput", () => {
  it("keeps published, sourced details and names everything it drops", () => {
    const { agency, dropped } = cleanAgencyInput({
      name: "Acme Recruiting", website: "https://recruiting.example.com", since: 2009, tags: ["IT specialist", "it specialist", "AI"],
      linkedin_url: "https://www.linkedin.com/in/a-recruiter",
      contacts: [
        { kind: "email", value: at("Jobs"), source_url: SRC, confirmed: true },
        { kind: "email", value: "jobs at example", source_url: SRC },
        { kind: "email", value: at("hr"), source_url: "http://recruiting.example.com" },
        { kind: "phone", value: PHONE, source_url: SRC },
        { kind: "phone", value: "call us", source_url: SRC },
      ],
      people: [{ name: "Alex Example", title: "Lead", source_url: "https://recruiting.example.com/team" }, { name: "No Source" }],
      team_note: { text: "Team page names a lead.", source_url: "javascript:x" },
      best_contact: { name: "Alex Example", source_url: "https://recruiting.example.com/team" },
    }, "2026-10-15");
    expect(agency).toMatchObject({ slug: "acme-recruiting", since: 2009, tags: ["IT specialist", "AI"], linkedin_url: "", team_note: { text: "", source_url: "" } });
    expect(agency.contacts).toEqual([
      { kind: "email", value: at("jobs"), label: "", source_url: SRC, found_on: "2026-10-15", confirmed: true },
      { kind: "phone", value: PHONE, label: "", source_url: SRC, found_on: "2026-10-15", confirmed: false },
    ]);
    expect(agency.people.map((p) => p.name)).toEqual(["Alex Example"]);
    expect(agency.best_contact.name).toBe("Alex Example");
    expect(dropped).toHaveLength(6);
    expect(dropped.join("\n")).toMatch(/linkedin_url: only the agency's own company page/);
    expect(() => cleanAgencyInput({ website: "https://x.example.com" })).toThrow(/name is required/);
  });
});

describe("adContacts", () => {
  it("takes the emails, phone numbers and contact name an ad publishes, with the ad as source", () => {
    const text = `Great role.\nContact Alex Example on ${PHONE} or ${at("alex")}. Apply now.`;
    const r = adContacts(text, "https://jobs.example.com/rec/3", "2026-10-15");
    expect(r.person).toBe("Alex Example");
    expect(r.contacts.map((c) => [c.kind, c.value, c.source_url])).toEqual([["email", at("alex"), "https://jobs.example.com/rec/3"], ["phone", PHONE, "https://jobs.example.com/rec/3"]]);
    expect(adContacts(text, "http://jobs.example.com/rec/3").contacts).toEqual([]);
    expect(adContacts("Contact us today.", "https://jobs.example.com/x")).toEqual({ contacts: [], person: "" });
  });
});

describe("tracking", () => {
  it("counts business days, skipping weekends", () => {
    expect(addBusinessDays("2026-10-15", 5)).toBe("2026-10-22"); // Thursday -> next Thursday
    expect(addBusinessDays("2026-10-16", 1)).toBe("2026-10-19"); // Friday -> Monday
    expect(addBusinessDays("nope", 5)).toBe("");
  });
  it("a contacted date sets the follow-up and the status, unless the person set them", () => {
    const a = record();
    expect(applyAgencyPatch(a, { contacted_on: "2026-10-15" }).map((e) => e.event)).toEqual(["Contacted"]);
    expect(applyAgencyPatch(a, { notes: "Spoke to Pat" })).toEqual([{ event: "Notes updated", note: "Spoke to Pat" }]);
    expect(a.tracking).toMatchObject({ status: "contacted", contacted_on: "2026-10-15", follow_up_on: "2026-10-22" });
    const b = record({ tracking: { status: "meeting", contacted_on: "", follow_up_on: "2026-11-01", notes: "" } });
    applyAgencyPatch(b, { contacted_on: "2026-10-15" });
    expect(b.tracking).toMatchObject({ status: "meeting", follow_up_on: "2026-11-01" });
  });
  it("checks patches from the renderer", () => {
    expect(agencyPatchArgs({ status: "replied", notes: "Spoke to them", favourite: true })).toEqual({ status: "replied", notes: "Spoke to them", favourite: true });
    expect(() => agencyPatchArgs({ status: "ghosted" })).toThrow();
    expect(() => agencyPatchArgs({ contacted_on: "15/10/2026" })).toThrow();
    expect(() => agencyPatchArgs({ email: at("x") })).toThrow(/isn't allowed/);
  });
});

describe("cards", () => {
  it("adds jobs, sponsorship signal and job-type tags, and filters by search, tag, city and sponsorship", () => {
    const rows = buildAgencyRows([
      record({ tags: ["AI"], cities: ["Sampletown"], job_refs: ["acme-recruiting/a", "acme-recruiting/b"], contacts: [{ kind: "email", value: at("jobs"), label: "", source_url: SRC, found_on: "", confirmed: true }] }),
      record({ name: "Example Labs Talent", slug: "example-labs-talent", favourite: true, cities: ["Exampleville"] }),
    ], [job("a", { wr_label: "sponsorship_offered" }), job("b", { status: "Rejected", title: "Data Engineer" })]);
    expect(rows.map((r) => r.slug)).toEqual(["example-labs-talent", "acme-recruiting"]);
    const acme = rows[1]!;
    expect(acme).toMatchObject({ all_tags: ["AI", "Contract"], sponsor_jobs: 1, email: at("jobs") });
    expect(acme.jobs.map((j) => [j.id, j.open])).toEqual([["a", true], ["b", false]]);
    expect(agencyFacets(rows)).toEqual({ tags: ["AI", "Contract"], cities: ["Exampleville", "Sampletown"] });
    expect(filterAgencies(rows, { q: "data engineer" }).map((r) => r.slug)).toEqual(["acme-recruiting"]);
    expect(filterAgencies(rows, { tag: "contract" }).map((r) => r.slug)).toEqual(["acme-recruiting"]);
    expect(filterAgencies(rows, { city: "Exampleville" }).map((r) => r.slug)).toEqual(["example-labs-talent"]);
    expect(filterAgencies(rows, { sponsor: true }).map((r) => r.slug)).toEqual(["acme-recruiting"]);
  });
});

describe("find_recruiters", () => {
  it("is a Recruiters-only web action whose prompt carries the published-contact rules", () => {
    expect(ACTIONS.find_recruiters).toMatchObject({ target: "workspace", surface: "recruiters" });
    expect(actionsFor("workspace")).not.toContain("find_recruiters");
    const p = buildActionPrompt("find_recruiters", { kind: "workspace" }, { now: "2026-10-15T00:00:00.000Z" });
    for (const r of PUBLISHED_CONTACT_RULES) expect(p).toContain(r);
    expect(p).toContain("recruiter_add");
    expect(p).toContain("- knowledge/recruiter-searches/2026-10-15.md");
    expect(p.indexOf(PUBLISHED_CONTACT_RULES[0])).toBeGreaterThan(p.indexOf("Rules:"));
  });
});

describe("outreach", () => {
  const acme = () => record({
    website: "https://recruiting.example.com",
    contacts: [{ kind: "email", value: at("jobs"), label: "", source_url: SRC, found_on: "", confirmed: true }],
    timeline: [{ at: "2026-10-01T00:00:00.000Z", event: "Found by Claude", note: "" }],
  });
  const sent = { to: `Acme Recruiting <${at("jobs")}>`, subject: "AI Developer – Alex Example", status: "sent", updated: "2026-10-10T01:00:00.000Z" };

  it("builds the timeline from drafts to its addresses, replies from its address or domain, and a due follow-up", () => {
    const { events, patch } = agencyActivity(acme(), [sent, { ...sent, to: "someone.else" + "@" + "example.org", subject: "Other" }],
      [{ from: "Pat <pat" + "@" + "recruiting.example.com>", date: "2026-10-12T00:00:00.000Z", subject: "Re: AI Developer" }, { from: "stranger" + "@" + "example.org", date: "2026-10-12T00:00:00.000Z", subject: "Spam" }], "2026-10-15");
    expect(events.map((e) => e.event)).toEqual(["Reply received", "Email sent", "Found by Claude"]);
    // The sent email sets the contacted date; the reply after it sets Replied.
    expect(patch).toEqual({ contacted_on: "2026-10-10", status: "replied" });
  });

  it("matches web mail only by exact address, and shows a follow-up that is due", () => {
    const a = record({ contacts: [{ kind: "email", value: "acme.jobs" + "@" + "gmail.com", label: "", source_url: SRC, found_on: "", confirmed: true }],
      tracking: { status: "contacted", contacted_on: "2026-10-01", follow_up_on: "2026-10-08", notes: "" } });
    const r = agencyActivity(a, [], [{ from: "someone" + "@" + "gmail.com", date: "2026-10-09", subject: "Hi" }], "2026-10-15");
    expect(r.events.map((e) => e.event)).toEqual(["Follow-up due"]);
    expect(r.patch).toBeNull();
    // An address's domain never widens the match: only the agency's own website domain does.
    const b = record({ contacts: [{ kind: "email", value: at("jobs"), label: "", source_url: SRC, found_on: "", confirmed: true }], tracking: { status: "contacted", contacted_on: "2026-10-01", follow_up_on: "", notes: "" } });
    expect(agencyActivity(b, [], [{ from: at("someone"), date: "2026-10-09", subject: "Hi" }], "2026-10-15").patch).toBeNull();
  });

  it("writes the template: role or enquiry subject, profile intro, sponsorship question only when asked", () => {
    const me = { name: "Alex Example", roles: ["AI Engineer"], seniority: "Mid-level", cities: ["Sampletown"], visa_subclass: "485" };
    const agency = { name: "Acme Recruiting", specialties: ["Technology"], best_contact: { name: "Pat Example", source_url: SRC } };
    const job = recruiterEmailDraft({ me, agency, job: { title: "AI Developer", location: "Sampletown" }, sponsorship: true, attached: true });
    expect(job.subject).toBe("AI Developer – Alex Example");
    expect(job.body).toContain("Hi Pat,");
    expect(job.body).toContain("I'm Alex Example, a Mid-level AI Engineer based in Sampletown. I'm interested in the AI Developer role you advertised in Sampletown");
    expect(job.body).toContain("I hold a subclass 485 visa and would need sponsorship. Do your clients sponsor for these roles?");
    expect(job.body).toContain("My resume is attached.");
    const general = recruiterEmailDraft({ me, agency: { ...agency, best_contact: { name: "", source_url: "" } }, job: null, sponsorship: false, attached: false });
    expect(general.subject).toBe("Enquiry: Technology roles – Alex Example");
    expect(general.body).not.toMatch(/sponsor/i);
    expect(general.body.endsWith("Regards,\nAlex")).toBe(true);
    expect(sponsorshipLine("")).toBe("I hold a temporary visa and would need sponsorship. Do your clients sponsor for these roles?");
  });
});
