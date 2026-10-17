import fs from "node:fs";
import path from "node:path";
import { LOCKABLE_DIRS, type ClaudeRunFile } from "@careeros/contract";
import { isOsJunk } from "@careeros/video";
import { probeFor } from "../actions.js";

/** Folders never scanned: app internals, and the locked folders (never read or counted without unlock). */
const SKIP_DIRS = new Set([".careeros", ".index", ".backup", ".git", ".claude", "node_modules", ...LOCKABLE_DIRS]);
/** Record files the `careeros` CLI or MCP tools write on Claude's behalf (job new, job event, search add, score_record, recruiter_add). Not stray. */
const CLI_RECORDS = [
  /^workspace\.json$/, /^knowledge\/(sponsors\.json|search-log\.jsonl)$/,
  /^companies\/[^/]+\/company\.json$/, /^companies\/[^/]+\/jobs\/[^/]+\/(job\.json|jd\.md|score\.json)$/,
  /^recruiters\/[^/]+\/agency\.json$/,
];
const MAX_SCAN = 20_000;
/** OS junk (.DS_Store, ._*, Thumbs.db, desktop.ini, .Spotlight-V100, ~$ lock files) is never a run's change, new or deleted. */

const LABELS: [RegExp, string][] = [
  [/(^|\/)resume\.md$/, "Resume"], [/(^|\/)cover-letter\.md$/, "Cover letter"], [/(^|\/)claims\.json$/, "Claim sources"], [/(^|\/)review\.json$/, "Second-pass review"],
  [/(^|\/)answers\.md$/, "Application answers"], [/(^|\/)score\.md$/, "Job score"], [/(^|\/)research\.md$/, "Company research"],
  [/(^|\/)questions\.md$/, "Interview questions"], [/(^|\/)script\.txt$/, "Video script"], [/(^|\/)spec\.json$/, "Video plan"],
  [/(^|\/)sources\.md$/, "Sources"], [/(^|\/)notes\.md$/, "Notes"], [/(^|\/)pitch\.md$/, "Pitch"],
  [/job-searches\/[^/]+\.md$/, "Search report"], [/\.mp4$/, "Video"], [/\.wav$/, "Narration"],
];
/** A friendly name for a file the run wrote. */
export function fileLabel(rel: string): string {
  return LABELS.find(([re]) => re.test(rel))?.[1] ?? path.posix.basename(rel);
}

const inside = (rel: string, folder: string) => rel === folder || rel.startsWith(`${folder}/`);

/**
 * Regular files and symlinks under `dir` (workspace-relative), no links followed, stopping at MAX_SCAN entries
 * (a known limit: a workspace past 20,000 entries is only partly checked; spec 2026-10-10 open points).
 */
function walk(root: string, start: string, visit: (rel: string, st: fs.Stats) => void): void {
  let seen = 0;
  const stack = [start];
  while (stack.length && seen < MAX_SCAN) {
    const rel = stack.pop()!;
    let names: string[];
    try { names = fs.readdirSync(path.join(root, ...rel.split("/").filter(Boolean))); } catch { continue; }
    for (const name of names) {
      if (++seen > MAX_SCAN) break;
      if (isOsJunk(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      if (SKIP_DIRS.has(r) || (rel === "" && SKIP_DIRS.has(name))) continue;
      let st: fs.Stats;
      try { st = fs.lstatSync(path.join(root, ...r.split("/"))); } catch { continue; }
      if (st.isDirectory()) stack.push(r);
      else if (st.isFile() || st.isSymbolicLink()) visit(r, st);
    }
  }
}

/** Every file's identity and change stamp, workspace-relative (locked folders and app internals skipped). */
export type Snapshot = Map<string, string>;
/** Links are stamped by where they point (never followed), so a new or re-pointed link shows up. */
const LINK = "link:";
function stamp(root: string, rel: string, st: fs.Stats): string {
  if (!st.isSymbolicLink()) return `${st.ino}:${st.size}:${st.mtimeMs}`;
  let to = "";
  try { to = fs.readlinkSync(path.join(root, ...rel.split("/"))); } catch { /* gone already */ }
  return `${LINK}${st.ino}:${to}`;
}

export function snapshot(root: string): Snapshot {
  const m: Snapshot = new Map();
  walk(root, "", (rel, st) => m.set(rel, stamp(root, rel, st)));
  return m;
}

export interface VerifyInput {
  root: string;
  /** The folder the run could write in; null when it could write nothing. */
  folder: string | null;
  /** When set, only these files count as the run's own; anything else in the folder is stray. */
  files?: readonly string[] | null;
  /** Files that must exist, new or rewritten by this run, for success. */
  expected: string[];
  /** The workspace before the run started. */
  before: Snapshot;
  /** Writes the stream reported as done: workspace-relative, or null for a path outside the workspace. */
  writes: (string | null)[];
  /** Folders of other runs that were active at the same time; their files are theirs, not stray. */
  others: string[];
  /**
   * "writes": only the run's own reported writes can be stray (final review I5). For a run with no shell and only
   * Write/Edit tools (a video script), every change it can make shows up as a tool event; other changes in the
   * workspace while it ran (another video's render, mail sync, the person's edits) are someone else's.
   */
  strayFrom?: "workspace" | "writes";
}
export interface VerifyResult { files: ClaudeRunFile[]; missing: string[]; stray: string[] }

/**
 * After a run: which files it made or changed in its folder, which expected outputs are missing (or weren't
 * rewritten), and anything new or changed outside its folder while it ran (stray). Expected files are checked
 * with the same probe as the hand-off: a regular, single-named file at its real path, no links on the way.
 */
export function verifyRun(v: VerifyInput): VerifyResult {
  const own = (rel: string) => (v.files ? v.files.includes(rel) : v.folder !== null && inside(rel, v.folder));
  const after = snapshot(v.root);
  const changed = (rel: string) => after.has(rel) && after.get(rel) !== v.before.get(rel);
  const probe = probeFor(v.root);
  const missing = v.expected.filter((rel) => !probe(rel).exists || !changed(rel) || !own(rel));
  const files: ClaudeRunFile[] = [];
  const stray = new Set<string>();
  const byWrites = v.strayFrom === "writes";
  for (const rel of after.keys()) {
    if (!changed(rel)) continue;
    if (byWrites) {
      if (own(rel) && !after.get(rel)!.startsWith(LINK)) files.push({ path: rel, label: fileLabel(rel), expected: v.expected.includes(rel) });
      continue;
    }
    // A link the run made or re-pointed is never one of its files, even in its own folder: it could lead anywhere.
    if (after.get(rel)!.startsWith(LINK)) { stray.add(`${rel} (link)`); continue; }
    if (own(rel)) { files.push({ path: rel, label: fileLabel(rel), expected: v.expected.includes(rel) }); continue; }
    if (v.others.some((o) => inside(rel, o))) continue;
    if (CLI_RECORDS.some((re) => re.test(rel))) continue;
    stray.add(rel);
  }
  for (const rel of byWrites ? [] : v.before.keys()) {
    if (after.has(rel) || own(rel) || v.others.some((o) => inside(rel, o))) continue;
    stray.add(`${rel} (deleted)`);
  }
  for (const w of v.writes) {
    if (w === null) stray.add("a file outside your workspace");
    else if (!own(w)) stray.add(w);
  }
  files.sort((a, b) => Number(b.expected) - Number(a.expected) || a.path.localeCompare(b.path));
  return { files: files.slice(0, 100), missing, stray: [...stray].sort().slice(0, 50) };
}
