import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { newJob } from "../src/jobs.js";
import { buildIndex, openIndex, planRefresh, refreshIndex } from "../src/index-db.js";
import { writeRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

const mid = (s: string) => "<" + s + "@" + "example.org>";
const sidecar = (over: Record<string, unknown> = {}) => ({
  schema: 1, message_id: mid("m1"), direction: "in", subject: "Interview for AI Engineer", date: "2026-01-14T09:00:00.000Z",
  from: { name: "Acme Talent", address: "talent" + "@" + "example.org" }, ...over,
});

function seeded() {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  const a = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
  const L = layout(root);
  writeRecord("email", path.join(L.jobEmailsDir(a.company_slug, a.id), "2026-01-14-interview-for-ai-engineer-aaaaaa.json"), sidecar());
  writeRecord("email", path.join(L.companyEmailsDir(a.company_slug), "2026-01-13-hello-from-acme-bbbbbb.json"), sidecar({ message_id: mid("m2"), subject: "Hello from Acme", date: "2026-01-13T09:00:00.000Z" }));
  buildIndex(root);
  return { root, a, L };
}
const rows = (root: string) => {
  const db = openIndex(root);
  const r = db.prepare("SELECT company_slug, job_id, subject, direction, opened FROM emails ORDER BY date").all() as { subject: string }[];
  db.close();
  return r;
};

describe("emails in the index", () => {
  it("indexes job mail and company mail", () => {
    const { root, a } = seeded();
    expect(rows(root)).toEqual([
      { company_slug: "acme-corp", job_id: "", subject: "Hello from Acme", direction: "in", opened: 0 },
      { company_slug: "acme-corp", job_id: a.id, subject: "Interview for AI Engineer", direction: "in", opened: 0 },
    ]);
  });
  it("maps email paths to the smallest refresh", () => {
    const p = planRefresh(["companies/acme-corp/emails/x.json", "companies/acme-corp/jobs/j1/emails/y.json"]);
    expect(p.full).toBe(false);
    expect([...p.companyEmails]).toEqual(["acme-corp"]);
    expect([...p.jobs]).toEqual(["acme-corp/j1"]);
  });
  it("picks up a new message for one job", () => {
    const { root, a, L } = seeded();
    const f = path.join(L.jobEmailsDir(a.company_slug, a.id), "2026-01-15-re-interview-cccccc.json");
    writeRecord("email", f, sidecar({ message_id: mid("m3"), subject: "Re: Interview", direction: "out", date: "2026-01-15T09:00:00.000Z" }));
    expect(refreshIndex(root, [f])).toMatchObject({ mode: "incremental", emails: 2 });
    expect(rows(root)).toHaveLength(3);
  });
  it("drops a deleted company message", () => {
    const { root, a, L } = seeded();
    const f = path.join(L.companyEmailsDir(a.company_slug), "2026-01-13-hello-from-acme-bbbbbb.json");
    fs.rmSync(f);
    refreshIndex(root, [f]);
    expect(rows(root).map((r) => r.subject)).toEqual(["Interview for AI Engineer"]);
  });
  it("reports a broken sidecar and keeps going", () => {
    const { root, a, L } = seeded();
    const f = path.join(L.jobEmailsDir(a.company_slug, a.id), "2026-01-16-broken-dddddd.json");
    fs.writeFileSync(f, "{");
    const r = refreshIndex(root, [f]);
    expect(r.skipped.map((s) => s.file)).toContain(path.relative(root, f));
    expect(rows(root)).toHaveLength(2);
  });
  it("ignores drafts and saved attachments next to the messages", () => {
    const { root, a, L } = seeded();
    fs.mkdirSync(L.draftsDir(a.company_slug, a.id), { recursive: true });
    fs.writeFileSync(path.join(L.draftsDir(a.company_slug, a.id), "d1.md"), "To: x\n\nHi\n");
    expect(buildIndex(root).emails).toBe(2);
  });
  it("rebuilds an index made before the emails table existed", () => {
    const { root, a, L } = seeded();
    const db = openIndex(root);
    db.exec("DROP TABLE emails");
    db.close();
    expect(refreshIndex(root, [L.jobFile(a.company_slug, a.id)]).mode).toBe("full");
    expect(rows(root)).toHaveLength(2);
  });
});
