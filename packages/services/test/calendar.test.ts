import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout, readRecord } from "@careeros/core";
import { HANDLERS, MUTATION_AREAS } from "../src/dispatch.js";
import { readHandlers as R } from "../src/read.js";
import { jobExtraHandlers as X } from "../src/job-extras.js";
import { openSample } from "./helpers.js";

const ACME = ["acme-corp", "2026-01-12-ai-engineer"] as const;
const LABS = ["example-labs", "2026-01-12-backend-engineer-llm"] as const;

describe("interview date and Add to Calendar", () => {
  it("saves the interview time through the store, notes it once, and clears it", () => {
    const { ctx, root } = openSample();
    const d = X["jobs.setInterview"](ctx, ...ACME, "2026-01-21T14:30");
    expect(d.job.interview_at).toBe("2026-01-21T14:30");
    X["jobs.setInterview"](ctx, ...ACME, "2026-01-21T14:30");
    const rec = readRecord("job", layout(root).jobFile(...ACME));
    expect(rec.timeline.filter((e) => e.event === "Interview set")).toEqual([expect.objectContaining({ note: "2026-01-21 14:30" })]);
    expect(X["jobs.setInterview"](ctx, ...ACME, "").job.interview_at).toBe("");
    expect(R["jobs.get"](ctx, ...ACME).job.timeline.at(-1)?.event).toBe("Interview cleared");
  });

  it("writes an .ics file into the job folder and opens it with the computer", async () => {
    const { ctx, root, host } = openSample();
    await expect(X["jobs.addToCalendar"](ctx, ...ACME, "interview")).rejects.toThrow(/Set the interview date and time first/);
    X["jobs.setInterview"](ctx, ...ACME, "2026-01-21T14:30");
    await X["jobs.addToCalendar"](ctx, ...ACME, "interview");
    const file = path.join(layout(root).jobDir(...ACME), "calendar", "interview.ics");
    expect(host.shell.openedPaths).toEqual([file]);
    const ics = fs.readFileSync(file, "utf8");
    expect(ics).toContain("DTSTART:20260121T143000\r\n");
    expect(ics).toContain("SUMMARY:Interview: AI Engineer at Acme Corp\r\n");
    expect(ics).toContain("UID:interview-acme-corp-2026-01-12-ai-engineer.jobcairn\r\n");
  });

  it("makes a follow-up event only once the job is Applied", async () => {
    const { ctx, root, host } = openSample();
    await expect(X["jobs.addToCalendar"](ctx, ...LABS, "follow_up")).rejects.toThrow(/once you've applied/);
    R["jobs.setStatus"](ctx, ...LABS, "Applied", "");
    await X["jobs.addToCalendar"](ctx, ...LABS, "follow_up");
    const file = path.join(layout(root).jobDir(...LABS), "calendar", "follow-up.ics");
    expect(host.shell.openedPaths).toEqual([file]);
    expect(fs.readFileSync(file, "utf8")).toMatch(/DTSTART;VALUE=DATE:202601(22|23)\r\n/);
  });

  it("refuses to write through a link in the job folder", async () => {
    const { ctx, root } = openSample();
    X["jobs.setInterview"](ctx, ...ACME, "2026-01-21T14:30");
    const dir = path.join(layout(root).jobDir(...ACME), "calendar");
    fs.symlinkSync(fs.mkdtempSync(path.join(path.dirname(root), "elsewhere-")), dir);
    await expect(X["jobs.addToCalendar"](ctx, ...ACME, "interview")).rejects.toThrow(/is a link/);
  });

  it("is wired into dispatch", () => {
    expect(HANDLERS).toHaveProperty(["jobs.setInterview"]);
    expect(HANDLERS).toHaveProperty(["jobs.addToCalendar"]);
    expect(MUTATION_AREAS["jobs.setInterview"]).toContain("jobs");
  });
});
