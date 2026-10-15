import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout, updateRecord } from "@careeros/core";
import { buildCompanyRows, nameSlug } from "@careeros/contract";
import { companyContacts, companyHandlers as C } from "../src/companies.js";
import { openSample } from "./helpers.js";

describe("companies read model", () => {
  it("lists every company with its jobs, fit, stage and last activity", () => {
    const { ctx } = openSample();
    const rows = C["companies.list"](ctx);
    expect(rows.map((r) => r.name)).toEqual(["Acme Corp", "Acme Recruiting", "Example Labs"]);
    const acme = rows[0]!;
    expect(acme).toMatchObject({ key: "acme-corp", slug: "acme-corp", jobs: 1, open_jobs: 1 });
    expect(acme.stage).not.toBeNull();
    expect(acme.last_activity).not.toBe("");
    expect(typeof acme.sponsor.score).toBe("number");
  });

  it("adds list-only employers with a name key that never shadows a folder", () => {
    const { ctx, root } = openSample();
    updateRecord("sponsors", layout(root).sponsors, (s) => {
      s.employers = [{ name: "Acme Overseas", aliases: [], status: "verified", evidence: [], last_checked: "2026-10-08" }];
    });
    const row = C["companies.list"](ctx).find((r) => r.name === "Acme Overseas")!;
    expect(row).toMatchObject({ key: "acme-overseas", slug: null, jobs: 0, stage: null, mail: 0 });
    const d = C["companies.get"](ctx, "acme-overseas");
    expect(d).toMatchObject({ jobs: [], files: [], timeline: [] });
  });

  it("opens one company: jobs, locations, research files and a newest-first timeline", () => {
    const { ctx, root } = openSample();
    const dir = layout(root).companyDir("acme-corp");
    fs.writeFileSync(path.join(dir, "research.md"), "# Acme Corp\n");
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes", "call.md"), "Call notes\n");
    fs.writeFileSync(path.join(dir, ".hidden"), "x");
    const d = C["companies.get"](ctx, "acme-corp");
    expect(d.company.name).toBe("Acme Corp");
    expect(d.jobs).toHaveLength(1);
    expect(d.files.map((f) => f.rel)).toEqual(["companies/acme-corp/notes/call.md", "companies/acme-corp/research.md"]);
    expect(d.files.find((f) => f.path === "research.md")).toMatchObject({ label: "Company research", kind: "markdown" });
    const at = d.timeline.map((e) => e.at);
    expect([...at].sort().reverse()).toEqual(at);
    expect(d.timeline[0]).toMatchObject({ job_id: d.jobs[0]!.id });
  });

  it("reads the published contacts from contacts.json and keeps the file out of Research", () => {
    const { ctx } = openSample();
    const d = C["companies.get"](ctx, "acme-corp");
    expect(d.contacts?.careers_url).toBe("https://acme.example.com/careers");
    expect(d.contacts?.emails.map((e) => e.address)).toContain("careers" + "@" + "example.com");
    expect(d.files.map((f) => f.path)).not.toContain("contacts.json");
    expect(C["companies.get"](ctx, "example-labs").contacts).toBeNull();
  });

  it("treats a broken, oversized or symlinked contacts.json as no contacts, and drops bad entries", () => {
    const { ctx, root } = openSample();
    const file = path.join(layout(root).companyDir("acme-corp"), "contacts.json");
    fs.writeFileSync(file, "{ not json");
    expect(companyContacts(root, "acme-corp")).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ notes: "x".repeat(70_000) }));
    expect(companyContacts(root, "acme-corp")).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ emails: [{ address: "hr" + "@" + "example.com", kind: "hr", source_url: "http://acme.example.com" }] }));
    expect(C["companies.get"](ctx, "acme-corp").contacts).toMatchObject({ emails: [], dropped: 1 });
    fs.rmSync(file);
    const outside = path.join(root, "..", `outside-${Date.now()}.json`);
    fs.writeFileSync(outside, JSON.stringify({ careers_url: "https://acme.example.com/careers" }));
    fs.symlinkSync(outside, file);
    expect(companyContacts(root, "acme-corp")).toBeNull();
  });

  it("refuses a company that isn't there", () => {
    const { ctx } = openSample();
    expect(() => C["companies.get"](ctx, "no-such-company")).toThrow(/isn't in this workspace/);
  });

  it("skips a symlinked file in the company folder", () => {
    const { ctx, root } = openSample();
    const outside = path.join(root, "..", `outside-${Date.now()}.md`);
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(layout(root).companyDir("acme-corp"), "link.md"));
    expect(C["companies.get"](ctx, "acme-corp").files.map((f) => f.path)).not.toContain("link.md");
  });
});

describe("buildCompanyRows", () => {
  it("makes route-safe keys and de-duplicates list-only names", () => {
    expect(nameSlug("Example Labs Pty. Ltd.")).toBe("example-labs-pty-ltd");
    expect(nameSlug("!!!")).toBe("company");
    const base = { status: "unknown" as const, evidence: [], last_checked: "", score: 20, score_tier: "Low", score_reasons: [], jobs: 0, open_jobs: 0, job_refs: [], aliases: [], qld: null, ai_relevance: "" };
    const rows = buildCompanyRows(
      [{ ...base, name: "Acme", slug: "acme" }, { ...base, name: "Acme", slug: null }, { ...base, name: "ACME", slug: null }],
      [{ slug: "acme", name: "Acme", website: "https://acme.example.com" }], [], [{ company_slug: "acme", count: 2, last: "2026-10-01T00:00:00Z" }],
    );
    expect(rows.map((r) => r.key).sort()).toEqual(["acme", "acme-2", "acme-3"]);
    expect(rows.find((r) => r.slug === "acme")).toMatchObject({ website: "https://acme.example.com", mail: 2, last_activity: "2026-10-01T00:00:00Z" });
  });
});
