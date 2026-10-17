import fs from "node:fs";
import path from "node:path";
import { insideRoot, layout } from "@careeros/core";
import { RESEARCH_FILE, researchedOn } from "@careeros/contract";

/** Bytes read from the top of research.md to find its "Researched:" line. */
const HEAD_BYTES = 8 * 1024;

/**
 * When the company's research.md was researched: the date it states (YYYY-MM-DD), else its modified time (ISO).
 * "" when there is no research.md (or it's a symlink, or outside the workspace).
 */
export function companyResearchAt(root: string, slug: string): string {
  const file = path.join(layout(root).companyDir(slug), RESEARCH_FILE);
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { return ""; }
  if (!st.isFile() || !insideRoot(root, file)) return "";
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { /* unreadable: fall back to the file time */ }
  return researchedOn(head) || st.mtime.toISOString();
}
