import fs from "node:fs";
import path from "node:path";
import { appendSearch, readSearches } from "./knowledge.js";
import { listJobs, newJob, uniquePath } from "./jobs.js";
import { insideRoot, layout, slugify, splitClient } from "./paths.js";
import { safeChmod } from "./perm.js";
import { defaults } from "./schema.js";
import { readJson, readRecord, updateRecord, writeRecord } from "./store.js";
import { JOB_STATUSES, type JobStatus, type WorkRightsLabel } from "./types.js";
import { type Issue, validateWorkspace } from "./validate.js";
import { initWorkspace, isWorkspace } from "./workspace.js";

export interface LegacyAction { kind: "job" | "copy" | "sponsors" | "searches" | "skip"; from: string; to: string; note?: string }
export interface LegacyReport { actions: LegacyAction[]; unmapped: string[]; skipped: string[]; issues: Issue[] }

const ME_MAP: [string, string][] = [
  ["Resume", "me/resumes"], ["Visa", "me/identity/visa"], ["Current-company", "me/employment"],
  ["Current Address", "me/identity/address"], ["Personal Projects", "me/projects"], ["resume-docs", "me/history"],
];
const HANDLED_TOP = new Set(["Company", "Job-Hunt-Sponsorship", ...ME_MAP.map((m) => m[0])]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".wrangler", ".turbo", ".vercel", "__pycache__", ".claude"]);
const MAX_BYTES = 25 * 1024 * 1024;
// Withdrawn imports as itself (a final status since 2026-10-17); a closed ad you never applied for stays Skipped.
const STATUS_MAP: Record<string, JobStatus> = { Screening: "Interview", Interviewing: "Interview", Closed: "Skipped", Ghosted: "No response", "No Response": "No response" };

/** A legacy tracker's status in this app's words: the same word when it is one of ours, else mapped, else Found. */
export function legacyStatus(s: string | undefined): JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(s ?? "") ? (s as JobStatus) : (STATUS_MAP[s ?? ""] ?? "Found");
}

type Legacy = Record<string, unknown> & {
  company?: string; role?: string; source?: string; source_url?: string; apply_via?: string; posted?: string; location?: string;
  work_mode?: string; salary?: string; status?: string; sponsorship?: string; sponsor_score?: number; sponsor_tier?: string;
  sponsor_reasons?: string[]; score?: { match?: number | null; odds?: number | null; tier?: string };
  must_haves?: unknown[]; must_haves_check?: unknown[]; nice_to_haves?: unknown[]; nice_to_haves_check?: unknown[];
  rights_scan?: Record<string, unknown>; date_found?: string; timeline?: { date?: string; event?: string; note?: string }[];
  files?: { label?: string; path?: string }[];
};

// Copies a file and then explicitly re-applies the source's permission bits,
// so a 0600 source file (for example under Visa/ or Current-company/) stays
// 0600 at the destination regardless of umask or platform copy semantics.
function copyPreserveMode(from: string, to: string, exclusive = false): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (exclusive) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  else fs.copyFileSync(from, to);
  try {
    safeChmod(to, fs.statSync(from).mode & 0o777);
  } catch {
    // Best effort: an unreadable mode should not block the import itself.
  }
}

// Never follows a symlink: lstat() is used (not stat()) so a symlinked file or
// directory anywhere in the legacy tree is reported in `skipped` and skipped,
// rather than being read through.
function copyTree(from: string, to: string, report: LegacyReport, dry: boolean, src: string, dest: string): void {
  // The starting folder itself must be real and inside src (a symlinked Visa/ must not be followed).
  if (!realInSrc(src, from)) return;
  for (const name of fs.readdirSync(from).sort()) {
    if (name === ".DS_Store") continue;
    const a = path.join(from, name);
    const b = path.join(to, name);
    if (name.startsWith(".")) { report.skipped.push(path.relative(src, a)); continue; }
    const st = fs.lstatSync(a);
    if (st.isSymbolicLink()) { report.skipped.push(`${path.relative(src, a)} (symlink)`); continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) { report.skipped.push(path.relative(src, a)); continue; }
      copyTree(a, b, report, dry, src, dest);
      continue;
    }
    if (!st.isFile()) { report.skipped.push(`${path.relative(src, a)} (not a regular file)`); continue; }
    if (st.size > MAX_BYTES) { report.skipped.push(`${path.relative(src, a)} (over 25 MB)`); continue; }
    if (fs.existsSync(b) && fs.statSync(b).size === st.size) continue;
    if (!insideRoot(dest, b)) throw new Error(`refusing to write outside the workspace: ${b}`);
    // A different source that happens to map to the same target name must
    // never overwrite it: pick a fresh name and copy exclusively (COPYFILE_EXCL).
    const target = dry ? b : uniquePath(b);
    report.actions.push({ kind: "copy", from: path.relative(src, a), to: path.relative(dest, target) });
    if (!dry) copyPreserveMode(a, target, true);
  }
}

// True only for an existing path that is not a symlink and whose real location is inside src.
function realInSrc(src: string, p: string): boolean {
  return fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink() && insideRoot(src, p);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function label(s: string | undefined): WorkRightsLabel {
  if (s === "Explicit") return "sponsorship_offered";
  if (s === "No") return "citizen_pr_only";
  return "silent";
}

// Copies job folder contents (skipping application.json, dotfiles and symlinks)
// into the new job's folder, classifying JD/score/resume/cover/email files.
function importJobFiles(dir: string, jobDir: string, report: LegacyReport, src: string, dest: string, labels: Map<string, string>) {
  const added: { path: string; label: string; at: string }[] = [];
  let hasJd = false, hasScore = false;
  const put = (from: string, rel: string, lbl: string) => {
    // A different source file that happens to map to the same target name
    // must never overwrite it: pick a fresh name, then copy exclusively.
    const to = uniquePath(path.join(jobDir, rel));
    if (!insideRoot(dest, to)) throw new Error(`refusing to write outside the workspace: ${to}`);
    copyPreserveMode(from, to, true);
    report.actions.push({ kind: "copy", from: path.relative(src, from), to: path.relative(dest, to) });
    added.push({ path: path.relative(jobDir, to).split(path.sep).join("/"), label: lbl, at: "" });
  };
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === "application.json" || name === ".DS_Store") continue;
    const p = path.join(dir, name);
    if (name.startsWith(".")) { report.skipped.push(path.relative(src, p)); continue; }
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { report.skipped.push(`${path.relative(src, p)} (symlink)`); continue; }
    const lbl = labels.get(name) ?? name;
    if (st.isDirectory()) {
      // Copied recursively with copyTree (symlink/dotfile guards, size limit,
      // idempotent re-runs) so nested sub-folders are never silently dropped.
      const sub = /email|recruit|recuriter/i.test(name) ? "emails" : slugify(name, "folder");
      copyTree(p, path.join(jobDir, sub), report, false, src, dest);
    } else if (!st.isFile()) {
      report.skipped.push(`${path.relative(src, p)} (not a regular file)`);
    } else if (/^JD.*\.md$/i.test(name) && !hasJd) { put(p, "jd.md", "Job description"); hasJd = true; }
    else if (/^score.*\.md$/i.test(name) && !hasScore) { put(p, "score.md", "Career-skill score"); hasScore = true; }
    else if (/^(resume|cover|answers)/i.test(name)) put(p, path.join("application", name), lbl);
    else put(p, name, lbl);
  }
  return added;
}

export function importLegacy(src: string, dest: string, opts: { dryRun?: boolean; now?: Date } = {}): LegacyReport {
  if (!fs.existsSync(src)) throw new Error(`legacy folder not found: ${src}`);
  const dry = opts.dryRun ?? false;
  const report: LegacyReport = { actions: [], unmapped: [], skipped: [], issues: [] };
  if (!dry && !isWorkspace(dest)) initWorkspace(dest, { now: opts.now });
  const L = layout(dest);

  for (const name of fs.readdirSync(src).sort()) {
    if (name === ".DS_Store") continue;
    const st = fs.lstatSync(path.join(src, name));
    if (st.isSymbolicLink()) { report.skipped.push(`${name} (symlink)`); continue; }
    if (name.startsWith(".")) report.skipped.push(name);
    else if (!HANDLED_TOP.has(name)) report.unmapped.push(name);
  }

  for (const [from, to] of ME_MAP) {
    const s = path.join(src, from);
    if (realInSrc(src, s)) copyTree(s, path.join(dest, to), report, dry, src, dest);
  }

  const sponsorsFile = path.join(src, "Job-Hunt-Sponsorship", "sponsors.json");
  if (realInSrc(src, sponsorsFile)) {
    const raw = readJson(sponsorsFile) as { employers?: unknown[] };
    report.actions.push({ kind: "sponsors", from: path.relative(src, sponsorsFile), to: path.relative(dest, L.sponsors) });
    if (!dry) writeRecord("sponsors", L.sponsors, defaults("sponsors", { employers: raw.employers ?? [] }));
  }

  const logFile = path.join(src, "Job-Hunt-Sponsorship", "SEARCH-LOG.md");
  if (realInSrc(src, logFile)) {
    const have = dry ? new Set<string>() : new Set(readSearches(dest).entries.map((e) => `${e.at}|${e.site}|${e.query}|${e.location}`));
    let n = 0;
    for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
      if (!line.startsWith("| 20")) continue;
      const [date = "", site = "", query = "", location = "", results = "", kept = "", notes = ""] = line.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
      const at = date.length === 10 ? `${date}T00:00:00` : `${date.replace(" ", "T")}:00`;
      if (have.has(`${at}|${site}|${query}|${location}`)) continue;
      n++;
      if (!dry) appendSearch(dest, { at, site, query, location, results, kept, notes });
    }
    report.actions.push({ kind: "searches", from: path.relative(src, logFile), to: path.relative(dest, L.searchLog), note: `${n} rows` });
  }

  const companyRoot = path.join(src, "Company");
  if (realInSrc(src, companyRoot)) {
    const done = new Set<string>();
    if (!dry) for (const j of listJobs(dest)) {
      try { const f = readRecord("job", j.file).custom.legacy_folder; if (typeof f === "string") done.add(f); } catch { /* reported by validate */ }
    }
    for (const dirName of fs.readdirSync(companyRoot).sort()) {
      const dir = path.join(companyRoot, dirName);
      const dst = fs.lstatSync(dir);
      if (dst.isSymbolicLink()) { report.skipped.push(`${path.relative(src, dir)} (symlink)`); continue; }
      if (dirName.startsWith("_") || !dst.isDirectory()) continue;
      const legacyFolder = `Company/${dirName}`;
      const appFile = path.join(dir, "application.json");
      if (!fs.existsSync(appFile) || fs.lstatSync(appFile).isSymbolicLink()) {
        if (fs.existsSync(appFile)) report.skipped.push(`${legacyFolder}/application.json (symlink)`);
        else report.unmapped.push(legacyFolder);
        continue;
      }
      if (done.has(legacyFolder)) continue;
      const app = readJson(appFile) as Legacy;
      const name = String(app.company || dirName);
      const title = String(app.role || "Unknown role");
      const found = String(app.date_found || app.timeline?.[0]?.date || "").slice(0, 10);
      const when = /^\d{4}-\d{2}-\d{2}$/.test(found) ? new Date(`${found}T00:00:00.000Z`) : (opts.now ?? new Date());
      const company_slug = slugify(splitClient(name).company, "company");
      const plannedId = `${when.toISOString().slice(0, 10)}-${slugify(title, "job")}`;
      if (dry) { report.actions.push({ kind: "job", from: legacyFolder, to: `companies/${company_slug}/jobs/${plannedId}` }); continue; }

      const res = newJob(dest, {
        company: name, title, url: app.source_url || undefined,
        source: /seek|linkedin|indeed/i.test(app.source ?? "") ? "browser" : "pasted", source_site: app.source ?? "",
        apply_via: app.apply_via, posted: app.posted, location: app.location, work_mode: app.work_mode, salary_text: app.salary,
      }, { now: when }, { match: "url" });
      if (!res.created) { report.actions.push({ kind: "skip", from: legacyFolder, to: `companies/${res.company_slug}/jobs/${res.id}`, note: "same URL already imported" }); continue; }
      report.actions.push({ kind: "job", from: legacyFolder, to: `companies/${res.company_slug}/jobs/${res.id}` });

      const jobFile = L.jobFile(res.company_slug, res.id);
      const labels = new Map((app.files ?? []).filter((f) => f.path).map((f) => [String(f.path), String(f.label ?? f.path)]));
      const files = importJobFiles(dir, path.dirname(jobFile), report, src, dest, labels);
      const scan = app.rights_scan ?? {};
      const status = legacyStatus(app.status);
      updateRecord("job", jobFile, (j) => {
        j.status = status;
        j.work_rights = { label: label(app.sponsorship), quotes: [...strings(scan.positive), ...strings(scan.weak_positive), ...strings(scan.hard), ...strings(scan.soft)], decided_by: app.rights_scan ? "scan" : "none" };
        j.scores.sponsor = { value: app.sponsor_score ?? null, tier: app.sponsor_tier ?? "", reasons: app.sponsor_reasons ?? [] };
        j.scores.career = { match: app.score?.match ?? null, odds: app.score?.odds ?? null, tier: app.score?.tier ?? "", scored_at: "" };
        j.scores.fit.must_haves = app.must_haves_check ?? app.must_haves ?? [];
        j.scores.fit.nice_to_haves = app.nice_to_haves_check ?? app.nice_to_haves ?? [];
        if (app.timeline?.length) j.timeline = app.timeline.map((e) => ({ at: String(e.date ?? found), event: String(e.event ?? ""), note: String(e.note ?? "") }));
        j.files = files.map((f) => ({ ...f, at: found }));
        j.custom = { ...j.custom, legacy_folder: legacyFolder, legacy_fit: app.fit ?? null, legacy: app };
      });
    }
  }

  if (!dry) report.issues = validateWorkspace(dest);
  return report;
}
