import fs from "node:fs";
import path from "node:path";
import { insideRoot } from "./paths.js";
import { readRecord, RecordError } from "./store.js";
import type { VideoRecord } from "./types.js";

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
/** Workspace-relative video folders: recaps/<YYYY>-W<ww>, or 1 to 3 plain segments under a topic, company or job folder. */
export const VIDEO_FOLDER_RE = new RegExp(
  `^(?:recaps/\\d{4}-W\\d{2}(?:-\\d{4}-\\d{2}-\\d{2}(?:-\\d{1,2})?)?|(?:learning/${SLUG}|companies/${SLUG}(?:/jobs/${SLUG})?)(?:/[a-z0-9][a-z0-9_-]{0,60}){1,3})$`,
);

/** The only top-level names a video folder may hold. Delete refuses folders with anything else in them. */
export const VIDEO_ARTIFACTS: ReadonlySet<string> = new Set([
  "request.json", "video.json", "script.txt", "spec.json", "sources.md", "notes.md", "pitch.md", "stats.json", "factcheck.json",
  "narration.wav", "narration.timing.json", "transcript.raw.json", "transcript.json", "captions.srt", "captions.vtt",
  "contact-sheet.jpg", "comp", "renders", "work", "snapshots", "qa", "narration-cache", "credits.md",
]);

export function isVideoFolderRel(rel: string): boolean {
  return typeof rel === "string" && rel.length <= 300 && VIDEO_FOLDER_RE.test(rel);
}

/** Every folder under learning/, companies/ and recaps/ that holds a video.json. Never follows links or enters hidden folders. */
export function listVideoFolders(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    const matched = entries.some((e) => e.isFile() && e.name === "video.json") && isVideoFolderRel(rel);
    // Return on match without descending: once a folder is a video folder, its
    // artifact subfolders (comp/renders/work/snapshots) are never reached, so a
    // company or topic slug named "media", "vendor" etc. is never skipped either -
    // that name check only ever applied above this, on the way down.
    if (matched) { out.push(rel); return; }
    if (depth >= 7) return;
    for (const e of entries) {
      // Dirent.isDirectory() is false for symlinks, so links are never followed.
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      walk(`${rel}/${e.name}`, depth + 1);
    }
  };
  for (const top of ["learning", "companies", "recaps"]) {
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(root, top)); } catch { continue; }
    if (st.isDirectory() && !st.isSymbolicLink()) walk(top, 1);
  }
  return out.sort();
}

export const VIDEOS_DDL = `CREATE TABLE IF NOT EXISTS videos (folder TEXT PRIMARY KEY, type TEXT, title TEXT, status TEXT, subject_kind TEXT,
  company_slug TEXT, job_id TEXT, topic TEXT, week TEXT, length_s REAL, created_at TEXT, updated_at TEXT, final TEXT, draft TEXT,
  captions TEXT, used_locked INTEGER, json TEXT);`;

interface Stmt { run(...args: (string | number | null)[]): unknown }
interface DbLike { prepare(sql: string): Stmt }

/** Inserts one row per video.json. Broken records are reported in `skipped`, never thrown. */
export function indexVideos(db: DbLike, root: string, skipped: { file: string; problems: string[] }[]): number {
  const ins = db.prepare(`INSERT OR REPLACE INTO videos VALUES (${Array(17).fill("?").join(", ")})`);
  let n = 0;
  for (const rel of listVideoFolders(root)) {
    const file = path.join(root, rel, "video.json");
    if (!insideRoot(root, file)) { skipped.push({ file: `${rel}/video.json`, problems: ["outside the workspace"] }); continue; }
    let v: VideoRecord;
    try { v = readRecord("video", file); } catch (e) {
      if (e instanceof RecordError) { skipped.push({ file: `${rel}/video.json`, problems: e.problems }); continue; }
      throw e;
    }
    ins.run(
      rel, v.type, v.title, v.status, v.subject.kind, v.subject.company_slug ?? null, v.subject.id ?? null, v.subject.topic ?? null,
      v.subject.week ?? null, v.length_s, v.created_at, v.updated_at, v.renders.final?.path ?? null, v.renders.draft?.path ?? null,
      v.captions.style, v.locked_facts.length ? 1 : 0, JSON.stringify(v),
    );
    n++;
  }
  return n;
}
