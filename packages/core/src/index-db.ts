import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isEligible, pinRank } from "./eligibility.js";
import { type EmailSkip, readEmails } from "./emails.js"; // 3b
import { listJobs, type ListJobsSkip } from "./jobs.js";
import { readSearches } from "./knowledge.js";
import { insideRoot, layout } from "./paths.js";
import { readRecord, RecordError } from "./store.js";
import { withLegacyFit } from "./score.js";
import type { Company, Job, WorkRightsStatus } from "./types.js";
import { indexVideos, VIDEOS_DDL } from "./videos.js";

const require = createRequire(import.meta.url);
// Loaded through require so test runners that don't know node:sqlite as a builtin still work.
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type Db = InstanceType<typeof DatabaseSync>;
type JobRef = { company_slug: string; id: string; file: string };

export interface IndexReport { jobs: number; companies: number; events: number; searches: number; emails: number; skipped: { file: string; problems: string[] }[] }
export interface RefreshReport extends IndexReport { mode: "full" | "incremental" }
export interface RefreshPlan { full: boolean; companies: Set<string>; companyJobs: Set<string>; jobs: Set<string>; companyEmails: Set<string>; searches: boolean; videos: boolean }

// 3b: kept in sync with the tables in DDL below; used to detect an index built before a
// table existed (e.g. emails), which forces a full rebuild instead of an incremental one.
const TABLES = ["jobs", "companies", "events", "searches", "emails"];
const DDL = `
CREATE TABLE jobs (company_slug TEXT, id TEXT, company_name TEXT, client TEXT, title TEXT, source TEXT, source_site TEXT,
  url TEXT, posted TEXT, found_at TEXT, location TEXT, work_mode TEXT, job_type TEXT, salary_text TEXT, wr_label TEXT,
  fit REAL, sponsor REAL, career_match REAL, career_odds REAL, career_tier TEXT, status TEXT, eligible INTEGER,
  pinned INTEGER, last_activity TEXT, json TEXT, PRIMARY KEY (company_slug, id));
CREATE TABLE companies (slug TEXT PRIMARY KEY, name TEXT, type TEXT, big_tech INTEGER, sponsor_status TEXT);
CREATE TABLE events (company_slug TEXT, job_id TEXT, at TEXT, event TEXT, note TEXT);
CREATE TABLE searches (at TEXT, site TEXT, query TEXT, location TEXT, results TEXT, kept TEXT, notes TEXT);
CREATE TABLE emails (company_slug TEXT, job_id TEXT, file TEXT PRIMARY KEY, direction TEXT, date TEXT, subject TEXT,
  from_name TEXT, from_addr TEXT, thread_key TEXT, attachments INTEGER, opened INTEGER, matched_by TEXT);
CREATE INDEX jobs_status ON jobs(status);
CREATE INDEX events_at ON events(at);
CREATE INDEX emails_date ON emails(date);
`;

export function openIndex(root: string): Db {
  return new DatabaseSync(layout(root).indexDb);
}

interface Ctx { root: string; report: IndexReport; status: WorkRightsStatus; db: Db }

function emptyReport(): IndexReport { return { jobs: 0, companies: 0, events: 0, searches: 0, emails: 0, skipped: [] }; }
const rel = (root: string, f: string) => path.relative(root, f);

function skipError(ctx: Ctx, e: unknown): void {
  if (e instanceof RecordError) ctx.report.skipped.push({ file: rel(ctx.root, e.file), problems: e.problems });
  else throw e;
}

function profileStatus(root: string, report: IndexReport): WorkRightsStatus {
  try { return readRecord("profile", layout(root).profile).work_rights.status; }
  catch (e) {
    if (e instanceof RecordError) { report.skipped.push({ file: rel(root, e.file), problems: e.problems }); return "unknown"; }
    throw e;
  }
}

// 3b: one row per message sidecar; id "" is the company's own mail.
function indexEmails(ctx: Ctx, slug: string, id: string): void {
  const skipped: EmailSkip[] = [];
  const ins = ctx.db.prepare("INSERT OR REPLACE INTO emails VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const { ref, email: e } of readEmails(ctx.root, slug, id, skipped)) {
    ins.run(slug, id, ref.rel, e.direction, e.date, e.subject, e.from.name, e.from.address, e.thread_key,
      e.attachments.filter((a) => !a.inline).length, e.opened_at ? 1 : 0, e.matched_by);
    ctx.report.emails++;
  }
  ctx.report.skipped.push(...skipped);
}

/** Inserts one company row. Returns its display name, or null if there is no usable record. */
function indexCompany(ctx: Ctx, slug: string): string | null {
  const L = layout(ctx.root);
  const companyDir = L.companyDir(slug);
  if (!fs.existsSync(companyDir)) return null;
  // Security: never read through a folder that resolves outside the workspace.
  if (!insideRoot(ctx.root, companyDir)) {
    ctx.report.skipped.push({ file: rel(ctx.root, companyDir), problems: ["outside the workspace"] });
    return null;
  }
  const f = L.companyFile(slug);
  if (!fs.existsSync(f)) return null;
  let c: Company;
  try { c = readRecord("company", f); } catch (e) { skipError(ctx, e); return null; }
  ctx.db.prepare("INSERT INTO companies VALUES (?, ?, ?, ?, ?)").run(slug, c.name, c.type, c.big_tech ? 1 : 0, c.sponsor.status);
  ctx.report.companies++;
  indexEmails(ctx, slug, ""); // 3b
  return c.name;
}

function indexJob(ctx: Ctx, ref: JobRef, companyName: string): void {
  // Security: a job or company folder may be a symlink redirecting outside the workspace.
  if (!insideRoot(ctx.root, ref.file)) {
    ctx.report.skipped.push({ file: rel(ctx.root, ref.file), problems: ["outside the workspace"] });
    return;
  }
  let j: Job;
  try { j = readRecord("job", ref.file); } catch (e) { skipError(ctx, e); return; }
  // An older score.md with no structured score: its "Fit score NN / 100" fills an empty fit (the record is unchanged).
  j = withLegacyFit(ctx.root, path.dirname(ref.file), j);
  const last = j.timeline.reduce((m, ev) => (ev.at > m ? ev.at : m), j.found_at);
  ctx.db.prepare(`INSERT INTO jobs VALUES (${Array(25).fill("?").join(", ")})`).run(
    ref.company_slug, ref.id, companyName, j.client, j.title, j.source, j.source_site,
    j.url, j.posted, j.found_at, j.location, j.work_mode, j.job_type, j.salary.text, j.work_rights.label,
    j.scores.fit.value, j.scores.sponsor.value, j.scores.career.match, j.scores.career.odds, j.scores.career.tier,
    j.status, isEligible(ctx.status, j.work_rights.label) ? 1 : 0, pinRank(j.work_rights.label), last, JSON.stringify(j),
  );
  ctx.report.jobs++;
  const insEvent = ctx.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)");
  for (const ev of j.timeline) { insEvent.run(ref.company_slug, ref.id, ev.at, ev.event, ev.note ?? ""); ctx.report.events++; }
  indexEmails(ctx, ref.company_slug, ref.id); // 3b
}

function indexSearches(ctx: Ctx): void {
  const insSearch = ctx.db.prepare("INSERT INTO searches VALUES (?, ?, ?, ?, ?, ?, ?)");
  const { entries, badLines } = readSearches(ctx.root);
  for (const s of entries) { insSearch.run(s.at, s.site, s.query, s.location, s.results, s.kept, s.notes); ctx.report.searches++; }
  if (badLines.length) ctx.report.skipped.push({ file: rel(ctx.root, layout(ctx.root).searchLog), problems: badLines.map((n) => `line ${n} is not valid JSON`) });
}

export function buildIndex(root: string): IndexReport {
  const L = layout(root);
  const report = emptyReport();
  const status = profileStatus(root, report);
  fs.mkdirSync(path.dirname(L.indexDb), { recursive: true });
  const tmp = `${L.indexDb}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  const ctx: Ctx = { root, report, status, db };
  try {
    db.exec(DDL);
    db.exec(VIDEOS_DDL);
    db.exec("BEGIN");
    const names = new Map<string, string>();
    if (fs.existsSync(L.companiesDir)) {
      for (const slug of fs.readdirSync(L.companiesDir).sort()) {
        const name = indexCompany(ctx, slug);
        if (name !== null) names.set(slug, name);
      }
    }
    const jobSkips: ListJobsSkip[] = [];
    for (const ref of listJobs(root, jobSkips)) indexJob(ctx, ref, names.get(ref.company_slug) ?? ref.company_slug);
    for (const s of jobSkips) report.skipped.push({ file: rel(root, s.file), problems: [s.problem] });
    indexSearches(ctx);
    indexVideos(db, root, report.skipped);
    db.exec("COMMIT");
  } catch (e) {
    db.close();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  db.close();
  fs.renameSync(tmp, L.indexDb);
  return report;
}

const VIDEO_PARTS = new Set(["videos", "interview", "summary-video"]);

export function planRefresh(relPaths: string[]): RefreshPlan {
  const plan: RefreshPlan = { full: false, companies: new Set(), companyJobs: new Set(), jobs: new Set(), companyEmails: new Set(), searches: false, videos: false };
  for (const raw of relPaths) {
    const r = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (r.startsWith("..")) continue;
    const parts = r.split("/");
    if (parts.at(-1) === "video.json" || parts[0] === "learning" || parts[0] === "recaps" || parts.some((p) => VIDEO_PARTS.has(p))) plan.videos = true;
    if (r === "" || r === "." || r === "workspace.json" || parts[0] === "settings" || r === "companies") { plan.full = true; continue; }
    if (parts[0] === "knowledge" && (parts.length === 1 || parts[1] === "search-log.jsonl")) { plan.searches = true; continue; }
    if (parts[0] !== "companies" || !parts[1]) continue;
    const slug = parts[1];
    if (parts.length === 2) { plan.companies.add(slug); plan.companyJobs.add(slug); }
    else if (parts[2] === "company.json") plan.companies.add(slug);
    else if (parts[2] === "emails") plan.companyEmails.add(slug); // 3b
    else if (parts[2] === "jobs" && parts.length === 3) plan.companyJobs.add(slug);
    else if (parts[2] === "jobs" && parts[3]) plan.jobs.add(`${slug}/${parts[3]}`);
  }
  return plan;
}

export function refreshIndex(root: string, changedPaths: string[]): RefreshReport {
  const L = layout(root);
  const full = (): RefreshReport => ({ ...buildIndex(root), mode: "full" });
  if (!fs.existsSync(L.indexDb)) return full();
  const rels = changedPaths.map((p) => (path.isAbsolute(p) ? path.relative(root, p) : p).split(path.sep).join("/"));
  const plan = planRefresh(rels);
  if (plan.full) return full();
  const report = emptyReport();
  if (!plan.companies.size && !plan.companyJobs.size && !plan.jobs.size && !plan.companyEmails.size && !plan.searches && !plan.videos) return { ...report, mode: "incremental" };

  const db = new DatabaseSync(L.indexDb);
  try {
    const t = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => "?").join(", ")})`).get(...TABLES) as { n: number };
    if (t.n !== TABLES.length) { db.close(); return full(); }
    const ctx: Ctx = { root, report, status: profileStatus(root, report), db };
    db.exec("BEGIN");
    if (plan.videos) {
      db.exec(VIDEOS_DDL);
      db.exec("DELETE FROM videos");
      indexVideos(db, root, report.skipped);
    }
    for (const slug of plan.companies) {
      db.prepare("DELETE FROM companies WHERE slug = ?").run(slug);
      db.prepare("DELETE FROM emails WHERE company_slug = ? AND job_id = ''").run(slug); // 3b: indexCompany re-reads them
      const name = indexCompany(ctx, slug);
      db.prepare("UPDATE jobs SET company_name = ? WHERE company_slug = ?").run(name ?? slug, slug);
    }
    const names = new Map((db.prepare("SELECT slug, name FROM companies").all() as { slug: string; name: string }[]).map((r) => [r.slug, r.name]));
    for (const slug of plan.companyEmails) { // 3b
      if (plan.companies.has(slug)) continue;
      db.prepare("DELETE FROM emails WHERE company_slug = ? AND job_id = ''").run(slug);
      if (names.has(slug)) indexEmails(ctx, slug, "");
    }
    const jobSkips: ListJobsSkip[] = [];
    const refs = listJobs(root, jobSkips);
    const touched = new Set([...plan.companyJobs, ...[...plan.jobs].map((k) => k.split("/")[0]!)]);
    for (const slug of plan.companyJobs) {
      db.prepare("DELETE FROM jobs WHERE company_slug = ?").run(slug);
      db.prepare("DELETE FROM events WHERE company_slug = ?").run(slug);
      db.prepare("DELETE FROM emails WHERE company_slug = ? AND job_id <> ''").run(slug); // 3b
      for (const ref of refs.filter((x) => x.company_slug === slug)) indexJob(ctx, ref, names.get(slug) ?? slug);
    }
    for (const key of plan.jobs) {
      const [slug = "", id = ""] = key.split("/");
      if (plan.companyJobs.has(slug)) continue;
      db.prepare("DELETE FROM jobs WHERE company_slug = ? AND id = ?").run(slug, id);
      db.prepare("DELETE FROM events WHERE company_slug = ? AND job_id = ?").run(slug, id);
      db.prepare("DELETE FROM emails WHERE company_slug = ? AND job_id = ?").run(slug, id); // 3b
      const ref = refs.find((x) => x.company_slug === slug && x.id === id);
      if (ref) indexJob(ctx, ref, names.get(slug) ?? slug);
    }
    // listJobs() scans every company in the workspace, so jobSkips may include broken
    // links in companies this refresh never touched; only report the ones under a
    // company whose jobs we actually re-indexed, so an unrelated pre-existing problem
    // elsewhere doesn't show up as new on every incremental refresh.
    for (const s of jobSkips) {
      const r = rel(root, s.file).split(path.sep);
      if (r[0] === "companies" && touched.has(r[1] ?? "")) report.skipped.push({ file: rel(root, s.file), problems: [s.problem] });
    }
    if (plan.searches) { db.exec("DELETE FROM searches"); indexSearches(ctx); }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
    db.close();
    throw e;
  }
  db.close();
  return { ...report, mode: "incremental" };
}
