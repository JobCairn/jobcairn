import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { insideRoot } from "./paths.js";
import { safeChmod } from "./perm.js";
import { check } from "./schema.js";
import type { Kind, KindMap } from "./types.js";

export class RecordError extends Error {
  constructor(public readonly file: string, public readonly problems: string[]) {
    super(`${file}: ${problems.join("; ")}`);
    this.name = "RecordError";
  }
}

export function readJson(file: string): unknown {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { throw new RecordError(file, [`cannot read: ${(e as Error).message}`]); }
  try { return JSON.parse(text); }
  catch (e) { throw new RecordError(file, [`invalid JSON: ${(e as Error).message}`]); }
}

export function readRecord<K extends Kind>(kind: K, file: string): KindMap[K] {
  const r = check(kind, readJson(file));
  if (!r.ok) throw new RecordError(file, r.problems);
  return r.value;
}

export interface WriteFileAtomicOpts {
  exclusive?: boolean;
  /**
   * fsync the new content before it replaces the file, and the folder after, so the write survives
   * a power loss or kernel panic, not just a crash of this process. For writes that must be on disk
   * before something irreversible happens (claiming an email send).
   */
  durable?: boolean;
}

/** fsyncs a folder, so a file created or renamed in it is on disk. Not possible on Windows, where it is skipped. */
export function fsyncDir(dir: string): void {
  let fd: number;
  try { fd = fs.openSync(dir, "r"); } catch { return; }
  try { fs.fsyncSync(fd); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EISDIR" && code !== "EINVAL" && code !== "EBADF") throw e;
  } finally { fs.closeSync(fd); }
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// `opts.exclusive`: fail (ENOENT-free EEXIST) instead of overwriting when `file`
// already exists. Used for new-record creation (e.g. queue.ts) where a caller must
// detect a colliding id and retry with a different one, rather than clobbering
// whatever is already there. Implemented with linkSync (atomic create-if-absent),
// not a rename, which always overwrites.
export function writeFileAtomic(file: string, content: string | Uint8Array, mode?: number, opts: WriteFileAtomicOpts = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    if (opts.durable) fsyncFile(tmp);
    if (opts.exclusive) {
      if (mode !== undefined) safeChmod(tmp, mode);
      fs.linkSync(tmp, file); // throws EEXIST if `file` already exists; never overwrites
      fs.unlinkSync(tmp);
    } else {
      // If mode is undefined but the target exists, preserve its permissions.
      if (mode === undefined && fs.existsSync(file)) {
        const existingMode = fs.statSync(file).mode & 0o777;
        safeChmod(tmp, existingMode);
      } else if (mode !== undefined) {
        // If mode was specified, apply it (umask can strip bits at creation).
        safeChmod(tmp, mode);
      }
      fs.renameSync(tmp, file);
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  if (opts.durable) fsyncDir(path.dirname(file));
}

// Symlink-safe one-line append used for the search log and inbox/_filed.md.
// Refuses if `file` resolves outside `root`, if its parent folder is a
// symlink, or (atomically, via O_NOFOLLOW) if `file` itself is a symlink.
export function appendLineSafe(root: string, file: string, line: string, fsync = false): void {
  if (!insideRoot(root, file)) throw new Error(`refusing to write outside the workspace: ${file}`);
  const dir = path.dirname(file);
  let dirStat: fs.Stats | undefined;
  try { dirStat = fs.lstatSync(dir); } catch { dirStat = undefined; }
  if (dirStat) {
    if (dirStat.isSymbolicLink()) throw new Error(`refusing to write through a symlinked folder: ${dir}`);
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    throw new Error(`refusing to write through a symlinked file: ${file}: ${(e as Error).message}`);
  }
  try {
    fs.writeSync(fd, line);
    if (fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * appendLineSafe, then fsync: the line is on disk when this returns, and so is the file itself
 * (its folder is fsynced too) when this call created it.
 */
export function appendLineDurable(root: string, file: string, line: string): void {
  let existed = true;
  try { fs.lstatSync(file); } catch { existed = false; }
  appendLineSafe(root, file, line, true);
  if (!existed) fsyncDir(path.dirname(file));
}

export function writeRecord<K extends Kind>(kind: K, file: string, data: KindMap[K] | Record<string, unknown>, opts: WriteFileAtomicOpts = {}): KindMap[K] {
  const r = check(kind, data);
  if (!r.ok) throw new RecordError(file, r.problems);
  writeFileAtomic(file, JSON.stringify(r.value, null, 2) + "\n", undefined, opts);
  return r.value;
}

export function updateRecord<K extends Kind>(kind: K, file: string, fn: (cur: KindMap[K]) => KindMap[K] | void, opts: WriteFileAtomicOpts = {}): KindMap[K] {
  const cur = readRecord(kind, file);
  const next = fn(cur) ?? cur;
  return writeRecord(kind, file, next, opts);
}
