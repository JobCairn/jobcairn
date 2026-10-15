import fs from "node:fs";
import path from "node:path";
import { insideRoot } from "@careeros/core";
import { fileKind } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { lockedFor } from "./integrity.js";

export const MAX_INCOMING_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MEDIA = new Set(["image", "video", "pdf"]);
const CHUNK = 64 * 1024;

/** A file that passed checkIncomingFile. dev/ino pin the exact file so copyIncoming can tell if it was swapped. */
export interface CheckedFile { abs: string; name: string; size: number; dev: number; ino: number }

const hiddenSegment = (p: string) => path.resolve(p).split(path.sep).some((seg) => seg.startsWith("."));

/**
 * Turns a workspace-relative path from the renderer into a real absolute path, or throws.
 * "read": text files for display; "media": images, video and PDFs for the careeros-file: scheme;
 * "reveal": any file or folder, shown in the OS file manager (the person's own action, so locks don't apply).
 * Error messages quote only `rel`, never an absolute path.
 */
export function resolveWorkspaceFile(ctx: ServiceContext, rel: string, use: "read" | "media" | "reveal"): string {
  return checkWorkspaceFile(ctx, rel, use).real;
}

/** A media file that passed resolveWorkspaceFile(..., "media"). dev/ino pin it so the shell can refuse a swap before it opens it. */
export interface MediaFile { real: string; dev: number; ino: number }

export function resolveMediaFile(ctx: ServiceContext, rel: string): MediaFile {
  const { real, st } = checkWorkspaceFile(ctx, rel, "media");
  return { real, dev: st.dev, ino: st.ino };
}

function checkWorkspaceFile(ctx: ServiceContext, rel: string, use: "read" | "media" | "reveal"): { real: string; st: fs.Stats } {
  const root = ctx.requireRoot();
  const parts = rel.split("/");
  if (!rel || rel.includes("\\") || path.isAbsolute(rel) || parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) {
    throw new Error(`"${rel}" isn't available to the app.`);
  }
  const abs = path.join(root, ...parts);
  if (!fs.existsSync(abs)) throw new Error(`"${rel}" can't be found. It may have been moved or deleted.`);
  if (!insideRoot(root, abs)) throw new Error(`"${rel}" points outside the workspace.`);
  let real: string;
  let st: fs.Stats;
  try {
    real = fs.realpathSync.native(abs);
    st = fs.statSync(real);
  } catch {
    throw new Error(`"${rel}" can't be opened.`);
  }
  if (use !== "reveal") {
    const locked = lockedFor(ctx, root, real); // by path, or by the identity of a locked folder that was moved
    if (locked) throw new Error(`${locked} is locked. Allow it once in Privacy first.`);
    if (!st.isFile()) throw new Error(`"${rel}" isn't a file.`);
    // A hard link is a second name for the same file, possibly one inside a locked folder; the real path can't tell.
    if (st.nlink > 1) throw new Error(`"${rel}" is linked to another file, so the app won't open it.`);
    const kind = fileKind(real);
    if (use === "read" && (!(kind === "markdown" || kind === "text") || st.size > MAX_TEXT_BYTES)) throw new Error(`"${rel}" can't be shown as text.`);
    if (use === "media" && !MEDIA.has(kind)) throw new Error(`"${rel}" can't be shown here.`);
  }
  return { real, st };
}

/**
 * Checks a file the person dropped or picked, before anything is copied. Messages quote only the file name.
 * `root` null (no workspace open yet, or a file that is only read): a file already in the workspace is allowed.
 */
export function checkIncomingFile(root: string | null, abs: string): CheckedFile {
  const name = path.basename(abs);
  if (!path.isAbsolute(abs)) throw new Error(`"${name}" can't be added: the app needs the full path.`);
  if (hiddenSegment(abs)) throw new Error(`Hidden files and folders can't be added ("${name}").`);
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { throw new Error(`"${name}" can't be found.`); }
  if (st.isSymbolicLink()) throw new Error(`"${name}" is a link. Add the file it points to instead.`);
  if (!st.isFile()) throw new Error(`"${name}" isn't a regular file.`);
  if (st.nlink > 1) throw new Error(`"${name}" is linked to another file. Add a plain copy instead.`);
  if (st.size > MAX_INCOMING_BYTES) throw new Error(`"${name}" is larger than 25 MB.`);
  let real: string;
  let realRoot: string | null;
  try {
    real = fs.realpathSync.native(abs);
    realRoot = root === null ? null : fs.realpathSync.native(root);
  } catch {
    throw new Error(`"${name}" can't be opened.`);
  }
  // A plain-looking path can still run through a linked folder into a hidden one (Downloads/keys -> ~/.ssh).
  if (hiddenSegment(real)) throw new Error(`Hidden files and folders can't be added ("${name}").`);
  if (realRoot !== null && (real === realRoot || real.startsWith(realRoot + path.sep))) throw new Error(`"${name}" is already in your workspace.`);
  return { abs: real, name, size: st.size, dev: st.dev, ino: st.ino };
}

/**
 * Makes sure `dir` is a real folder inside the workspace (creating it if missing) before anything is written into it.
 * A symlink or a non-folder in its place is refused. `label` is the workspace-relative name used in messages.
 */
export function realDirInRoot(root: string, dir: string, label: string): string {
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(dir); } catch { st = undefined; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`${label} isn't a real folder, so nothing was added.`);
  if (!st) {
    if (!insideRoot(root, path.dirname(dir))) throw new Error(`${label} is outside the workspace, so nothing was added.`);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { throw new Error(`${label} can't be created.`); }
  }
  if (!insideRoot(root, dir)) throw new Error(`${label} is outside the workspace, so nothing was added.`);
  return dir;
}

/**
 * Copies a checked file to `dest` without trusting the path again: the source is opened without following links
 * (and without blocking on a FIFO), must still be the same regular file that was checked, and at most 25 MB is
 * copied. `dest` is created exclusively (never overwritten). Any failure removes the partial copy.
 */
export function copyIncoming(f: CheckedFile, dest: string): void {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const changed = () => new Error(`"${f.name}" changed after it was checked. Add it again.`);
  let src: number | undefined;
  let out: number | undefined;
  let created = false;
  try {
    try { src = fs.openSync(f.abs, flags); } catch { throw changed(); }
    const st = fs.fstatSync(src);
    if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino) throw changed();
    if (st.size > MAX_INCOMING_BYTES) throw new Error(`"${f.name}" is larger than 25 MB.`);
    try { out = fs.openSync(dest, "wx", 0o600); } catch { throw new Error(`"${path.basename(dest)}" can't be created.`); }
    created = true;
    const buf = Buffer.alloc(CHUNK);
    let total = 0;
    for (;;) {
      let n: number;
      try { n = fs.readSync(src, buf, 0, CHUNK, null); } catch { throw new Error(`"${f.name}" can't be read.`); }
      if (n === 0) break;
      total += n;
      if (total > MAX_INCOMING_BYTES) throw new Error(`"${f.name}" is larger than 25 MB.`);
      try { fs.writeSync(out, buf, 0, n); } catch { throw new Error(`"${path.basename(dest)}" can't be written.`); }
    }
    const done = out;
    out = undefined;
    fs.closeSync(done);
  } catch (e) {
    if (out !== undefined) try { fs.closeSync(out); } catch { /* already failing */ }
    if (created) fs.rmSync(dest, { force: true });
    throw e;
  } finally {
    if (src !== undefined) try { fs.closeSync(src); } catch { /* nothing to do */ }
  }
}

function readText(ctx: ServiceContext, rel: string): string {
  const real = resolveWorkspaceFile(ctx, rel, "read");
  try { return fs.readFileSync(real, "utf8"); } catch { throw new Error(`"${rel}" can't be read.`); }
}

export const fileHandlers = {
  "files.readText": readText,
  "files.reveal": (ctx: ServiceContext, rel: string) => { ctx.host.shell.showItemInFolder(resolveWorkspaceFile(ctx, rel, "reveal")); },
  "files.pick": (ctx: ServiceContext) => ctx.host.shell.pickFile(),
} satisfies Partial<HandlerTable>;
