import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow, Dialog, SaveDialogOptions } from "electron";

const FILTERS = {
  pdf: { name: "PDF", extensions: ["pdf"] }, docx: { name: "Word document", extensions: ["docx"] },
  md: { name: "Markdown", extensions: ["md"] }, txt: { name: "Plain text", extensions: ["txt"] },
} as const;

/**
 * Resume Studio downloads: the main process asks where to save (in Downloads by default) and writes the bytes
 * there. The renderer only names the format; it never sees or chooses a path. Owner-only permissions: a resume
 * carries contact details. False when the person cancels.
 */
export async function saveDownload(
  getWindow: () => BrowserWindow | null, dialog: Pick<Dialog, "showSaveDialog">, downloads: string, name: string, bytes: Uint8Array, kind: keyof typeof FILTERS,
): Promise<boolean> {
  const safe = path.basename(name).replace(/^\.+/, "") || `Resume.${kind}`;
  const opts: SaveDialogOptions = { title: "Save your resume", defaultPath: downloads ? path.join(downloads, safe) : safe, filters: [{ name: FILTERS[kind].name, extensions: [...FILTERS[kind].extensions] }], properties: ["createDirectory", "showOverwriteConfirmation"] };
  const win = getWindow();
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return false;
  const tmp = `${r.filePath}.${process.pid}.download.tmp`;
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, r.filePath);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error("The file couldn't be saved there. Choose another folder.", { cause: e });
  }
  return true;
}
