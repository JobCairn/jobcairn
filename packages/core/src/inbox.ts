import fs from "node:fs";
import path from "node:path";
import { isFinalStatus } from "@careeros/contract";
import { type Clock, iso } from "./clock.js";
import { JOB_SUBDIRS, type JobSubdir, jobFilePath, listJobs, uniquePath } from "./jobs.js";
import { assertSegment, insideRoot, layout, ME_DIRS, type MeDir } from "./paths.js";
import { appendLineSafe, readRecord, updateRecord } from "./store.js";
import type { Job } from "./types.js";

export type InboxTarget =
  | { kind: "me"; dir: MeDir; sub?: string }
  | { kind: "job"; company_slug: string; id: string; subdir?: JobSubdir };

const LOG = "_filed.md";

export function listInbox(root: string): string[] {
  const dir = layout(root).inbox;
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(dir); } catch { return []; }
  // A symlinked inbox/ (or one replaced by a non-folder) is never listed.
  if (st.isSymbolicLink() || !st.isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => !n.startsWith(".") && n !== LOG)
    // lstat (not stat): a symlinked entry is never treated as a listable file.
    .filter((n) => {
      try { return fs.lstatSync(path.join(dir, n)).isFile(); } catch { return false; }
    })
    .sort();
}

/** One line of inbox/_filed.md: a file the drop box filed, where it went and when. */
export interface FiledEntry { at: string; name: string; to: string; note: string }

/**
 * The drop box's history, newest first, read from the append-only inbox/_filed.md that fileInboxItem
 * writes. Lines that don't parse are skipped. Files filed before the log existed simply aren't listed.
 */
export function readFiledLog(root: string, limit = 50): FiledEntry[] {
  const file = path.join(layout(root).inbox, LOG);
  let text: string;
  try {
    if (!fs.lstatSync(file).isFile()) return [];
    text = fs.readFileSync(file, "utf8");
  } catch { return []; }
  const out: FiledEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^- (\S+) \| (.+) -> (.+?) \| ?(.*)$/);
    if (m && !Number.isNaN(Date.parse(m[1]!))) out.push({ at: m[1]!, name: m[2]!, to: m[3]!, note: m[4]!.trim() });
  }
  return out.reverse().slice(0, limit);
}

// Newlines in a logged name or note could forge extra log lines; flatten them.
function logSafe(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

export function fileInboxItem(root: string, name: string, target: InboxTarget, note = "", c?: Clock): { to: string } {
  const L = layout(root);

  // The inbox/ folder itself must be a real folder inside the workspace: a
  // symlink here (pointing anywhere, even to a real folder outside root)
  // must never be listed from or filed through.
  let inboxStat: fs.Stats | undefined;
  try { inboxStat = fs.lstatSync(L.inbox); } catch { inboxStat = undefined; }
  if (inboxStat && (inboxStat.isSymbolicLink() || !insideRoot(root, L.inbox))) {
    throw new Error("refusing to use an inbox outside the workspace");
  }

  // `name` must be a single safe path segment, and never the log file or a dotfile
  // (assertSegment rejects "", ".", "..", slashes, backslashes and NUL).
  try {
    assertSegment(name, "inbox file name");
  } catch {
    throw new Error(`"${name}" is not an inbox file name`);
  }
  if (name.startsWith(".") || name === LOG) {
    throw new Error(`"${name}" is not an inbox file name`);
  }

  const src = path.join(L.inbox, name);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(src);
  } catch {
    throw new Error(`"${name}" is not in the inbox`);
  }
  // lstat (not stat) so a symlink is never followed: isFile() is false for both
  // symlinks and directories, so this single check refuses both.
  if (!st.isFile()) throw new Error(`"${name}" is not in the inbox`);

  let destDir: string;
  if (target.kind === "me") {
    if (!(ME_DIRS as readonly string[]).includes(target.dir)) throw new Error(`unknown me/ folder "${target.dir}"`);
    destDir = L.me(target.dir);
    if (target.sub) {
      // Every segment of `sub` must itself be a safe segment, so "..", an
      // absolute path (leading "/" yields an empty first segment) and NUL are
      // all rejected the same way a bad `name` would be.
      const segments = target.sub.split("/");
      for (const seg of segments) assertSegment(seg, "sub-folder");
      destDir = path.join(destDir, ...segments);
    }
  } else {
    const subdir = target.subdir ?? "";
    if (!(JOB_SUBDIRS as readonly string[]).includes(subdir)) throw new Error(`unknown subdir "${subdir}"`);
    // jobFilePath validates company_slug/id as safe segments, confirms the job
    // exists, and refuses to resolve outside the workspace (symlink-safe).
    const jf = jobFilePath(root, target.company_slug, target.id);
    destDir = path.join(path.dirname(jf), subdir);
  }

  const dest = uniquePath(path.join(destDir, name));
  // Both the destination and the folder that will contain it must resolve
  // inside the workspace, so a symlinked me/ or job folder can't redirect the file.
  if (!insideRoot(root, destDir) || !insideRoot(root, dest)) {
    throw new Error("refusing to file outside the workspace");
  }
  fs.mkdirSync(destDir, { recursive: true });

  // Move without ever overwriting: uniquePath already picked a name that
  // doesn't exist, and the EXDEV fallback copies with COPYFILE_EXCL, only
  // unlinking the source once that copy has actually succeeded.
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

  const at = iso(c);
  const to = path.relative(root, dest);
  if (target.kind === "job") {
    const jf = jobFilePath(root, target.company_slug, target.id);
    const relToJob = path.relative(path.dirname(jf), dest).split(path.sep).join("/");
    updateRecord("job", jf, (j) => {
      j.files.push({ path: relToJob, label: note || name, at });
    });
  }
  const toDisplay = to.split(path.sep).join("/");
  appendLineSafe(root, path.join(L.inbox, LOG), `- ${at} | ${logSafe(name)} -> ${toDisplay} | ${logSafe(note)}\n`);
  return { to };
}

export interface InboxSuggestion { target: InboxTarget | null; reason: string; confidence: "high" | "medium" | "low" }

const ME_RULES: { re: RegExp; dir: MeDir; sub?: string; why: string }[] = [
  { re: /\b(visa|vevo|bridging|grant notice)\b/, dir: "identity", sub: "visa", why: "The name mentions a visa." },
  { re: /\b(passport|birth certificate|drivers? licen[cs]e|licen[cs]e|medicare|id card|identity)\b/, dir: "identity", why: "The name looks like an identity document." },
  { re: /\b(payslip|pay slip|payg|separation|employment|employer reference|reference letter|service letter)\b/, dir: "employment", why: "The name looks like an employment document." },
  { re: /\b(transcript|degree|diploma|certificate|academic|graduation|qualification)\b/, dir: "education", why: "The name looks like an education document." },
];

interface Candidate { company_slug: string; id: string; company: string; title: string; status: string; found_at: string }

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function normaliseName(name: string): string {
  return words(name.replace(/\.[A-Za-z0-9]{1,5}$/, ""));
}

function candidates(root: string): Candidate[] {
  const L = layout(root);
  const companyNames = new Map<string, string>();
  const out: Candidate[] = [];
  for (const ref of listJobs(root)) {
    let j: Job;
    try { j = readRecord("job", ref.file); } catch { continue; }
    if (!companyNames.has(ref.company_slug)) {
      let n = ref.company_slug;
      try { n = readRecord("company", L.companyFile(ref.company_slug)).name; } catch { /* use the slug */ }
      companyNames.set(ref.company_slug, n);
    }
    out.push({ company_slug: ref.company_slug, id: ref.id, company: companyNames.get(ref.company_slug)!, title: j.title, status: j.status, found_at: j.found_at });
  }
  return out;
}

function matchCompany(text: string, all: Candidate[]): Candidate[] {
  const t = ` ${text} `;
  return all.filter((c) => {
    const phrase = words(c.company);
    const slug = c.company_slug.replace(/-/g, " ");
    return (phrase.length >= 3 && t.includes(` ${phrase} `)) || (slug.length >= 3 && t.includes(` ${slug} `));
  });
}

function bestJob(found: Candidate[], text: string): Candidate {
  const tw = new Set(text.split(" "));
  const score = (c: Candidate) => words(c.title).split(" ").filter((w) => w.length > 2 && tw.has(w)).length;
  const closed = (c: Candidate) => (isFinalStatus(c.status) ? 1 : 0);
  return [...found].sort((a, b) => closed(a) - closed(b) || score(b) - score(a) || b.found_at.localeCompare(a.found_at))[0]!;
}

function jobSubdir(text: string, ext: string): JobSubdir {
  if (ext === ".eml" || /\b(email|e mail|message|offer)\b/.test(text)) return "emails";
  if (/\b(interview|prep|questions)\b/.test(text)) return "interview";
  if (/\b(cover|letter|answers?|application|resume|cv|tailored)\b/.test(text)) return "application";
  return "";
}

export function suggestInboxTarget(root: string, name: string): InboxSuggestion {
  try { assertSegment(name, "inbox file name"); } catch { throw new Error(`"${name}" is not an inbox file name`); }
  const text = normaliseName(name);
  const ext = path.extname(name).toLowerCase();

  for (const r of ME_RULES) {
    if (r.re.test(text)) return { target: r.sub ? { kind: "me", dir: r.dir, sub: r.sub } : { kind: "me", dir: r.dir }, reason: r.why, confidence: "high" };
  }
  const all = candidates(root);
  const byName = matchCompany(text, all);
  if (byName.length) {
    const job = bestJob(byName, text);
    const subdir = jobSubdir(text, ext);
    const sure = subdir !== "" || /\b(jd|job description)\b/.test(text);
    return { target: { kind: "job", company_slug: job.company_slug, id: job.id, subdir }, reason: `The name mentions ${job.company}.`, confidence: sure ? "high" : "medium" };
  }
  if (/\b(resume|cv|curriculum vitae)\b/.test(text)) return { target: { kind: "me", dir: "resumes" }, reason: "The name looks like a resume.", confidence: "medium" };
  if (/\b(portfolio|project|case study)\b/.test(text)) return { target: { kind: "me", dir: "projects" }, reason: "The name looks like a project.", confidence: "low" };

  if ([".md", ".txt", ".eml"].includes(ext)) {
    const file = path.join(layout(root).inbox, name);
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && st.size <= 256 * 1024) {
        const found = matchCompany(words(fs.readFileSync(file, "utf8")), all);
        if (found.length) {
          const job = bestJob(found, text);
          return { target: { kind: "job", company_slug: job.company_slug, id: job.id, subdir: jobSubdir(text, ext) }, reason: `The file mentions ${job.company}.`, confidence: "medium" };
        }
      }
    } catch { /* not in the inbox: name rules only */ }
  }
  return { target: null, reason: "No rule matched. Choose a folder.", confidence: "low" };
}

/** A saved job, as matched by findJobInText. */
export interface JobMatch { company_slug: string; id: string; company: string; title: string }

/**
 * The saved job whose company `text` names (its name or folder name), preferring open jobs whose title shares words
 * with `hint` (a title Claude or the ad gave). Null when no saved company is named.
 */
export function findJobInText(root: string, text: string, hint = ""): JobMatch | null {
  const found = matchCompany(words(text), candidates(root));
  if (!found.length) return null;
  const j = bestJob(found, words(hint || text));
  return { company_slug: j.company_slug, id: j.id, company: j.company, title: j.title };
}
