import fs from "node:fs";
import path from "node:path";
import { readFiledLog, readMeta } from "@careeros/core";
import type { FolderSummary, InboxOverview } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import { lockedFor } from "./integrity.js";

/** The sections the drop box files into, in the order the hub shows them. */
export const FOLDERS: { id: string; label: string; rel: string }[] = [
  { id: "resumes", label: "Resumes", rel: "me/resumes" },
  { id: "history", label: "Work history", rel: "me/history" },
  { id: "projects", label: "Projects", rel: "me/projects" },
  { id: "education", label: "Education", rel: "me/education" },
  { id: "identity", label: "Identity documents", rel: "me/identity" },
  { id: "employment", label: "Employment records", rel: "me/employment" },
  { id: "companies", label: "Companies and jobs", rel: "companies" },
  { id: "knowledge", label: "Knowledge", rel: "knowledge" },
  { id: "learning", label: "Learning", rel: "learning" },
];
const MAX_FILES = 5000;

/**
 * Files under `dir` (dotfiles, records and links skipped; links never followed) and the newest change.
 * `skip` is asked before entering each folder, so a locked folder that was moved inside a counted
 * section is never listed or stat'ed.
 */
function countFiles(dir: string, skip: (d: string) => boolean): { count: number; updated: number } {
  let count = 0;
  let updated = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 8 || count >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip(p)) walk(p, depth + 1); }
      else if (e.isFile() && !/^(job|company)\.json$/.test(e.name)) {
        count++;
        try { updated = Math.max(updated, fs.lstatSync(p).mtimeMs); } catch { /* gone */ }
      }
    }
  };
  walk(dir, 0);
  return { count, updated };
}

/**
 * The drop box hub: a count per section and the filing history. A folder that is locked in Privacy is
 * never listed, counted or stat'ed, whether or not Claude holds a grant for it right now, and wherever
 * it has been moved to inside the workspace.
 */
export function inboxOverview(ctx: ServiceContext): InboxOverview {
  const root = ctx.requireRoot();
  const locked = new Set<string>(readMeta(root).privacy.locked);
  const folders: FolderSummary[] = FOLDERS.map((f) => {
    if (locked.has(f.rel)) return { ...f, count: null, updated: "", locked: true };
    const abs = path.join(root, ...f.rel.split("/"));
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(abs); } catch { st = undefined; }
    if (!st || !st.isDirectory()) return { ...f, count: 0, updated: "", locked: false };
    // Locked by path or by recorded folder identity (a locked folder moved or renamed into this section).
    const skip = (d: string) => lockedFor(ctx, root, d) !== null;
    if (skip(abs)) return { ...f, count: null, updated: "", locked: true };
    const { count, updated } = countFiles(abs, skip);
    return { ...f, count, updated: updated ? new Date(updated).toISOString() : "", locked: false };
  });
  return { folders, history: readFiledLog(root, 30) };
}
