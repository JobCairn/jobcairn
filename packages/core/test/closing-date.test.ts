import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { newJob } from "../src/jobs.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { validateWorkspace } from "../src/validate.js";
import { tmpDir } from "./helpers.js";

const NOW = new Date(2026, 9, 17, 11, 0);
function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: NOW }); return root; }
const job = (root: string, r: { company_slug: string; id: string }) => readRecord("job", layout(root).jobFile(r.company_slug, r.id));

describe("a job's closing date", () => {
  it("is saved from the value Claude read", () => {
    const root = ws();
    expect(job(root, newJob(root, { company: "Acme Corp", title: "AI Engineer", closes: "Friday 31 October" }, { now: NOW })).closes_on).toBe("2026-10-31");
  });

  it("is read from the ad's own words when no value is given", () => {
    const root = ws();
    const j = job(root, newJob(root, { company: "Acme Corp", title: "AI Engineer", jd_text: "Build agents.\n\nApplications close 7/11/2026." }, { now: NOW }));
    expect(j.closes_on).toBe("2026-11-07");
  });

  it("is left out when the ad states none, and the record stays valid", () => {
    const root = ws();
    const j = job(root, newJob(root, { company: "Acme Corp", title: "AI Engineer", closes: "ASAP", jd_text: "Build agents." }, { now: NOW }));
    expect("closes_on" in j).toBe(false);
    expect(validateWorkspace(root)).toEqual([]);
  });

  it("seen again: a missing closing date is filled, one already there is kept", () => {
    const root = ws();
    const first = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: NOW });
    const again = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1", closes: "2026-11-01" }, { now: NOW });
    expect(again.filled).toContain("closing date");
    newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1", closes: "2026-12-01" }, { now: NOW });
    expect(job(root, first).closes_on).toBe("2026-11-01");
  });
});
