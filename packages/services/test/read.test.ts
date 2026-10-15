import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout, refreshIndex, updateRecord } from "@careeros/core";
import { readHandlers as R } from "../src/read.js";
import { settingsHandlers as S } from "../src/settings.js";
import { openSample } from "./helpers.js";

const ACME = ["acme-corp", "2026-01-12-ai-engineer"] as const;
const LABS = ["example-labs", "2026-01-12-backend-engineer-llm"] as const;
const DEV = ["acme-recruiting", "2026-01-12-ai-developer"] as const;

describe("jobs read model", () => {
  it("pins sponsorship ads and hides ads you can't apply for", () => {
    const { ctx } = openSample();
    const list = R["jobs.list"](ctx, {});
    expect(list.rows[0]).toMatchObject({ company_name: "Acme Corp", pinned: true });
    expect(list.hiddenIneligible).toBe(1);
    expect(R["jobs.get"](ctx, ...DEV).eligible).toBe(false);
  });

  it("recomputes eligibility right after a work-rights change in Settings (Review Focus 5)", () => {
    const { ctx } = openSample();
    S["settings.save"](ctx, "profile", [{ path: "work_rights.status", value: "citizen" }]);
    expect(R["jobs.list"](ctx, {}).hiddenIneligible).toBe(0);
    expect(R["jobs.get"](ctx, ...DEV).eligible).toBe(true);
    S["settings.save"](ctx, "profile", [{ path: "work_rights.status", value: "needs_sponsorship" }]);
    expect(R["jobs.list"](ctx, {}).hiddenIneligible).toBe(1);
  });

  it("shows details with description, files and missing files", () => {
    const { ctx, root } = openSample();
    const d = R["jobs.get"](ctx, ...ACME);
    expect(d.description).toContain("Build LLM agents");
    expect(d.company?.name).toBe("Acme Corp");
    expect(d.files[0]).toMatchObject({ path: "jd.md", rel: "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md", exists: true, kind: "markdown" });
    fs.rmSync(path.join(layout(root).jobDir(...ACME), "jd.md"));
    expect(R["jobs.get"](ctx, ...ACME).files[0]).toMatchObject({ exists: false, size: null });
    expect(R["jobs.get"](ctx, ...ACME).description).toBe("");
  });

  it("survives deleted and broken job files (Review Focus 4)", () => {
    const { ctx, root } = openSample();
    const L = layout(root);
    fs.rmSync(L.jobDir(...LABS), { recursive: true });
    expect(() => R["jobs.get"](ctx, ...LABS)).toThrow(/no job example-labs\/2026-01-12-backend-engineer-llm/);
    fs.writeFileSync(L.jobFile(...ACME), "{ not json");
    expect(() => R["jobs.get"](ctx, ...ACME)).toThrow(/invalid JSON/);
    const report = refreshIndex(root, [L.jobDir(...LABS), L.jobFile(...ACME)]);
    expect(report.skipped.map((s) => s.file)).toContain("companies/acme-corp/jobs/2026-01-12-ai-engineer/job.json");
    expect(R["jobs.list"](ctx, { showIneligible: true }).rows.map((r) => r.title)).toEqual(["AI Developer"]);
    expect(R["home.summary"](ctx).total).toBe(1);
  });

  it("sets status and adds notes, and the list sees them at once", () => {
    const { ctx } = openSample();
    expect(R["jobs.setStatus"](ctx, ...LABS, "Saved", "").job.status).toBe("Saved");
    expect(R["jobs.addNote"](ctx, ...LABS, "Asked about the team").job.timeline.at(-1)).toMatchObject({ event: "Note", note: "Asked about the team" });
    expect(R["jobs.list"](ctx, { statuses: ["Saved"] }).rows.map((r) => r.id)).toEqual([LABS[1]]);
  });

  it("stores saved views in settings/search.json", () => {
    const { ctx, root } = openSample();
    R["jobs.saveView"](ctx, "Sponsored", { labels: ["sponsorship_offered"] });
    R["jobs.saveView"](ctx, "Sponsored", { labels: ["visa_ok"] });
    expect(R["jobs.views"](ctx)).toEqual([{ name: "Sponsored", query: { labels: ["visa_ok"] } }]);
    expect(JSON.parse(fs.readFileSync(layout(root).search, "utf8")).views).toHaveLength(1);
    expect(R["jobs.deleteView"](ctx, "Sponsored")).toEqual([]);
  });

  it("lists a malformed saved view without throwing, dropping its bad keys", () => {
    const { ctx, root } = openSample();
    const L = layout(root);
    const raw = JSON.parse(fs.readFileSync(L.search, "utf8"));
    raw.views = [{ name: "Busted", query: { modes: "remote", sort: "bogus", labels: ["visa_ok", "not-a-label"], limit: 99999, text: 42 } }];
    fs.writeFileSync(L.search, JSON.stringify(raw, null, 2));
    expect(() => R["jobs.views"](ctx)).not.toThrow();
    const stored = R["jobs.views"](ctx);
    expect(stored).toEqual([{ name: "Busted", query: { labels: ["visa_ok"] } }]);
    expect(() => R["jobs.list"](ctx, stored[0]!.query)).not.toThrow();
    // No sample job carries the "visa_ok" label, so the filter (the one surviving key) legitimately
    // finds nothing - the point is that it runs at all instead of throwing on the bad keys.
    expect(R["jobs.list"](ctx, stored[0]!.query)).toMatchObject({ rows: [], total: 0 });
  });
});

describe("other read models", () => {
  it("summarises Home", () => {
    const { ctx } = openSample();
    expect(R["home.summary"](ctx)).toMatchObject({ name: "Alex Example", total: 3, visaDaysLeft: 897, pendingApprovals: 1, pendingRequests: 1, inboxCount: 0 });
  });
  it("lists sponsors and searches", () => {
    const { ctx } = openSample();
    expect(R["sponsors.list"](ctx).map((s) => [s.name, s.jobs])).toEqual([["Acme Corp", 1], ["Acme Recruiting", 1], ["Example Labs", 1]]);
    expect(R["searches.list"](ctx)).toEqual({ rows: [expect.objectContaining({ site: "Greenhouse", recent: true })], sites: ["Greenhouse"] });
  });
  it("keeps sponsor-cache evidence and scores every employer (cache-only and matched)", () => {
    const { ctx, root } = openSample();
    const foi = { date: "2026-10-08", note: "On Home Affairs FOI FA 24/01/00298 list of accredited sponsors", url: "https://example.gov.au/foi.pdf" };
    const ad = { date: "2026-10-09", note: "SEEK ad for ML Engineer says 482 considered", url: "https://jobs.example.com/labs/9" };
    updateRecord("sponsors", layout(root).sponsors, (s) => {
      s.employers = [
        { name: "Acme Overseas", aliases: ["Acme OS"], status: "checked-none", evidence: [foi], qld: false, ai_relevance: "Low", last_checked: "2026-10-08" },
        { name: "Example Labs Pty Ltd", aliases: [], status: "verified", evidence: [ad, foi, ad], qld: true, ai_relevance: "High", last_checked: "2026-10-09" },
      ];
    });
    const rows = R["sponsors.list"](ctx);
    const by = (n: string) => rows.find((r) => r.name === n)!;
    expect(rows.map((r) => r.name)).toEqual(["Acme Corp", "Acme Overseas", "Acme Recruiting", "Example Labs"]);
    expect(by("Acme Overseas")).toMatchObject({
      slug: null, status: "checked_none", evidence: [foi], aliases: ["Acme OS"], qld: false, ai_relevance: "Low", score: 15, jobs: 0,
    });
    // A company with a record and a cache entry: the cache's evidence is merged in, deduped and dated.
    expect(by("Example Labs")).toMatchObject({ status: "verified", evidence: [foi, ad], qld: true, ai_relevance: "High", last_checked: "2026-10-09" });
    expect(by("Example Labs").score).toBeGreaterThanOrEqual(80);
    expect(by("Example Labs").score_reasons.length).toBeGreaterThan(0);
    for (const r of rows) expect(typeof r.score).toBe("number");
    expect(by("Acme Recruiting")).toMatchObject({ status: "unknown", score: 20 });
  });
  it("needs an open workspace", () => {
    const { ctx } = openSample();
    ctx.setRoot(null);
    expect(() => R["home.summary"](ctx)).toThrow("No workspace is open.");
  });
});

describe("job score on the detail", () => {
  it("is null when unscored, a legacy fit from score.md, then score.json once score_record ran", () => {
    const { ctx, root } = openSample();
    const dir = layout(root).jobDir(...LABS);
    expect(R["jobs.get"](ctx, ...LABS).score).toBeNull();
    fs.writeFileSync(path.join(dir, "score.md"), "# Score\n\nFit score 52/100\n");
    expect(R["jobs.get"](ctx, ...LABS).score).toMatchObject({ fit: 52, source: "legacy", must_haves: [] });
    fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
      fit: 64, interview_odds: 50, tier: "Meh", recommendation: "Maybe.", must_haves: [{ text: "Go", status: "met", evidence: "me/resumes/a.pdf" }],
      changes: [], summary: "", scored_at: "2026-01-14T09:00:00.000Z",
    }));
    expect(R["jobs.get"](ctx, ...LABS).score).toMatchObject({ fit: 64, tier: "Meh", source: "structured", must_haves: [{ text: "Go", status: "met", evidence: "your resume" }] });
  });

  it("falls back to the record's scores when there is no score.json", () => {
    const { ctx, root } = openSample();
    updateRecord("job", layout(root).jobFile(...LABS), (j) => {
      j.scores.fit = { value: 70, must_haves: [{ skill: "Kafka", met: false }], nice_to_haves: [] };
      j.timeline.push({ at: "2026-01-13T02:30:00.000Z", event: "Scored", note: "" });
    });
    expect(R["jobs.get"](ctx, ...LABS).score).toMatchObject({ fit: 70, source: "record", scored_at: "2026-01-13T02:30:00.000Z", must_haves: [{ text: "Kafka", status: "not_met" }] });
  });
});
