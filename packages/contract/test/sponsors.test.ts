import { describe, expect, it } from "vitest";
import { IMPORT_SPONSOR_REASON, buildSponsorRows, mergeEvidence, normalizeSponsorStatus, sponsorKey, sponsorLikelihood, type SponsorCompanyInput, type SponsorJobInput } from "../src/index.js";

const FOI = { date: "2026-10-08", note: "On Home Affairs FOI FA 24/01/00298 list of accredited sponsors (as at 11 Jan 2024).", url: "https://example.gov.au/foi.pdf" };
const AD = { date: "2026-10-09", note: "SEEK ad for ML Engineer says 482 considered", url: "https://jobs.example.com/acme/2" };

describe("normalizeSponsorStatus", () => {
  it("accepts the cache's hyphen form and the record's underscore form", () => {
    expect(normalizeSponsorStatus("checked-none")).toBe("checked_none");
    expect(normalizeSponsorStatus("to-verify")).toBe("to_verify");
    expect(normalizeSponsorStatus("Verified")).toBe("verified");
    expect(normalizeSponsorStatus("sanctioned")).toBe("sanctioned");
    expect(normalizeSponsorStatus("pending-review")).toBe("unknown");
    expect(normalizeSponsorStatus(undefined)).toBe("unknown");
  });
});

describe("sponsorKey", () => {
  it("ignores case, legal suffixes, 'Australia' and punctuation", () => {
    expect(sponsorKey("Acme Corp Pty Ltd")).toBe(sponsorKey("acme corp"));
    expect(sponsorKey("Example Labs Australia")).toBe(sponsorKey("Example Labs"));
    expect(sponsorKey("Acme Recruiting, Inc.")).toBe(sponsorKey("Acme Recruiting"));
  });
});

describe("mergeEvidence", () => {
  it("merges, dedupes and sorts by date (oldest first, latest last)", () => {
    const merged = mergeEvidence([AD, FOI], [{ ...FOI, note: `  ${FOI.note} ` }, { date: "", note: "Undated note", url: "" }]);
    expect(merged.map((e) => e.note)).toEqual(["Undated note", FOI.note, AD.note]);
  });
  it("drops malformed items and coerces fields to strings", () => {
    expect(mergeEvidence([null, "x", { note: "Only a note" }] as unknown[])).toEqual([{ date: "", note: "Only a note", url: "" }]);
  });
});

describe("sponsorLikelihood (port of check_sponsor.py likelihood)", () => {
  const base = { name: "Acme Corp", qld: null, ai_relevance: "", last_checked: "", evidence: [] as typeof FOI[] };
  it("scores each status like the original", () => {
    expect(sponsorLikelihood({ ...base, status: "sanctioned" })).toMatchObject({ score: 0, tier: "Avoid" });
    expect(sponsorLikelihood({ ...base, status: "verified", evidence: [FOI] })).toMatchObject({ score: 55, tier: "Medium" });
    expect(sponsorLikelihood({ ...base, status: "verified", evidence: [FOI, AD], ai_relevance: "High" })).toMatchObject({ score: 80, tier: "High" });
    expect(sponsorLikelihood({ ...base, status: "verified", evidence: [AD], ai_relevance: "Medium" }).score).toBe(75);
    expect(sponsorLikelihood({ ...base, status: "to_verify" }).score).toBe(50);
    expect(sponsorLikelihood({ ...base, status: "checked_none", last_checked: "2026-10-08" })).toMatchObject({ score: 15, tier: "Very low" });
    expect(sponsorLikelihood({ ...base, status: "unknown" })).toMatchObject({ score: 20, tier: "Low" });
  });
  it("uses the ad when there is one", () => {
    expect(sponsorLikelihood({ ...base, status: "unknown" }, { sponsorship: "Explicit" }).score).toBe(95);
    expect(sponsorLikelihood({ ...base, status: "verified", evidence: [AD] }, { sponsorship: "Explicit" }).score).toBe(100);
    expect(sponsorLikelihood({ ...base, status: "verified" }, { sponsorship: "No" }).score).toBe(5);
    expect(sponsorLikelihood({ ...base, status: "unknown" }, { likely_sponsor: true, sponsor_reason: "global consultancy" }).score).toBe(40);
  });
  it("gives plain reasons, including QLD presence", () => {
    const r = sponsorLikelihood({ ...base, status: "verified", evidence: [AD], ai_relevance: "High", qld: true });
    expect(r.reasons).toEqual([
      `evidence they sponsor: ${AD.note}`, "has sponsored AI/software roles", "QLD presence",
    ]);
  });
});

describe("buildSponsorRows", () => {
  const companies: SponsorCompanyInput[] = [
    { name: "Acme Corp", slug: "acme-corp", sponsor: { status: "unknown", evidence: [], last_checked: "" } },
    { name: "Example Labs", slug: "example-labs", sponsor: { status: "to_verify", evidence: [AD], last_checked: "2026-10-09" } },
  ];
  const jobs: SponsorJobInput[] = [
    { company_slug: "acme-corp", id: "j1", title: "AI Engineer", status: "Applied", sponsor: { value: 95, tier: "Very high", reasons: ["ad says sponsorship is available"] } },
    { company_slug: "acme-corp", id: "j2", title: "Data Engineer", status: "Rejected", sponsor: { value: null, tier: "", reasons: [] } },
  ];
  const employers = [
    { name: "Acme Corp Pty Ltd", aliases: ["Acme"], status: "verified", evidence: [FOI], qld: true, ai_relevance: "High", last_checked: "2026-10-08" },
    { name: "Example Labs", status: "verified", evidence: [AD, FOI], qld: false, ai_relevance: "Medium", last_checked: "2026-10-10" },
    { name: "Acme Overseas", aliases: [], status: "checked-none", evidence: [{ ...FOI, note: "Checked: none found" }], last_checked: "2026-10-01" },
  ];
  const rows = buildSponsorRows(companies, employers, jobs);
  const by = (n: string) => rows.find((r) => r.name === n)!;

  it("keeps the evidence of employers that only exist in the sponsor cache", () => {
    expect(by("Acme Overseas")).toMatchObject({
      slug: null, status: "checked_none", jobs: 0, open_jobs: 0, last_checked: "2026-10-01",
      evidence: [{ date: FOI.date, note: "Checked: none found", url: FOI.url }],
    });
    expect(by("Acme Overseas").score).toBe(15);
  });

  it("merges cache evidence and details into a company that also has a record", () => {
    const acme = by("Acme Corp");
    expect(acme.evidence).toEqual([FOI]);
    expect(acme).toMatchObject({ status: "verified", qld: true, ai_relevance: "High", aliases: ["Acme Corp Pty Ltd", "Acme"], last_checked: "2026-10-08" });
    const labs = by("Example Labs");
    expect(labs.evidence).toEqual([FOI, AD]);
    expect(labs.status).toBe("verified");
    expect(labs.last_checked).toBe("2026-10-10");
    expect(rows).toHaveLength(3);
  });

  it("scores every row: the best of the employer and its job ads, with reasons", () => {
    expect(by("Acme Corp")).toMatchObject({ score: 95, score_tier: "Very high" });
    expect(by("Acme Corp").score_reasons).toEqual(["From the ad for AI Engineer", "ad says sponsorship is available"]);
    expect(by("Example Labs")).toMatchObject({ score: 75, score_tier: "High" });
    for (const r of rows) expect(typeof r.score).toBe("number");
  });

  it("never gives a score without a reason", () => {
    const all = [...rows, ...buildSponsorRows([{ name: "Acme Bare", slug: "acme-bare", sponsor: { status: "", evidence: [], last_checked: "" } }], [{ name: "Example Odd", status: "pending-review" }], [])];
    for (const r of all) expect(r.score_reasons.length, r.name).toBeGreaterThan(0);
  });

  it("lists related jobs and counts the open ones", () => {
    expect(by("Acme Corp")).toMatchObject({ jobs: 2, open_jobs: 1 });
    expect(by("Acme Corp").job_refs).toEqual([
      { company_slug: "acme-corp", id: "j1", title: "AI Engineer", status: "Applied", open: true },
      { company_slug: "acme-corp", id: "j2", title: "Data Engineer", status: "Rejected", open: false },
    ]);
  });

  it("a sanctioned finding always wins the status", () => {
    const r = buildSponsorRows([{ ...companies[1]!, sponsor: { ...companies[1]!.sponsor, last_checked: "2026-12-01" } }],
      [{ name: "Example Labs", status: "sanctioned", evidence: [], last_checked: "2026-01-01" }], []);
    expect(r[0]).toMatchObject({ status: "sanctioned", score: 0 });
  });

  it("L1: a fresh checked-none never downgrades an earlier verified record (rank, not recency)", () => {
    const ROLE = { date: "2026-09-01", note: "SEEK ad for AI Engineer says 482 considered", url: "https://jobs.example.com/acme/1" };
    const r = buildSponsorRows(
      [{ name: "Acme Ranked", slug: "acme-ranked", sponsor: { status: "verified", evidence: [ROLE], last_checked: "2026-09-01" } }],
      [{ name: "Acme Ranked", status: "checked-none", evidence: [], last_checked: "2026-10-01" }],
      [],
    );
    expect(r[0]!.status).toBe("verified");
    expect(r[0]!.score).toBeGreaterThanOrEqual(55);
    expect(r[0]!.score).toBeLessThanOrEqual(80);
  });

  it("L1: the strongest cache status wins regardless of array order", () => {
    const toVerify = { name: "Acme Order", status: "to-verify", evidence: [], last_checked: "2026-09-01" };
    const verified = { name: "Acme Order", status: "verified", evidence: [FOI], last_checked: "2026-10-01" };
    const company = [{ name: "Acme Order", slug: "acme-order", sponsor: { status: "unknown", evidence: [], last_checked: "" } }];
    const a = buildSponsorRows(company, [toVerify, verified], []);
    const b = buildSponsorRows(company, [verified, toVerify], []);
    expect(a[0]!.status).toBe("verified");
    expect(b[0]!.status).toBe("verified");
  });

  it("P2: a cache entry with no status defaults to to-verify, like the Python check()", () => {
    const r = buildSponsorRows([], [{ name: "Acme NoStatus" }], []);
    expect(r[0]).toMatchObject({ status: "to_verify", score: 50 });
  });
});

describe("sponsorKey (L2): mirrors the Python SUFFIXES/norm()", () => {
  it("strips the extra legal, regional and corporate suffixes, and a leading 'the'", () => {
    const base = sponsorKey("Acme");
    expect(sponsorKey("Acme Group")).toBe(base);
    expect(sponsorKey("Example Labs Technologies")).toBe(sponsorKey("Example Labs"));
    expect(sponsorKey("The Acme Company")).toBe(base);
    expect(sponsorKey("Acme Services")).toBe(base);
    expect(sponsorKey("Acme APAC")).toBe(base);
  });

  it("round 2: strips 'the' as a whole word anywhere in the name, not just leading (matches Python norm())", () => {
    expect(sponsorKey("Learning the Hub")).toBe(sponsorKey("Learning Hub"));
    expect(sponsorKey("The Learning Hub")).toBe(sponsorKey("Learning Hub"));
  });
});

describe("sponsorLikelihood (P1): evidence notes in reasons are truncated to 90 chars", () => {
  it("matches the Python likelihood()'s note[:90]", () => {
    const longNote = "SEEK ad for Senior AI Engineer at Acme Corp explicitly states that visa sponsorship under the 482 program is considered for the right candidate";
    const AD2 = { date: "2026-10-09", note: longNote, url: "https://jobs.example.com/acme/3" };
    const r = sponsorLikelihood({ name: "Acme Corp", status: "verified", evidence: [AD2], qld: null, ai_relevance: "", last_checked: "" });
    const reason = r.reasons.find((x) => x.startsWith("evidence they sponsor:"))!;
    expect(reason).toBe(`evidence they sponsor: ${longNote.slice(0, 90)}`);
    expect(reason.length).toBeLessThanOrEqual("evidence they sponsor: ".length + 90);
  });
});

describe("a sponsor score copied from the employer when a job was added", () => {
  it("is never credited to the ad later (a stale copy can't lift the employer)", () => {
    const co: SponsorCompanyInput = { name: "Acme Corp", slug: "acme-corp", sponsor: { status: "checked-none", evidence: [], last_checked: "2026-01-10" } };
    const job: SponsorJobInput = { company_slug: "acme-corp", id: "j1", title: "AI Engineer", status: "Found", sponsor: { value: 70, tier: "High", reasons: [IMPORT_SPONSOR_REASON, "old evidence"] } };
    expect(buildSponsorRows([co], [], [job])[0]!.score).toBe(15);
    const fromAd = { ...job, sponsor: { value: 95, tier: "Very high", reasons: ["ad says sponsorship is available"] } };
    expect(buildSponsorRows([co], [], [fromAd])[0]!.score).toBe(95);
  });
});
