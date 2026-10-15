/**
 * Read-only: how far a video's captions are from its voice, per paragraph (fix/caption-sync).
 *
 *   npx tsx packages/video/scripts/caption-drift.ts <video folder>
 *
 * Reads narration.wav (with ffmpeg silencedetect), narration.timing.json, script.txt and transcript.json from the
 * folder and prints timings only, never the words. Writes nothing. To fix a video made before this fix, render it
 * again in the app: the captions re-time themselves (the narration is reused).
 */
import fs from "node:fs";
import path from "node:path";
import { nodeProcessRunner } from "../src/process.js";
import { captionDrift, detectSilences, paragraphOfTimes, paragraphOfTokens, speechSpan, type Span } from "../src/sync.js";
import type { Word } from "../src/types.js";

const folder = process.argv[2];
if (!folder) { console.error("usage: caption-drift <video folder>"); process.exit(2); }
const abs = path.resolve(folder);
const read = (f: string) => fs.readFileSync(path.join(abs, f), "utf8");
const timing = JSON.parse(read("narration.timing.json")) as { total: number; paragraphs: Span[] };
const words = JSON.parse(read("transcript.json")) as Word[];
const script = read("script.txt");
const silences = await detectSilences(nodeProcessRunner(), process.env.FFMPEG ?? "ffmpeg", abs, "narration.wav", timing.total);
const byToken = paragraphOfTokens(script, timing.paragraphs.length);
const para = byToken && byToken.length === words.length ? byToken : paragraphOfTimes(words, timing.paragraphs);
const report = captionDrift({ words, para, paragraphs: timing.paragraphs, silences });
console.table(timing.paragraphs.map((p, k) => {
  const sp = speechSpan(p, silences);
  const start = report.points.find((x) => x.kind === "start" && x.at === sp.start);
  const end = report.points.find((x) => x.kind === "end" && x.at === sp.end);
  return { paragraph: k + 1, voice_starts: sp.start, first_caption_drift_s: start?.drift ?? null, last_caption_drift_s: end?.drift ?? null };
}));
console.log(report.message);
process.exit(report.ok ? 0 : 1);
