import { canOpenExternally, previewKind, type FilePreview, type LockableDir, type PreviewKind } from "@careeros/contract";
import { friendlyFile, showInFolderLabel } from "../components/files";
import { bytes } from "../format";
import { fmtDayOf } from "../reading/dates";

/** One file a list hands to the viewer. `rel` never reaches the screen: the title and type are friendly names. */
export interface ViewerFile {
  rel: string;
  /** What the list calls it ("Cover letter notes"). Defaults to a name made from the file name. */
  title?: string;
  /** When the list knows it (ISO or a date). The viewer prefers the file's own date. */
  at?: string;
}

const KIND_NAME: Record<PreviewKind, string> = {
  markdown: "Text", text: "Text", word: "Word document", pdf: "PDF", image: "Image", video: "Video", other: "File",
};

const FOLDER_NAME: Record<LockableDir, string> = { "me/identity": "Identity documents", "me/employment": "Employment records" };

/** The header line: friendly title, then "PDF · 1.5 KB · 8 Oct 2026" (date only, never an invented time). */
export function viewerTitle(f: ViewerFile): string {
  const own = f.title?.trim();
  return own || friendlyFile(f.rel, f.at ?? "").title;
}

export function viewerMeta(f: ViewerFile, p: FilePreview | null): string {
  const kind = p?.kind ?? previewKind(f.rel);
  const type = kind === "other" ? (friendlyFile(f.rel).type || "File") : KIND_NAME[kind];
  if (p?.state === "locked") return `${type} · locked`;
  const size = p && "size" in p ? bytes(p.size) : "";
  // The list's own date first, so the viewer and the row it came from agree.
  const at = f.at || (p && "at" in p ? p.at : "");
  return [type, size, at ? fmtDayOf(at) : ""].filter(Boolean).join(" · ");
}

/** The words for a file the viewer can't show, and which way out to offer. No path or raw error ever shows. */
export interface Notice { title: string; text: string; open: boolean; privacy?: boolean }

export function noticeFor(f: ViewerFile, p: FilePreview): Notice | null {
  const openable = canOpenExternally(f.rel);
  switch (p.state) {
    case "ready": return null;
    case "locked":
      return { title: "This file is locked", text: `It's in ${FOLDER_NAME[p.folder]}, which stays locked until you allow it in Privacy. Nothing in it was read.`, open: false, privacy: true };
    case "missing":
      return { title: "This file can't be found", text: "It may have been moved, renamed or deleted since this list was made.", open: false };
    case "too_large":
      return { title: "Too large to show here", text: `This file is ${bytes(p.size)}. The viewer shows files up to ${bytes(p.limit)}.${openable ? " Open it in its default app instead." : ""}`, open: openable };
    case "unsupported":
      if (p.reason === "old_word") return { title: "Older Word file", text: "The app can only preview .docx Word files. Open this one in Word, or save it as .docx to preview it here.", open: openable };
      if (p.reason === "unreadable") return { title: "No preview for this file", text: `It couldn't be read for a preview.${openable ? " Open it in its default app instead." : ""}`, open: openable };
      return {
        title: "No preview for this kind of file",
        text: openable ? `Open it in its default app, or use ${showInFolderLabel()}.` : `For safety the app doesn't open this kind of file. Use ${showInFolderLabel()} to see it there.`,
        open: openable,
      };
  }
}

/** Plain text of a ready preview, for Copy and Listen. Null for media. */
export function textOf(p: FilePreview | null): string | null {
  return p?.state === "ready" && p.text !== null ? p.text : null;
}

/** Word text arrives as plain paragraphs separated by blank lines. */
export const paragraphs = (text: string): string[] => text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
