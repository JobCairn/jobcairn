import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { addEvent, insideRoot, layout, readRecord, writeFileAtomic } from "@careeros/core";
import {
  EXPORT_FORMATS, EXPORT_SOURCE_TEXT, EXPORT_SOURCES, exportRel, exportSourceRel,
  type ExportFormat, type ExportSource, type ExportState,
} from "@careeros/contract";
import { writableProblem } from "./actions.js";
import type { ServiceContext } from "./context.js";
import { resolveWorkspaceFile } from "./files.js";
import { isPlaceholderFile } from "./placeholder.js";
import type { HandlerTable } from "./handlers.js";
import { renderDocx } from "./print/docx.js";
import { loadPrintFonts } from "./print/fonts.js";
import { renderHtml } from "./print/html.js";
import { ExportUnavailable, parseIsolated, ParseTooComplex, TooManyBlocks } from "./print/isolate.js";
import { MAX_EXPORT_BLOCKS, type PrintDoc } from "./print/markdown.js";
import { jobDetail, jobDirRel, touch } from "./read.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { exportStyle } from "./resume.js";
import { resumeDocx, resumeHtml, ResumeTooLarge } from "./print/resume-print.js";
import { parseResume, resumeLayout, visibleMarkdown, type ResumeStyle } from "@careeros/contract";

/** A resume or letter is a few KB; anything this large is refused before it is parsed. */
export const MAX_EXPORT_SOURCE_BYTES = 512 * 1024;
export { MAX_EXPORT_BLOCKS, MAX_EXPORT_RUNS } from "./print/markdown.js";

/** A regular file (not a link) inside the workspace, or null. */
function fileStat(root: string, rel: string): fs.Stats | null {
  const abs = path.join(root, ...rel.split("/"));
  try {
    const st = fs.lstatSync(abs);
    return st.isFile() && insideRoot(root, abs) ? st : null;
  } catch { return null; }
}

/** Why nothing can be written at this export name, or null: only a missing name or a plain, single-named file will do. */
function targetProblem(root: string, rel: string): string | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(path.join(root, ...rel.split("/"))); } catch { return null; }
  if (st.isFile() && st.nlink === 1) return null;
  return `${rel.split("/").slice(-3).join("/")} is a folder or link. Move it and try again.`;
}

export function exportState(ctx: ServiceContext, slug: string, id: string): ExportState {
  const root = ctx.requireRoot();
  jobDetail(root, slug, id); // a job that is gone gives the usual plain "no job" message
  return {
    sources: EXPORT_SOURCES.map((source) => {
      const p = exportSourceRel(slug, id, source);
      return { source, path: p, exists: !!fileStat(root, p) && !isPlaceholderFile(path.join(root, ...p.split("/"))) };
    }),
    files: EXPORT_SOURCES.flatMap((source) => EXPORT_FORMATS.map((format) => {
      const p = exportRel(slug, id, source, format);
      const st = fileStat(root, p);
      const problem = targetProblem(root, p);
      return { source, format, name: `${source}.${format}`, path: p, exists: !!st && !problem, size: st && !problem ? st.size : null, at: st && !problem ? st.mtime.toISOString() : "", problem };
    })),
  };
}

const plainFolderOrMissing = (abs: string) => {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return true; }
  return st.isDirectory() && !st.isSymbolicLink();
};

/**
 * application/export, created if needed. The application and export folders must each be a plain folder (not a
 * link, not a file); no part of the path may be a link or a file with a second name; and the folder must not be,
 * by path or by recorded identity, a locked folder that was moved here (writableProblem, shared with Claude
 * actions). Checked again after the folder is created.
 */
function exportDir(ctx: ServiceContext, root: string, slug: string, id: string): string {
  const appRel = `${jobDirRel(slug, id)}/application`;
  const rel = `${appRel}/export`;
  const refuse = (what: string) => new Error(`${what} must be a plain folder in the workspace, so nothing was exported.`);
  const check = () => {
    for (const r of [appRel, rel]) if (!plainFolderOrMissing(path.join(root, ...r.split("/")))) throw refuse(r);
    const bad = writableProblem(ctx, root, rel);
    if (bad !== null) throw refuse(bad);
  };
  check();
  const dir = path.join(root, ...rel.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  check();
  if (!insideRoot(root, dir)) throw refuse(rel);
  return dir;
}

function checkBytes(format: ExportFormat, bytes: Uint8Array): void {
  const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (format === "pdf" ? !head.startsWith("%PDF-") : !head.startsWith("PK")) throw new Error(`The ${format.toUpperCase()} export failed. Nothing was written for it.`);
}

/** Reads application/<source>.md through the usual read checks (locks, links, second names and the size cap). */
function readSourceMarkdown(ctx: ServiceContext, slug: string, id: string, source: ExportSource): string {
  const rel = `application/${source}.md`;
  const tooBig = () => new Error(`${rel} is larger than 512 KB, so it wasn't exported.`);
  const real = resolveWorkspaceFile(ctx, exportSourceRel(slug, id, source), "read");
  let md: string;
  try {
    if (fs.statSync(real).size > MAX_EXPORT_SOURCE_BYTES) throw tooBig();
    md = fs.readFileSync(real, "utf8");
  } catch (e) {
    throw (e as Error).message === tooBig().message ? e : new Error(`${rel} can't be read.`);
  }
  if (Buffer.byteLength(md) > MAX_EXPORT_SOURCE_BYTES) throw tooBig();
  return md;
}

/** The older styled-Markdown path: parses the source off the main thread into print blocks. */
async function parseSource(md: string, source: ExportSource, title: string, style?: ResumeStyle): Promise<PrintDoc> {
  const rel = `application/${source}.md`;
  // Sections hidden in the Resume Studio are left out of the export (the Markdown keeps them).
  if (style?.hidden.length) md = visibleMarkdown(parseResume(md), style.hidden);
  try {
    return await parseIsolated(md, title);
  } catch (e) {
    if (e instanceof ParseTooComplex) throw new Error(`${rel} is too complex to export. Simplify its formatting and try again.`);
    if (e instanceof TooManyBlocks) throw new Error(`${rel} has more than ${MAX_EXPORT_BLOCKS} headings, paragraphs and bullets, so it wasn't exported.`);
    if (e instanceof ExportUnavailable) throw new Error(`Export isn't available right now. Restart ${identity.name} and try again.`);
    throw e;
  }
}

/**
 * A styled resume as PDF or Word, drawn from the same layout tree as the Resume Studio's preview and downloads
 * (resume.ts renderResume), so the chosen template comes out the same from either place. The line-based resume
 * model needs no worker: it is linear in the file's size, which is capped at 512 KB, and the node count is capped.
 */
async function renderStyledResume(ctx: ServiceContext, md: string, title: string, style: ResumeStyle, format: ExportFormat): Promise<Uint8Array> {
  const tree = resumeLayout(parseResume(md), style.hidden);
  try {
    return format === "pdf"
      ? await ctx.host.printer!.toPdf(resumeHtml(tree, title, style, loadPrintFonts(style.font)))
      : await resumeDocx(tree, title, style);
  } catch (e) {
    if (e instanceof ResumeTooLarge) throw new Error("application/resume.md has too many headings, paragraphs and bullets, so it wasn't exported.");
    throw e;
  }
}

/** Temp and backup names commitAll uses; the pid is the process that made them. */
const LEFTOVER = /^\.(resume|cover-letter)\.(pdf|docx)\.(export-(\d+)-[0-9a-f]{8}\.tmp|backup-(\d+)-[0-9a-f]{8})$/;

/**
 * Removes what an earlier export left behind when the app stopped mid-write: regular, single-named files whose name
 * is exactly a temp or backup name of another process. Folders, links, second names and anything else are left alone.
 */
function sweepLeftovers(dir: string): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const m = LEFTOVER.exec(n);
    if (!m || Number(m[4] ?? m[5]) === process.pid) continue;
    const abs = path.join(dir, n);
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile() && st.nlink === 1) fs.unlinkSync(abs);
    } catch { /* gone already, or not ours to remove */ }
  }
}

/**
 * Writes every file or none. Each file is first written in full to a hidden temp name (owner-only: the files carry
 * contact details). Then, when replacing, the existing files are moved aside, and each temp file is linked to its
 * final name, which never overwrites. If any step fails, the files this export created are removed and the ones moved
 * aside are put back. Without `overwrite`, an existing file is never touched.
 */
function commitAll(dir: string, made: { file: string; bytes: Uint8Array }[], overwrite: boolean): void {
  const tag = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const temps: string[] = [];
  const aside: { final: string; backup: string }[] = [];
  const created: string[] = [];
  try {
    for (const m of made) {
      const tmp = path.join(dir, `.${m.file}.export-${tag}.tmp`);
      writeFileAtomic(tmp, m.bytes, 0o600, { exclusive: true });
      temps.push(tmp);
    }
    // Checked again here: only a plain, single-named file is ever moved aside, and nothing is ever deleted recursively.
    for (const m of made) {
      const final = path.join(dir, m.file);
      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(final); } catch { st = null; }
      if (st && !(st.isFile() && st.nlink === 1)) throw new Error(`application/export/${m.file} is a folder or link. Move it and try again.`);
      if (st && !overwrite) throw new Error(`Already exported: ${m.file}. Choose Replace to write them again.`);
    }
    if (overwrite) {
      for (const m of made) {
        const final = path.join(dir, m.file);
        if (!fs.existsSync(final)) continue;
        const backup = path.join(dir, `.${m.file}.backup-${tag}`);
        fs.renameSync(final, backup);
        aside.push({ final, backup });
      }
    }
    made.forEach((m, i) => {
      const final = path.join(dir, m.file);
      fs.linkSync(temps[i]!, final); // EEXIST if a file appeared in the meantime: nothing is overwritten
      created.push(final);
    });
  } catch (e) {
    for (const f of created) try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    for (const a of aside) try { fs.renameSync(a.backup, a.final); } catch { /* best effort */ }
    throw e;
  } finally {
    for (const t of temps) try { fs.rmSync(t, { force: true }); } catch { /* best effort */ }
  }
  for (const a of aside) try { fs.rmSync(a.backup, { force: true }); } catch { /* best effort */ }
}

function ownerName(root: string): string {
  try { return readRecord("profile", layout(root).profile).contact.name; } catch { return ""; }
}

async function exportDocs(ctx: ServiceContext, slug: string, id: string, sources: ExportSource[], formats: ExportFormat[], overwrite: boolean): Promise<ExportState> {
  const root = ctx.requireRoot();
  const want = EXPORT_SOURCES.filter((s) => sources.includes(s));
  const kinds = EXPORT_FORMATS.filter((f) => formats.includes(f));
  const before = exportState(ctx, slug, id);
  const missing = want.filter((s) => !before.sources.find((x) => x.source === s)?.exists);
  if (missing.length) throw new Error(`${missing.map((s) => `application/${s}.md`).join(" and ")} isn't there yet. Prepare the application first.`);
  const clash = before.files.filter((f) => f.exists && want.includes(f.source) && kinds.includes(f.format));
  if (clash.length && !overwrite) throw new Error(`Already exported: ${clash.map((f) => f.name).join(", ")}. Choose Replace to write them again.`);
  const printer = ctx.host.printer;
  if (kinds.includes("pdf") && !printer) throw new Error("PDF export isn't available here.");
  const blocked = before.files.find((f) => f.problem && want.includes(f.source) && kinds.includes(f.format));
  if (blocked) throw new Error(blocked.problem!); // with or without Replace: a folder or link is never moved or deleted
  sweepLeftovers(exportDir(ctx, root, slug, id)); // refuse a bad folder before any work is done
  const name = ownerName(root);
  // Everything is made in memory first, so a failed parse or print writes nothing at all.
  const made: { file: string; bytes: Uint8Array }[] = [];
  for (const source of want) {
    // A .studio/<source>.style.json from the Resume Studio sets the look.
    const style = exportStyle(ctx, root, slug, id, `${source}.md`);
    const title = [name, EXPORT_SOURCE_TEXT[source]].filter(Boolean).join(" - ");
    const md = readSourceMarkdown(ctx, slug, id, source);
    // A styled resume uses the Studio's layout tree and template. Everything else (a resume with no style file, and
    // the cover letter, which is a letter, not a resume) keeps the older Markdown path: plain, or lightly styled.
    const doc = source === "resume" && style ? null : await parseSource(md, source, title, style);
    for (const format of kinds) {
      const bytes = doc
        ? format === "pdf" ? await printer!.toPdf(renderHtml(doc, loadPrintFonts(style?.font), style)) : await renderDocx(doc, style)
        : await renderStyledResume(ctx, md, title, style!, format);
      checkBytes(format, bytes);
      made.push({ file: `${source}.${format}`, bytes });
    }
  }
  const dir = exportDir(ctx, root, slug, id); // and again, just before writing
  commitAll(dir, made, overwrite);
  addEvent(root, slug, id, "Exported", made.map((m) => m.file).join(", "), ctx.clock()); // only after every file is in place
  touch(root, jobDirRel(slug, id));
  return exportState(ctx, slug, id);
}

export const docsHandlers = {
  "docs.state": exportState,
  "docs.export": exportDocs,
} satisfies Partial<HandlerTable>;
