import fs from "node:fs";
import path from "node:path";
import { insideRoot, lockedFolderFor } from "@careeros/core";
import { canOpenExternally, LOCKABLE_DIRS, PREVIEW_LIMITS, previewKind, type FilePreview, type LockableDir } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { resolveWorkspaceFile } from "./files.js";
import { lockedFor } from "./integrity.js";
import { extractDocText } from "./resume-fill.js";

const asLockable = (d: string | null): LockableDir | null => (d && (LOCKABLE_DIRS as readonly string[]).includes(d) ? (d as LockableDir) : null);

/**
 * The in-app viewer's answer for one workspace file. The lock is decided before anything else, from the path alone
 * (so a locked folder doesn't even say whether a file exists), then again from the real path and the folder's
 * identity. Only then is the file looked at: its size against the caps, and its text for Markdown, text and Word.
 * PDFs, images and video are read later by the careeros-file: scheme, which runs the same checks again.
 */
export async function previewFile(ctx: ServiceContext, rel: string): Promise<FilePreview> {
  const root = ctx.requireRoot();
  const kind = previewKind(rel);
  const parts = rel.split("/");
  if (!rel || rel.includes("\\") || path.isAbsolute(rel) || parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) {
    throw new Error("This file isn't available to the app.");
  }
  const abs = path.join(root, ...parts);
  const byPath = asLockable(lockedFolderFor(root, abs, ctx.clock()));
  if (byPath) return { state: "locked", kind, folder: byPath };
  if (!fs.existsSync(abs)) return { state: "missing", kind };
  if (!insideRoot(root, abs)) throw new Error("This file points outside the workspace.");
  let real: string;
  let st: fs.Stats;
  try { real = fs.realpathSync.native(abs); st = fs.statSync(real); } catch { return { state: "missing", kind }; }
  const locked = lockedFor(ctx, root, real);
  if (locked) return { state: "locked", kind, folder: asLockable(locked) ?? "me/identity" };
  if (!st.isFile()) return { state: "missing", kind };
  // A second name for a file (maybe one in a locked folder): the real path can't tell, so it is never read.
  if (st.nlink > 1) return { state: "unsupported", kind, size: st.size, at: st.mtime.toISOString(), reason: "unreadable" };
  const base = { size: st.size, at: st.mtime.toISOString() };
  if (kind === "other") return { state: "unsupported", kind, ...base, reason: path.extname(real).toLowerCase() === ".doc" ? "old_word" : "kind" };
  const limit = kind === "markdown" || kind === "text" ? PREVIEW_LIMITS.text : kind === "word" ? PREVIEW_LIMITS.word : PREVIEW_LIMITS.media;
  if (st.size > limit) return { state: "too_large", kind, ...base, limit };
  if (kind === "markdown" || kind === "text") {
    // The same checks the text reader uses (locks by identity, hard links, kind, size), then the bytes.
    let text: string;
    try { text = fs.readFileSync(resolveWorkspaceFile(ctx, rel, "read"), "utf8"); } catch { return { state: "unsupported", kind, ...base, reason: "unreadable" }; }
    return { state: "ready", kind, ...base, text };
  }
  if (kind === "word") {
    // The isolated reader Fill from my resume and the drop box use: a worker with a memory cap and a deadline.
    try { return { state: "ready", kind, ...base, text: await extractDocText(real) }; } catch { return { state: "unsupported", kind, ...base, reason: "unreadable" }; }
  }
  // pdf, image, video: confirm the media checks pass now, so a refusal shows here and not as a broken frame.
  try { resolveWorkspaceFile(ctx, rel, "media"); } catch { return { state: "unsupported", kind, ...base, reason: "unreadable" }; }
  return { state: "ready", kind, ...base, text: null };
}

/** "Open in default app": documents and media only, never a locked folder, never an app or a script. */
export async function openFile(ctx: ServiceContext, rel: string): Promise<void> {
  if (!canOpenExternally(rel)) throw new Error("This kind of file can't be opened from the app. Use Show in Finder instead.");
  const root = ctx.requireRoot();
  const real = resolveWorkspaceFile(ctx, rel, "reveal");
  const locked = lockedFor(ctx, root, real);
  if (locked) throw new Error("This file is in a locked folder. Allow it once in Privacy first.");
  const st = fs.statSync(real);
  if (!st.isFile() || st.nlink > 1 || !canOpenExternally(real)) throw new Error("This file can't be opened from the app. Use Show in Finder instead.");
  if (!ctx.host.shell.openPath) throw new Error("Opening files in another app isn't available here. Use Show in Finder instead.");
  await ctx.host.shell.openPath(real);
}

export const filePreviewHandlers = {
  "files.preview": previewFile,
  "files.open": openFile,
} satisfies Partial<HandlerTable>;
