import fs from "node:fs";
import path from "node:path";
import { isVideoFolderRel, type VideoRecord } from "@careeros/core";
import { VIDEO_TYPE_RE, type VideoSubjectArg } from "@careeros/contract";

/**
 * How long making a video took: the sum of its steps' times in video.json. Reused steps count as 0 ms in the record,
 * so this is the time this video's own runs spent. Undefined when no step has a time.
 */
export function makingMs(rec: Pick<VideoRecord, "stages">): number | undefined {
  let sum = 0;
  for (const st of Object.values(rec.stages ?? {})) {
    const ms = Number((st as { ms?: unknown } | undefined)?.ms);
    if (Number.isFinite(ms) && ms > 0) sum += ms;
  }
  return sum > 0 ? Math.round(sum) : undefined;
}

/** Fixed names only, in order of preference: never a path taken from the record. */
const POSTERS = ["contact-sheet.jpg", "qa/frame-1.jpg"] as const;

/** The still to show for a video folder, as a workspace path, or null when it has none. Links are not followed. */
export function posterFor(root: string, folder: string): string | null {
  for (const name of POSTERS) {
    try {
      if (fs.lstatSync(path.join(root, folder, name)).isFile()) return `${folder}/${name}`;
    } catch { /* not there */ }
  }
  return null;
}

/** A folder with a script but no video.json: made before videos were built into the app. */
export interface LegacyVideo { folder: string; type: string; subject: VideoSubjectArg; created_at: string }

const isDir = (p: string) => { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const isFile = (p: string) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
const dirs = (p: string) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch { return []; } };

/** The video type of an older folder: spec.json's "type" when it is a plain id, else the folder name without "-N". */
function legacyType(abs: string, name: string, fallback: string): string {
  try {
    const t = (JSON.parse(fs.readFileSync(path.join(abs, "spec.json"), "utf8")) as { type?: unknown }).type;
    if (typeof t === "string" && t.length <= 40 && VIDEO_TYPE_RE.test(t)) return t;
  } catch { /* unreadable spec: use the name */ }
  const base = name.replace(/-\d+$/, "");
  return base !== name && VIDEO_TYPE_RE.test(base) ? base : fallback;
}

/**
 * Older video folders in the places videos are made (a job's videos/, a company's videos/, a Learn topic's videos/)
 * that hold script.txt but no video.json. The pipeline lists only folders with a video.json, so these were invisible.
 */
export function listLegacyVideos(root: string): LegacyVideo[] {
  const out: LegacyVideo[] = [];
  const visit = (folder: string, type: string, subject: VideoSubjectArg) => {
    if (!isVideoFolderRel(folder)) return;
    const abs = path.join(root, folder);
    if (!isDir(abs) || isFile(path.join(abs, "video.json")) || !isFile(path.join(abs, "script.txt"))) return;
    let created_at = "";
    try { created_at = fs.statSync(path.join(abs, "script.txt")).mtime.toISOString(); } catch { created_at = ""; }
    out.push({ folder, type: legacyType(abs, folder.split("/").pop()!, type), subject, created_at });
  };
  const companies = path.join(root, "companies");
  if (isDir(companies)) {
    for (const slug of dirs(companies)) {
      for (const name of dirs(path.join(companies, slug, "videos"))) visit(`companies/${slug}/videos/${name}`, "company-briefing", { kind: "company", company_slug: slug });
      for (const id of dirs(path.join(companies, slug, "jobs"))) {
        for (const name of dirs(path.join(companies, slug, "jobs", id, "videos"))) visit(`companies/${slug}/jobs/${id}/videos/${name}`, "jd-walkthrough", { kind: "job", company_slug: slug, id });
      }
    }
  }
  const learning = path.join(root, "learning");
  if (isDir(learning)) {
    for (const topic of dirs(learning)) {
      for (const name of dirs(path.join(learning, topic, "videos"))) visit(`learning/${topic}/videos/${name}`, "skill-gap-lesson", { kind: "topic", topic });
    }
  }
  return out;
}
