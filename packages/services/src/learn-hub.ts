import fs from "node:fs";
import path from "node:path";
import { careerosDir, layout, readRecord, writeFileAtomic } from "@careeros/core";
import {
  gapsFrom, jobsToLearn, learnEntries, ME_DIRS, sanitizeProgress, skillGaps, skillsIn,
  type JobRecord, type JobToLearn, type LearnHub, type LearnProgress, type ProgressMap,
} from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { lockedFor } from "./integrity.js";
import { learnList } from "./learn.js";
import { jobDirRel, jobRows } from "./read.js";

/** Text read per file, and files read per folder, so a huge workspace can't stall Learn. */
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ME_FILES = 200;
const MAX_STATE_BYTES = 256 * 1024;
const TEXT_FILE = /\.(md|markdown|txt)$/i;

/** A regular, single-named file that isn't in a locked folder, or null. */
function safeFile(ctx: ServiceContext, root: string, abs: string): fs.Stats | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (!st.isFile() || st.nlink > 1) return null;
  return lockedFor(ctx, root, abs) === null ? st : null;
}

function readHead(abs: string, max = MAX_TEXT_BYTES): string {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function readText(ctx: ServiceContext, root: string, abs: string): string {
  if (!safeFile(ctx, root, abs)) return "";
  try { return readHead(abs); } catch { return ""; }
}

/** Text files under `dir`, one level of subfolders deep, skipping links, hidden names and locked folders. */
function textFiles(ctx: ServiceContext, root: string, dir: string, depth = 1, out: string[] = []): string[] {
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return out; }
  if (!st.isDirectory() || st.isSymbolicLink() || lockedFor(ctx, root, dir) !== null) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    if (out.length >= MAX_ME_FILES || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    let s: fs.Stats;
    try { s = fs.lstatSync(p); } catch { continue; }
    if (s.isDirectory() && !s.isSymbolicLink() && depth > 0) textFiles(ctx, root, p, depth - 1, out);
    else if (s.isFile() && TEXT_FILE.test(name)) out.push(p);
  }
  return out;
}

/**
 * What the person already has: the profile's keywords and the text of their own documents in me/
 * (resumes, history, projects, education). A locked folder (me/identity, me/employment) is never
 * read: lockedFor() refuses it by path and by its recorded identity, even if it was moved.
 */
export function ownSkillsText(ctx: ServiceContext, root: string): string[] {
  const L = layout(root);
  const texts: string[] = [];
  for (const d of ME_DIRS) for (const f of textFiles(ctx, root, L.me(d))) texts.push(readText(ctx, root, f));
  return texts;
}

const MAX_DOC_SKILLS = 12;

/**
 * The skills the person's own documents mention (me/, locked folders skipped), most documents first: skill names
 * from the shared keyword list only, never the documents' text. Find jobs searches and matches on them. Best effort.
 */
export function documentSkills(ctx: ServiceContext, root: string): string[] {
  let texts: string[] = [];
  try { texts = ownSkillsText(ctx, root); } catch { return []; }
  const count = new Map<string, number>();
  for (const t of texts) for (const k of skillsIn(t)) count.set(k, (count.get(k) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_DOC_SKILLS).map(([k]) => k);
}

/** The skills the person listed in their profile, one per entry. */
export function declaredSkills(root: string): string[] {
  return readRecord("profile", layout(root).profile).targets.keywords;
}

/** Whether a job has a score: score.md in its folder, or a scored date on the record. */
function isScored(ctx: ServiceContext, root: string, job: JobRecord): boolean {
  return !!job.scores.career.scored_at || safeFile(ctx, root, path.join(root, jobDirRel(job.company_slug, job.id), "score.md")) !== null;
}

export interface JobFacts extends JobToLearn { scored: boolean; eligible: boolean; status: string; found_at: string; preparing: boolean }

const PREPARING = new Set(["Applying", "Applied", "Interview", "Offer"]);
const CLOSED = new Set(["Skipped", "Rejected"]);
/** A job still in play for skill suggestions. */
export const isActiveJob = (j: { eligible: boolean; status: string }) => j.eligible && !CLOSED.has(j.status);

/**
 * Writes a small state file in .careeros. When something else sits at that name (a folder), says so
 * plainly, with the workspace-relative name only, never an absolute path.
 */
export function writeStateFile(root: string, name: string, body: string): void {
  const file = path.join(careerosDir(root), name);
  let isDir = false;
  try { isDir = fs.lstatSync(file).isDirectory(); } catch { /* missing is fine */ }
  if (isDir) throw new Error(`This setting can't be saved because .careeros/${name} is a folder. Move or delete that folder, then try again.`);
  writeFileAtomic(file, body);
}

/** Every saved job with what Learn and the checklist need, eligible and newest first. Reads each ad only when `withText` is set. */
export function jobFacts(ctx: ServiceContext, root: string, opts: { withText?: boolean } = {}): (JobFacts & { text: string })[] {
  return jobRows(root).flatMap((r) => {
    let job: JobRecord;
    try { job = readRecord("job", layout(root).jobFile(r.company_slug, r.id)) as unknown as JobRecord; } catch { return []; }
    const dir = path.join(root, jobDirRel(r.company_slug, r.id));
    const appResume = safeFile(ctx, root, path.join(dir, "application", "resume.md")) !== null;
    return [{
      company_slug: r.company_slug, id: r.id, title: r.title, company_name: r.company_name, gaps: gapsFrom(job),
      scored: isScored(ctx, root, job), eligible: r.eligible, status: r.status, found_at: r.found_at,
      preparing: PREPARING.has(r.status) || appResume,
      text: opts.withText ? `${r.title}\n${readText(ctx, root, path.join(dir, "jd.md"))}` : "",
    }];
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.found_at.localeCompare(a.found_at) || a.title.localeCompare(b.title));
}

// -- Progress sidecar (.careeros/learn-progress.json) --------------------------

const progressFile = (root: string) => path.join(root, ".careeros", "learn-progress.json");

/** Reads a small JSON state file in .careeros without following links; anything odd reads as empty. */
export function readStateFile(file: string): unknown {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink > 1 || st.size > MAX_STATE_BYTES) return {};
    return JSON.parse(readHead(file, MAX_STATE_BYTES));
  } catch { return {}; }
}

export function readProgress(root: string): ProgressMap {
  return sanitizeProgress(readStateFile(progressFile(root)));
}

function mtime(root: string): (rel: string) => string {
  return (rel) => { try { return fs.lstatSync(path.join(root, ...rel.split("/"))).mtime.toISOString(); } catch { return ""; } };
}

export function learnHub(ctx: ServiceContext): LearnHub {
  const root = ctx.requireRoot();
  const data = learnList(ctx);
  const entries = learnEntries(data, readProgress(root), mtime(root));
  const jobs = jobFacts(ctx, root, { withText: true });
  const topics = new Set(data.topics.filter((t) => t.items.length).map((t) => t.slug));
  // "Appears in N of M jobs" counts only jobs still in play: eligible, not Skipped or Rejected.
  const active = jobs.filter(isActiveJob);
  const suggestions = skillGaps({ jobs: active.map((j) => j.text), have: ownSkillsText(ctx, root), declared: declaredSkills(root), started: (s) => topics.has(s) });
  return { entries, suggestions, ...jobsToLearn(jobs.map(({ text: _t, eligible: _e, status: _s, found_at: _f, preparing: _p, ...j }) => j)), jobs: jobs.length };
}

/** Only items Learn lists can have progress; entries for files that are gone are dropped on the next write. */
function setProgress(ctx: ServiceContext, rel: string, progress: LearnProgress): LearnHub {
  const root = ctx.requireRoot();
  const listed = new Set(learnEntries(learnList(ctx), {}, () => "").map((e) => e.path));
  if (!listed.has(rel)) throw new Error("That item isn't in Learn any more.");
  const cur = readProgress(root);
  const next: ProgressMap = {};
  for (const [k, v] of Object.entries(cur)) if (listed.has(k)) next[k] = v;
  if (progress === "not_started") delete next[rel];
  else next[rel] = { state: progress, at: ctx.now().toISOString() };
  writeStateFile(root, "learn-progress.json", `${JSON.stringify(next, null, 2)}\n`);
  return learnHub(ctx);
}

export const learnHubHandlers = {
  "learn.hub": learnHub,
  "learn.setProgress": setProgress,
} satisfies Partial<HandlerTable>;
