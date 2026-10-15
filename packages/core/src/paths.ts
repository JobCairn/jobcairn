import fs from "node:fs";
import path from "node:path";
import { LOCKABLE_DIRS } from "./types.js";

export const ME_DIRS = ["resumes", "history", "identity", "employment", "education", "projects"] as const;
export type MeDir = (typeof ME_DIRS)[number];
export const LOCKED_DIRS = LOCKABLE_DIRS;

export function slugify(input: string, fallback = "item"): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || fallback;
}

export function splitClient(name: string): { company: string; client: string | null } {
  const m = name.match(/^(.*?)\s*\((?:client:?\s*)?([^)]*)\)\s*$/i);
  if (m && m[1] && m[1].trim()) {
    const client = (m[2] ?? "").trim();
    return { company: m[1].trim(), client: client || null };
  }
  return { company: name.trim(), client: null };
}

// Resolves `p` as far as the real filesystem allows: realpath()s the deepest
// existing ancestor (collapsing any symlinks, including macOS's /var ->
// /private/var), then re-appends whatever segments don't exist yet.
// Falls back to the plain resolved path if nothing on the chain exists.
// Uses realpathSync.native, not the plain JS realpathSync: on a case-insensitive
// filesystem the native call normalises each segment to its real on-disk casing,
// while the JS fallback can preserve whatever casing the caller happened to pass in
// -- which would make two strings that name the exact same real directory compare
// unequal (see lockedFolderFor's own realOrResolved, which already uses .native).
export function realish(p: string): string {
  const abs = path.resolve(p);
  const parts = abs.split(path.sep);
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join(path.sep) || path.sep;
    if (fs.existsSync(candidate)) {
      try {
        const real = fs.realpathSync.native(candidate);
        const remainder = parts.slice(i);
        return remainder.length ? path.join(real, ...remainder) : real;
      } catch {
        return abs;
      }
    }
  }
  return abs;
}

/**
 * Whether `root`'s filesystem treats case as insignificant (the default on macOS and
 * Windows). Detected by swapping the case of every letter in `root`'s own path and
 * checking whether that still resolves to the exact same file (same dev/ino) --
 * never by asking the OS for a capability flag, which can be wrong for network or
 * overlay filesystems. Used only to decide whether a case-insensitive *comparison*
 * is safe: on a case-sensitive volume, folding case in a scope check could let a
 * same-letters-different-case folder stand in for a real one it merely resembles,
 * so callers must default to case-sensitive and only fold case when this says so.
 */
export function isCaseInsensitiveFs(root: string): boolean {
  const swapped = [...root].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join("");
  if (swapped === root) return false;
  try {
    const a = fs.statSync(root, { bigint: true });
    const b = fs.statSync(swapped, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

export function insideRoot(root: string, p: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(p);
  const lexicalOk = t === r || t.startsWith(r + path.sep);
  if (!lexicalOk) return false;
  const realRoot = realish(root);
  const realP = realish(p);
  return realP === realRoot || realP.startsWith(realRoot + path.sep);
}

export function assertSegment(s: string, what: string): void {
  // Control characters (0x00-0x1F, 0x7F) cover NUL as well as \r, \n and \t,
  // any of which could forge extra lines in a log or confuse a shell/CLI.
  if (!s || s === "." || s === ".." || s.includes("/") || s.includes("\\") || s.includes("..") || /[\x00-\x1f\x7f]/.test(s)) {
    throw new Error(`unsafe ${what}: "${s}"`);
  }
}

export function layout(root: string) {
  const j = (...p: string[]) => path.join(root, ...p);
  return {
    root,
    workspaceFile: j("workspace.json"),
    profile: j("settings", "profile.json"),
    search: j("settings", "search.json"),
    integrations: j("settings", "integrations.json"),
    env: j("settings", ".env"),
    inbox: j("inbox"),
    companiesDir: j("companies"),
    learning: j("learning"),
    recaps: j("recaps"),
    videoTypesDir: j("settings", "video-types"),
    researchDir: (slug: string) => j("companies", slug, "research"),
    companyVideosDir: (slug: string) => j("companies", slug, "videos"),
    jobVideosDir: (slug: string, id: string) => j("companies", slug, "jobs", id, "videos"),
    sponsors: j("knowledge", "sponsors.json"),
    searchLog: j("knowledge", "search-log.jsonl"),
    indexDb: j(".index", "careeros.sqlite"),
    backupDir: j(".backup"),
    me: (d: MeDir) => j("me", d),
    companyDir: (slug: string) => j("companies", slug),
    companyFile: (slug: string) => j("companies", slug, "company.json"),
    jobsDir: (slug: string) => j("companies", slug, "jobs"),
    jobDir: (slug: string, id: string) => j("companies", slug, "jobs", id),
    jobFile: (slug: string, id: string) => j("companies", slug, "jobs", id, "job.json"),
    companyEmailsDir: (slug: string) => j("companies", slug, "emails"),
    jobEmailsDir: (slug: string, id: string) => j("companies", slug, "jobs", id, "emails"),
    /** A job's drafts, or (id "") the company's own: a general enquiry to a recruiter. */
    draftsDir: (slug: string, id: string) => (id ? j("companies", slug, "jobs", id, "emails", "drafts") : j("companies", slug, "emails", "drafts")),
    recruitersDir: j("recruiters"),
    agencyFile: (slug: string) => j("recruiters", slug, "agency.json"),
    mailState: j(".careeros", "mail-state.json"),
    mailTriage: j(".careeros", "mail-triage"),
  };
}
export type Layout = ReturnType<typeof layout>;
