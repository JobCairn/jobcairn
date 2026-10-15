import fs from "node:fs";
import path from "node:path";
import { insideRoot, layout } from "./paths.js";
import { readRecord, RecordError } from "./store.js";
import type { EmailRecord } from "./types.js";

export interface EmailFileRef { file: string; rel: string; company_slug: string; job_id: string }
export interface EmailSkip { file: string; problems: string[] }

/** The emails folder for a job, or for the company itself when id is "". */
export function emailsDirFor(root: string, slug: string, id: string): string {
  return id ? layout(root).jobEmailsDir(slug, id) : layout(root).companyEmailsDir(slug);
}

/** Message sidecars (*.json) in one emails folder. Drafts and attachments live in subfolders and are skipped. Never follows links. */
export function listEmailFiles(root: string, slug: string, id: string): EmailFileRef[] {
  const dir = emailsDirFor(root, slug, id);
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return []; }
  if (!st.isDirectory() || !insideRoot(root, dir)) return [];
  const out: EmailFileRef[] = [];
  for (const n of fs.readdirSync(dir).sort()) {
    if (!n.endsWith(".json") || n.startsWith(".")) continue;
    const file = path.join(dir, n);
    if (!fs.lstatSync(file).isFile()) continue;
    out.push({ file, rel: path.relative(root, file).split(path.sep).join("/"), company_slug: slug, job_id: id });
  }
  return out;
}

export function readEmails(root: string, slug: string, id: string, skipped?: EmailSkip[]): { ref: EmailFileRef; email: EmailRecord }[] {
  const out: { ref: EmailFileRef; email: EmailRecord }[] = [];
  for (const ref of listEmailFiles(root, slug, id)) {
    try { out.push({ ref, email: readRecord("email", ref.file) }); }
    catch (e) {
      if (e instanceof RecordError) skipped?.push({ file: path.relative(root, ref.file), problems: e.problems });
      else throw e;
    }
  }
  return out;
}
