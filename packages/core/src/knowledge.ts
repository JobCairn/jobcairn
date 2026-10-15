import fs from "node:fs";
import { type Clock, iso } from "./clock.js";
import { layout } from "./paths.js";
import { appendLineSafe } from "./store.js";

export interface SearchEntry {
  at: string; site: string; query: string; location: string; results: string; kept: string; notes: string;
  /** How the search ran (Search in my Chrome or web search). Absent on entries logged before it was recorded. */
  mode?: "chrome" | "web";
}

export function appendSearch(
  root: string,
  e: { site: string; query: string; location: string; at?: string; results?: string | number; kept?: string | number; notes?: string; mode?: "chrome" | "web" },
  c?: Clock,
): SearchEntry {
  const entry: SearchEntry = {
    at: e.at ?? iso(c), site: e.site, query: e.query, location: e.location,
    results: e.results === undefined ? "" : String(e.results), kept: e.kept === undefined ? "" : String(e.kept), notes: e.notes ?? "",
    ...(e.mode ? { mode: e.mode } : {}),
  };
  appendLineSafe(root, layout(root).searchLog, JSON.stringify(entry) + "\n");
  return entry;
}

export function readSearches(root: string): { entries: SearchEntry[]; badLines: number[] } {
  const file = layout(root).searchLog;
  const entries: SearchEntry[] = [];
  const badLines: number[] = [];
  if (!fs.existsSync(file)) return { entries, badLines };
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const v = JSON.parse(line) as SearchEntry;
      if (typeof v.site !== "string" || typeof v.query !== "string") throw new Error("missing fields");
      entries.push(v);
    } catch {
      badLines.push(i + 1);
    }
  });
  return { entries, badLines };
}

const key = (site: string, q: string, loc: string) =>
  [site.toLowerCase().trim(), q.toLowerCase().replace(/\W+/g, " ").trim(), loc.toLowerCase().trim()].join("|");

export function ranRecently(root: string, site: string, query: string, location: string, days = 7, c?: Clock): SearchEntry | null {
  const cutoff = new Date((c?.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
  const want = key(site, query, location);
  const hits = readSearches(root).entries.filter((e) => e.at >= cutoff && key(e.site, e.query, e.location) === want);
  return hits.at(-1) ?? null;
}
