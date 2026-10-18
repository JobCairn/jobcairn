/**
 * Research any topic (spec 2026-10-17-research-any-topic): research/<slug>/ holds topic.json (written here), report.md
 * and report.json (Claude, research_topic) and the exports (report.html, report.pdf, written here). Claude's files are
 * only read: report.json is checked by the contract's schema and the renderer draws it with its own components.
 */
import fs from "node:fs";
import path from "node:path";
import { insideRoot, writeFileAtomic } from "@careeros/core";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import {
  readResearchReport, researchHtml, researchMeta, researchStale, researchTextHtml, RESEARCH_DIR, RESEARCH_FILES, REPORT_JSON_MAX,
  topicLabel, topicSlug, type ResearchDepth, type ResearchTopic, type ResearchView,
} from "@careeros/contract";
import { writableProblem } from "./actions.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { realDirInRoot } from "./files.js";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_MD_BYTES = 1024 * 1024;
const MAX_TOPIC_BYTES = 16 * 1024;

/** A plain, single-linked file's modified time, else null. */
const fileAt = (abs: string): string | null => {
  try { const st = fs.lstatSync(abs); return st.isFile() && st.nlink === 1 ? st.mtime.toISOString() : null; } catch { return null; }
};
/** A plain, single-linked file's text when it is at most `max` bytes, else null. */
function readPlain(abs: string, max: number): string | null {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.nlink !== 1 || st.size > max) return null;
    return fs.readFileSync(abs, "utf8");
  } catch { return null; }
}

/** research/ itself, when it is a plain folder inside the workspace (null when it doesn't exist yet). */
function topDir(root: string): string | null {
  const abs = path.join(root, RESEARCH_DIR);
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("The research folder isn't a plain folder in the workspace.");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!insideRoot(root, abs)) throw new Error("The research folder isn't a plain folder in the workspace.");
  return abs;
}

/** One topic's folder: research/<slug>/, a plain folder. */
function topicDir(root: string, slug: string): string {
  if (!SLUG.test(slug) || slug.length > 64) throw new Error("That isn't a research topic.");
  const top = topDir(root);
  const abs = top ? path.join(top, slug) : null;
  let ok = false;
  try { const st = abs ? fs.lstatSync(abs) : null; ok = !!st && st.isDirectory() && !st.isSymbolicLink(); } catch { ok = false; }
  if (!abs || !ok || !insideRoot(root, abs)) throw new Error("That research topic isn't there any more.");
  return abs;
}

function topicOf(ctx: ServiceContext, abs: string, slug: string): ResearchTopic {
  let raw: unknown = null;
  const text = readPlain(path.join(abs, RESEARCH_FILES.topic), MAX_TOPIC_BYTES);
  try { raw = text === null ? null : JSON.parse(text); } catch { raw = null; }
  const meta = researchMeta(raw, slug);
  const at = fileAt(path.join(abs, RESEARCH_FILES.md)) ?? "";
  let as_of = "";
  if (at) {
    const json = readPlain(path.join(abs, RESEARCH_FILES.json), REPORT_JSON_MAX);
    if (json !== null) as_of = readResearchReport(json).report?.as_of ?? "";
  }
  return { slug, ...meta, at, as_of, stale: researchStale(at, ctx.now()) };
}

export function researchList(ctx: ServiceContext): ResearchTopic[] {
  const root = ctx.requireRoot();
  const top = topDir(root);
  if (!top) return [];
  const out: ResearchTopic[] = [];
  for (const d of fs.readdirSync(top, { withFileTypes: true })) {
    if (!d.isDirectory() || d.isSymbolicLink() || !SLUG.test(d.name) || d.name.length > 64) continue;
    out.push(topicOf(ctx, path.join(top, d.name), d.name));
  }
  // Newest first: the report's time, else when the topic was made.
  return out.sort((a, b) => (b.at || b.created_at).localeCompare(a.at || a.created_at) || a.title.localeCompare(b.title));
}

function writeTopic(abs: string, t: { title: string; questions: string; depth: ResearchDepth; created_at: string }): void {
  writeFileAtomic(path.join(abs, RESEARCH_FILES.topic), `${JSON.stringify(t, null, 2)}\n`);
}

export function researchCreate(ctx: ServiceContext, title: string, questions: string, depth: ResearchDepth): ResearchTopic {
  const root = ctx.requireRoot();
  if (!/[\p{L}\p{N}]/u.test(title)) throw new Error("Type a topic to research, like a work visa or pay for a role.");
  const clean = topicLabel(title);
  if (!clean.trim()) throw new Error("Type a topic to research, like a work visa or pay for a role.");
  const top = realDirInRoot(root, path.join(root, RESEARCH_DIR), "The research folder");
  if (writableProblem(ctx, root, RESEARCH_DIR) !== null) throw new Error("The research folder isn't a plain folder in the workspace.");
  const base = topicSlug(clean).slice(0, 56).replace(/-+$/, "") || "topic";
  let slug = base;
  for (let n = 2; fs.existsSync(path.join(top, slug)); n++) slug = `${base}-${n}`;
  const abs = path.join(top, slug);
  if (!insideRoot(root, abs)) throw new Error("refusing to write outside the workspace");
  fs.mkdirSync(abs);
  writeTopic(abs, { title: clean, questions: questions.trim(), depth, created_at: ctx.now().toISOString() });
  return topicOf(ctx, abs, slug);
}

export function researchUpdate(ctx: ServiceContext, slug: string, questions: string, depth: ResearchDepth): ResearchTopic {
  const root = ctx.requireRoot();
  const abs = topicDir(root, slug);
  const t = topicOf(ctx, abs, slug);
  writeTopic(abs, { title: t.title, questions: questions.trim(), depth, created_at: t.created_at || ctx.now().toISOString() });
  return topicOf(ctx, abs, slug);
}

export function researchGet(ctx: ServiceContext, slug: string): ResearchView {
  const root = ctx.requireRoot();
  const abs = topicDir(root, slug);
  const topic = topicOf(ctx, abs, slug);
  const markdown = topic.at ? readPlain(path.join(abs, RESEARCH_FILES.md), MAX_MD_BYTES) : null;
  const json = readPlain(path.join(abs, RESEARCH_FILES.json), REPORT_JSON_MAX + 1);
  const parsed = json === null ? { report: null, problems: fileAt(path.join(abs, RESEARCH_FILES.json)) ? ["report.json is too large"] : [] } : readResearchReport(json);
  const rel = (f: string) => (fileAt(path.join(abs, f)) ? `${RESEARCH_DIR}/${slug}/${f}` : null);
  return { topic, report: parsed.report, markdown, problems: parsed.problems, exports: { html: rel(RESEARCH_FILES.html), pdf: rel(RESEARCH_FILES.pdf) } };
}

const madeAt = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** The export's HTML: the report from report.json, else report.md as escaped text. */
function exportHtml(ctx: ServiceContext, slug: string): { abs: string; html: string } {
  const root = ctx.requireRoot();
  const abs = topicDir(root, slug);
  const v = researchGet(ctx, slug);
  const o = { madeAt: madeAt(ctx.now()), product: identity.name };
  if (v.report) return { abs, html: researchHtml(v.report, o) };
  if (v.markdown !== null) return { abs, html: researchTextHtml(v.topic.title, v.markdown, o) };
  throw new Error("Claude hasn't written this report yet. Research it first.");
}

/** Writes an export file in the topic's folder, refusing a link or anything that isn't a plain file in its place. */
function writeExport(root: string, abs: string, name: string, data: string | Uint8Array): void {
  const file = path.join(abs, name);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${name} isn't a plain file, so it wasn't replaced.`);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (!insideRoot(root, file)) throw new Error("refusing to write outside the workspace");
  writeFileAtomic(file, data);
}

export function researchExportHtml(ctx: ServiceContext, slug: string): string {
  const { abs, html } = exportHtml(ctx, slug);
  writeExport(ctx.requireRoot(), abs, RESEARCH_FILES.html, html);
  return `${RESEARCH_DIR}/${slug}/${RESEARCH_FILES.html}`;
}

export async function researchExportPdf(ctx: ServiceContext, slug: string): Promise<string> {
  const printer = ctx.host.printer;
  if (!printer) throw new Error("PDF export isn't available here.");
  const { abs, html } = exportHtml(ctx, slug);
  const pdf = await printer.toPdf(html);
  writeExport(ctx.requireRoot(), abs, RESEARCH_FILES.pdf, pdf);
  return `${RESEARCH_DIR}/${slug}/${RESEARCH_FILES.pdf}`;
}

/** For the trash: the topic's title and how many videos go with it. Throws when it isn't there. */
export function researchTrashInfo(ctx: ServiceContext, slug: string): { title: string; videos: number } {
  const root = ctx.requireRoot();
  const abs = topicDir(root, slug);
  const t = topicOf(ctx, abs, slug);
  let videos = 0;
  try { videos = fs.readdirSync(path.join(abs, "videos")).filter((n) => !n.startsWith(".")).length; } catch { videos = 0; }
  return { title: t.title, videos };
}

export const researchHandlers = {
  "research.list": researchList,
  "research.create": researchCreate,
  "research.update": researchUpdate,
  "research.get": researchGet,
  "research.exportHtml": researchExportHtml,
  "research.exportPdf": researchExportPdf,
} satisfies Partial<HandlerTable>;
