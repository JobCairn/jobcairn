import { describe, expect, it } from "vitest";
import type { ApprovalView, JobRow } from "@careeros/contract";
import { STAGES, defaultStage, filterPrepare, stageCounts, stageRows, waitingKeys } from "../src/applications/stages";

const row = (over: Partial<JobRow>): JobRow => ({
  company_slug: "acme-corp", id: "j", company_name: "Acme Corp", client: null, title: "AI Engineer", location: "", work_mode: "", salary_text: "", salary_min: null, salary_max: null,
  wr_label: "Silent", fit: null, sponsor: null, status: "Found", source: "ats", source_site: "", posted: "", found_at: "2026-01-01", eligible: true, pinned: false, last_activity: "2026-01-01", ...over,
} as JobRow);
const approval = (payload: Record<string, unknown>, status = "pending"): ApprovalView => ({ id: "a", action: "status_change", title: "", summary: "", steps: [], payload, created_at: "", created_by: "claude", status, decided_at: "", result_note: "", digest: "", from_app: false } as ApprovalView);

describe("application stages", () => {
  const rows = [
    row({ id: "a", status: "Found" }), row({ id: "b", status: "Saved" }), row({ id: "c", status: "Applying" }), row({ id: "d", status: "Applied" }),
    row({ id: "e", status: "Interview" }), row({ id: "f", status: "Offer" }), row({ id: "g", status: "Rejected" }), row({ id: "h", status: "Skipped" }),
    row({ id: "i", status: "No response" }), row({ id: "j", status: "Withdrawn" }),
  ];
  it("maps every status to one stage tab, in order", () => {
    expect(STAGES.map((s) => s.label)).toEqual(["To prepare", "In progress", "Waiting for your OK", "Sent", "Interviews", "Closed"]);
    const waiting = waitingKeys([approval({ company_slug: "acme-corp", id: "c" })]);
    expect(stageCounts(rows, waiting)).toEqual({ prepare: 2, progress: 1, waiting: 1, sent: 1, interviews: 2, closed: 4 });
    expect(stageRows("interviews", rows, waiting).map((r) => r.id)).toEqual(["e", "f"]);
  });
  it("only counts pending approvals that name a job", () => {
    expect([...waitingKeys([approval({ company_slug: "acme-corp", id: "c" }, "approved"), approval({ note: "x" }), approval({ company_slug: "acme-corp", id: "d" })])]).toEqual(["acme-corp/d"]);
  });
  it("opens on In progress when there is any, else To prepare, unless you picked one this session", () => {
    expect(defaultStage({ prepare: 3, progress: 1, waiting: 0, sent: 0, interviews: 0, closed: 0 }, null)).toBe("progress");
    expect(defaultStage({ prepare: 3, progress: 0, waiting: 0, sent: 0, interviews: 0, closed: 0 }, null)).toBe("prepare");
    expect(defaultStage({ prepare: 3, progress: 1, waiting: 0, sent: 0, interviews: 0, closed: 0 }, "sent")).toBe("sent");
  });
  it("filters and sorts the jobs to prepare", () => {
    const list = [row({ id: "a", fit: 60, found_at: "2026-01-03" }), row({ id: "b", fit: 85, found_at: "2026-01-01", source_site: "SEEK" }), row({ id: "c", fit: null, found_at: "2026-01-05", pinned: true })];
    expect(filterPrepare(list, { sort: "best", fit70: false, source: "" }).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(filterPrepare(list, { sort: "fit", fit70: false, source: "" }).map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(filterPrepare(list, { sort: "newest", fit70: false, source: "" }).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(filterPrepare(list, { sort: "best", fit70: true, source: "" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterPrepare(list, { sort: "best", fit70: false, source: "seek" }).map((r) => r.id)).toEqual(["b"]);
  });
});
