import { ArgError, arr, bool, httpsUrl, int, num, obj, oneOf, opt, str, type V } from "./validate.js";

/**
 * Research any topic (spec 2026-10-17-research-any-topic): research/<slug>/ holds topic.json (the app), report.md and
 * report.json (Claude). The app never shows Claude-written HTML: report.json is checked here and rendered by the app's
 * own components; when it fails, the app shows report.md with its Markdown reader instead.
 */

export const RESEARCH_DIR = "research";
/** actions.ts topicLabel, repeated here so this module doesn't import actions.ts (which imports REPORT_SHAPE from here). */
const topicLabel = (s: string) => s.replace(/[^\p{L}\p{N} +#./()&,'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
/** A report older than this many days shows "Needs refresh". */
export const RESEARCH_STALE_DAYS = 30;
export const RESEARCH_DEPTHS = ["quick", "thorough"] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];
/** The largest report.json the app reads. */
export const REPORT_JSON_MAX = 512 * 1024;
/** The questions a person adds go to Claude as the request's note (NOTE_MAX). */
export const RESEARCH_QUESTIONS_MAX = 1000;
export const RESEARCH_FILES = { topic: "topic.json", md: "report.md", json: "report.json", html: "report.html", pdf: "report.pdf" } as const;

export interface ResearchSource {
  id: number; title: string; url: string; publisher?: string;
  /** The day Claude read the page (YYYY-MM-DD). */
  accessed: string;
  /** A government, regulator or other official page. */
  official?: boolean;
}
export interface ResearchFact { label: string; value: string; detail?: string; sources?: number[] }
export interface ResearchSection { heading: string; paragraphs?: string[]; bullets?: string[]; sources?: number[] }
export interface ResearchStep { title: string; detail?: string; duration?: string; sources?: number[] }
export interface ResearchTable { title: string; columns: string[]; rows: string[][]; note?: string; sources?: number[] }
export interface ResearchBar { label: string; value: number }
export interface ResearchChart { title: string; unit?: string; bars: ResearchBar[]; note?: string; sources?: number[] }
export interface ResearchReport {
  schema: 1;
  title: string;
  /** The day the facts were checked (YYYY-MM-DD). */
  as_of: string;
  summary: string;
  /** Claude's note that these rules or numbers change often, or "" / absent. */
  changes_often?: string;
  confidence?: "high" | "medium" | "low";
  key_facts?: ResearchFact[];
  sections?: ResearchSection[];
  steps?: ResearchStep[];
  tables?: ResearchTable[];
  charts?: ResearchChart[];
  uncertain?: string[];
  sources: ResearchSource[];
}

/** One topic as the Research list shows it. */
export interface ResearchTopic {
  slug: string; title: string; questions: string; depth: ResearchDepth; created_at: string;
  /** When report.md was last written (ISO), or "" before Claude has written it. */
  at: string;
  /** report.json's "as of" date when it reads, else "". */
  as_of: string;
  stale: boolean;
}
/** One topic's page. `report` is null when report.json is missing or failed its check (`problems` says why). */
export interface ResearchView {
  topic: ResearchTopic;
  report: ResearchReport | null;
  markdown: string | null;
  problems: string[];
  /** The exported files that exist (workspace-relative), else null. */
  exports: { html: string | null; pdf: string | null };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date: V<string> = (v, at) => {
  const s = str({ min: 10, max: 10, pattern: DATE })(v, at);
  if (Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new ArgError(`${at} must be a real date`);
  return s;
};
const line = (max: number) => str({ min: 1, max });
const text = (max: number) => str({ min: 1, max, multiline: true });
const refs = opt(arr(int(1, 99), { max: 12 }));

/**
 * Lenient about extra keys (Claude may add one), strict about the known ones: only the shape's own keys are kept,
 * then checked. `null` for an optional key counts as absent.
 */
function known<S extends Record<string, V<unknown>>>(shape: S): V<{ [K in keyof S]: ReturnType<S[K]> }> {
  const strict = obj(shape);
  return (v, at) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return strict(v, at);
    const picked: Record<string, unknown> = {};
    for (const k of Object.keys(shape)) {
      const x = (v as Record<string, unknown>)[k];
      if (Object.hasOwn(v, k) && x !== null) picked[k] = x;
    }
    return strict(picked, at);
  };
}

const source = known({
  id: int(1, 99), title: line(200), url: httpsUrl, publisher: opt(str({ max: 120 })), accessed: date, official: opt(bool),
});
const fact = known({ label: line(80), value: line(80), detail: opt(str({ max: 300, multiline: true })), sources: refs });
const section = known({
  heading: line(120), paragraphs: opt(arr(text(1500), { max: 8 })), bullets: opt(arr(text(400), { max: 12 })), sources: refs,
});
const step = known({ title: line(120), detail: opt(str({ max: 600, multiline: true })), duration: opt(str({ max: 60 })), sources: refs });
const table = known({
  title: line(120), columns: arr(line(60), { min: 2, max: 6 }), rows: arr(arr(str({ max: 200 }), { min: 2, max: 6 }), { min: 1, max: 20 }),
  note: opt(str({ max: 300 })), sources: refs,
});
const chart = known({
  title: line(120), unit: opt(str({ max: 30 })), bars: arr(known({ label: line(60), value: num(0, 1e12) }), { min: 1, max: 12 }),
  note: opt(str({ max: 300 })), sources: refs,
});
const report = known({
  schema: int(1, 1), title: line(160), as_of: date, summary: text(2000),
  changes_often: opt(str({ max: 300, multiline: true })), confidence: opt(oneOf(["high", "medium", "low"] as const)),
  key_facts: opt(arr(fact, { max: 12 })), sections: opt(arr(section, { max: 12 })), steps: opt(arr(step, { max: 15 })),
  tables: opt(arr(table, { max: 6 })), charts: opt(arr(chart, { max: 4 })), uncertain: opt(arr(text(400), { max: 10 })),
  sources: arr(source, { min: 1, max: 40 }),
});

/**
 * report.json, checked: every field's type and length, https source links only, finite chart numbers, rows as wide
 * as their table, and every footnote naming a listed source. Returns null with the reasons when it fails.
 */
export function parseResearchReport(raw: unknown): { report: ResearchReport | null; problems: string[] } {
  let r: ResearchReport;
  try { r = report(raw, "report") as ResearchReport; } catch (e) { return { report: null, problems: [(e as Error).message] }; }
  const problems: string[] = [];
  const ids = new Set<number>();
  for (const s of r.sources) {
    if (ids.has(s.id)) problems.push(`report.sources has source ${s.id} twice`);
    ids.add(s.id);
  }
  const check = (where: string, list: number[] | undefined) => {
    for (const n of list ?? []) if (!ids.has(n)) problems.push(`${where} cites source ${n}, which isn't listed`);
  };
  r.key_facts?.forEach((x, i) => check(`report.key_facts[${i}]`, x.sources));
  r.sections?.forEach((x, i) => check(`report.sections[${i}]`, x.sources));
  r.steps?.forEach((x, i) => check(`report.steps[${i}]`, x.sources));
  r.tables?.forEach((x, i) => {
    check(`report.tables[${i}]`, x.sources);
    x.rows.forEach((row, j) => { if (row.length !== x.columns.length) problems.push(`report.tables[${i}].rows[${j}] has ${row.length} cells for ${x.columns.length} columns`); });
  });
  r.charts?.forEach((x, i) => check(`report.charts[${i}]`, x.sources));
  return problems.length ? { report: null, problems } : { report: r, problems: [] };
}

/** report.json's text, parsed and checked. Oversized or broken JSON is a problem, never a throw. */
export function readResearchReport(text: string): { report: ResearchReport | null; problems: string[] } {
  if (text.length > REPORT_JSON_MAX) return { report: null, problems: ["report.json is too large"] };
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^﻿/, "")); } catch { return { report: null, problems: ["report.json isn't valid JSON"] }; }
  return parseResearchReport(raw);
}

/** True when the report was written more than RESEARCH_STALE_DAYS ago. Unknown times are not stale. */
export function researchStale(at: string, now: Date): boolean {
  const t = Date.parse(at);
  return !Number.isNaN(t) && now.getTime() - t > RESEARCH_STALE_DAYS * 86_400_000;
}

/** topic.json as the app wrote it; anything unreadable falls back to the folder name. */
export function researchMeta(raw: unknown, slug: string): Pick<ResearchTopic, "title" | "questions" | "depth" | "created_at"> {
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const title = topicLabel(s(o.title, 80)) || topicLabel(slug.replace(/-/g, " "));
  const depth = (RESEARCH_DEPTHS as readonly unknown[]).includes(o.depth) ? o.depth as ResearchDepth : "quick";
  const created = s(o.created_at, 40);
  return { title, questions: s(o.questions, RESEARCH_QUESTIONS_MAX), depth, created_at: Number.isNaN(Date.parse(created)) ? "" : created };
}

/** The "Research a topic" request's options and note for a topic (Refresh sends the same). */
export function researchRequest(t: Pick<ResearchTopic, "questions" | "depth">): { options: { depth: ResearchDepth }; note: string } {
  return { options: { depth: t.depth }, note: t.questions.trim() };
}

/** The shape Claude writes, for the prompt (one line). */
export const REPORT_SHAPE =
  '{"schema": 1, "title": "...", "as_of": "YYYY-MM-DD", "summary": "2 to 4 plain sentences", "changes_often": "what changes often, or \\"\\"", ' +
  '"confidence": "high|medium|low", "key_facts": [{"label": "...", "value": "short figure or fact", "detail": "...", "sources": [1]}], ' +
  '"sections": [{"heading": "...", "paragraphs": ["..."], "bullets": ["..."], "sources": [1, 2]}], ' +
  '"steps": [{"title": "...", "detail": "...", "duration": "typical time, or \\"\\"", "sources": [1]}], ' +
  '"tables": [{"title": "...", "columns": ["...", "..."], "rows": [["...", "..."]], "note": "...", "sources": [2]}], ' +
  '"charts": [{"title": "...", "unit": "...", "bars": [{"label": "...", "value": 0}], "note": "...", "sources": [3]}], ' +
  '"uncertain": ["what you could not confirm"], ' +
  '"sources": [{"id": 1, "title": "...", "url": "https://...", "publisher": "...", "accessed": "YYYY-MM-DD", "official": true}]}';
