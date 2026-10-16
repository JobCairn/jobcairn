import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initWorkspace, layout, mergeAgency, readRecord } from "@careeros/core";
import { FakeMailProvider } from "../src/fake.js";
import { linkableDomain, matchMessage, suggestCompany, type CompanyInfo, type HeaderInfo } from "../src/match.js";
import { listTriage } from "../src/store.js";
import { companyIndex, syncMail, withAgencies } from "../src/sync.js";
import { addr, ALEX, rawMessage } from "../src/testing.js";

// Recruiter mail (spec 2026-10-17-add-recruiter-and-mail). Addresses built by concatenation for the privacy scan.
const at = (local: string, domain: string) => local + "@" + domain;
const NOW = new Date("2026-10-17T09:00:00.000Z");
const head = (from: string, subject = "Catching up"): HeaderInfo => ({ direction: "in", from: { name: "", address: from }, to: [{ name: "", address: ALEX }], cc: [], subject });

const agency = (over: Record<string, unknown> = {}) => ({
  schema: 1, name: "Acme Recruiting", slug: "acme-recruiting", website: "https://www.acmerecruiting.example.com", since: null, specialties: [], tags: [], cities: [],
  hiring_summary: "", about_url: "", city_links: [], linkedin_url: "", team_note: { text: "", source_url: "" }, best_contact: { name: "", source_url: "" },
  contacts: [{ kind: "email" as const, value: at("jobs", "acme-mail.example.net"), label: "", source_url: "https://acmerecruiting.example.com/contact", found_on: "", confirmed: true }],
  people: [], job_refs: [], sources: [], email_match: [] as string[], needs_check: false, favourite: false,
  tracking: { status: "to_contact" as const, contacted_on: "", follow_up_on: "", notes: "" }, timeline: [], custom: {}, ...over,
});

describe("agencies in the company index", () => {
  it("matches an agency by its website's domain, a published address exactly, and the addresses and domains you linked", () => {
    const idx = withAgencies([], [agency({ email_match: [at("sam.r", "gmail.com"), "acme-talent.example.org"] })] as never);
    expect(idx[0]).toMatchObject({ slug: "acme-recruiting", agency_only: true });
    expect(matchMessage(head(at("sam", "mail.acmerecruiting.example.com")), idx)).toMatchObject({ company_slug: "acme-recruiting", matched_by: "domain" });
    expect(matchMessage(head(at("jobs", "acme-mail.example.net")), idx)).toMatchObject({ company_slug: "acme-recruiting", matched_by: "email_match" });
    // A published address never widens to its domain.
    expect(matchMessage(head(at("someone", "acme-mail.example.net")), idx)).toBeNull();
    expect(matchMessage(head(at("sam.r", "gmail.com")), idx)).toMatchObject({ company_slug: "acme-recruiting" });
    expect(matchMessage(head(at("other", "gmail.com")), idx)).toBeNull();
    expect(matchMessage(head(at("kim", "acme-talent.example.org")), idx)).toMatchObject({ company_slug: "acme-recruiting", matched_by: "email_match" });
  });

  it("a free-mail or job-board domain in a match list never files a whole domain", () => {
    const c: CompanyInfo = { slug: "acme-corp", name: "Acme Corp", aliases: [], website: "", recruiter_email: "", email_match: ["gmail.com", "seek.com.au"], jobs: [] };
    expect(matchMessage(head(at("anyone", "gmail.com")), [c])).toBeNull();
    expect(linkableDomain("gmail.com")).toBe(false);
    expect(linkableDomain(at("x", "outlook.com.au"))).toBe(false);
    expect(linkableDomain("seek.com.au")).toBe(false);
    expect(linkableDomain(at("x", "acmerecruiting.example.com"))).toBe(true);
  });

  it("an agency is never matched or suggested by its name in a subject", () => {
    const idx = withAgencies([], [agency()] as never);
    expect(matchMessage(head(at("alerts", "jobs.example.org"), "New roles at Acme Recruiting"), idx)).toBeNull();
    expect(suggestCompany(head(at("x", "acmerecruiting-news.example.org"), "Acme Recruiting"), idx)).toBeNull();
  });

  it("folds an agency into its company of the same slug instead of adding a second entry", () => {
    const company: CompanyInfo = { slug: "acme-recruiting", name: "Acme Recruiting", aliases: [], website: "", recruiter_email: "", email_match: [], jobs: [] };
    const idx = withAgencies([company], [agency({ email_match: ["acme-talent.example.org"] })] as never);
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatchObject({ website: "https://www.acmerecruiting.example.com", email_match: [at("jobs", "acme-mail.example.net"), "acme-talent.example.org"] });
    expect(idx[0]!.agency_only).toBeUndefined();
  });
});

describe("syncing an agency's mail", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it("files mail from an agency with no company folder under it, making the folder; personal mail stays out", async () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-agency-")));
    dirs.push(tmp);
    const root = path.join(tmp, "ws");
    initWorkspace(root, { now: NOW });
    mergeAgency(root, { slug: "acme-recruiting", name: "Acme Recruiting", website: "https://acmerecruiting.example.com", email_match: [at("sam.r", "gmail.com")] }, null);
    expect(companyIndex(root).find((c) => c.slug === "acme-recruiting")?.agency_only).toBe(true);
    const provider = new FakeMailProvider();
    provider.add("inbox", rawMessage({ id: "a1", from: addr("sam.r", "gmail.com"), subject: "Quick chat about data roles" }));
    provider.add("inbox", rawMessage({ id: "a2", from: addr("kim", "acmerecruiting.example.com"), subject: "Hello" }));
    provider.add("inbox", rawMessage({ id: "p1", from: addr("mum", "example.net"), subject: "Dinner on Sunday?" }));
    const r = await syncMail({ root, provider, account: ALEX, now: NOW, firstSyncDays: 400, lockFile: path.join(tmp, "lock") });
    expect(r).toMatchObject({ stored: 2, triaged: 0, skipped: 1, error: "" });
    const company = readRecord("company", layout(root).companyFile("acme-recruiting"));
    expect(company).toMatchObject({ name: "Acme Recruiting", type: "recruiter" });
    expect(fs.readdirSync(layout(root).companyEmailsDir("acme-recruiting")).filter((n) => n.endsWith(".json"))).toHaveLength(2);
    expect(listTriage(root)).toHaveLength(0);
  });
});
