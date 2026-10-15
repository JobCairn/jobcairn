/**
 * The Resumes screen: the person's own resume files (me/resumes, shown, never edited here), every job's tailored
 * resume (application/resume.md) and every general version (resume-variants/<variant>/). General versions live
 * outside me/ on purpose: a resume Claude wrote must never be read back as evidence for the next one.
 */
import fs from "node:fs";
import path from "node:path";
import { insideRoot, layout, listJobs, readRecord, slugify, writeFileAtomic } from "@careeros/core";
import { BASE_RESUME_REL, MAX_RESUME_BYTES, VARIANT_SLUG, VARIANTS_DIR, type ResumeItemRef, type ResumeLibrary, type ResumeStyle } from "@careeros/contract";
import { writableProblem } from "./actions.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { realDirInRoot } from "./files.js";
import { readResumeSource, resumeFolder, variantDir, variantName, writeStyleIn } from "./resume.js";
import { extractDocText } from "./resume-fill.js";

const fileAt = (abs: string): string | null => {
  try { const st = fs.lstatSync(abs); return st.isFile() && st.nlink === 1 ? st.mtime.toISOString() : null; } catch { return null; }
};
const plainDirs = (abs: string): string[] => {
  try { return fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => d.name).sort(); } catch { return []; }
};

function list(ctx: ServiceContext): ResumeLibrary {
  const root = ctx.requireRoot();
  const L = layout(root);
  // The person's own resume: files only. "Fill from my resume"'s "<name> (text).txt" copy is for Claude, not shown.
  const base: ResumeLibrary["base"] = [];
  const me = L.me("resumes");
  let names: fs.Dirent[] = [];
  try { if (!fs.lstatSync(me).isSymbolicLink()) names = fs.readdirSync(me, { withFileTypes: true }); } catch { names = []; }
  for (const d of names) {
    if (!d.isFile() || d.name.startsWith(".") || / \(text\)\.txt$/.test(d.name)) continue;
    const at = fileAt(path.join(me, d.name));
    if (at) base.push({ rel: `me/resumes/${d.name}`, name: d.name, at });
  }
  base.sort((a, b) => b.at.localeCompare(a.at));

  const tailored: ResumeLibrary["tailored"] = [];
  for (const j of listJobs(root)) {
    const at = fileAt(path.join(L.jobDir(j.company_slug, j.id), "application", "resume.md"));
    if (!at) continue;
    try {
      const job = readRecord("job", j.file);
      let company = j.company_slug;
      try { company = readRecord("company", L.companyFile(j.company_slug)).name || company; } catch { /* the slug will do */ }
      tailored.push({ company_slug: j.company_slug, id: j.id, title: job.title, company_name: company, status: job.status, at });
    } catch { /* unreadable jobs are reported by validate */ }
  }
  tailored.sort((a, b) => b.at.localeCompare(a.at));

  const variants: ResumeLibrary["variants"] = [];
  const top = path.join(root, VARIANTS_DIR);
  let topOk = false;
  try { const st = fs.lstatSync(top); topOk = st.isDirectory() && !st.isSymbolicLink(); } catch { topOk = false; }
  for (const v of topOk ? plainDirs(top) : []) {
    if (!VARIANT_SLUG.test(v) || v.length > 60) continue;
    const abs = path.join(top, v);
    const meta = variantName(abs, v);
    const at = fileAt(path.join(abs, "resume.md"));
    variants.push({ variant: v, name: meta.name, created_at: meta.created_at, at: at ?? meta.created_at, ready: !!at });
  }
  variants.sort((a, b) => b.at.localeCompare(a.at));
  return { base, tailored, variants };
}

/** A new general version's folder and name. Claude writes its resume.md (tailor_resume_variant). */
function newVariant(ctx: ServiceContext, name: string): { variant: string } {
  const root = ctx.requireRoot();
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("Give the version a name, like Backend-heavy.");
  const top = realDirInRoot(root, path.join(root, VARIANTS_DIR), "The resume versions folder");
  if (writableProblem(ctx, root, VARIANTS_DIR) !== null) throw new Error("The resume versions folder isn't a plain folder in the workspace.");
  const base = slugify(clean, "version").slice(0, 52).replace(/-+$/, "") || "version";
  let variant = base;
  for (let n = 2; fs.existsSync(path.join(top, variant)); n++) variant = `${base}-${n}`;
  const abs = path.join(top, variant);
  if (!insideRoot(root, abs)) throw new Error("refusing to write outside the workspace");
  fs.mkdirSync(abs);
  writeFileAtomic(path.join(abs, "variant.json"), `${JSON.stringify({ name: clean, created_at: ctx.now().toISOString() }, null, 2)}\n`);
  variantDir(ctx, root, variant);
  return { variant };
}

/** One of the person's own files in me/resumes: a plain, single-named file in that folder, nothing else. */
function baseFile(root: string, rel: string): string {
  if (!BASE_RESUME_REL.test(rel)) throw new Error("That resume isn't one of your files in Resumes.");
  const dir = layout(root).me("resumes");
  const abs = path.join(dir, path.basename(rel));
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { throw new Error("That resume isn't there any more."); }
  if (!st.isFile() || st.nlink !== 1 || fs.lstatSync(dir).isSymbolicLink() || !insideRoot(root, abs)) throw new Error("That resume isn't a plain file in your Resumes folder.");
  return abs;
}

const MAX_BASE_BYTES = 10 * 1024 * 1024;

/** Markdown from one of the person's own files: Markdown and text as they are, PDF and Word as their text. */
async function baseMarkdown(abs: string): Promise<string> {
  const ext = path.extname(abs).toLowerCase();
  if (fs.statSync(abs).size > MAX_BASE_BYTES) throw new Error("That file is too large to copy.");
  const text = ext === ".md" || ext === ".markdown" || ext === ".txt" ? fs.readFileSync(abs, "utf8") : ext === ".pdf" || ext === ".docx" ? await extractDocText(abs) : null;
  if (text === null) throw new Error("Only Markdown, text, PDF and Word resumes can be copied.");
  if (!text.trim()) throw new Error("No text could be read from that file, so nothing was copied.");
  return Buffer.byteLength(text) > MAX_RESUME_BYTES ? text.slice(0, MAX_RESUME_BYTES / 2) : text;
}

/**
 * A copy of any resume as a new general version (resume-variants/<slug>/resume.md, with its style), so it can be
 * edited on its own. The source is only read.
 */
async function duplicate(ctx: ServiceContext, source: ResumeItemRef, name: string): Promise<{ variant: string }> {
  const root = ctx.requireRoot();
  let markdown: string;
  let style: ResumeStyle | null = null;
  if (source.kind === "base") markdown = await baseMarkdown(baseFile(root, source.rel));
  else ({ markdown, style } = readResumeSource(ctx, source));
  const { variant } = newVariant(ctx, name);
  const dir = variantDir(ctx, root, variant).abs;
  writeFileAtomic(path.join(dir, "resume.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  if (style) writeStyleIn(dir, "resume.md", style);
  return { variant };
}

/**
 * What deleting a resume moves (trash.ts): a job's tailored resume.md, a general version's whole folder, or one of
 * the person's own files. Checked here; the workspace trash moves it.
 */
export function resumeTrashItem(ctx: ServiceContext, target: ResumeItemRef): { rel: string; title: string; job: { slug: string; id: string } | null } {
  const root = ctx.requireRoot();
  if (target.kind === "base") {
    const abs = baseFile(root, target.rel);
    return { rel: `me/resumes/${path.basename(abs)}`, title: path.basename(abs), job: null };
  }
  if (target.kind === "variant") {
    const v = variantDir(ctx, root, target.variant);
    return { rel: v.rel, title: variantName(v.abs, target.variant).name, job: null };
  }
  const abs = path.join(resumeFolder(ctx, target), "resume.md");
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { throw new Error("That resume isn't there any more."); }
  if (!st.isFile() || st.nlink !== 1) throw new Error("That resume isn't a plain file, so nothing was removed.");
  let title = target.id;
  try { title = readRecord("job", layout(root).jobFile(target.company_slug, target.id)).title || title; } catch { /* the id will do */ }
  try { title = `${title} at ${readRecord("company", layout(root).companyFile(target.company_slug)).name || target.company_slug}`; } catch { /* the job will do */ }
  return { rel: `companies/${target.company_slug}/jobs/${target.id}/application/resume.md`, title: `Tailored resume for ${title}`, job: { slug: target.company_slug, id: target.id } };
}

export const resumesHandlers = {
  "resumes.list": list,
  "resumes.newVariant": newVariant,
  "resumes.duplicate": duplicate,
  // "resumes.remove" is in trash.ts: it moves the resume to the workspace trash.
} satisfies Partial<HandlerTable>;
