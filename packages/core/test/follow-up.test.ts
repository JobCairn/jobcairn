import path from "node:path";
import { describe, expect, it } from "vitest";
import { localDate } from "@careeros/contract";
import { initWorkspace } from "../src/workspace.js";
import { newJob, setStatus } from "../src/jobs.js";
import { FIXED, tmpDir } from "./helpers.js";

describe("setStatus › follow-up day", () => {
  it("sets the follow-up day 7 days out when a job moves to Applied, and leaves other moves alone", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    const j = newJob(root, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/1" }, { now: FIXED });
    const saved = setStatus(root, j.company_slug, j.id, "Saved", "", { now: FIXED });
    expect(saved.custom.follow_up_on).toBeUndefined();
    const applied = setStatus(root, j.company_slug, j.id, "Applied", "", { now: FIXED });
    expect(applied.custom.follow_up_on).toBe(localDate(new Date(FIXED.getTime() + 7 * 86_400_000)));
  });
});
