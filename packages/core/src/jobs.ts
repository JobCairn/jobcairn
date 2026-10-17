import fs from "node:fs";
import path from "node:path";
import { type Clock, iso } from "./clock.js";
import { type DuplicateOptions, findDuplicateJob, markSeenAgain } from "./dedupe.js";
import { assertSegment, insideRoot, layout, slugify, splitClient } from "./paths.js";
import { defaults } from "./schema.js";
import { lockedFolderFor } from "./privacy.js";
import { readJson, updateRecord, writeFileAtomic, writeRecord } from "./store.js";
import { JOB_STATUSES, type Job, type JobSource, type JobStatus } from "./types.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { FOLLOW_UP_DAYS, localDate, storedClosing, storedPosted } from "@careeros/contract";

export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|ref$|refid$|trk|trackingid$)/i.test(k)) x.searchParams.delete(k);
    }
    x.hostname = x.hostname.toLowerCase();
    let s = x.toString();
    s = s.replace(/\/(\?|$)/, "$1");
    return s;
  } catch {
    return u.trim();
  }
}

export function ensureCompany(root: string, rawName: string): { slug: string; created: boolean; client: string | null } {
  const { company, client } = splitClient(rawName);
  const slug = slugify(company, "company");
  const file = layout(root).companyFile(slug);
  if (!insideRoot(root, file)) throw new Error("refusing to write outside the workspace");
  if (fs.existsSync(file)) return { slug, created: false, client };
  writeRecord("company", file, defaults("company", { name: company || slug, slug }));
  return { slug, created: true, client };
}

export interface ListJobsSkip { file: string; problem: string }

// Resolves, without ever throwing, whether `p` is a usable directory: returns
// "dir" if so, "missing" if it (or its symlink target) doesn't exist, "broken"
// for a dangling symlink, or "not-a-folder" for a file/other non-directory.
function dirKind(p: string): "dir" | "missing" | "broken" | "not-a-folder" {
  let lst: fs.Stats;
  try { lst = fs.lstatSync(p); } catch { return "missing"; }
  if (lst.isSymbolicLink()) {
    let real: fs.Stats;
    try { real = fs.statSync(p); } catch { return "broken"; }
    return real.isDirectory() ? "dir" : "not-a-folder";
  }
  return lst.isDirectory() ? "dir" : "not-a-folder";
}

// Lists every job folder's job.json under companies/. Uses lstat throughout
// so a dangling symlink or a file sitting where a company/jobs folder
// belongs is skipped (optionally reported via `skipped`) and never thrown.
export function listJobs(root: string, skipped?: ListJobsSkip[]): { company_slug: string; id: string; file: string }[] {
  const L = layout(root);
  const out: { company_slug: string; id: string; file: string }[] = [];
  if (!fs.existsSync(L.companiesDir)) return out;
  for (const c of fs.readdirSync(L.companiesDir).sort()) {
    const companyDir = L.companyDir(c);
    const ck = dirKind(companyDir);
    if (ck === "missing") continue;
    if (ck === "broken") { skipped?.push({ file: companyDir, problem: "broken link" }); continue; }
    if (ck === "not-a-folder") continue; // reported by validateWorkspace's own company loop

    const jd = L.jobsDir(c);
    const jk = dirKind(jd);
    if (jk === "missing") continue;
    if (jk === "broken") { skipped?.push({ file: jd, problem: "broken link" }); continue; }
    if (jk === "not-a-folder") { skipped?.push({ file: jd, problem: "not a folder" }); continue; }

    for (const id of fs.readdirSync(jd).sort()) {
      const file = L.jobFile(c, id);
      if (fs.existsSync(file)) out.push({ company_slug: c, id, file });
    }
  }
  return out;
}

export function findJobByUrl(root: string, url: string): { company_slug: string; id: string } | null {
  const want = normalizeUrl(url);
  for (const j of listJobs(root)) {
    try {
      const raw = readJson(j.file) as { url?: unknown };
      if (typeof raw.url === "string" && raw.url && normalizeUrl(raw.url) === want) return { company_slug: j.company_slug, id: j.id };
    } catch {
      // Invalid files are reported by validateWorkspace; skip them here.
    }
  }
  return null;
}

export interface NewJobInput {
  company: string; title: string; url?: string; source?: JobSource; source_site?: string; apply_via?: string;
  posted?: string;
  /** When applications close, as the ad shows it ("2026-10-31", "31 Oct"). Left out: read from jd_text when it says. */
  closes?: string;
  location?: string; work_mode?: string; job_type?: string; salary_text?: string; jd_text?: string;
}

export interface NewJobResult {
  company_slug: string; id: string; created: boolean;
  /** True when the job was already in the workspace: nothing new was made (see findDuplicateJob). */
  duplicate?: boolean;
  /** What a duplicate filled in on the job already there (link, pay, posted date, how to apply). */
  filled?: string[];
}

/**
 * Adds a job, unless it is already in the workspace (same ad, or same company, title and place). A duplicate makes
 * no folder: the job already there comes back with duplicate true, its missing link, pay or posted date filled in
 * and a "Seen again" note. `opts.match: "url"` (the legacy importer) only treats the same ad as a duplicate and
 * changes nothing on it.
 */
export function newJob(root: string, input: NewJobInput, c?: Clock, opts: DuplicateOptions = {}): NewJobResult {
  const title = input.title.trim();
  if (!title) throw new Error("job title is required");
  const hit = findDuplicateJob(root, { url: input.url, company: input.company, title, location: input.location }, opts);
  if (hit) {
    const filled = opts.match === "url" ? [] : markSeenAgain(root, hit, {
      url: input.url ? normalizeUrl(input.url) : "", salary_text: input.salary_text, posted: input.posted, apply_via: input.apply_via,
      site: input.source_site, closes: input.closes, jd_text: input.jd_text,
    }, c);
    return { company_slug: hit.company_slug, id: hit.id, created: false, duplicate: true, filled };
  }
  const { slug, client } = ensureCompany(root, input.company);
  const at = iso(c);
  const L = layout(root);
  const base = `${at.slice(0, 10)}-${slugify(title, "job")}`;
  let id = base;
  for (let n = 2; fs.existsSync(L.jobDir(slug, id)); n++) id = `${base}-${n}`;
  const file = L.jobFile(slug, id);
  if (!insideRoot(root, file)) throw new Error("refusing to write outside the workspace");
  // A board's "3d ago" or "30+ days ago" is stored as a date counted from when the job was found, marked approximate.
  const posted = storedPosted(input.posted, at);
  // A closing date only when the ad states one: the value Claude read, else the ad's own words. Never a guess.
  const closes = storedClosing(input.closes, input.jd_text, at);
  writeRecord("job", file, defaults("job", {
    id, company_slug: slug, client, title,
    source: input.source ?? "pasted", source_site: input.source_site ?? "",
    url: input.url ? normalizeUrl(input.url) : "", apply_via: input.apply_via ?? "", posted: posted.posted, ...(posted.approx ? { posted_approx: true } : {}),
    ...(closes ? { closes_on: closes } : {}), found_at: at, location: input.location ?? "", work_mode: input.work_mode ?? "", job_type: input.job_type ?? "",
    salary: { text: input.salary_text ?? "" },
    timeline: [{ at, event: "Found", note: input.source_site || input.source || "pasted" }],
  }));
  if (input.jd_text) {
    const jdPath = path.join(L.jobDir(slug, id), "jd.md");
    if (!insideRoot(root, jdPath)) throw new Error("refusing to write outside the workspace");
    writeFileAtomic(jdPath, input.jd_text.endsWith("\n") ? input.jd_text : `${input.jd_text}\n`);
    updateRecord("job", file, (j) => { j.files.push({ path: "jd.md", label: "Job description", at }); });
  }
  return { company_slug: slug, id, created: true };
}

export function jobFilePath(root: string, slug: string, id: string): string {
  assertSegment(slug, "company slug");
  assertSegment(id, "job id");
  const f = layout(root).jobFile(slug, id);
  if (!fs.existsSync(f)) throw new Error(`no job ${slug}/${id}`);
  // Real-path check: a symlinked job or company folder must not redirect writes outside the workspace.
  if (!insideRoot(root, f)) throw new Error("refusing to write outside the workspace");
  return f;
}

export function addEvent(root: string, slug: string, id: string, event: string, note = "", c?: Clock): Job {
  return updateRecord("job", jobFilePath(root, slug, id), (j) => { j.timeline.push({ at: iso(c), event, note }); });
}

export function setStatus(root: string, slug: string, id: string, status: string, note = "", c?: Clock): Job {
  if (!(JOB_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`unknown status "${status}". Use one of: ${JOB_STATUSES.join(", ")}`);
  }
  return updateRecord("job", jobFilePath(root, slug, id), (j) => {
    j.status = status as JobStatus;
    j.timeline.push({ at: iso(c), event: `Status: ${status}`, note });
    // Applying sets the day to follow up (local date, FOLLOW_UP_DAYS later); the app shows "Follow up due" from it.
    if (status === "Applied") {
      const now = c?.now ?? new Date();
      j.custom = { ...j.custom, follow_up_on: localDate(new Date(now.getTime() + FOLLOW_UP_DAYS * 86_400_000)) };
    }
  });
}

export const JOB_SUBDIRS = ["", "application", "emails", "interview"] as const;
export type JobSubdir = (typeof JOB_SUBDIRS)[number];

export function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let n = 2; ; n++) {
    const q = `${stem}-${n}${ext}`;
    if (!fs.existsSync(q)) return q;
  }
}

export function attachFile(root: string, slug: string, id: string, src: string, opts: { label: string; subdir?: JobSubdir; move?: boolean }, c?: Clock): string {
  const jf = jobFilePath(root, slug, id);
  const subdir = opts.subdir ?? "";
  if (!(JOB_SUBDIRS as readonly string[]).includes(subdir)) throw new Error(`unknown subdir "${subdir}"`);

  const locked = lockedFolderFor(root, src, c);
  if (locked) throw new Error(`refusing to attach from ${locked}: it is locked. Unlock it in the ${identity.name} app (Privacy) first`);
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`refusing to attach "${path.basename(src)}": not a regular file`);
  }

  const jobDir = path.dirname(jf);
  const dir = path.join(jobDir, subdir);
  const dest = uniquePath(path.join(dir, path.basename(src)));
  if (!insideRoot(root, dir) || !insideRoot(jobDir, dest)) throw new Error("refusing to write outside the job folder");
  fs.mkdirSync(dir, { recursive: true });
  if (opts.move) {
    try {
      fs.renameSync(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EXDEV") {
        fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        fs.unlinkSync(src);
      } else {
        throw e;
      }
    }
  } else {
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  }
  const rel = path.relative(jobDir, dest).split(path.sep).join("/");
  updateRecord("job", jf, (j) => { j.files.push({ path: rel, label: opts.label, at: iso(c) }); });
  return rel;
}
