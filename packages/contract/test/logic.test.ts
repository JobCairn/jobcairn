import { describe, expect, it } from "vitest";
import {
  applyJobQuery, applyStep, approvalDigestText, buildApplyPrompt, buildNextUp, canonicalJson, effectivelyLocked, privacyNavLabel, gapsFrom, isEligible, isReply, jobRowFromRecord, sanitizeJobQuery, visaDaysLeft,
  weeklyActivity, type JobRecord, type JobRow,
} from "../src/index.js";

function job(over: Partial<JobRecord> & { id: string; company_slug: string }): JobRecord {
  return {
    client: null, title: "AI Engineer", source: "ats", source_site: "Greenhouse", url: "", apply_via: "", posted: "",
    found_at: "2026-01-12T09:00:00.000Z", location: "Sampletown NSW", work_mode: "Hybrid", job_type: "",
    salary: { min: null, max: null, currency: "", period: "", text: "" },
    work_rights: { label: "silent", quotes: [], decided_by: "none" },
    scores: { fit: { value: null, must_haves: [], nice_to_haves: [] }, sponsor: { value: null, tier: "", reasons: [] }, career: { match: null, odds: null, tier: "", scored_at: "" } },
    status: "Found", timeline: [], files: [], ...over,
  };
}
const row = (j: JobRecord, eligible = true): JobRow => jobRowFromRecord(j, j.company_slug, eligible);

describe("job list logic", () => {
  const rows = [
    row(job({ id: "a", company_slug: "example-labs", scores: { ...job({ id: "x", company_slug: "x" }).scores, fit: { value: 90, must_haves: [], nice_to_haves: [] } } })),
    row(job({ id: "b", company_slug: "acme-corp", work_rights: { label: "sponsorship_offered", quotes: [], decided_by: "scan" } })),
    row(job({ id: "c", company_slug: "acme-recruiting", work_rights: { label: "citizen_pr_only", quotes: [], decided_by: "scan" } }), false),
  ];
  it("pins sponsorship-offered rows first under every sort, only when prioritiseSponsorship is true", () => {
    for (const sort of ["default", "fit", "sponsor", "newest"] as const) expect(applyJobQuery(rows, { sort }, true).rows[0]?.id).toBe("b");
  });
  it("round 2: never pins (or tiebreaks on sponsor score in the default sort) when prioritiseSponsorship is false (the default)", () => {
    // Row "b" (sponsorship_offered, no fit score) would be pinned first under the old
    // unconditional rule; with prioritiseSponsorship off it sorts on fit like any other row.
    expect(applyJobQuery(rows, { sort: "default" }).rows[0]?.id).toBe("a");
    expect(applyJobQuery(rows, { sort: "default" }, false).rows[0]?.id).toBe("a");
  });
  it("hides ineligible ads by default and counts them", () => {
    expect(applyJobQuery(rows, {})).toMatchObject({ total: 2, hiddenIneligible: 1 });
    expect(applyJobQuery(rows, { showIneligible: true })).toMatchObject({ total: 3, hiddenIneligible: 0 });
  });
  it("filters by text, status, label, fit, and keeps unknown salaries", () => {
    expect(applyJobQuery(rows, { text: "acme" }).rows.map((r) => r.id)).toEqual(["b"]);
    expect(applyJobQuery(rows, { fitMin: 50 }).rows.map((r) => r.id)).toEqual(["a"]);
    expect(applyJobQuery(rows, { salaryMin: 150000 }).total).toBe(2);
    expect(applyJobQuery(rows, { labels: ["silent"] }).rows.map((r) => r.id)).toEqual(["a"]);
    // Paging over the pinned order (not the default, unprioritised one): b is pinned first, a second.
    expect(applyJobQuery(rows, { limit: 1, offset: 1 }, true).rows.map((r) => r.id)).toEqual(["a"]);
  });
  it("knows who can apply", () => {
    expect(isEligible("needs_sponsorship", "citizen_pr_only")).toBe(false);
    expect(isEligible("citizen", "clearance")).toBe(true);
  });
});

describe("sanitizeJobQuery", () => {
  it("keeps well-formed fields as-is", () => {
    expect(sanitizeJobQuery({
      text: "engineer", statuses: ["Found", "Saved"], showIneligible: true, labels: ["visa_ok"], location: "Sampletown",
      modes: ["remote", "hybrid"], salaryMin: 120000, sources: ["ats"], fitMin: 50, sponsorMin: 40, since: "2026-01-01",
      sort: "fit", limit: 10, offset: 5,
    })).toEqual({
      text: "engineer", statuses: ["Found", "Saved"], showIneligible: true, labels: ["visa_ok"], location: "Sampletown",
      modes: ["remote", "hybrid"], salaryMin: 120000, sources: ["ats"], fitMin: 50, sponsorMin: 40, since: "2026-01-01",
      sort: "fit", limit: 10, offset: 5,
    });
  });
  it("drops a non-array where an array is expected instead of throwing", () => {
    expect(sanitizeJobQuery({ modes: "remote", labels: "visa_ok" })).toEqual({});
  });
  it("filters unknown members out of enum arrays instead of rejecting the whole list", () => {
    expect(sanitizeJobQuery({ statuses: ["Found", "Nonsense"], labels: ["visa_ok", "nope"], sources: ["ats", "carrier-pigeon"] }))
      .toEqual({ statuses: ["Found"], labels: ["visa_ok"], sources: ["ats"] });
  });
  it("drops an unknown sort instead of throwing", () => {
    expect(sanitizeJobQuery({ sort: "random" })).toEqual({});
    expect(sanitizeJobQuery({ sort: "newest" })).toEqual({ sort: "newest" });
  });
  it("drops out-of-range or wrongly typed numbers and booleans", () => {
    expect(sanitizeJobQuery({ fitMin: "90", sponsorMin: -5, salaryMin: Infinity, limit: 0, offset: -1, showIneligible: "yes" })).toEqual({});
    expect(sanitizeJobQuery({ fitMin: 90, limit: 500, offset: 0 })).toEqual({ fitMin: 90, limit: 500, offset: 0 });
  });
  it("drops unknown top-level keys and non-object input", () => {
    expect(sanitizeJobQuery({ text: "ok", evil: "__proto__", unknownField: 1 })).toEqual({ text: "ok" });
    expect(sanitizeJobQuery(null)).toEqual({});
    expect(sanitizeJobQuery("not an object")).toEqual({});
    expect(sanitizeJobQuery(["array", "not", "object"])).toEqual({});
  });
});

describe("home logic", () => {
  const now = new Date("2026-01-15T10:00:00.000Z"); // a Thursday
  it("counts days left on a visa, or null when not set", () => {
    expect(visaDaysLeft("2026-01-25", now)).toBe(10);
    expect(visaDaysLeft("", now)).toBeNull();
    expect(visaDaysLeft("soon", now)).toBeNull();
  });
  it("buckets activity into Monday-start weeks", () => {
    const w = weeklyActivity([
      { at: "2026-01-12T09:00:00.000Z", event: "Found" }, { at: "2026-01-13T09:00:00.000Z", event: "Status: Applied" },
      { at: "2026-01-14T09:00:00.000Z", event: "Status: Interview" }, { at: "2026-01-02T09:00:00.000Z", event: "Found" },
      { at: "2025-01-01T09:00:00.000Z", event: "Found" },
    ], now, 3);
    expect(w).toEqual([
      { week: "2025-12-29", found: 1, applied: 0, replies: 0 },
      { week: "2026-01-05", found: 0, applied: 0, replies: 0 },
      { week: "2026-01-12", found: 1, applied: 1, replies: 1 },
    ]);
    expect(isReply("Email received")).toBe(true);
    expect(isReply("Note")).toBe(false);
  });
  it("orders next-up: approvals, requests, interviews, best jobs, inbox", () => {
    const rows = [
      row(job({ id: "i", company_slug: "example-labs", status: "Interview" })),
      row(job({ id: "p", company_slug: "acme-corp", work_rights: { label: "sponsorship_offered", quotes: [], decided_by: "scan" } })),
    ];
    const items = buildNextUp({
      rows,
      approvals: [{ id: "a1", action: "status_change", title: "Move to Interview", summary: "", steps: [], payload: {}, created_at: "", created_by: "claude", status: "pending", decided_at: "", result_note: "", digest: "0".repeat(64), from_app: false }],
      requests: [{ id: "r1", folder: "me/identity", field: "", why: "visa expiry", who: "claude", minutes: 15, created_at: "", status: "pending", decided_at: "", expires_at: "" }],
      inbox: [{ name: "cv.pdf", size: 1, suggestion: { target: null, reason: "No rule matched. Choose a folder.", confidence: "low" } }],
    });
    expect(items.map((i) => i.kind)).toEqual(["approval", "request", "interview", "prepare", "inbox"]);
  });
});

describe("job detail and apply logic", () => {
  it("reads gaps only from must-haves marked unmet", () => {
    const j = job({ id: "g", company_slug: "acme-corp" });
    j.scores.fit.must_haves = ["Python", { skill: "Kubernetes", met: false }, { item: "RAG", status: "missing" }, { skill: "TypeScript", met: true }, { text: "Kubernetes", met: false }];
    expect(gapsFrom(j)).toEqual(["Kubernetes", "RAG"]);
  });
  it("moves through the apply steps", () => {
    const f = (path: string) => ({ path, rel: path, label: path, at: "", exists: true, size: 1, kind: "markdown" as const });
    const ap = (status: "pending" | "done" | "declined") => ({ id: "a", action: "apply_handoff" as const, title: "", summary: "", steps: [], payload: {}, created_at: "", created_by: "app" as const, status, decided_at: "", result_note: "", digest: "0".repeat(64), from_app: true });
    expect(applyStep("Found", [], null)).toBe("prepare");
    expect(applyStep("Applying", [f("application/PREPARE.md")], null)).toBe("prepare");
    expect(applyStep("Applying", [f("application/resume.md")], null)).toBe("review");
    expect(applyStep("Applying", [f("application/resume.md")], ap("pending"))).toBe("handoff");
    expect(applyStep("Applying", [f("application/resume.md")], ap("declined"))).toBe("review");
    expect(applyStep("Applying", [f("application/resume.md")], ap("done"))).toBe("confirm");
    expect(applyStep("Applied", [], null)).toBe("done");
  });
  it("writes a prompt that names the job folder and forbids submitting", () => {
    const p = buildApplyPrompt("AI Engineer", "Acme Corp", "acme-corp", "2026-01-12-ai-engineer");
    expect(p).toContain("companies/acme-corp/jobs/2026-01-12-ai-engineer");
    expect(p).toContain("Do not submit anything");
  });
});

describe("approval digests (final review I3)", () => {
  it("gives the same text whatever the key order, and changes with anything a card shows", () => {
    const a = { action: "status_change" as const, title: "Move to Interview", summary: "", steps: ["Set it"], payload: { id: "x", company_slug: "acme-corp", status: "Interview" }, created_by: "claude" as const };
    const b = { ...a, payload: { status: "Interview", company_slug: "acme-corp", id: "x" } };
    expect(approvalDigestText(a)).toBe(approvalDigestText(b));
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
    for (const change of [{ title: "Move to Offer" }, { payload: { ...a.payload, status: "Offer" } }, { created_by: "app" as const }, { steps: [] }]) {
      expect(approvalDigestText({ ...a, ...change })).not.toBe(approvalDigestText(a));
    }
  });
});

describe("privacy nav state (final review M7)", () => {
  const now = new Date("2026-01-15T09:00:00.000Z");
  const grant = (until: string) => ({ folder: "me/identity" as const, until, request_id: "r" });
  it("counts a folder with a live grant as open, and an ended grant as locked", () => {
    const locked = ["me/identity", "me/employment"] as ("me/identity" | "me/employment")[];
    expect(effectivelyLocked({ locked, grants: [grant("2026-01-15T09:15:00.000Z")] }, now)).toEqual(["me/employment"]);
    expect(effectivelyLocked({ locked, grants: [grant("2026-01-15T08:59:00.000Z")] }, now)).toEqual(locked);
    expect(privacyNavLabel({ locked, grants: [], problems: [] }, now)).toBe("Locked");
    expect(privacyNavLabel({ locked, grants: [grant("2026-01-15T09:15:00.000Z")], problems: [] }, now)).toBe("Open");
    expect(privacyNavLabel({ locked: [], grants: [], problems: [] }, now)).toBe("Open");
    expect(privacyNavLabel({ locked, grants: [], problems: [{ folder: "me/identity", kind: "missing", found_at: null }] }, now)).toBe("Check");
  });
});
