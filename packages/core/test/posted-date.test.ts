import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { newJob } from "../src/jobs.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { tmpDir } from "./helpers.js";

const NOW = new Date(2026, 9, 14, 15, 0);
function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: NOW }); return root; }
const job = (root: string, r: { company_slug: string; id: string }) => readRecord("job", layout(root).jobFile(r.company_slug, r.id));

describe("a job's posted date as the board said it", () => {
  it("\"3d ago\" is saved as a date counted from when it was found, marked approximate", () => {
    const root = ws();
    const j = job(root, newJob(root, { company: "Acme Corp", title: "AI Engineer", posted: "3d ago" }, { now: NOW }));
    expect(j.posted).toBe("2026-10-11");
    expect(j.posted_approx).toBe(true);
  });
  it("a stated date stays exact; words that aren't a date stay as they were (no date, never the found day)", () => {
    const root = ws();
    const a = job(root, newJob(root, { company: "Acme Corp", title: "AI Engineer", posted: "2026-10-02" }, { now: NOW }));
    expect(a.posted).toBe("2026-10-02");
    expect(a.posted_approx).toBeUndefined();
    const b = job(root, newJob(root, { company: "Example Labs", title: "Data Engineer", posted: "Hiring now" }, { now: NOW }));
    expect(b.posted).toBe("Hiring now");
  });
  it("seen again: a missing posted date is filled the same way", () => {
    const root = ws();
    const first = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: NOW });
    newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1", posted: "2 weeks ago" }, { now: NOW });
    expect(job(root, first)).toMatchObject({ posted: "2026-09-30", posted_approx: true });
  });
});
