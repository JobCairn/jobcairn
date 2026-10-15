import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { newJob } from "../src/jobs.js";
import { readRecord } from "../src/store.js";
import { layout } from "../src/paths.js";
import { buildIndex, openIndex } from "../src/index-db.js";
import { readLegacyScore, readScoreJson, recordScore } from "../src/score.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }
const ARGS = {
  fit: 72, interview_odds: 60, tier: "Good Fit" as const, recommendation: "Apply. See me/history/profile.md.",
  must_haves: [
    { text: "Python", status: "met" as const, evidence: "me/resumes/alex-example.pdf shows four years." },
    { text: "Kafka", status: "not_met" as const, evidence: "" },
  ],
  nice_to_haves: [{ text: "Go", status: "partial" as const, evidence: "A side project." }],
  changes: ["A Kafka project"], summary: "Strong match for Acme Corp (Workflow 2, job evaluation).",
};

describe("recordScore", () => {
  it("writes score.json, sets the record's scores, marks met, and logs Scored, all in plain words", () => {
    const root = ws();
    const j = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const r = recordScore(root, j.company_slug, j.id, ARGS, { now: FIXED });
    expect(r).toMatchObject({ fit: 72, interview_odds: 60, tier: "Good Fit", source: "structured", scored_at: "2026-01-15T09:30:00.000Z" });
    expect(r.recommendation).toBe("Apply. See your profile.");
    expect(r.summary).toBe("Strong match for Acme Corp.");
    const dir = layout(root).jobDir(j.company_slug, j.id);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "score.json"), "utf8"));
    expect(saved.must_haves[0].evidence).toBe("your resume shows four years.");
    expect(JSON.stringify(saved)).not.toMatch(/me\/|\.pdf|\.md/);
    const rec = readRecord("job", layout(root).jobFile(j.company_slug, j.id));
    expect(rec.scores.fit.value).toBe(72);
    expect(rec.scores.fit.must_haves).toEqual([
      { text: "Python", status: "met", evidence: "your resume shows four years.", met: true },
      { text: "Kafka", status: "not_met", evidence: "", met: false },
    ]);
    expect(rec.scores.career).toEqual({ match: 72, odds: 60, tier: "Good Fit", scored_at: "2026-01-15T09:30:00.000Z" });
    expect(rec.timeline.at(-1)).toEqual({ at: "2026-01-15T09:30:00.000Z", event: "Scored", note: "Fit 72/100 · Good Fit" });
    expect(readScoreJson(root, dir)).toMatchObject({ fit: 72, tier: "Good Fit" });
  });
  it("refuses a job that doesn't exist", () => {
    expect(() => recordScore(ws(), "acme-corp", "nope", ARGS)).toThrow(/no job/);
  });
});

describe("legacy score.md", () => {
  it("reads a fit from score.md, and the index uses it for an unscored record", () => {
    const root = ws();
    const j = newJob(root, { company: "Example Labs", title: "Backend Engineer" }, { now: FIXED });
    const dir = layout(root).jobDir(j.company_slug, j.id);
    fs.writeFileSync(path.join(dir, "score.md"), "# Score\n\n**Fit score: 52 / 100**\n\n| # | Must-have | Status |\n|---|---|---|\n");
    expect(readLegacyScore(root, dir)).toMatchObject({ fit: 52, source: "legacy" });
    expect(readScoreJson(root, dir)).toBeNull();
    buildIndex(root);
    const db = openIndex(root);
    const row = db.prepare("SELECT fit, json FROM jobs").get() as { fit: number; json: string };
    db.close();
    expect(row.fit).toBe(52);
    expect(JSON.parse(row.json).scores.fit.value).toBe(52);
    // The record on disk is unchanged.
    expect(readRecord("job", layout(root).jobFile(j.company_slug, j.id)).scores.fit.value).toBeNull();
  });
  it("leaves the fit unset when score.md has no clear number", () => {
    const root = ws();
    const j = newJob(root, { company: "Example Labs", title: "Engineer" }, { now: FIXED });
    const dir = layout(root).jobDir(j.company_slug, j.id);
    fs.writeFileSync(path.join(dir, "score.md"), "Looks fine overall.\n");
    expect(readLegacyScore(root, dir)).toBeNull();
    buildIndex(root);
    const db = openIndex(root);
    expect((db.prepare("SELECT fit FROM jobs").get() as { fit: number | null }).fit).toBeNull();
    db.close();
  });
});
