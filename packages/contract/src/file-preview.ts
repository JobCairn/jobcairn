/**
 * The in-app file viewer (files.preview / files.open). One answer per file, decided in main: the viewer never reads
 * a file itself, never sees a path outside the workspace, and a file in a locked folder comes back as "locked" with
 * no size, date or text.
 */
import type { LockableDir } from "./constants.js";

/** What the viewer can show. "word" is a text preview of a .docx; "other" can only be opened in another app. */
export type PreviewKind = "markdown" | "text" | "word" | "pdf" | "image" | "video" | "other";

/** Size caps for a preview. Larger files still open in the default app. */
export const PREVIEW_LIMITS = { text: 2 * 1024 * 1024, word: 25 * 1024 * 1024, media: 100 * 1024 * 1024 } as const;

export type FilePreview =
  /** markdown, text and word carry the text; pdf, image and video load through the app's own file URL. */
  | { state: "ready"; kind: PreviewKind; size: number; at: string; text: string | null }
  /** In a locked folder. Nothing about the file was read. */
  | { state: "locked"; kind: PreviewKind; folder: LockableDir }
  | { state: "too_large"; kind: PreviewKind; size: number; at: string; limit: number }
  /** A kind the app can't show (or a Word file it couldn't read): open it in another app instead. */
  | { state: "unsupported"; kind: PreviewKind; size: number; at: string; reason: "kind" | "unreadable" | "old_word" }
  | { state: "missing"; kind: PreviewKind };

const EXT_KIND: Record<string, PreviewKind> = {
  md: "markdown", markdown: "markdown", txt: "text", eml: "text", json: "text",
  docx: "word", pdf: "pdf", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  mp4: "video", m4v: "video", webm: "video", mov: "video",
};

/** The viewer's kind from a file name. ".doc" (old Word) is "other": the text reader only knows .docx. */
export function previewKind(name: string): PreviewKind {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");
  return EXT_KIND[ext] ?? "other";
}

/**
 * Kinds "Open in default app" may open: documents and media only. A drop box or a saved attachment can hold an app or
 * a script (.command, .app, .sh), so opening is never "run anything". Older .doc and .rtf can carry macros, so they only get Show in Finder.
 */
const OPENABLE = new Set(["md", "markdown", "txt", "csv", "json", "pdf", "docx", "odt", "pages", "key", "numbers", "xlsx", "pptx", "png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "m4v", "webm", "mov"]);
export function canOpenExternally(name: string): boolean {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");
  return OPENABLE.has(ext);
}
