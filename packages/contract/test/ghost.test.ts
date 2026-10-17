import { describe, expect, it } from "vitest";
import {
  adTextHash, applyJobQuery, findReposts, GHOST_STALE_DAYS, hiddenAsStale, normaliseAdText, REPOST_MIN_WORDS, sanitizeJobQuery, shingles,
  shingleSimilarity, staleReason, withGhostFlags, type GhostAd, type JobRow,
} from "../src/index.js";

const NOW = new Date("2026-10-15T09:00:00.000Z");

/** About 80 words of made-up ad text. */
const AD = [
  "Acme Corp is hiring a data analyst to join our growing insights team in Sampletown.",
  "You will build dashboards, clean messy data and explain what the numbers mean to people across the business.",
  "We use SQL, Python and a modern cloud warehouse, and we care about clear writing as much as clear charts.",
  "You will work with product, finance and operations, own a small set of reports end to end,",
  "and help us decide what to measure next. Flexible hours, a friendly team and real ownership from day one.",
].join(" ");

const ad = (over: Partial<GhostAd>): GhostAd => ({
  key: "acme-corp/a", company: "acme", id: "a", title: "Data Analyst", posted: "2026-09-01", found_at: "2026-09-01T00:00:00.000Z", text: AD, ...over,
});

const row = (over: Partial<JobRow>): JobRow => ({
  company_slug: "acme-corp", id: "a", company_name: "Acme Corp", client: null, title: "Data Analyst", location: "Sampletown NSW", work_mode: "",
  salary_text: "", salary_min: null, salary_max: null, wr_label: "silent", fit: null, sponsor: null, status: "Found", source: "pasted",
  source_site: "", posted: "", found_at: "2026-10-01T00:00:00.000Z", eligible: true, pinned: false, last_activity: "2026-10-01T00:00:00.000Z", ...over,
});

describe("ad text normalising and hashing", () => {
  it("ignores case, punctuation, accents, links and Markdown", () => {
    expect(normaliseAdText("**Café** & Co — see https://example.com/jobs/1!")).toBe("cafe and co see");
    expect(adTextHash("# Data Analyst\n\nSQL, Python.")).toBe(adTextHash("data analyst sql python"));
    expect(adTextHash("data analyst")).not.toBe(adTextHash("data engineer"));
    expect(adTextHash("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("makes five-word shingles, and one shingle for very short text", () => {
    expect([...shingles("one two three four five six")]).toEqual(["one two three four five", "two three four five six"]);
    expect([...shingles("just three words")]).toEqual(["just three words"]);
    expect(shingles("").size).toBe(0);
  });

  it("scores Jaccard similarity", () => {
    expect(shingleSimilarity(shingles(AD), shingles(AD))).toBe(1);
    expect(shingleSimilarity(shingles(AD), shingles("something else entirely about gardening and soil"))).toBe(0);
    expect(shingleSimilarity(new Set(), new Set())).toBe(1);
    const a = new Set(["a", "b", "c", "d"]);
    const b = new Set(["a", "b", "c", "e"]);
    expect(shingleSimilarity(a, b)).toBeCloseTo(3 / 5);
  });
});

describe("staleReason", () => {
  it("flags open ads posted more than 30 days ago, and says why", () => {
    const r = staleReason({ posted: "2026-09-01", status: "Found" }, NOW);
    expect(r).toMatch(/^Posted 44 days ago \(1 Sept? 2026\)\./);
    expect(staleReason({ posted: "~2026-09-10 (5 weeks ago)", status: "Saved" }, NOW)).toMatch(/^Posted 35 days ago/);
  });

  it("leaves recent, undated and acted-on ads alone", () => {
    const edge = new Date(NOW.getTime() - GHOST_STALE_DAYS * 86_400_000).toISOString().slice(0, 10);
    expect(staleReason({ posted: edge, status: "Found" }, NOW)).toBeNull();
    expect(staleReason({ posted: "2026-10-10", status: "Found" }, NOW)).toBeNull();
    expect(staleReason({ posted: "", status: "Found" }, NOW)).toBeNull();
    expect(staleReason({ posted: "3 weeks ago", status: "Found" }, NOW)).toBeNull();
    expect(staleReason({ posted: "2026-01-01", status: "Applied" }, NOW)).toBeNull();
    expect(staleReason({ posted: "2026-01-01", status: "Interview" }, NOW)).toBeNull();
  });
});

describe("findReposts", () => {
  it("flags the later of two identical ads from one company and names the earlier", () => {
    const out = findReposts([ad({}), ad({ key: "acme-corp/b", id: "b", title: "Data Analyst (Sampletown)", posted: "2026-10-05" })]);
    expect([...out.keys()]).toEqual(["acme-corp/b"]);
    expect(out.get("acme-corp/b")).toMatch(/^The same ad text as "Data Analyst", saved from 1 Sept? 2026\./);
  });

  it("is order independent: the earliest ad is never the repost", () => {
    const out = findReposts([ad({ key: "acme-corp/b", id: "b", posted: "2026-10-05" }), ad({})]);
    expect([...out.keys()]).toEqual(["acme-corp/b"]);
  });

  it("catches near-identical text at 90% or more, not below", () => {
    const words = AD.split(" ");
    // One word changed near the end: still the same ad.
    const near = [...words.slice(0, -3), "Sydney", ...words.slice(-2)].join(" ");
    const sim = shingleSimilarity(shingles(AD), shingles(near));
    expect(sim).toBeGreaterThanOrEqual(0.9);
    expect(sim).toBeLessThan(1);
    const out = findReposts([ad({}), ad({ key: "acme-corp/b", id: "b", posted: "2026-10-05", text: near })]);
    expect(out.get("acme-corp/b")).toMatch(/^Ad text 9\d% the same as "Data Analyst"/);
    // Every tenth word changed: a different ad.
    const far = words.map((w, i) => (i % 10 === 5 ? "different" : w)).join(" ");
    expect(shingleSimilarity(shingles(AD), shingles(far))).toBeLessThan(0.9);
    expect(findReposts([ad({}), ad({ key: "acme-corp/b", id: "b", posted: "2026-10-05", text: far })]).size).toBe(0);
  });

  it("only compares ads from the same company", () => {
    expect(findReposts([ad({}), ad({ key: "example-labs/b", company: "example labs", id: "b", posted: "2026-10-05" })]).size).toBe(0);
  });

  it("skips short or empty ads, which match too easily", () => {
    const short = AD.split(" ").slice(0, REPOST_MIN_WORDS - 1).join(" ");
    expect(findReposts([ad({ text: short }), ad({ key: "acme-corp/b", id: "b", text: short, posted: "2026-10-05" })]).size).toBe(0);
    expect(findReposts([ad({ text: "" }), ad({ key: "acme-corp/b", id: "b", text: "", posted: "2026-10-05" })]).size).toBe(0);
  });

  it("falls back to when the ad was found, and to the id, to order undated ads", () => {
    const out = findReposts([
      ad({ key: "acme-corp/z", id: "z", posted: "", found_at: "2026-10-02T00:00:00.000Z" }),
      ad({ key: "acme-corp/y", id: "y", posted: "", found_at: "2026-10-01T00:00:00.000Z" }),
    ]);
    expect([...out.keys()]).toEqual(["acme-corp/z"]);
  });

  it("flags every later copy of a thrice-posted ad", () => {
    const out = findReposts([ad({}), ad({ key: "acme-corp/b", id: "b", posted: "2026-09-20" }), ad({ key: "acme-corp/c", id: "c", posted: "2026-10-10" })]);
    expect([...out.keys()].sort()).toEqual(["acme-corp/b", "acme-corp/c"]);
  });
});

describe("flags on job rows and the Hide likely stale filter", () => {
  const rows = [
    row({ id: "old", posted: "2026-08-01" }),
    row({ id: "again", posted: "2026-10-10" }),
    row({ id: "fresh", posted: "2026-10-12" }),
    row({ id: "applied-old", posted: "2026-08-01", status: "Applied" }),
    row({ id: "closed", posted: "2026-09-20", closes_on: "2026-10-14" }),
    row({ id: "old-but-open", posted: "2026-08-01", closes_on: "2026-10-31" }),
  ];
  const flagged = withGhostFlags(rows, new Map([["acme-corp/again", "Reposted because…"]]), NOW);

  it("adds stale and repost reasons, and leaves other rows untouched", () => {
    expect(flagged[0]!.ghost?.stale).toMatch(/^Posted 75 days ago/);
    expect(flagged[1]!.ghost).toEqual({ repost: "Reposted because…" });
    expect(flagged[2]).toBe(rows[2]);
    expect(flagged[3]!.ghost).toBeUndefined();
    expect(flagged[4]!.ghost).toEqual({ closed: expect.stringMatching(/^The ad said applications closed on 14 Oct 2026/) });
    expect(flagged[5]!.ghost?.closed).toBeUndefined();
  });

  it("hides only open ads that closed or were reposted: age alone never hides", () => {
    expect(flagged.map(hiddenAsStale)).toEqual([false, true, false, false, true, false]);
    expect(hiddenAsStale({ status: "Applied", ghost: { repost: "x" } })).toBe(false);
    expect(hiddenAsStale({ status: "Applied", ghost: { closed: "x" } })).toBe(false);
    expect(hiddenAsStale({ status: "Found", ghost: { stale: "x" } })).toBe(false);
  });

  it("applyJobQuery leaves them out only when asked, and counts the total after", () => {
    expect(applyJobQuery(flagged, {}).total).toBe(6);
    const list = applyJobQuery(flagged, { hideStale: true });
    expect(list.rows.map((r) => r.id).sort()).toEqual(["applied-old", "fresh", "old", "old-but-open"]);
    expect(list.total).toBe(4);
  });

  it("sanitizeJobQuery keeps hideStale only when it is true", () => {
    expect(sanitizeJobQuery({ hideStale: true })).toEqual({ hideStale: true });
    expect(sanitizeJobQuery({ hideStale: "yes" })).toEqual({});
    expect(sanitizeJobQuery({ hideStale: false })).toEqual({});
  });
});
