/**
 * Resume Studio services: load, autosave, versions, Claude's suggested rewrite, downloads. Every file lives in the job's
 * application folder (or its .versions and .studio dot folders); names come from fixed patterns, never from the renderer as paths.
 * See docs/specs/2026-10-10-resume-studio.md.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { addEvent, insideRoot, layout, readRecord, writeFileAtomic } from "@careeros/core";
import {
  DEFAULT_RESUME_STYLE, MAX_RESUME_BYTES, MAX_VERSIONS, parseResume, parseResumeStyle, resumeLayout, rewriteOptions, STUDIO_DIR, studioRewriteOptions, styleName,
  SUGGESTED_FOR, SUGGESTED_NAME, toPlainText, VERSION_EVERY_MS, VERSION_ID, visibleMarkdown,
  VARIANTS_DIR,
  type ActionTarget, type ClaudeRunRequest, type DownloadResult, type ResumeCopy, type ResumeDownload, type ResumeRef, type ResumeState, type ResumeStyle,
  type ResumeVersionView, type RewriteOptions, type SuggestionDecision, type VersionKind,
} from "@careeros/contract";
import { writableProblem } from "./actions.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { loadPrintFonts } from "./print/fonts.js";
import { resumeDocx, resumeHtml, ResumeTooLarge } from "./print/resume-print.js";
import { jobDetail, jobDirRel } from "./read.js";

const MAX_STYLE_BYTES = 64 * 1024;
const VERSIONS = ".versions";

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const plainDir = (abs: string): boolean | null => {
  try { const st = fs.lstatSync(abs); return st.isDirectory() && !st.isSymbolicLink(); } catch { return null; }
};

/**
 * The job's application folder: it must exist and be a plain folder in the workspace that Claude may write in
 * (no links, no second names, not a locked folder by path or identity: writableProblem, shared with Claude actions).
 */
function appDir(ctx: ServiceContext, root: string, slug: string, id: string): { abs: string; rel: string } {
  jobDetail(root, slug, id); // a job that is gone gives the usual plain message
  const rel = `${jobDirRel(slug, id)}/application`;
  const abs = path.join(root, ...rel.split("/"));
  if (plainDir(abs) !== true || writableProblem(ctx, root, rel) !== null || !insideRoot(root, abs)) {
    throw new Error("This job's application folder isn't a plain folder in the workspace, so the resume can't be opened.");
  }
  return { abs, rel };
}

/** A general version's folder (resume-variants/<variant>/), with the same checks as a job's application folder. */
export function variantDir(ctx: ServiceContext, root: string, variant: string): { abs: string; rel: string } {
  const rel = `${VARIANTS_DIR}/${variant}`;
  const abs = path.join(root, VARIANTS_DIR, variant);
  if (plainDir(path.join(root, VARIANTS_DIR)) !== true || plainDir(abs) !== true || writableProblem(ctx, root, rel) !== null || !insideRoot(root, abs)) {
    throw new Error("This resume version's folder isn't there any more, or isn't a plain folder in the workspace.");
  }
  return { abs, rel };
}

/** A general version's name, from its variant.json (the slug when it can't be read). */
export function variantName(abs: string, variant: string): { name: string; created_at: string } {
  const r = readIn(abs, "variant.json", 16 * 1024, "");
  try {
    const j = r ? (JSON.parse(r.text) as { name?: unknown; created_at?: unknown }) : {};
    return { name: typeof j.name === "string" && j.name.trim() ? j.name.trim().slice(0, 80) : variant, created_at: typeof j.created_at === "string" ? j.created_at : "" };
  } catch { return { name: variant, created_at: "" }; }
}

/** The folder a resume lives in, and how the studio names it. */
function homeOf(ctx: ServiceContext, root: string, ref: ResumeRef): { abs: string; rel: string; title: string; company_name: string; job: { slug: string; id: string } | null } {
  if (ref.kind === "job") {
    const app = appDir(ctx, root, ref.company_slug, ref.id);
    const d = jobDetail(root, ref.company_slug, ref.id);
    return { ...app, title: d.job.title, company_name: d.company?.name ?? ref.company_slug, job: { slug: ref.company_slug, id: ref.id } };
  }
  const v = variantDir(ctx, root, ref.variant);
  return { ...v, title: variantName(v.abs, ref.variant).name, company_name: "", job: null };
}

/**
 * Reads one file in a checked folder without following links: a regular, single-named file of at most `max`
 * bytes, or null when it isn't there. Anything else (a link, a folder, too big) throws `bad`.
 */
function readIn(dir: string, name: string, max: number, bad: string): { text: string; mtime: Date } | null {
  let fd: number;
  try { fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(bad);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > max) throw new Error(bad);
    const buf = Buffer.alloc(st.size + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > max) throw new Error(bad);
    return { text: buf.subarray(0, n).toString("utf8"), mtime: st.mtime };
  } finally { fs.closeSync(fd); }
}

/** Writes over a name only when nothing or a plain, single-named file is there. Atomic (temp file, then rename). */
function writeIn(dir: string, name: string, content: string, label: string): void {
  const abs = path.join(dir, name);
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${label} is a folder or link, so nothing was saved.`);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  writeFileAtomic(abs, content);
}

function readResume(dir: string, file: string, variant = false): string {
  const r = readIn(dir, file, MAX_RESUME_BYTES, "The resume can't be opened here: it must be a plain file of at most 512 KB.");
  if (!r) throw new Error(variant ? "Claude hasn't written this version yet. Write it from the Resumes screen first." : "This job has no tailored resume yet. Prepare the application first.");
  return r.text;
}

/**
 * application/.studio/: the style settings and Claude's suggestions. A dot folder, so the Apply and Job file lists
 * and the hand-off never treat them as application files. Plain folder only; null when absent and not created.
 */
function studioDir(appAbs: string, create: boolean): string | null {
  const dir = path.join(appAbs, STUDIO_DIR);
  const ok = plainDir(dir);
  if (ok === false) throw new Error("The studio's settings folder isn't a plain folder, so nothing was saved.");
  if (ok === null) { if (!create) return null; fs.mkdirSync(dir, { mode: 0o700 }); }
  return dir;
}

function readStyle(appAbs: string, file: string): { style: ResumeStyle; exists: boolean } {
  const dir = studioDir(appAbs, false);
  const r = dir ? readIn(dir, styleName(file), MAX_STYLE_BYTES, "The resume's style settings can't be read.") : null;
  if (!r) return { style: { ...DEFAULT_RESUME_STYLE }, exists: false };
  try { return { style: parseResumeStyle(JSON.parse(r.text)), exists: true }; } catch { return { style: { ...DEFAULT_RESUME_STYLE }, exists: true }; }
}

// ---- versions ------------------------------------------------------------------

/** application/.versions/<name>/, created if needed. Plain folders only. */
function versionsDir(appAbs: string, file: string, create: boolean): string | null {
  const top = path.join(appAbs, VERSIONS);
  const dir = path.join(top, file);
  for (const d of [top, dir]) {
    const ok = plainDir(d);
    if (ok === false) throw new Error("The versions folder isn't a plain folder, so no version was saved.");
    if (ok === null) { if (!create) return null; fs.mkdirSync(d, { mode: 0o700 }); }
  }
  return dir;
}

const stampOf = (d: Date) => d.toISOString().replace(/[-:.]/g, "").toLowerCase();
function atOf(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})(\d{3})z/.exec(id)!;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

function listVersions(appAbs: string, file: string): ResumeVersionView[] {
  const dir = versionsDir(appAbs, file, false);
  if (!dir) return [];
  const out: ResumeVersionView[] = [];
  for (const n of fs.readdirSync(dir)) {
    const id = n.replace(/\.md$/, "");
    if (!n.endsWith(".md") || !VERSION_ID.test(id)) continue;
    try {
      const st = fs.lstatSync(path.join(dir, n));
      if (st.isFile() && st.nlink === 1) out.push({ id, kind: id.split("-").pop() as VersionKind, at: atOf(id), size: st.size });
    } catch { /* gone */ }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

function writeVersion(ctx: ServiceContext, appAbs: string, file: string, text: string, kind: VersionKind): void {
  const dir = versionsDir(appAbs, file, true)!;
  // Strictly after the newest version, so the list order is the order things happened.
  const newest = listVersions(appAbs, file)[0];
  let t = Math.max(ctx.now().getTime(), newest ? Date.parse(newest.at) + 1 : 0);
  for (let tries = 0; tries < 50; tries++, t++) {
    try { writeFileAtomic(path.join(dir, `${stampOf(new Date(t))}-${kind}.md`), text, 0o600, { exclusive: true }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || tries === 49) throw e;
    }
  }
  // Keep the newest MAX_VERSIONS, but never drop the original.
  const all = listVersions(appAbs, file);
  for (const v of all.filter((x) => x.kind !== "original").slice(MAX_VERSIONS - 1)) {
    try { fs.unlinkSync(path.join(dir, `${v.id}.md`)); } catch { /* best effort */ }
  }
}

function readVersion(appAbs: string, file: string, versionId: string): string {
  const dir = versionsDir(appAbs, file, false);
  const r = dir ? readIn(dir, `${versionId}.md`, MAX_RESUME_BYTES, "That version can't be read.") : null;
  if (!r) throw new Error("That version isn't there any more.");
  return r.text;
}

// ---- Claude's suggested rewrite -------------------------------------------------

const SUGGESTED_BAD = "Claude's suggestion can't be read: it must be a plain file of at most 512 KB.";
function readSuggested(appAbs: string, file: string): { text: string; mtime: Date } | null {
  if (file !== SUGGESTED_FOR) return null;
  const dir = studioDir(appAbs, false);
  return dir ? readIn(dir, SUGGESTED_NAME, MAX_RESUME_BYTES, SUGGESTED_BAD) : null;
}

/**
 * rewrite_resume through the engine: Resume Studio sends positions in the saved resume.md ("s1", "b0"), never its
 * text. Here, after reading the file, they become the catalogue's ids (studioRewriteOptions). An empty request (a
 * one-click run or a retry with nothing chosen) is left as it is.
 */
export function studioRequest(ctx: ServiceContext, root: string, t: ActionTarget, req: ClaudeRunRequest): ClaudeRunRequest {
  const raw = req.options ?? {};
  if (!Object.keys(raw).length || t.kind !== "job") return req;
  let o: RewriteOptions;
  try { o = rewriteOptions(raw, "options"); } catch { throw new Error("Choose what to rewrite in Resume Studio."); }
  const app = appDir(ctx, root, t.company_slug, t.id);
  return { ...req, options: studioRewriteOptions(parseResume(readResume(app.abs, SUGGESTED_FOR)), o) };
}

// ---- state -----------------------------------------------------------------------

function state(ctx: ServiceContext, ref: ResumeRef, file: string): ResumeState {
  const root = ctx.requireRoot();
  const app = homeOf(ctx, root, ref);
  const markdown = readResume(app.abs, file, !app.job);
  const st = fs.lstatSync(path.join(app.abs, file));
  let sug: { text: string; mtime: Date } | null = null;
  let problem: string | null = null;
  try { sug = app.job ? readSuggested(app.abs, file) : null; } catch { problem = SUGGESTED_BAD; }
  return {
    ref, file, title: app.title, company_name: app.company_name,
    markdown, digest: sha256(markdown), style: readStyle(app.abs, file).style, saved_at: st.mtime.toISOString(),
    versions: listVersions(app.abs, file),
    suggestion: sug ? { markdown: sug.text, at: sug.mtime.toISOString(), older: st.mtime > sug.mtime } : null,
    suggestion_problem: problem,
  };
}

const CHANGED = "The resume changed outside the studio (Claude may have written it). Reload to see the latest before saving.";

/** Writes the resume, keeping the first state as "original" and versioning by kind (manual saves at most every 10 minutes). */
function writeResume(ctx: ServiceContext, appAbs: string, file: string, before: string, after: string, kind: VersionKind | "autosave"): void {
  const versions = listVersions(appAbs, file);
  if (!versions.length) writeVersion(ctx, appAbs, file, before, "original");
  writeIn(appAbs, file, after, "The resume");
  if (kind !== "autosave") { writeVersion(ctx, appAbs, file, after, kind); return; }
  const newest = versions[0];
  if (!newest) return; // the "original" just written starts the 10-minute clock
  if (ctx.now().getTime() - Date.parse(newest.at) >= VERSION_EVERY_MS) writeVersion(ctx, appAbs, file, after, "manual");
}

/**
 * Autosave. `replacing`: the person chose to keep their edits over a version written outside the studio (usually
 * Claude's rewrite); that version is kept first as "replaced", so nothing is lost.
 */
function save(ctx: ServiceContext, ref: ResumeRef, file: string, markdown: string, style: ResumeStyle, digest: string, replacing = false): ResumeState {
  const root = ctx.requireRoot();
  const app = homeOf(ctx, root, ref);
  if (Buffer.byteLength(markdown) > MAX_RESUME_BYTES) throw new Error("The resume is larger than 512 KB, so it wasn't saved.");
  const cur = readResume(app.abs, file);
  if (sha256(cur) !== digest) throw new Error(CHANGED);
  if (markdown !== cur) {
    if (replacing) writeVersion(ctx, app.abs, file, cur, "replaced");
    writeResume(ctx, app.abs, file, cur, markdown, "autosave");
  }
  const clean = parseResumeStyle(style);
  const old = readStyle(app.abs, file);
  if (old.exists || JSON.stringify(clean) !== JSON.stringify(DEFAULT_RESUME_STYLE)) {
    if (JSON.stringify(old.style) !== JSON.stringify(clean) || !old.exists) writeIn(studioDir(app.abs, true)!, styleName(file), `${JSON.stringify(clean, null, 2)}\n`, "The style file");
  }
  return state(ctx, ref, file);
}

function restore(ctx: ServiceContext, ref: ResumeRef, file: string, versionId: string, digest: string): ResumeState {
  const root = ctx.requireRoot();
  const app = homeOf(ctx, root, ref);
  const cur = readResume(app.abs, file);
  if (sha256(cur) !== digest) throw new Error(CHANGED);
  const text = readVersion(app.abs, file, versionId);
  writeResume(ctx, app.abs, file, cur, text, "restore");
  if (app.job) addEvent(root, app.job.slug, app.job.id, "Resume restored", `A version from ${atOf(versionId).slice(0, 10)}`, ctx.clock());
  return state(ctx, ref, file);
}

/**
 * Claude's suggested rewrite. Accept: it becomes the resume (versioned as Claude's rewrite). Reject: it is deleted.
 * Keep my edits: it is saved under Versions first ("Claude's rewrite (replaced)"), then deleted. It is never part of
 * the application (a dot folder) until accepted.
 */
function suggestion(ctx: ServiceContext, ref: ResumeRef, file: string, decision: SuggestionDecision, digest: string): ResumeState {
  const root = ctx.requireRoot();
  const app = homeOf(ctx, root, ref);
  if (!app.job) throw new Error("Claude's suggestions are for a job's tailored resume.");
  const cur = readResume(app.abs, file);
  const r = readSuggested(app.abs, file);
  if (!r) throw new Error("Claude's suggestion isn't there any more. Reload to see the latest.");
  if (decision === "accept") {
    if (sha256(cur) !== digest) throw new Error(CHANGED);
    if (r.text !== cur) writeResume(ctx, app.abs, file, cur, r.text, "ai");
    addEvent(root, app.job.slug, app.job.id, "Resume updated", "Accepted Claude's rewrite", ctx.clock());
  } else if (decision === "keep") {
    if (!listVersions(app.abs, file).length) writeVersion(ctx, app.abs, file, cur, "original");
    writeVersion(ctx, app.abs, file, r.text, "replaced");
  }
  try { fs.unlinkSync(path.join(studioDir(app.abs, false)!, SUGGESTED_NAME)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return state(ctx, ref, file);
}

// ---- downloads -------------------------------------------------------------------

function ownerName(root: string): string {
  try { return readRecord("profile", layout(root).profile).contact.name; } catch { return ""; }
}
/** A file name made only of plain characters: no separators, dots at the start or control characters. */
export function downloadName(parts: string[], ext: string): string {
  const base = parts.map((p) => p.replace(/[^\p{L}\p{N} &,()'-]/gu, " ").replace(/\s+/g, " ").trim()).filter(Boolean).join(" - ").slice(0, 120).trim() || "Resume";
  return `${base}.${ext}`;
}

export async function renderResume(ctx: ServiceContext, ref: ResumeRef, file: string, format: ResumeDownload): Promise<{ bytes: Uint8Array; name: string }> {
  const root = ctx.requireRoot();
  const app = homeOf(ctx, root, ref);
  const md = readResume(app.abs, file, !app.job);
  const { style } = readStyle(app.abs, file);
  const model = parseResume(md);
  const who = ownerName(root);
  const name = (ext: string) => downloadName(app.job ? [who, app.company_name, "Resume"] : [who, "Resume", app.title], ext);
  if (format === "md") return { bytes: new TextEncoder().encode(visibleMarkdown(model, style.hidden)), name: name("md") };
  if (format === "txt") return { bytes: new TextEncoder().encode(toPlainText(model, style.hidden)), name: name("txt") };
  // PDF and Word come from the same layout tree as the studio's preview. The resume is parsed by the line-based
  // model (no Markdown library), linear in its size and capped at 512 KB; the node count is capped too.
  const tree = resumeLayout(model, style.hidden);
  const title = [who, "Resume"].filter(Boolean).join(" - ");
  try {
    if (format === "pdf") {
      if (!ctx.host.printer) throw new Error("PDF export isn't available here.");
      const bytes = await ctx.host.printer.toPdf(resumeHtml(tree, title, style, loadPrintFonts(style.font)));
      if (!Buffer.from(bytes.subarray(0, 5)).toString("latin1").startsWith("%PDF-")) throw new Error("The PDF export failed.");
      return { bytes, name: name("pdf") };
    }
    return { bytes: await resumeDocx(tree, title, style), name: name("docx") };
  } catch (e) {
    if (e instanceof ResumeTooLarge) throw new Error("The resume has too many headings, paragraphs and bullets to export.");
    throw e;
  }
}

async function download(ctx: ServiceContext, ref: ResumeRef, file: string, format: ResumeDownload): Promise<DownloadResult> {
  const save = ctx.host.shell.saveFile;
  if (!save) throw new Error("Downloads aren't available here.");
  const r = await renderResume(ctx, ref, file, format);
  // The main process shows the save dialog and writes the file; no path ever comes from the renderer.
  const saved = await save.call(ctx.host.shell, r.name, r.bytes, format);
  return { saved, name: r.name };
}

function copy(ctx: ServiceContext, ref: ResumeRef, file: string, format: ResumeCopy): boolean {
  const root = ctx.requireRoot();
  const app = homeOf(ctx, root, ref);
  const model = parseResume(readResume(app.abs, file, !app.job));
  const { style } = readStyle(app.abs, file);
  try { ctx.host.shell.copyText(format === "md" ? visibleMarkdown(model, style.hidden) : toPlainText(model, style.hidden)); return true; } catch { return false; }
}

/**
 * Changes a job's resume or cover letter from outside the studio (a stretch bullet softened or dropped on the Apply
 * screen), versioned like a studio edit so it can be undone. `next` returns null when the change no longer applies;
 * then nothing is written and false comes back.
 */
export function reviseDraft(ctx: ServiceContext, slug: string, id: string, file: string, next: (cur: string) => string | null): boolean {
  const app = appDir(ctx, ctx.requireRoot(), slug, id);
  const cur = readResume(app.abs, file);
  const after = next(cur);
  if (after === null) return false;
  if (after !== cur) writeResume(ctx, app.abs, file, cur, after, "manual");
  return true;
}

/** The style a source's export should follow (docs.export), or undefined when it has no style file. */
export function exportStyle(ctx: ServiceContext, root: string, slug: string, id: string, file: string): ResumeStyle | undefined {
  try {
    const app = appDir(ctx, root, slug, id);
    const r = readStyle(app.abs, file);
    return r.exists ? r.style : undefined;
  } catch { return undefined; }
}

/** A resume's Markdown and style, for a copy (Resumes › Duplicate as general version). */
export function readResumeSource(ctx: ServiceContext, ref: ResumeRef): { markdown: string; style: ResumeStyle | null } {
  const app = homeOf(ctx, ctx.requireRoot(), ref);
  const r = readStyle(app.abs, SUGGESTED_FOR);
  return { markdown: readResume(app.abs, SUGGESTED_FOR, !app.job), style: r.exists ? r.style : null };
}

/** Where a resume lives on disk: the job's application folder or the general version's folder (checked). */
export function resumeFolder(ctx: ServiceContext, ref: ResumeRef): string {
  return homeOf(ctx, ctx.requireRoot(), ref).abs;
}

/** Writes a style file next to a resume in a checked folder (its .studio dot folder is created if needed). */
export function writeStyleIn(folderAbs: string, file: string, style: ResumeStyle): void {
  writeIn(studioDir(folderAbs, true)!, styleName(file), `${JSON.stringify(parseResumeStyle(style), null, 2)}\n`, "The style file");
}

export const resumeHandlers = {
  "resume.load": state,
  "resume.save": save,
  "resume.version": (ctx: ServiceContext, ref: ResumeRef, file: string, versionId: string) => {
    const app = homeOf(ctx, ctx.requireRoot(), ref);
    return readVersion(app.abs, file, versionId);
  },
  "resume.restore": restore,
  "resume.suggestion": suggestion,
  "resume.download": download,
  "resume.copy": copy,
} satisfies Partial<HandlerTable>;
