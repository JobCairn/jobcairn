import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makePrinter, PRINT_PARTITION, type PrintElectron, type PrintSession } from "../src/printer.js";

type Fn = (...a: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fake Electron: records the session handlers and window settings, and "prints" what the page file holds. */
function fakeElectron(opts: { hang?: boolean; fail?: boolean; clearHangs?: boolean } = {}) {
  const sessionHandlers: { request?: Fn; permission?: Fn; check?: Fn; download?: Fn } = {};
  const partitions: [string, unknown][] = [];
  const cleared: string[] = [];
  const ses: PrintSession = {
    webRequest: { onBeforeRequest: (fn) => { sessionHandlers.request = fn; } },
    setPermissionRequestHandler: (fn) => { sessionHandlers.permission = fn; },
    setPermissionCheckHandler: (fn) => { sessionHandlers.check = fn; },
    on: (_e, fn) => { sessionHandlers.download = fn; },
    clearStorageData: () => { cleared.push("storage"); return opts.clearHangs ? new Promise<void>(() => undefined) : Promise.resolve(); },
    clearCache: () => { cleared.push("cache"); return opts.clearHangs ? new Promise<void>(() => undefined) : Promise.resolve(); },
  };
  const windows: FakeWindow[] = [];
  class FakeWindow {
    destroyed = false;
    loaded: string | null = null;
    pageMode = 0;
    dirMode = 0;
    events = new Map<string, Fn>();
    openHandler: Fn | null = null;
    webContents = {
      on: (ev: string, fn: Fn) => { this.events.set(ev, fn); },
      setWindowOpenHandler: (fn: Fn) => { this.openHandler = fn; },
      printToPDF: vi.fn(async () => {
        if (opts.hang) return new Promise<Uint8Array>(() => undefined);
        if (opts.fail) throw new Error("print failed");
        return new TextEncoder().encode(`%PDF-1.7 ${fs.readFileSync(new URL(this.loaded!), "utf8").length}`);
      }),
    };
    constructor(public options: Record<string, any>) { windows.push(this); } // eslint-disable-line @typescript-eslint/no-explicit-any
    async loadURL(url: string) {
      // The page loads only if the session lets it through.
      let cancel = true;
      sessionHandlers.request!({ url }, (r: { cancel: boolean }) => { cancel = r.cancel; });
      if (cancel) throw new Error("ERR_BLOCKED_BY_CLIENT");
      this.loaded = url;
      const file = new URL(url);
      this.pageMode = fs.statSync(file).mode & 0o777;
      this.dirMode = fs.statSync(path.dirname(file.pathname)).mode & 0o777;
    }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }
  const electron: PrintElectron = {
    BrowserWindow: FakeWindow as unknown as PrintElectron["BrowserWindow"],
    session: { fromPartition: (p, o) => { partitions.push([p, o]); return ses; } },
  };
  return { electron, windows, sessionHandlers, partitions, cleared };
}

const tmpRoot = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-printer-test-")));
const HTML = "<!doctype html><title>Alex Example - Resume</title><p>Fictional</p>";

describe("electron printer", () => {
  it("prints in a hidden, sandboxed window with scripts, images, Node and preload off", async () => {
    const f = fakeElectron();
    const root = tmpRoot();
    const pdf = await makePrinter(f.electron, { tmpDir: () => root }).toPdf(HTML);
    expect(new TextDecoder().decode(pdf)).toBe(`%PDF-1.7 ${HTML.length}`);
    const [w] = f.windows;
    expect(w!.options.show).toBe(false);
    expect(w!.options.webPreferences).toMatchObject({
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      javascript: false, images: false, webgl: false, plugins: false, devTools: false,
    });
    expect(w!.options.webPreferences.preload).toBeUndefined();
    expect(w!.options.webPreferences.partition).toBeUndefined();
    expect(f.partitions).toEqual([[PRINT_PARTITION, { cache: false }]]);
    expect(PRINT_PARTITION.startsWith("persist:")).toBe(false); // in memory only
    expect(w!.webContents.printToPDF).toHaveBeenCalledWith(expect.objectContaining({ pageSize: "A4", generateTaggedPDF: true, printBackground: false }));
  });

  it("writes the page owner-only in a private temp folder, then removes it and the window", async () => {
    const f = fakeElectron();
    const root = tmpRoot();
    await makePrinter(f.electron, { tmpDir: () => root }).toPdf(HTML);
    const [w] = f.windows;
    expect(w!.pageMode).toBe(0o600);
    expect(w!.dirMode).toBe(0o700);
    expect(w!.destroyed).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(f.cleared).toEqual(["storage", "cache"]);
  });

  it("cancels every request but the page and data: fonts, and refuses permissions, downloads, navigation and new windows", async () => {
    const f = fakeElectron();
    await makePrinter(f.electron, { tmpDir: tmpRoot }).toPdf(HTML);
    const verdict = (url: string) => { let c: boolean | undefined; f.sessionHandlers.request!({ url }, (r: { cancel: boolean }) => { c = r.cancel; }); return c; };
    expect(verdict("data:font/woff2;base64,d09GMg==")).toBe(false);
    for (const url of ["https://tracker.example.com/p.png", "http://127.0.0.1:9222/json", "file:///etc/hosts", f.windows[0]!.loaded!]) expect(verdict(url)).toBe(true); // the page itself only while printing
    let granted: boolean | undefined;
    f.sessionHandlers.permission!(null, "media", (g: boolean) => { granted = g; });
    expect(granted).toBe(false);
    expect(f.sessionHandlers.check!()).toBe(false);
    const ev = { preventDefault: vi.fn() };
    f.sessionHandlers.download!(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    const w = f.windows[0]!;
    for (const name of ["will-navigate", "will-redirect", "will-frame-navigate", "will-attach-webview"]) {
      const e = { preventDefault: vi.fn() };
      w.events.get(name)!(e);
      expect(e.preventDefault).toHaveBeenCalled();
    }
    expect(w.openHandler!()).toEqual({ action: "deny" });
  });

  it("gives up after the time limit and still cleans up", async () => {
    const f = fakeElectron({ hang: true });
    const root = tmpRoot();
    await expect(makePrinter(f.electron, { tmpDir: () => root, timeoutMs: 50 }).toPdf(HTML)).rejects.toThrow("The PDF export took too long. Nothing was written for it.");
    expect(f.windows[0]!.destroyed).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("cleans up after a failed print, and prints one page at a time", async () => {
    const bad = fakeElectron({ fail: true });
    const root = tmpRoot();
    await expect(makePrinter(bad.electron, { tmpDir: () => root }).toPdf(HTML)).rejects.toThrow("print failed");
    expect(bad.windows[0]!.destroyed).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);

    const f = fakeElectron();
    const p = makePrinter(f.electron, { tmpDir: () => root });
    const out = await Promise.all([p.toPdf(HTML), p.toPdf(`${HTML}<p>two</p>`)]);
    expect(out.map((b) => new TextDecoder().decode(b))).toEqual([`%PDF-1.7 ${HTML.length}`, `%PDF-1.7 ${HTML.length + 10}`]);
    expect(f.windows.every((w) => w.destroyed)).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("moves on when clearing the session never finishes, so the print queue can't hang", async () => {
    const f = fakeElectron({ clearHangs: true });
    const root = tmpRoot();
    const p = makePrinter(f.electron, { tmpDir: () => root, clearTimeoutMs: 50 });
    const t = Date.now();
    const out = await Promise.all([p.toPdf(HTML), p.toPdf(HTML)]);
    expect(out).toHaveLength(2);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(f.windows.every((w) => w.destroyed)).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("removes print folders an earlier run left behind, and nothing else", async () => {
    const root = tmpRoot();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const dir = (name: string, files: Record<string, string> = { "document.html": HTML }, age: Date | null = old) => {
      const d = path.join(root, name);
      fs.mkdirSync(d);
      for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(d, f), text);
      if (age) fs.utimesSync(d, age, age);
      return d;
    };
    dir("careeros-print-AbC123"); // stale: removed
    dir("careeros-print-New456", undefined, null); // under an hour old
    dir("careeros-print-Xtra78", { "document.html": HTML, "other.txt": "user" }); // something else inside
    dir("careeros-print-Empty9", {}); // not what a print leaves
    dir("careeros-print-toolongname"); // not the mkdtemp shape
    const linkInside = dir("careeros-print-Lnk001", {});
    const outside = path.join(tmpRoot(), "outside.html");
    fs.writeFileSync(outside, "user");
    fs.symlinkSync(outside, path.join(linkInside, "document.html"));
    fs.utimesSync(linkInside, old, old);
    const target = dir("not-a-print-folder");
    fs.symlinkSync(target, path.join(root, "careeros-print-Sym002")); // a link: never followed
    const f = fakeElectron();
    await makePrinter(f.electron, { tmpDir: () => root }).toPdf(HTML);
    expect(fs.readdirSync(root).sort()).toEqual([
      "careeros-print-Empty9", "careeros-print-Lnk001", "careeros-print-New456", "careeros-print-Sym002", "careeros-print-Xtra78",
      "careeros-print-toolongname", "not-a-print-folder",
    ]);
    expect(fs.readFileSync(outside, "utf8")).toBe("user");
    expect(fs.readdirSync(path.join(root, "careeros-print-Xtra78")).sort()).toEqual(["document.html", "other.txt"]);
  });
});

