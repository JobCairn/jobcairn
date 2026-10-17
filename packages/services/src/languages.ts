import fs from "node:fs";
import path from "node:path";
import { insideRoot, jobFilePath, layout, readRecord } from "@careeros/core";
import { checkLanguages, detectLanguageNeeds, spokenLanguages, type JobRow, type LanguageNeed, type SpokenLanguage } from "@careeros/contract";

/**
 * Languages in Jobs (spec 2026-10-17-languages-and-research-refresh): each saved ad's language needs, read from its
 * jd.md and kept in memory by file time and size, against the profile's Languages list. The job record is unchanged.
 */

const MAX_CACHED = 5000;
const cache = new Map<string, { stamp: string; needs: LanguageNeed[] }>();

/** The profile's Languages list, or [] when it has none or can't be read. */
export function profileLanguages(root: string): SpokenLanguage[] {
  try { return spokenLanguages(readRecord("profile", layout(root).profile).languages); } catch { return []; }
}

/** The languages one saved ad requires ([] without an ad). Read once per change to jd.md. */
export function adLanguageNeeds(root: string, slug: string, id: string): LanguageNeed[] {
  const file = path.join(path.dirname(jobFilePath(root, slug, id)), "jd.md");
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { return []; }
  if (!st.isFile() || !insideRoot(root, file)) return [];
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.needs;
  let needs: LanguageNeed[] = [];
  try { needs = detectLanguageNeeds(fs.readFileSync(file, "utf8")); } catch { /* unreadable: nothing to say */ }
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(file, { stamp, needs });
  return needs;
}

/**
 * The rows with a language result where one needs a look (a blocker or a warning). With no languages in the profile
 * nothing is known, so no ad is read and no row is marked.
 */
export function withLanguages(root: string, rows: JobRow[]): JobRow[] {
  const have = profileLanguages(root);
  if (!have.length) return rows;
  return rows.map((r) => {
    const lang = checkLanguages(adLanguageNeeds(root, r.company_slug, r.id), have);
    return lang && lang.verdict !== "unknown" ? { ...r, lang } : r;
  });
}
