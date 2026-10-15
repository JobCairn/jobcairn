import fs from "node:fs";
import path from "node:path";
import { legacyScoreResult, plainPaths, scoreResultFrom, type ScoreRecordArgs, type ScoreResult } from "@careeros/contract";
import { type Clock, iso } from "./clock.js";
import { jobFilePath } from "./jobs.js";
import { insideRoot } from "./paths.js";
import { updateRecord, writeFileAtomic } from "./store.js";
import type { Job } from "./types.js";

/** The structured score's file, beside the write-up (score.md) in the job's folder. */
export const SCORE_JSON = "score.json";
/** The largest score.md read for a legacy fit. */
const MAX_LEGACY_BYTES = 256 * 1024;

const plainItems = (xs: ScoreRecordArgs["must_haves"]) => xs.map((x) => ({ text: plainPaths(x.text), status: x.status, evidence: plainPaths(x.evidence) }));

/**
 * Saves a job's structured score: score.json next to score.md, and the job record's fit, must-haves and career
 * scores (so the Fit pill, the Jobs table, sorting, Home and Learn all read it), plus a "Scored" timeline event.
 * Text goes in plain words: any workspace path becomes a friendly name. Must-haves keep a `met` flag, so gap lists
 * built from the record keep working.
 */
export function recordScore(root: string, slug: string, id: string, args: ScoreRecordArgs, c?: Clock): ScoreResult {
  const file = jobFilePath(root, slug, id);
  const at = iso(c);
  const must = plainItems(args.must_haves);
  const nice = plainItems(args.nice_to_haves);
  const saved = {
    fit: args.fit, interview_odds: args.interview_odds, tier: args.tier, recommendation: plainPaths(args.recommendation),
    must_haves: must, nice_to_haves: nice, changes: args.changes.map(plainPaths), summary: plainPaths(args.summary), scored_at: at,
  };
  const out = path.join(path.dirname(file), SCORE_JSON);
  if (!insideRoot(root, out)) throw new Error("refusing to write outside the workspace");
  writeFileAtomic(out, JSON.stringify(saved, null, 2) + "\n");
  updateRecord("job", file, (j) => {
    j.scores.fit = { value: args.fit, must_haves: must.map((m) => ({ ...m, met: m.status === "met" })), nice_to_haves: nice.map((m) => ({ ...m, met: m.status === "met" })) };
    j.scores.career = { match: args.fit, odds: args.interview_odds, tier: args.tier, scored_at: at };
    j.timeline.push({ at, event: "Scored", note: `Fit ${args.fit}/100 · ${args.tier}` });
  });
  return scoreResultFrom(saved)!;
}

function readSmall(file: string, max: number): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, "utf8");
  } catch { return null; }
}

/** score.json in a job folder as a result, or null when it is missing or doesn't read as one. */
export function readScoreJson(root: string, jobDir: string): ScoreResult | null {
  const f = path.join(jobDir, SCORE_JSON);
  if (!insideRoot(root, f)) return null;
  const text = readSmall(f, MAX_LEGACY_BYTES);
  if (text === null) return null;
  try { return scoreResultFrom(JSON.parse(text)); } catch { return null; }
}

/** A fit read from an older score.md (no score.json), or null. Never guesses. */
export function readLegacyScore(root: string, jobDir: string, scoredAt = ""): ScoreResult | null {
  const f = path.join(jobDir, "score.md");
  if (!insideRoot(root, f)) return null;
  const text = readSmall(f, MAX_LEGACY_BYTES);
  return text === null ? null : legacyScoreResult(text, scoredAt);
}

/**
 * The job record as the index should see it: when the record has no fit but an older score.md names one, that fit
 * (and interview odds and tier when named) fills the gaps. The record on disk is not changed.
 */
export function withLegacyFit(root: string, jobDir: string, j: Job): Job {
  if (j.scores.fit.value !== null || j.scores.career.match !== null) return j;
  const legacy = readLegacyScore(root, jobDir);
  if (!legacy || legacy.fit === null) return j;
  return {
    ...j,
    scores: {
      ...j.scores,
      fit: { ...j.scores.fit, value: legacy.fit },
      career: { ...j.scores.career, match: legacy.fit, odds: j.scores.career.odds ?? legacy.interview_odds, tier: j.scores.career.tier || legacy.tier },
    },
  };
}
