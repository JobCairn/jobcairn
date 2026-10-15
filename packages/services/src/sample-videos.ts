import fs from "node:fs";
import path from "node:path";
import { addEvent, readRecord, writeRecord, type VideoRecord } from "@careeros/core";
import { isoWeek, weekRange } from "@careeros/video";
import type { ExampleClock } from "./sample-shared.js";

/**
 * The example's sample videos: real renders made with the app's own pipeline from scripts about the fictional example
 * (test/example-videos.render.test.ts makes them). They live in `.example-seed/videos/<name>/` and are copied into
 * the example at their video folders, dated "N days ago". Their subjects use the bundled Acme Corp job (its id is
 * fixed) and a learning topic, so the folders never change. None of them says a date. The weekly recap is for "this
 * week": its folder and week are worked out when the example opens (WEEK below), and it only says "this week".
 */
export const WEEK = "{week}";
export const EXAMPLE_VIDEOS: {
  name: string; type: string; label: string;
  subject: { kind: "job"; company_slug: string; id: string } | { kind: "topic"; topic: string } | { kind: "week"; week: string };
  folder: string; length_s: number; ago: number;
}[] = [
  {
    name: "acme-jd-walkthrough", type: "jd-walkthrough", label: "JD walkthrough", subject: { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" },
    folder: "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1", length_s: 50, ago: 3,
  },
  {
    name: "acme-pitch", type: "pitch", label: "Pitch", subject: { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" },
    folder: "companies/acme-corp/jobs/2026-01-12-ai-engineer/interview/pitch-1", length_s: 45, ago: 1,
  },
  {
    name: "evaluating-llm-apps-lesson", type: "skill-gap-lesson", label: "Skill-gap lesson", subject: { kind: "topic", topic: "Evaluating LLM apps" },
    folder: "learning/evaluating-llm-apps/videos/1", length_s: 50, ago: 4,
  },
  {
    name: "weekly-recap", type: "weekly-recap", label: "Weekly recap", subject: { kind: "week", week: WEEK },
    folder: `recaps/${WEEK}`, length_s: 50, ago: 0,
  },
];

/** The example video's folder and subject, with "this week" filled in for the recap. */
export function exampleVideoAt(v: (typeof EXAMPLE_VIDEOS)[number], now: Date): { folder: string; subject: (typeof EXAMPLE_VIDEOS)[number]["subject"] } {
  if (v.subject.kind !== "week") return { folder: v.folder, subject: v.subject };
  const week = isoWeek(now);
  return { folder: v.folder.replace(WEEK, week), subject: { kind: "week", week } };
}

/** What a finished video folder keeps in the seed: the record, script, scene spec, captions, poster and the render. */
export const SEED_VIDEO_FILES = [
  "video.json", "request.json", "script.txt", "spec.json", "sources.md", "notes.md", "pitch.md", "factcheck.json",
  "captions.srt", "captions.vtt", "contact-sheet.jpg", "stats.json", "renders/final.mp4",
];

/** Copies each rendered sample video into the example, with its dates moved to "N days ago". Missing ones are skipped. */
export function seedExampleVideos(root: string, seed: string, k: ExampleClock): void {
  for (const v of EXAMPLE_VIDEOS) {
    const from = path.join(seed, "videos", v.name);
    if (!fs.existsSync(path.join(from, "video.json")) || !fs.existsSync(path.join(from, "renders", "final.mp4"))) continue;
    const made = k.at(v.ago, 20, 30);
    const at = exampleVideoAt(v, made);
    const to = path.join(root, ...at.folder.split("/"));
    for (const rel of SEED_VIDEO_FILES) {
      const src = path.join(from, ...rel.split("/"));
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(path.join(to, ...rel.split("/"))), { recursive: true });
      fs.copyFileSync(src, path.join(to, ...rel.split("/")));
    }
    const file = path.join(to, "video.json");
    if (at.subject.kind === "week") {
      // The recap was rendered in some other week: its files name that week's folder. Point them at this one.
      const was = (readRecord("video", file) as VideoRecord).subject;
      const week = at.subject.week;
      if (was.kind === "week" && was.week && was.week !== week) {
        const old = was.week;
        for (const rel of SEED_VIDEO_FILES.filter((f) => /\.(json|md|txt)$/.test(f))) {
          const f = path.join(to, rel);
          if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, "utf8").split(old).join(week));
        }
      }
    }
    const rec = readRecord("video", file) as VideoRecord;
    const when = made.toISOString();
    rec.created_at = new Date(made.getTime() - 4 * 60_000).toISOString();
    rec.updated_at = when;
    if (rec.renders.final) rec.renders.final = { ...rec.renders.final, at: when };
    rec.renders.draft = null;
    for (const s of Object.values(rec.stages)) if (s.at) s.at = when;
    if (at.subject.kind === "week") {
      rec.subject = at.subject;
      const stats = path.join(to, "stats.json");
      if (fs.existsSync(stats)) fs.writeFileSync(stats, JSON.stringify({ ...JSON.parse(fs.readFileSync(stats, "utf8")), week: at.subject.week, ...weekRange(at.subject.week) }, null, 2) + "\n");
    }
    if (rec.last_run) rec.last_run = { ...rec.last_run, started_at: rec.created_at };
    writeRecord("video", file, rec);
    for (const f of [file, path.join(to, "renders", "final.mp4")]) fs.utimesSync(f, made, made);
    if (v.subject.kind === "job") addEvent(root, v.subject.company_slug, v.subject.id, "Video made", v.label, { now: made });
  }
}
