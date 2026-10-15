import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, session } from "electron";
import type { DocumentPrinter } from "@careeros/services";

/** In-memory session for print windows only (no "persist:" prefix): no cookies or cache on disk, cleared after every print. */
export const PRINT_PARTITION = "careeros-print";
/** A print that takes longer than this is abandoned: the window is destroyed and nothing is written. */
export const PRINT_TIMEOUT_MS = 30_000;

type Prevent = { preventDefault(): void };

/** The parts of Electron the printer uses, so tests can pass fakes. */
export interface PrintSession {
  webRequest: { onBeforeRequest(fn: (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void): void };
  setPermissionRequestHandler(fn: (wc: unknown, permission: string, cb: (granted: boolean) => void) => void): void;
  setPermissionCheckHandler(fn: () => boolean): void;
  on(event: "will-download", fn: (e: Prevent) => void): void;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
}
export interface PrintWebContents {
  on(event: "will-navigate" | "will-redirect" | "will-frame-navigate" | "will-attach-webview", fn: (e: Prevent) => void): void;
  setWindowOpenHandler(fn: () => { action: "deny" }): void;
  printToPDF(options: Record<string, unknown>): Promise<Uint8Array>;
}
export interface PrintWindow { webContents: PrintWebContents; loadURL(url: string): Promise<void>; destroy(): void; isDestroyed(): boolean }
export interface PrintElectron {
  BrowserWindow: new (options: Record<string, unknown>) => PrintWindow;
  session: { fromPartition(partition: string, options?: { cache: boolean }): PrintSession };
}
/** Clearing the print session after a print gets this long; then the queue moves on regardless. */
export const CLEAR_TIMEOUT_MS = 5_000;
export interface PrinterOptions { timeoutMs?: number; clearTimeoutMs?: number; tmpDir?: () => string }

/** The window settings for printing: never shown, sandboxed, no scripts, images, Node, preload or dev tools. */
export const printWindowOptions = (ses: PrintSession) => ({
  show: false, width: 794, height: 1123, paintWhenInitiallyHidden: true,
  webPreferences: {
    session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
    javascript: false, images: false, webgl: false, plugins: false, spellcheck: false, devTools: false, navigateOnDragDrop: false,
    // No `preload`: the print page gets no bridge of any kind.
  },
});

/** What mkdtemp makes for a print: "careeros-print-" and six random characters. */
const PRINT_DIR = /^careeros-print-[A-Za-z0-9]{6}$/;
/** A print folder older than this was left by a run that stopped mid-print (prints give up after 30 s). */
export const STALE_PRINT_MS = 60 * 60 * 1000;

/**
 * Removes print folders an earlier run left behind: a real folder (not a link) named like ours, owned by this user,
 * untouched for over an hour, holding exactly one plain, single-named document.html. That file is unlinked and the
 * then-empty folder removed with rmdir; nothing is ever deleted recursively.
 */
export function sweepStalePrintDirs(tmp: string, now = Date.now()): void {
  let names: string[];
  try { names = fs.readdirSync(tmp); } catch { return; }
  const uid = process.getuid?.();
  for (const n of names) {
    if (!PRINT_DIR.test(n)) continue;
    const d = path.join(tmp, n);
    try {
      const st = fs.lstatSync(d);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || now - st.mtimeMs < STALE_PRINT_MS) continue;
      const inside = fs.readdirSync(d);
      if (inside.length !== 1 || inside[0] !== "document.html") continue;
      const f = path.join(d, "document.html");
      const fst = fs.lstatSync(f);
      if (!fst.isFile() || fst.nlink !== 1) continue;
      fs.unlinkSync(f);
      fs.rmdirSync(d);
    } catch { /* changed under us, or not ours: leave it */ }
  }
}

/**
 * Prints the generated HTML in a hidden, sandboxed window with scripts off and every request but the page itself
 * (and its data: fonts) cancelled, then destroys the window and deletes the temp folder, whatever happened.
 * Prints run one at a time, so the session's request filter only ever allows the page being printed.
 */
export function makePrinter(electron: PrintElectron, opts: PrinterOptions = {}): DocumentPrinter {
  const timeoutMs = opts.timeoutMs ?? PRINT_TIMEOUT_MS;
  const clearTimeoutMs = opts.clearTimeoutMs ?? CLEAR_TIMEOUT_MS;
  const tmpRoot = opts.tmpDir ?? (() => os.tmpdir());
  let ses: PrintSession | null = null;
  let current: string | null = null; // the one page URL the filter lets through
  let queue: Promise<unknown> = Promise.resolve();

  const printSession = (): PrintSession => {
    if (ses) return ses;
    const s = electron.session.fromPartition(PRINT_PARTITION, { cache: false });
    // Cancels every request but the page being printed. The data: clause is kept but does nothing in practice:
    // Chromium never routes data: URLs through webRequest. What actually limits data: URLs is the page's CSP
    // (font-src data: only; default-src 'none') together with images: false and javascript: false.
    s.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !(current !== null && details.url === current) && !details.url.startsWith("data:") }));
    s.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
    s.on("will-download", (e) => e.preventDefault());
    ses = s;
    return s;
  };

  const printOnce = async (html: string): Promise<Uint8Array> => {
    const s = printSession();
    let dir: string | null = null;
    let win: PrintWindow | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      sweepStalePrintDirs(tmpRoot());
      dir = fs.mkdtempSync(path.join(tmpRoot(), "careeros-print-"));
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, "document.html");
      fs.writeFileSync(file, html, { mode: 0o600, flag: "wx" });
      current = pathToFileURL(file).href;
      win = new electron.BrowserWindow(printWindowOptions(s));
      const wc = win.webContents;
      for (const ev of ["will-navigate", "will-redirect", "will-frame-navigate", "will-attach-webview"] as const) wc.on(ev, (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      const page = current;
      const work = (async () => {
        await win!.loadURL(page);
        return wc.printToPDF({
          pageSize: "A4", printBackground: false, preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: false,
          margins: { top: 0.7, bottom: 0.7, left: 0.7, right: 0.7 },
        });
      })();
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The PDF export took too long. Nothing was written for it.")), timeoutMs); });
      work.catch(() => undefined); // if the deadline wins, a later failure is expected and ignored
      return new Uint8Array(await Promise.race([work, late]));
    } finally {
      if (timer) clearTimeout(timer);
      current = null;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      // Best effort, and bounded: if Chromium never answers, the next print must not wait forever. The session is in memory only.
      let clearTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([s.clearStorageData(), s.clearCache()]).catch(() => undefined),
        new Promise<void>((done) => { clearTimer = setTimeout(done, clearTimeoutMs); }),
      ]);
      clearTimeout(clearTimer);
    }
  };

  return {
    toPdf(html: string): Promise<Uint8Array> {
      const run = queue.then(() => printOnce(html), () => printOnce(html));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** The desktop printer: Electron's own BrowserWindow and session. */
export function electronPrinter(): DocumentPrinter {
  return makePrinter({ BrowserWindow, session } as unknown as PrintElectron);
}
