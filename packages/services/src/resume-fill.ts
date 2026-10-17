import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { insideRoot, layout, readRecord, uniquePath, updateRecord, writeFileAtomic } from "@careeros/core";
import {
  MAX_RESUME_FILE_BYTES, MAX_RESUME_TEXT, parseResumeFields, parseTargetSuggestions, RESUME_FIELD_KEYS, RESUME_FIELD_PATHS, RESUME_REL, sanitizeFillState,
  SUGGESTIONS_REL, type ResumeFieldKey, type ResumeFillState, type ResumeKind, type ResumeRead, type ResumeValues, type TargetSuggestions,
} from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import { checkIncomingFile, realDirInRoot, type CheckedFile } from "./files.js";
import type { HandlerTable } from "./handlers.js";
import { lockedFor } from "./integrity.js";
import { readStateFile, writeStateFile } from "./learn-hub.js";
import { touch } from "./read.js";
import { setPath } from "./settings.js";

/**
 * "Fill from my resume". Main reads the resume the person dropped or picked (checked like an Inbox drop), works out
 * what it is from its content, pulls its text out on this computer (PDF and Word in a worker with a deadline), and
 * hands only the contact fields back to the window. Saving copies the resume into me/resumes, where Claude and
 * later features look for it. Resume text is never logged, and never sent anywhere.
 */

const STATE = "resume-fill.json";
export const EXTRACT_TIMEOUT_MS = 15_000;
const WORKER_URL = new URL("./resume-fill-worker.mjs", import.meta.url);
const EXT: Record<ResumeKind, string> = { pdf: ".pdf", word: ".docx", markdown: ".md", text: ".txt" };
const tooBig = (name: string) => new Error(`"${name}" is larger than 10 MB. Use a smaller copy of your resume.`);

/** Reads a checked file without trusting its path again (same rules as copyIncoming), at most 10 MB. */
function readChecked(f: CheckedFile): Buffer {
  if (f.size > MAX_RESUME_FILE_BYTES) throw tooBig(f.name);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try { fd = fs.openSync(f.abs, flags); } catch { throw new Error(`"${f.name}" changed after it was checked. Add it again.`); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino) throw new Error(`"${f.name}" changed after it was checked. Add it again.`);
    if (st.size > MAX_RESUME_FILE_BYTES) throw tooBig(f.name);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

/** What the file is, from its first bytes. Its name and extension are never trusted. */
export function sniffResume(bytes: Uint8Array, name: string): ResumeKind {
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "word";
  if (head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    throw new Error(`"${name}" is an older Word file (.doc). Save it as .docx or PDF, then try again.`);
  }
  if (bytes.length === 0) throw new Error(`"${name}" is empty.`);
  if (bytes.includes(0)) throw new Error(`"${name}" isn't a resume this app can read. Use a PDF, Word (.docx), Markdown or text file.`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 64 * 1024)); } catch {
    throw new Error(`"${name}" isn't a resume this app can read. Use a PDF, Word (.docx), Markdown or text file.`);
  }
  return /^(?:#{1,6} |\*\*|- |\* )|\]\(https?:/m.test(text) ? "markdown" : "text";
}

/** `pages`: a PDF's page count (a Word file has no fixed pages). */
type WorkerReply = { ok: true; text: string; pages?: number } | { ok: false; reason: "pdf" | "word" | "locked" };

/** PDF and Word text, from a worker with a deadline and a bounded heap. */
function extractIsolated(kind: "pdf" | "word", bytes: Uint8Array, name: string, workerUrl = WORKER_URL): Promise<string> {
  return extractDocument(kind, bytes, name, workerUrl).then((r) => r.text);
}

/** Like extractIsolated, with the PDF's page count (null for Word). The ATS check of an export uses it (docs.check). */
export function extractDocument(kind: "pdf" | "word", bytes: Uint8Array, name: string, workerUrl = WORKER_URL): Promise<{ text: string; pages: number | null }> {
  const cant = () => new Error(kind === "pdf"
    ? `"${name}" can't be read as a PDF. Try saving it again, or use a Word or text version.`
    : `"${name}" can't be read as a Word document. Try saving it again as .docx or PDF.`);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    const copy = new Uint8Array(bytes); // its own buffer, moved to the worker
    try {
      worker = new Worker(workerUrl, { workerData: { kind, bytes: copy.buffer }, transferList: [copy.buffer], resourceLimits: { maxOldGenerationSizeMb: 384, stackSizeMb: 8 } });
    } catch { reject(cant()); return; }
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`"${name}" took too long to read. Try a simpler copy, such as a Word or text version.`))), EXTRACT_TIMEOUT_MS);
    worker.once("message", (r: WorkerReply) => finish(() => {
      if (r.ok) resolve({ text: r.text, pages: typeof r.pages === "number" ? r.pages : null });
      else reject(r.reason === "locked" ? new Error(`"${name}" is password-protected. Save a copy without a password, then try again.`) : cant());
    }));
    worker.once("error", () => finish(() => reject(cant())));
    worker.once("exit", () => finish(() => reject(cant())));
  });
}

async function readText(f: CheckedFile): Promise<{ kind: ResumeKind; text: string; bytes: Buffer }> {
  const bytes = readChecked(f);
  const kind = sniffResume(bytes, f.name);
  const text = kind === "pdf" || kind === "word" ? await extractIsolated(kind, bytes, f.name) : bytes.toString("utf8").slice(0, MAX_RESUME_TEXT);
  if (!text.replace(/\s+/g, "")) {
    throw new Error(kind === "pdf"
      ? `"${f.name}" has no text to read. It may be a scanned image. Try a Word or text version.`
      : `"${f.name}" has no text to read.`);
  }
  return { kind, text, bytes };
}

/**
 * The drop box's PDF and Word reader (inbox-text.ts): the same checks, worker and deadline as Fill from my resume.
 * Throws when the file can't be read; the drop box then falls back to name rules.
 */
export async function extractDocText(abs: string): Promise<string> {
  return (await readText(checkIncomingFile(null, abs))).text;
}

/** A file the person dropped or picked. With a workspace open, a file in a locked folder is refused. */
function checkResume(ctx: ServiceContext, abs: string): CheckedFile {
  const f = checkIncomingFile(null, abs);
  const root = ctx.root;
  if (root && insideRoot(root, f.abs)) {
    const locked = lockedFor(ctx, root, f.abs);
    if (locked) throw new Error(`${locked} is locked. Allow it once in Privacy first.`);
  }
  return f;
}

export async function readResume(ctx: ServiceContext, abs: string): Promise<ResumeRead> {
  const f = checkResume(ctx, abs);
  const { kind, text } = await readText(f);
  return { file: f.name, kind, fields: parseResumeFields(text) };
}

/** A plain copy name in me/resumes (RESUME_REL): letters, digits, spaces and a few marks, with the extension its content says. */
export function copyName(name: string, kind: ResumeKind): string {
  const stem = name.replace(/\.[^.]{1,8}$/, "").normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9 _().-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/-{2,}/g, "-").slice(0, 80).trim();
  return `${stem || "resume"}${EXT[kind]}`;
}

const rel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");

/**
 * Puts the resume in me/resumes (a copy; the original isn't touched) and, for PDF and Word, a plain-text copy next to
 * it that Claude can read. A resume already in me/resumes is used where it is. Returns the text copy's path.
 */
function keepResume(ctx: ServiceContext, root: string, f: CheckedFile, kind: ResumeKind, text: string, bytes: Buffer): { written: string[]; textRel: string } {
  const dir = realDirInRoot(root, layout(root).me("resumes"), "me/resumes");
  const realDir = fs.realpathSync.native(dir);
  const written: string[] = [];
  let mainRel: string;
  try {
    if (path.dirname(f.abs) === realDir && RESUME_REL.test(`me/resumes/${path.basename(f.abs)}`)) {
      mainRel = `me/resumes/${path.basename(f.abs)}`;
    } else {
      const dest = uniquePath(path.join(dir, copyName(f.name, kind)));
      writeFileAtomic(dest, bytes, 0o600, { exclusive: true });
      written.push(dest);
      mainRel = rel(root, dest);
    }
    if (kind !== "pdf" && kind !== "word") return { written, textRel: mainRel };
    const textDest = uniquePath(path.join(dir, `${path.basename(mainRel).replace(/\.[^.]+$/, "")} (text).txt`));
    writeFileAtomic(textDest, text, 0o600, { exclusive: true });
    written.push(textDest);
    return { written, textRel: rel(root, textDest) };
  } catch (e) {
    for (const w of written) fs.rmSync(w, { force: true });
    throw new Error("Your resume couldn't be saved in the Resumes folder.", { cause: e });
  }
}

const isEmpty = (v: unknown) => (Array.isArray(v) ? v.length === 0 : typeof v !== "string" || v.trim() === "");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The value to save for one field, cleaned, or null when the review left it empty. */
function cleanValue(key: ResumeFieldKey, v: ResumeValues[ResumeFieldKey]): string | string[] | null {
  if (key === "links") {
    const list = Array.isArray(v) ? [...new Set(v.map((x) => x.trim()).filter(Boolean))] : [];
    return list.length ? list : null;
  }
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s ? s : null;
}

function writeState(root: string, s: ResumeFillState, textRel: string): void {
  writeStateFile(root, STATE, `${JSON.stringify({ version: 1, ...s, text: textRel }, null, 2)}\n`);
}

function readState(root: string): { state: ResumeFillState | null; textRel: string } {
  const raw = readStateFile(path.join(root, ".careeros", STATE)) as Record<string, unknown>;
  const textRel = typeof raw.text === "string" && RESUME_REL.test(raw.text) ? raw.text : "";
  return { state: sanitizeFillState(raw), textRel };
}

/** The text copy of the resume last used to fill the profile, for the suggest_targets prompt, or "". */
export function resumeTextRel(root: string): string {
  return readState(root).textRel;
}

export async function fillFromResume(ctx: ServiceContext, abs: string, values: ResumeValues, overwrite: ResumeFieldKey[]): Promise<ResumeFillState> {
  const root = ctx.requireRoot();
  const f = checkResume(ctx, abs);
  const { kind, text, bytes } = await readText(f);
  const profile = readRecord("profile", layout(root).profile);
  const contact = profile.contact as unknown as Record<string, unknown>;
  const changes: { path: string; value: unknown }[] = [];
  const filled: ResumeFieldKey[] = [];
  const kept: ResumeFieldKey[] = [];
  for (const key of RESUME_FIELD_KEYS) {
    if (!Object.hasOwn(values, key)) continue;
    const next = cleanValue(key, values[key]);
    if (next === null) continue;
    const cur = contact[key];
    if (isEmpty(cur) || overwrite.includes(key)) {
      if (!same(cur, next)) changes.push({ path: RESUME_FIELD_PATHS[key], value: next });
      filled.push(key);
    } else if (!same(cur, next)) kept.push(key);
  }
  const { written, textRel } = keepResume(ctx, root, f, kind, text, bytes);
  try {
    if (changes.length) {
      updateRecord("profile", layout(root).profile, (cur) => { for (const c of changes) setPath(cur as unknown as Record<string, unknown>, c.path, c.value); });
    }
    touch(root, "settings/profile.json", ...written.map((w) => rel(root, w)));
  } catch (e) {
    for (const w of written) fs.rmSync(w, { force: true });
    throw e;
  }
  const state: ResumeFillState = { at: ctx.now().toISOString(), file: f.name.slice(0, 120), kind, filled, kept, seen: false };
  writeState(root, state, textRel);
  return sanitizeFillState(state)!;
}

function fillState(ctx: ServiceContext): ResumeFillState | null {
  return readState(ctx.requireRoot()).state;
}

function markFillSeen(ctx: ServiceContext): ResumeFillState | null {
  const root = ctx.requireRoot();
  const { state, textRel } = readState(root);
  if (!state || state.seen) return state;
  const next = { ...state, seen: true };
  writeState(root, next, textRel);
  return next;
}

const MAX_SUGGESTIONS_BYTES = 64 * 1024;

/** Claude's knowledge/profile/suggested-targets.json, read only if it is a plain, small file in the workspace. */
function suggestions(ctx: ServiceContext): TargetSuggestions | null {
  const root = ctx.requireRoot();
  const abs = path.join(root, ...SUGGESTIONS_REL.split("/"));
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.nlink > 1 || st.size > MAX_SUGGESTIONS_BYTES || !insideRoot(root, abs)) return null;
    return parseTargetSuggestions(JSON.parse(fs.readFileSync(abs, "utf8")), st.mtime.toISOString());
  } catch { return null; }
}

export const resumeFillHandlers = {
  "profile.readResume": readResume,
  "profile.fillFromResume": fillFromResume,
  "profile.fillState": fillState,
  "profile.markFillSeen": markFillSeen,
  "profile.suggestions": suggestions,
} satisfies Partial<HandlerTable>;

/** For tests: extraction with another worker file. */
export const _test = { extractIsolated, readChecked };
