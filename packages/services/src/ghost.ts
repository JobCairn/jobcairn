import path from "node:path";
import { companyKey, jobFilePath } from "@careeros/core";
import { findReposts, withGhostFlags, type GhostAd, type JobRow } from "@careeros/contract";
import { readIfFile } from "./read.js";

/**
 * The rows with their ghost flags (contract ghost.ts): stale from the posted date, reposts from the ad text. Only
 * companies with two or more saved jobs have their ads read, grouped by the duplicate check's company key
 * (core dedupe.ts), so a big workspace reads few files. Everything stays on this computer.
 */
export function withGhosts(root: string, rows: JobRow[], now: Date): JobRow[] {
  const groups = new Map<string, JobRow[]>();
  for (const r of rows) {
    const k = companyKey(r.company_name) || companyKey(r.company_slug.replace(/-/g, " "));
    if (k) (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const ads: GhostAd[] = [];
  for (const [company, group] of groups) {
    if (group.length < 2) continue;
    for (const r of group) {
      let text = "";
      try { text = readIfFile(root, path.join(path.dirname(jobFilePath(root, r.company_slug, r.id)), "jd.md")); } catch { /* no ad text */ }
      if (text) ads.push({ key: `${r.company_slug}/${r.id}`, company, id: r.id, title: r.title, posted: r.posted, found_at: r.found_at, text });
    }
  }
  return withGhostFlags(rows, findReposts(ads), now);
}
