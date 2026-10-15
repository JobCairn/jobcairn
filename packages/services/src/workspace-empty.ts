import fs from "node:fs";
import path from "node:path";
import { LOCKABLE_DIRS } from "@careeros/contract";

/**
 * Whether a workspace holds nothing of the person's yet, so "Move to Trash" may be offered for it. Rule-based, so
 * it holds for every user and every app version: the scaffold every new workspace gets (and what opening it adds)
 * doesn't count; anything else does. Unsure means "not empty": a link anywhere, an unknown entry, a folder that
 * can't be listed, or more entries than the walk allows.
 *
 * Locked folders (me/identity, me/employment) are never listed or counted. Only each folder's own lstat is taken: a
 * folder is untouched when its mtime is within 2 s of its birthtime (a folder's mtime changes whenever an entry is
 * added or removed). Anything else (touched, a link, no birthtime on this platform) counts as not empty.
 */

const IGNORABLE = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
/** App internals: the activity log and tour state, migration backups, the search index. */
const INTERNAL = new Set([".careeros", ".backup", ".index"]);
const CONTENT_DIRS = new Set(["companies", "inbox", "learning", "me"]);
const MAX_ENTRIES = 5_000;
const MAX_KNOWLEDGE_BYTES = 64 * 1024;

class NotEmpty extends Error {}

function entries(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((n) => !IGNORABLE.has(n)); } catch { throw new NotEmpty(); }
}

function lst(p: string): fs.Stats {
  try { return fs.lstatSync(p); } catch { throw new NotEmpty(); }
}

/** Throws NotEmpty on any file or link below `dir` (empty folders don't count). `skip`: names never descended into. */
function walk(dir: string, budget: { n: number }, skip: ReadonlySet<string> = new Set()): void {
  for (const name of entries(dir)) {
    if (skip.has(name)) continue;
    if (++budget.n > MAX_ENTRIES) throw new NotEmpty();
    const p = path.join(dir, name);
    const st = lst(p);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new NotEmpty();
    walk(p, budget);
  }
}

function smallText(p: string): string {
  const st = lst(p);
  if (!st.isFile() || st.size > MAX_KNOWLEDGE_BYTES) throw new NotEmpty();
  try { return fs.readFileSync(p, "utf8"); } catch { throw new NotEmpty(); }
}

/** knowledge/: only the default sponsors list (no employers) and an empty search log. */
function knowledgeDefault(dir: string): void {
  for (const name of entries(dir)) {
    const p = path.join(dir, name);
    if (name === "search-log.jsonl") { if (smallText(p).trim()) throw new NotEmpty(); continue; }
    if (name === "sponsors.json") {
      let v: unknown;
      try { v = JSON.parse(smallText(p)); } catch { throw new NotEmpty(); }
      const employers = (v as { employers?: unknown } | null)?.employers;
      if (employers !== undefined && !(Array.isArray(employers) && employers.length === 0)) throw new NotEmpty();
      continue;
    }
    throw new NotEmpty();
  }
}

const UNTOUCHED_MS = 2_000;
/** The locked folders' own names under me/: the walk never goes into them. */
const LOCKED_NAMES: ReadonlySet<string> = new Set(LOCKABLE_DIRS.map((d) => d.split("/")[1]!));

/**
 * Whether the locked folders could hold anything, from their own metadata only (never their contents). A missing
 * folder is fine unless the app recorded where it was (`lockRecorded`): then it may have been moved into the tree.
 */
function lockedFoldersTouched(root: string, lockRecorded: boolean): boolean {
  for (const rel of LOCKABLE_DIRS) {
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(root, ...rel.split("/"))); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && !lockRecorded) continue;
      return true;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return true;
    // No birthtime (some platforms report 0): can't tell, so not empty.
    if (!(st.birthtimeMs > 0) || Math.abs(st.mtimeMs - st.birthtimeMs) > UNTOUCHED_MS) return true;
  }
  return false;
}

/**
 * `lockRecorded`: the app has recorded a locked folder's identity for this workspace. If such a folder is then missing
 * from its place, it could have been moved anywhere in the tree, so nothing is walked and it counts as not empty.
 */
export function isEmptyWorkspace(root: string, opts: { lockRecorded?: boolean } = {}): boolean {
  try {
    if (lockedFoldersTouched(root, !!opts.lockRecorded)) return false;
    const budget = { n: 0 };
    for (const name of entries(root)) {
      const p = path.join(root, name);
      const st = lst(p);
      if (st.isSymbolicLink()) return false;
      if (INTERNAL.has(name) || name === "workspace.json" || name === "CLAUDE.md" || name === ".gitignore") continue;
      if (!st.isDirectory()) return false;
      if (CONTENT_DIRS.has(name)) { walk(p, budget, name === "me" ? LOCKED_NAMES : undefined); continue; }
      if (name === "knowledge") { knowledgeDefault(p); continue; }
      if (name === "settings") {
        for (const s of entries(p)) {
          const sst = lst(path.join(p, s));
          if (!sst.isFile() || !(s.endsWith(".json") || s === ".env")) return false;
        }
        continue;
      }
      if (name === ".claude") {
        for (const s of entries(p)) if (s !== "settings.json" || !lst(path.join(p, s)).isFile()) return false;
        continue;
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** How many companies the workspace has (folders under companies/ with a company.json), or null when unreadable. */
export function companyCount(root: string): number | null {
  try {
    const dir = path.join(root, "companies");
    let n = 0;
    for (const name of fs.readdirSync(dir)) {
      try { if (fs.lstatSync(path.join(dir, name, "company.json")).isFile()) n++; } catch { /* not a company folder */ }
      if (n >= MAX_ENTRIES) break;
    }
    return n;
  } catch { return null; }
}
