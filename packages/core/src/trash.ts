import fs from "node:fs";
import path from "node:path";
import { type Clock, iso } from "./clock.js";
import { insideRoot, layout, slugify } from "./paths.js";
import { readJson, writeFileAtomic } from "./store.js";
import { LOCKABLE_DIRS } from "./types.js";

/**
 * The workspace trash: "Delete" in the app never destroys anything. The folder or file moves into
 * `.backup/trash/<id>/files/<its workspace path>` with a `trash.json` that says what it was, so Undo and
 * Recently deleted can put it back where it was. Entries older than TRASH_DAYS are removed when the app opens.
 */
export const TRASH_DAYS = 30;
export const TRASH_KINDS = ["job", "company", "resume", "topic", "video", "job_file", "research"] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];
/** An entry's folder name: when it was deleted, then the kind and a slug of its name. */
export const TRASH_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z-]{1,20}-[a-z0-9-]{1,80}$/;

/** An email moved out of a deleted job or company so it stays in Mail; restore moves it back if it is still there. */
export interface TrashMailMove { from: string; to: string; matched_by?: string }
export interface TrashEntry {
  v: 1;
  id: string;
  kind: TrashKind;
  /** What the person called it: "Adpen", "AI Engineer at Adpen". */
  title: string;
  /** What went with it, in words: "and its 2 jobs". */
  detail: string;
  deleted_at: string;
  /** Workspace paths that moved, as they were. */
  items: string[];
  mail: TrashMailMove[];
  /** Anything else the app needs to undo the delete (a job file's entry in job.json). */
  meta: Record<string, unknown>;
}

export type TrashProblem = "taken" | "parent_gone" | "not_found" | "refused";
export class TrashError extends Error {
  constructor(public code: TrashProblem, message: string) { super(message); this.name = "TrashError"; }
}

// Never moved from here: the app's own folders, settings, and the lockable folders (locked or not).
const NEVER_TOP = new Set(["settings", "workspace.json", ".backup", ".index", ".careeros", ".claude", ".git"]);

const trashRoot = (root: string) => path.join(layout(root).backupDir, "trash");
const entryDir = (root: string, id: string) => path.join(trashRoot(root), id);
const manifestOf = (root: string, id: string) => path.join(entryDir(root, id), "trash.json");
const stored = (root: string, id: string, rel: string) => path.join(entryDir(root, id), "files", ...rel.split("/"));

/** Checks a workspace path may go to the trash, and returns it in its plain form ("companies/acme"). */
export function trashableRel(root: string, rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = clean.split("/");
  if (!clean || path.isAbsolute(clean) || parts.some((p) => !p || p === "." || p === ".." || /[\x00-\x1f\x7f]/.test(p))) {
    throw new TrashError("refused", "That isn't a place in this workspace.");
  }
  // A whole top folder ("companies", "me") is never one item.
  if (parts.length < 2 || NEVER_TOP.has(parts[0]!)) throw new TrashError("refused", "That part of the workspace can't be deleted here.");
  if ((LOCKABLE_DIRS as readonly string[]).some((d) => clean === d || clean.startsWith(`${d}/`) || d.startsWith(`${clean}/`))) {
    throw new TrashError("refused", "Private folders can't be deleted here.");
  }
  const abs = path.join(root, ...parts);
  if (!insideRoot(root, abs)) throw new TrashError("refused", "That isn't a place in this workspace.");
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { throw new TrashError("not_found", "It isn't there any more."); }
  if (st.isSymbolicLink()) throw new TrashError("refused", "That is a link to somewhere else, so it wasn't deleted.");
  return clean;
}

function newEntryDir(root: string, kind: TrashKind, title: string, c?: Clock): string {
  const stamp = iso(c).replace(/[:.]/g, "-");
  const base = `${stamp}-${kind.replace(/_/g, "-")}-${slugify(title, "item").slice(0, 70).replace(/-+$/, "") || "item"}`;
  fs.mkdirSync(trashRoot(root), { recursive: true });
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    try { fs.mkdirSync(entryDir(root, id)); return id; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  throw new Error("Too many deletions at the same moment. Try again.");
}

/**
 * Moves `rels` into one new trash entry. Every path is checked before anything moves, and a failed move puts back
 * the ones already moved, so it is all or nothing.
 */
export function moveToTrash(root: string, input: { kind: TrashKind; title: string; detail?: string; rels: string[]; mail?: TrashMailMove[]; meta?: Record<string, unknown> }, c?: Clock): TrashEntry {
  const rels = input.rels.map((r) => trashableRel(root, r));
  if (!rels.length) throw new TrashError("refused", "Nothing to delete.");
  for (const a of rels) for (const b of rels) if (a !== b && b.startsWith(`${a}/`)) throw new TrashError("refused", "The same item was named twice.");
  if (new Set(rels).size !== rels.length) throw new TrashError("refused", "The same item was named twice.");
  const id = newEntryDir(root, input.kind, input.title, c);
  const entry: TrashEntry = { v: 1, id, kind: input.kind, title: input.title, detail: input.detail ?? "", deleted_at: iso(c), items: rels, mail: input.mail ?? [], meta: input.meta ?? {} };
  const moved: string[] = [];
  try {
    writeFileAtomic(manifestOf(root, id), `${JSON.stringify(entry, null, 2)}\n`);
    for (const rel of rels) {
      const to = stored(root, id, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(path.join(root, rel), to);
      moved.push(rel);
    }
  } catch (e) {
    let stuck = false;
    for (const rel of moved.reverse()) { try { fs.renameSync(stored(root, id, rel), path.join(root, rel)); } catch { stuck = true; } }
    // Something that couldn't go back stays in its entry, listed in Recently deleted, so it is never lost.
    if (!stuck) fs.rmSync(entryDir(root, id), { recursive: true, force: true });
    throw e;
  }
  return entry;
}

function readEntry(root: string, id: string): TrashEntry | null {
  if (!TRASH_ID.test(id)) return null;
  try {
    const e = readJson(manifestOf(root, id)) as TrashEntry;
    if (!e || e.v !== 1 || e.id !== id || !Array.isArray(e.items) || !(TRASH_KINDS as readonly string[]).includes(e.kind)) return null;
    return { ...e, mail: Array.isArray(e.mail) ? e.mail : [], meta: e.meta && typeof e.meta === "object" ? e.meta : {}, detail: typeof e.detail === "string" ? e.detail : "" };
  } catch {
    return null;
  }
}

/** Every readable entry, newest first. */
export function listTrash(root: string): TrashEntry[] {
  let names: string[];
  try { names = fs.readdirSync(trashRoot(root)); } catch { return []; }
  return names.map((n) => readEntry(root, n)).filter((e): e is TrashEntry => e !== null)
    .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at) || b.id.localeCompare(a.id));
}

export function getTrash(root: string, id: string): TrashEntry {
  const e = readEntry(root, id);
  if (!e) throw new TrashError("not_found", "That item isn't in Recently deleted any more.");
  return e;
}

/**
 * Puts an entry back where it was. Refuses, moving nothing, when something else now sits at that place, or when
 * the company a job or file belonged to is gone (restore the company first).
 */
export function restoreFromTrash(root: string, id: string): TrashEntry {
  const e = getTrash(root, id);
  const items = e.items.filter((rel) => fs.existsSync(stored(root, id, rel)));
  if (!items.length) throw new TrashError("not_found", "Its files aren't in Recently deleted any more.");
  for (const rel of items) {
    trashablePlace(root, rel);
    const abs = path.join(root, rel);
    if (fs.existsSync(abs) || isLink(abs)) throw new TrashError("taken", `Something new is at its old place now, so "${e.title}" wasn't put back. Rename or delete that first.`);
    const parts = rel.split("/");
    if (parts[0] === "companies" && parts.length > 2 && !fs.existsSync(layout(root).companyFile(parts[1]!))) {
      throw new TrashError("parent_gone", `The company it belonged to was deleted. Restore the company first, then "${e.title}".`);
    }
  }
  const back: string[] = [];
  try {
    for (const rel of items) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.renameSync(stored(root, id, rel), abs);
      back.push(rel);
    }
  } catch (err) {
    for (const rel of back.reverse()) { try { fs.renameSync(path.join(root, rel), stored(root, id, rel)); } catch { /* best effort */ } }
    throw err;
  }
  fs.rmSync(entryDir(root, id), { recursive: true, force: true });
  return e;
}

/** A restore target must still be a place the trash may use (the rules could only have been met at delete time). */
function trashablePlace(root: string, rel: string): void {
  const parts = rel.split("/");
  if (parts.length < 2 || NEVER_TOP.has(parts[0]!) || (LOCKABLE_DIRS as readonly string[]).some((d) => rel === d || rel.startsWith(`${d}/`))) {
    throw new TrashError("refused", "That part of the workspace can't be restored here.");
  }
  if (!insideRoot(root, path.join(root, ...parts))) throw new TrashError("refused", "That isn't a place in this workspace.");
}

const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Deletes one entry for good ("Delete forever"). */
export function forgetTrash(root: string, id: string): TrashEntry {
  const e = getTrash(root, id);
  fs.rmSync(entryDir(root, id), { recursive: true, force: true });
  return e;
}

/** When an entry was deleted: its manifest, or the time in its folder name when the manifest can't be read. */
function deletedAt(root: string, name: string): number {
  const e = readEntry(root, name);
  if (e) return Date.parse(e.deleted_at);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
}

/** Removes entries deleted more than `days` ago. Returns how many went. Anything it can't date is kept. */
export function purgeTrash(root: string, now: Date, days = TRASH_DAYS): number {
  let names: string[];
  try { names = fs.readdirSync(trashRoot(root)); } catch { return 0; }
  const cutoff = now.getTime() - days * 86_400_000;
  let n = 0;
  for (const name of names) {
    if (!TRASH_ID.test(name)) continue;
    const at = deletedAt(root, name);
    if (Number.isFinite(at) && at < cutoff) { fs.rmSync(entryDir(root, name), { recursive: true, force: true }); n++; }
  }
  return n;
}

/** The day an entry goes for good. */
export function trashPurgeAt(e: TrashEntry, days = TRASH_DAYS): string {
  return new Date(Date.parse(e.deleted_at) + days * 86_400_000).toISOString();
}
