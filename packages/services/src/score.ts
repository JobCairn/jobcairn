import fs from "node:fs";
import path from "node:path";
import { insideRoot, SCORE_JSON } from "@careeros/core";
import { pickScore, type JobRecord, type ScoreResult } from "@careeros/contract";

const MAX = 256 * 1024;
function readSmall(root: string, file: string): string {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= MAX && insideRoot(root, file) ? fs.readFileSync(file, "utf8") : "";
  } catch { return ""; }
}

/**
 * A job's score for the Score card: score.json (the score_record tool's result), else the record's own scores, else
 * a fit read from an older score.md. Null when the job isn't scored. `jobDir` is the job's absolute folder.
 */
export function jobScore(root: string, jobDir: string, job: Pick<JobRecord, "scores" | "timeline">): ScoreResult | null {
  const raw = readSmall(root, path.join(jobDir, SCORE_JSON));
  let json: unknown = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
  return pickScore({ json, md: readSmall(root, path.join(jobDir, "score.md")), timeline: job.timeline, scores: job.scores });
}
