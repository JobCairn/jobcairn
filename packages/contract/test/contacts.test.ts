import { describe, expect, it } from "vitest";
import {
  ACTIONS, actionStatusView, buildActionPrompt, CONTACTS_RULES, defaultOptions, hasContacts, isPlainEmail, parseCompanyContacts,
  readCompanyContacts,
} from "../src/index.js";

// Built by concatenation so the privacy scan stays meaningful.
const at = (local: string) => local + "@" + "example.com";
const SRC = "https://acme.example.com/careers";
const ACME = { kind: "company", company_slug: "acme-corp" } as const;

describe("isPlainEmail", () => {
  it("takes plain role addresses and refuses anything else", () => {
    for (const ok of [at("careers"), at("talent.acquisition"), at("hr+jobs")]) expect(isPlainEmail(ok)).toBe(true);
    for (const bad of ["careers", "careers@", "@example.com", "a b" + "@" + "example.com", "careers@localhost", at(".careers"), at("a..b"),
      "\"x\"" + "@" + "example.com", "Acme <" + at("hr") + ">", 42, null]) expect(isPlainEmail(bad)).toBe(false);
  });
});

describe("parseCompanyContacts", () => {
  it("keeps sourced entries and drops bad addresses, missing sources and non-https sources", () => {
    const c = parseCompanyContacts({
      careers_url: SRC, ats_board_url: "https://boards.example.com/acme",
      emails: [
        { address: at("Careers"), kind: "careers", source_url: SRC, found_on: "2026-10-01", confirmed: true },
        { address: "not-an-email", kind: "hr", source_url: SRC },
        { address: at("hr"), kind: "hr" },
        { address: at("press"), kind: "press", source_url: "http://acme.example.com/press" },
        { address: at("jobs"), kind: "recruiting", source_url: "javascript:alert(1)" },
        { address: at("careers"), kind: "careers", source_url: SRC },
        { address: at("hello"), kind: "nonsense", source_url: SRC, found_on: "yesterday" },
      ],
      phone: "+61 7 0000 0000", linkedin_url: "https://evil.example.com/company/acme", notes: "Apply through the board.", extra: "ignored",
    })!;
    expect(c.emails).toEqual([
      { address: at("careers"), kind: "careers", source_url: SRC, found_on: "2026-10-01", confirmed: true },
      { address: at("hello"), kind: "other", source_url: SRC, found_on: "", confirmed: false },
    ]);
    expect(c.dropped).toBe(5);
    expect(c).toMatchObject({ careers_url: SRC, ats_board_url: "https://boards.example.com/acme", phone: "+61 7 0000 0000", linkedin_url: "", notes: "Apply through the board." });
  });

  it("blanks links that aren't plain https and keeps a LinkedIn company page", () => {
    const c = parseCompanyContacts({ careers_url: "http://acme.example.com", ats_board_url: "ftp://x", linkedin_url: "https://www.linkedin.com/company/acme", phone: "call us" })!;
    expect(c).toMatchObject({ careers_url: "", ats_board_url: "", linkedin_url: "https://www.linkedin.com/company/acme", phone: "", emails: [] });
    expect(hasContacts(c)).toBe(true);
    expect(hasContacts(parseCompanyContacts({}))).toBe(false);
    expect(parseCompanyContacts({ linkedin_url: "https://www.linkedin.com/in/someone" })!.linkedin_url).toBe("");
  });

  it("is tolerant: missing, not JSON, not an object or too big all mean no contacts", () => {
    for (const t of [null, undefined, "", "{", "[]", "\"x\"", "null", "x".repeat(70_000)]) expect(readCompanyContacts(t)).toBeNull();
    expect(readCompanyContacts("﻿{\"careers_url\": \"" + SRC + "\"}")).toMatchObject({ careers_url: SRC });
  });
});

describe("research_company contacts", () => {
  const prompt = (focus?: string[]) => buildActionPrompt("research_company", ACME, { company: "Acme Corp" },
    focus ? { options: { ...defaultOptions("research_company"), focus }, note: "" } : undefined, "0123456789abcdef");

  it("is on by default and asks for contacts.json with the published-only rules", () => {
    expect(defaultOptions("research_company").focus).toContain("contacts");
    for (const p of [prompt(), prompt(defaultOptions("research_company").focus as string[])]) {
      expect(p).toContain("Write them to contacts.json");
      expect(p).toContain("- companies/acme-corp/contacts.json");
      for (const r of CONTACTS_RULES) expect(p).toContain(r);
      expect(p).toMatch(/never guess or construct an address/);
      expect(p.indexOf(CONTACTS_RULES[0])).toBeGreaterThan(p.indexOf("Rules:"));
    }
  });

  it("leaves contacts out when the chip is off", () => {
    const p = prompt(["tech_stack"]);
    expect(p).not.toContain("contacts.json");
    expect(p).not.toContain(CONTACTS_RULES[0]);
  });

  it("counts research as done without contacts.json", () => {
    expect(ACTIONS.research_company.outputs).toEqual(["{folder}/research.md"]);
    const v = actionStatusView({
      id: "research_company", target: ACME, info: {}, requested_at: "", now: new Date("2026-10-15T00:00:00Z"),
      probe: (rel) => ({ exists: rel.endsWith("research.md"), at: "2026-10-14T00:00:00Z" }),
    });
    expect(v.status).toBe("ready");
  });
});
