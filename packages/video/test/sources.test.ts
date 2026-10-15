import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildIndex, openIndex } from "@careeros/core";
import { buildSourcePack, candidateTerms, doNotClaim } from "../src/sources.js";
import { isoWeek, weekRange, weekStats } from "../src/stats.js";
import { ACME_JOB, RESEARCH, seedAcme, typeOf } from "./fixtures.js";
import { FIXED, sampleCopy } from "./helpers.js";

const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
const pack = (root: string, type: string, subject: Parameters<typeof buildSourcePack>[0]["subject"] = JOB, folder = `${ACME_JOB}/videos/x-1`) =>
  buildSourcePack({ root, type: typeOf(type), subject, folder, clock: { now: FIXED } });

describe("weeks", () => {
  it("numbers weeks the ISO way", () => {
    expect(isoWeek(FIXED)).toBe("2026-W03");
    expect(isoWeek(new Date("2021-01-03T12:00:00Z"))).toBe("2020-W53");
    expect(weekRange("2026-W03")).toEqual({ from: "2026-01-12", to: "2026-01-18" });
    expect(weekRange("2020-W53")).toEqual({ from: "2020-12-28", to: "2021-01-03" });
    expect(() => weekRange("2026-W54")).toThrow(/not a week/);
  });

  it("counts the week from the job files, matching the index", () => {
    const root = sampleCopy();
    const s = weekStats(root, "2026-W03");
    expect(s).toMatchObject({
      week: "2026-W03", from: "2026-01-12", to: "2026-01-18", found: 3, applied: 1, replies: 0, interviews: 0,
      sponsorship: { sponsorship_offered: 1, visa_ok: 0, silent: 1, citizen_pr_only: 1, clearance: 0 },
    });
    expect(s.next_steps).toEqual([
      { title: "Backend Engineer (LLM)", company: "Example Labs", action: "Decide whether to apply" },
      { title: "AI Engineer", company: "Acme Corp", action: "Watch for a reply" },
    ]);
    buildIndex(root);
    const db = openIndex(root);
    const q = (sql: string) => (db.prepare(sql).get("2026-01-12", "2026-01-19") as { n: number }).n;
    expect(q("SELECT COUNT(*) AS n FROM jobs WHERE found_at >= ? AND found_at < ?")).toBe(s.found);
    expect(q("SELECT COUNT(*) AS n FROM events WHERE event = 'Status: Applied' AND at >= ? AND at < ?")).toBe(s.applied);
    db.close();
    expect(weekStats(root, "2026-W10")).toMatchObject({ found: 0, applied: 0, next_steps: expect.any(Array) });
  });
});

describe("buildSourcePack", () => {
  it("gathers a JD walkthrough's files and facts", () => {
    const root = sampleCopy();
    seedAcme(root);
    const p = pack(root, "jd-walkthrough");
    expect(p.missing).toEqual([]);
    expect(p.files.map((f) => [f.rel, f.resolver, f.untrusted])).toEqual([
      [`${ACME_JOB}/jd.md`, "job.jd", true],
      // must-haves text is built from the job ad (Task 6, carried into Task 15): untrusted, same as the ad itself.
      [`${ACME_JOB}/job.json`, "job.must_haves", true],
      [`${ACME_JOB}/score.md`, "job.score", false],
      ["me/history/roles.md", "history", false],
    ]);
    expect(p.files[1]!.extract).toBe("Must-haves:\n- LLM agents: met\n- Kubernetes: not met\nNice-to-haves:\n- Postgres");
    expect(p.facts).toMatchObject({ name: "Alex Example", role: "AI Engineer", company: "Acme Corp", gap: "", week: "" });
    expect(p.candidateTerms).toEqual(expect.arrayContaining(["Example Labs", "2024", "40"]));
    expect(p.candidateTerms).not.toContain("AI Engineer");
  });

  it("says what is missing and how to fix it", () => {
    const root = sampleCopy();
    const p = pack(root, "company-briefing", { kind: "company", company_slug: "acme-corp" }, "companies/acme-corp/videos/briefing-1");
    expect(p.missing).toEqual([{ resolver: "company.research", message: "Research this company first.", fix: "research-company", blocked: false }]);
    const q = pack(root, "jd-walkthrough");
    expect(q.missing.map((m) => m.fix)).toEqual(["score-job"]);
  });

  it("reads company research as untrusted and keeps the company record", () => {
    const root = sampleCopy();
    seedAcme(root);
    const p = pack(root, "company-briefing", { kind: "company", company_slug: "acme-corp" }, "companies/acme-corp/videos/briefing-1");
    // company.record is built from the company's own record (Task 6, carried into Task 15):
    // untrusted, same as research, since both can carry recruiter-supplied text.
    expect(p.files.map((f) => [f.rel, f.untrusted])).toEqual([[RESEARCH, true], ["companies/acme-corp/company.json", true]]);
    expect(p.files[1]!.extract).toMatch(/^Name: Acme Corp/);
  });

  it("never reads links, locked folders or huge files (Review Focus 4)", () => {
    const root = sampleCopy();
    seedAcme(root);
    fs.symlinkSync(path.join(root, "me/identity/visa.md"), path.join(root, "me/history/visa-link.md"));
    fs.writeFileSync(path.join(root, "me/history/huge.md"), "x".repeat(210 * 1024));
    fs.mkdirSync(path.join(root, "me/identity/history"), { recursive: true });
    const p = pack(root, "pitch");
    expect(p.files.map((f) => f.rel)).toEqual(["me/history/roles.md", `${ACME_JOB}/jd.md`, "settings/profile.json"]);
    expect(p.files.find((f) => f.rel === "settings/profile.json")!.extract).not.toMatch(/visa|485|expir/i);
  });

  it("cuts long extracts", () => {
    const root = sampleCopy();
    seedAcme(root);
    fs.writeFileSync(path.join(root, ACME_JOB, "jd.md"), `# Ad\n\n${"Build agents. ".repeat(600)}`);
    const jd = pack(root, "jd-walkthrough").files[0]!;
    expect(jd.extract.length).toBeLessThanOrEqual(4000 + 20);
    expect(jd.extract.endsWith("[cut]")).toBe(true);
  });

  it("builds a weekly pack from the stats", () => {
    const root = sampleCopy();
    const p = pack(root, "weekly-recap", { kind: "week", week: "2026-W03" }, "recaps/2026-W03");
    expect(p.files.map((f) => f.rel)).toEqual(["recaps/2026-W03/stats.json"]);
    expect(p.facts.stats?.found).toBe(3);
    expect(p.facts.week).toBe("2026-W03");
  });

  it("teaches a gap linked to a job", () => {
    const root = sampleCopy();
    seedAcme(root);
    const p = pack(root, "skill-gap-lesson", { kind: "topic", topic: "Kubernetes", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }, "learning/kubernetes/videos/1");
    expect(p.facts.gap).toBe("Kubernetes");
    expect(p.files.map((f) => f.resolver)).toEqual(["job.jd", "job.score"]);
    expect(p.missing).toEqual([]);
  });
});

describe("candidateTerms", () => {
  it("keeps names and numbers only the candidate's history has", () => {
    expect(candidateTerms(["Lead Engineer at Example Labs since 2024, 3 agents"], ["Example Labs is hiring. 3 roles."])).toEqual(["2024", "Lead Engineer"]);
  });

  it("matches whole terms, not substrings (fix round 1)", () => {
    expect(candidateTerms(["Shipped for 40 users, led as Lead Engineer"], ["Paid $140k. Lead Engineering team."])).toEqual(["40", "Lead Engineer"]);
  });

  it("excludes a version fragment and bare single digits, keeps a digit with an attached unit (review round 2 (a))", () => {
    expect(candidateTerms(["Shipped v1.5, closed 5 deals, grew 5%"], [])).toEqual(["5%"]);
  });
});

describe("fix round 1", () => {
  it("bounds a directory walk and reports it as a partial source, not a crash", () => {
    const root = sampleCopy();
    const dir = path.join(root, "me/history");
    for (let i = 0; i < 1001; i++) fs.writeFileSync(path.join(dir, `bulk-${String(i).padStart(4, "0")}.md`), "");
    const p = pack(root, "pitch");
    const historyMissing = p.missing.find((m) => m.resolver === "history");
    expect(historyMissing).toMatchObject({ resolver: "history", fix: "none" });
    expect(historyMissing!.message).toContain("Too many files in me/history");
    expect(historyMissing!.message).not.toContain(root);
    expect(historyMissing!.message).not.toMatch(/\/(Users|home)\//);
    // the walk still found files (truncated, not empty): a partial source alongside a
    // successful resolver, not treated as the resolver itself having failed
    expect(p.files.some((f) => f.resolver === "history")).toBe(true);
  });

  it("treats an invalid week as a missing source instead of crashing", () => {
    const root = sampleCopy();
    expect(() => pack(root, "weekly-recap", { kind: "week", week: "2026-W54" }, "recaps/2026-W54")).not.toThrow();
    const p = pack(root, "weekly-recap", { kind: "week", week: "2026-W54" }, "recaps/2026-W54");
    expect(p.files).toEqual([]);
    expect(p.missing).toEqual([{ resolver: "index.stats", message: "There are no numbers for this week.", fix: "none", blocked: false }]);
    expect(p.facts.stats).toBeNull();
  });

  it("treats an unsafe company slug as absent rather than building a path with it", () => {
    const root = sampleCopy();
    seedAcme(root);
    const p = pack(root, "jd-walkthrough", { kind: "job", company_slug: "../../me/identity", id: "2026-01-12-ai-engineer" });
    expect(p.files.map((f) => f.rel)).toEqual(["me/history/roles.md"]);
    expect(p.facts.company).toBe("");
    expect(p.missing.every((m) => m.fix === "none")).toBe(true);
  });

  it("keeps the learning topic folder inside learning/, even when folder tries to escape it", () => {
    const root = sampleCopy();
    seedAcme(root);
    const p = pack(
      root, "skill-gap-lesson",
      { kind: "topic", topic: "Kubernetes", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" },
      "learning/../me/identity/videos/1",
    );
    expect(p.files.every((f) => !f.rel.includes("..") && !f.rel.startsWith("me/identity"))).toBe(true);
    expect(p.files.map((f) => f.rel)).not.toContain("CLAUDE.md");
    expect(p.files.map((f) => f.resolver)).toEqual(["job.jd", "job.score"]);
  });

  it("refuses a source file that is a symlink, reaching readSafe through a single-file resolver", () => {
    const root = sampleCopy();
    seedAcme(root);
    const jd = path.join(root, ACME_JOB, "jd.md");
    fs.rmSync(jd);
    fs.symlinkSync(path.join(root, "me/identity/visa.md"), jd);
    const p = pack(root, "jd-walkthrough");
    expect(p.files.some((f) => f.rel === `${ACME_JOB}/jd.md`)).toBe(false);
    // The symlink really resolves into me/identity, a lockable folder: reported as blocked,
    // with the 3c request_access message, not the ordinary "save the job ad" one (Task 15).
    expect(p.missing).toEqual([{
      resolver: "job.jd", message: "This file is in a locked folder and is not included here. Ask for access with request_access, then try again.",
      fix: "none", blocked: true,
    }]);
    expect(JSON.stringify(p)).not.toMatch(/visa|485|expir/i);
  });

  it("refuses a source file with more than one hard link", () => {
    const root = sampleCopy();
    seedAcme(root);
    const jd = path.join(root, ACME_JOB, "jd.md");
    fs.linkSync(jd, path.join(root, ACME_JOB, "jd-alias.md"));
    const p = pack(root, "jd-walkthrough");
    expect(p.files.some((f) => f.rel === `${ACME_JOB}/jd.md`)).toBe(false);
    // A hard link isn't a locked-folder case: the ordinary "missing" message and fix, not blocked.
    expect(p.missing).toEqual([{ resolver: "job.jd", message: "Save the job ad first. This video needs jd.md.", fix: "save-jd", blocked: false }]);
  });

  it("reports a plain 'couldn't read' message, distinct from hitting the entry cap, when a directory read fails partway through (review round 2, item 8)", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spy = vi.spyOn(fs, "opendirSync").mockReturnValue({
      readSync: () => { throw new Error("boom"); },
      closeSync: () => {},
    } as unknown as fs.Dir);
    try {
      const p = pack(root, "pitch");
      const historyMissing = p.missing.find((m) => m.resolver === "history");
      expect(historyMissing).toEqual({ resolver: "history", message: "Couldn't read all of me/history.", fix: "none", blocked: false });
    } finally {
      spy.mockRestore();
    }
  });

  // Since develop's final review I4, core reads an unreadable workspace.json as "every lockable folder is locked"
  // (lockedOrAll) instead of throwing, so files outside me/identity and me/employment still read and the locked
  // folders stay shut.
  it("keeps the lockable folders shut, and the rest readable, when workspace.json itself can't be read", () => {
    const root = sampleCopy();
    seedAcme(root);
    fs.writeFileSync(path.join(root, "workspace.json"), "{not json");
    const p = pack(root, "jd-walkthrough");
    expect(p.missing.find((m) => m.resolver === "job.jd")).toBeUndefined();
    expect(p.files.some((f) => f.rel.endsWith("/jd.md"))).toBe(true);
    expect(p.files.some((f) => f.rel.startsWith("me/identity/") || f.rel.startsWith("me/employment/"))).toBe(false);
  });
});

// Fix round 1 (load-bearing item 1): job.json, company.json and profile.json were read with
// core's readRecord (fs.readFileSync, no symlink/lock gate at all - unlike every file-backed
// resolver above, which goes through readSafe). A job.json or company.json symlinked into a
// locked me/identity or me/employment folder put its title, must-haves, name or sponsor text
// straight into facts and the untrusted pack text, bypassing the exact protection the rest of
// this file exists to provide.
describe("fix round 1: record-backed resolvers (job.json, company.json, profile.json) are gated like every other source", () => {
  it("never leaks a job.json planted in a locked folder through facts.role or job.must_haves", () => {
    const root = sampleCopy();
    seedAcme(root);
    const jobFile = path.join(root, ACME_JOB, "job.json");
    fs.rmSync(jobFile);
    fs.writeFileSync(path.join(root, "me/identity/job.json"), JSON.stringify({
      schema: 1, id: "2026-01-12-ai-engineer", company_slug: "acme-corp", title: "LEAKED-SECRET-TITLE",
      scores: { fit: { must_haves: [{ skill: "LEAKED-SECRET-SKILL", met: true }], nice_to_haves: [] } },
    }));
    fs.symlinkSync(path.join(root, "me/identity/job.json"), jobFile);
    const p = pack(root, "jd-walkthrough");
    expect(p.facts.role).not.toBe("LEAKED-SECRET-TITLE");
    expect(JSON.stringify(p)).not.toContain("LEAKED-SECRET");
    const mustHaves = p.missing.find((m) => m.resolver === "job.must_haves");
    expect(mustHaves).toMatchObject({ blocked: true });
  });

  it("never leaks a company.json planted in a locked folder through facts.company or company.record", () => {
    const root = sampleCopy();
    seedAcme(root);
    fs.mkdirSync(path.join(root, "me/employment"), { recursive: true });
    const companyFile = path.join(root, "companies/acme-corp/company.json");
    fs.rmSync(companyFile);
    fs.writeFileSync(path.join(root, "me/employment/c.json"), JSON.stringify({
      schema: 1, name: "LEAKED-SECRET-COMPANY", slug: "acme-corp",
      sponsor: { status: "verified", evidence: [{ date: "2026-01-01", note: "LEAKED-SECRET-EVIDENCE", url: "" }], last_checked: "" },
    }));
    fs.symlinkSync(path.join(root, "me/employment/c.json"), companyFile);
    const p = pack(root, "company-briefing", { kind: "company", company_slug: "acme-corp" }, "companies/acme-corp/videos/briefing-1");
    expect(p.facts.company).not.toBe("LEAKED-SECRET-COMPANY");
    expect(JSON.stringify(p)).not.toContain("LEAKED-SECRET");
  });

  it("never leaks a profile.json planted in a locked folder through facts.name", () => {
    const root = sampleCopy();
    seedAcme(root);
    const profileFile = path.join(root, "settings/profile.json");
    const real = JSON.parse(fs.readFileSync(profileFile, "utf8"));
    fs.writeFileSync(path.join(root, "me/identity/profile.json"), JSON.stringify({ ...real, contact: { ...real.contact, name: "LEAKED-SECRET-NAME" } }));
    fs.rmSync(profileFile);
    fs.symlinkSync(path.join(root, "me/identity/profile.json"), profileFile);
    const p = pack(root, "pitch");
    expect(p.facts.name).not.toBe("LEAKED-SECRET-NAME");
    expect(JSON.stringify(p)).not.toContain("LEAKED-SECRET-NAME");
  });
});

describe("do-not-claim lists in me/history (honesty about claims)", () => {
  const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
  it("reads the items under a do-not-claim or cautions heading, and stops at the next heading", () => {
    const md = [
      "# Roles", "- AI Engineer, Example Labs", "",
      "## Do not claim", "- People management or direct reports", "* P&L ownership", "1. Kubernetes beyond basics", "",
      "## Projects", "- Support agent",
      "### Cautions", "- Don't say I led the platform team",
      "Do-not-claim: Gemini beyond concepts",
    ].join("\n");
    expect(doNotClaim(md)).toEqual([
      "People management or direct reports", "P&L ownership", "Kubernetes beyond basics", "Don't say I led the platform team", "Gemini beyond concepts",
    ]);
    expect(doNotClaim("# Roles\n- AI Engineer\n")).toEqual([]);
    expect(doNotClaim("**Do not claim:** people management\n- **Cautions:** P&L ownership\n")).toEqual(["people management", "P&L ownership"]);
  });

  it("puts the list on the pack from the whole history file, even past the extract cut", () => {
    const root = sampleCopy();
    seedAcme(root);
    const long = `${"- filler line about work\n".repeat(400)}\n## Do not claim\n- People management\n`;
    fs.writeFileSync(path.join(root, "me/history/cautions.md"), long);
    const pack = buildSourcePack({ root, type: typeOf("pitch"), subject: JOB, folder: `${ACME_JOB}/interview/pitch-1`, clock: { now: FIXED } });
    expect(pack.files.find((f) => f.rel === "me/history/cautions.md")!.extract).not.toContain("People management");
    expect(pack.cautions).toEqual(["People management"]);
  });
});
