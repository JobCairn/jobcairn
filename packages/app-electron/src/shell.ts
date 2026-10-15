import { execFile } from "node:child_process";
import { saveDownload } from "./save-file.js";
import { promisify } from "node:util";
import { app, clipboard, dialog, shell, type BrowserWindow, type OpenDialogOptions } from "electron";
import { isSafeLink, type ShellHost } from "@careeros/services";
import { identity } from "@careeros/brand/identity";
import { openClaudeDesktop } from "./claude.js";
import { linkPrompt } from "./security.js";

const run = promisify(execFile);

export function electronShell(getWindow: () => BrowserWindow | null, picks: string[] | null): ShellHost {
  const ask = async (opts: OpenDialogOptions): Promise<string | null> => {
    if (picks) return picks.shift() ?? null;
    const win = getWindow();
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0] ?? null;
  };
  return {
    pickFolder: (purpose) => ask({
      title: purpose === "create" ? "Choose a folder for your workspace" : purpose === "open" ? `Open a ${identity.name} workspace` : "Choose your old career folder",
      properties: purpose === "create" ? ["openDirectory", "createDirectory", "promptToCreate"] : ["openDirectory"],
    }),
    pickFile: () => ask({ title: "Choose a file", properties: ["openFile"] }),
    // https only, no user-info part (isSafeLink); the prompt names the real host and the full address, and the
    // address shown is exactly the one opened. A link from an email can carry a note (the text said one address,
    // the link goes to another): it shows under the address as a warning, and Cancel stays the default.
    openExternal: async (url, note) => {
      const prompt = isSafeLink(url) ? linkPrompt(url) : null;
      if (!prompt) return false;
      const href = new URL(url).href;
      const win = getWindow();
      const opts = {
        type: (note ? "warning" : "question") as "warning" | "question", buttons: ["Open", "Cancel"], defaultId: 1, cancelId: 1,
        message: prompt.message, detail: note ? `${prompt.detail}\n\n${note}` : prompt.detail,
      };
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (response !== 0) return false;
      await shell.openExternal(href);
      return true;
    },
    showItemInFolder: (p) => shell.showItemInFolder(p),
    // Services check the path first (workspace, locks, a document or media kind only; never an app or a script).
    openPath: async (p) => { if (await shell.openPath(p)) throw new Error("No app on this computer opens this kind of file. Use Show in Finder instead."); },
    // Recoverable: the file goes to the system Trash, never straight to deletion. Services choose and check the path.
    trashItem: (p) => shell.trashItem(p),
    openClaudeDesktop: () => openClaudeDesktop(process.platform, (cmd, args) => run(cmd, args)),
    copyText: (text) => clipboard.writeText(text),
    saveFile: (name, bytes, kind) => saveDownload(getWindow, dialog, app.getPath("downloads"), name, bytes, kind),
  };
}
