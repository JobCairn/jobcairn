// Loads the real main.ts against a fake `electron` module, so the wiring itself is tested:
// window settings, navigation and window-open blocking, IPC error shape, the careeros-file: handler
// (with real services and a real sample workspace), and the grant re-check on resume.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { identity } from "@careeros/brand/identity";
import { listAccessRequests } from "@careeros/core";
import type { Runtime } from "@careeros/services";
import { CALL, fileUrlFor } from "../src/channels.js";
import { CSP } from "../src/security.js";

type Fn = (...a: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Ev = { preventDefault: ReturnType<typeof vi.fn> };

const E = vi.hoisted(() => {
  const emitter = () => {
    const m = new Map<string, Fn[]>();
    const self = {
      on(ev: string, fn: Fn) { m.set(ev, [...(m.get(ev) ?? []), fn]); return self; },
      once(ev: string, fn: Fn) { return self.on(ev, fn); },
      emit(ev: string, ...a: unknown[]) { for (const fn of m.get(ev) ?? []) fn(...a); },
      count: (ev: string) => (m.get(ev) ?? []).length,
    };
    return self;
  };
  const windows: { opts: Record<string, any>; webContents: { send: Fn; mainFrame: { url: string } } }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  class BrowserWindow {
    opts: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    webContents = { send: vi.fn(), mainFrame: { url: "app://careeros/index.html" } };
    private em = emitter();
    constructor(opts: Record<string, any>) { this.opts = opts; windows.push(this); } // eslint-disable-line @typescript-eslint/no-explicit-any
    once(ev: string, fn: Fn) { this.em.on(ev, fn); }
    on(ev: string, fn: Fn) { this.em.on(ev, fn); }
    loadURL = vi.fn(async () => undefined);
    show = vi.fn(); isMinimized = () => false; restore = vi.fn(); focus = vi.fn();
  }
  const state = { userData: "", appPath: "" };
  const app = Object.assign(emitter(), {
    isPackaged: false,
    getPath: vi.fn(() => state.userData), getAppPath: vi.fn(() => state.appPath), setPath: vi.fn(), getVersion: () => "0.1.0",
    setName: vi.fn(), setAboutPanelOptions: vi.fn(), dock: { setIcon: vi.fn() },
    enableSandbox: vi.fn(), requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn(),
    whenReady: () => Promise.resolve(),
  });
  const handlers = new Map<string, Fn>();
  const protocols = new Map<string, Fn>();
  const perms: { request?: Fn; check?: Fn } = {};
  const module = {
    app, BrowserWindow,
    Menu: { buildFromTemplate: vi.fn((t: unknown) => t), setApplicationMenu: vi.fn() },
    ipcMain: { handle: vi.fn((ch: string, fn: Fn) => { handlers.set(ch, fn); }) },
    net: { fetch: vi.fn() },
    powerMonitor: emitter(),
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn((s: string, fn: Fn) => { protocols.set(s, fn); }) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    session: {
      defaultSession: Object.assign(emitter(), { setPermissionRequestHandler: (fn: Fn) => { perms.request = fn; }, setPermissionCheckHandler: (fn: Fn) => { perms.check = fn; } }),
      // The remote-image session: in memory, no permissions, cookie/Referer/Origin headers stripped.
      fromPartition: vi.fn(() => ({
        setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn() }, fetch: vi.fn(),
      })),
    },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })), showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  };
  return { module, windows, state, handlers, protocols, perms, emitter, runtimes: [] as Runtime[], createRuntime: vi.fn() };
});

vi.mock("electron", () => ({ ...E.module, default: E.module }));
vi.mock("@careeros/services", async (importOriginal) => {
  const real = await importOriginal<typeof import("@careeros/services")>();
  E.createRuntime.mockImplementation((...a: Parameters<typeof real.createRuntime>) => {
    const r = real.createRuntime(...a);
    vi.spyOn(r, "checkGrants");
    E.runtimes.push(r);
    return r;
  });
  return { ...real, createRuntime: E.createRuntime };
});

const SAMPLE = path.resolve(import.meta.dirname, "../../../samples/alex-example");
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-main-")));
// Every workspace file the careeros-file: handler opens (it reads from a descriptor, not net.fetch).
const opened: string[] = [];
// main.ts serves app:// from <its folder>/renderer; the fake net.fetch answers that one URL, so nothing is written into src/.
const RENDERER_INDEX = path.resolve(import.meta.dirname, "../src/renderer/index.html");
let root = "";
let outsideFile = "";

const win = () => E.windows[0]!;
const trusted = () => ({ sender: win().webContents, senderFrame: win().webContents.mainFrame });
const call = (method: string, args: unknown[], event: unknown = trusted()) => Promise.resolve().then(() => E.handlers.get(CALL)!(event, method, args));
const get = (url: string, headers: Record<string, string> = {}) =>
  E.protocols.get("careeros-file")!({ url, headers: new Headers(headers) } as unknown as Request) as Promise<Response>;
const runtime = () => E.runtimes[0]!;

beforeAll(async () => {
  E.state.userData = tmp();
  E.state.appPath = path.resolve(import.meta.dirname, "..");
  const ws = tmp();
  root = path.join(ws, "CareerOS");
  fs.cpSync(SAMPLE, root, { recursive: true });
  // Fictional media: a normal clip, a file literally named "%41.png" next to "A.png" (to catch a double decode),
  // a locked identity scan, a link from learning/ into the locked folder and a link out of the workspace.
  const learning = path.join(root, "learning");
  fs.mkdirSync(path.join(root, "me", "identity"), { recursive: true });
  fs.writeFileSync(path.join(learning, "demo clip.png"), "clip-bytes");
  fs.writeFileSync(path.join(learning, "%41.png"), "percent-name");
  fs.writeFileSync(path.join(learning, "A.png"), "letter-a");
  fs.writeFileSync(path.join(learning, "notes.txt"), "plain text");
  fs.writeFileSync(path.join(root, "me", "identity", "passport-scan.png"), "fictional-scan");
  outsideFile = path.join(ws, "outside.png");
  fs.writeFileSync(outsideFile, "outside-bytes");
  fs.symlinkSync(path.join(root, "me", "identity", "passport-scan.png"), path.join(learning, "sneaky.png"));
  fs.symlinkSync(outsideFile, path.join(learning, "escape.png"));
  fs.writeFileSync(path.join(root, "me", "identity", "visa-scan.png"), "fictional-visa");
  fs.linkSync(path.join(root, "me", "identity", "visa-scan.png"), path.join(learning, "hardlink.png"));

  const realOpen = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).startsWith(ws)) opened.push(String(p));
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
  E.module.net.fetch.mockImplementation(async (url: string) => {
    const p = fileURLToPath(url);
    if (p === RENDERER_INDEX) return new Response("<!doctype html>", { status: 200 });
    if (!fs.existsSync(p)) return new Response("missing", { status: 404 });
    return new Response(fs.readFileSync(p), { status: 200 });
  });

  await import("../src/main.js");
  await vi.waitFor(() => expect(E.handlers.has(CALL)).toBe(true));
});

afterAll(() => { E.module.app.emit("before-quit", { preventDefault() {} }); });

describe("window and app hardening", () => {
  it("creates one sandboxed, isolated window and one runtime", () => {
    expect(E.windows).toHaveLength(1);
    expect(win().opts.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
    expect(win().opts.webPreferences).not.toHaveProperty("enableRemoteModule");
    expect(E.module.app.enableSandbox).toHaveBeenCalled();
    expect(E.module.app.requestSingleInstanceLock).toHaveBeenCalled();
    // The grant timer is installed by createRuntime, once per context; main creates exactly one runtime.
    expect(E.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("shows the display name only through presentation APIs", () => {
    expect(win().opts.title).toBe(identity.name);
    expect(E.module.app.setAboutPanelOptions).toHaveBeenCalledWith(expect.objectContaining({ applicationName: identity.name }));
    const icon = win().opts.icon as string | undefined;
    if (icon) expect(icon).toMatch(/app-icon-1024\.png$/);
    if (process.platform === "darwin") {
      if (icon) expect(E.module.app.dock.setIcon).toHaveBeenCalledWith(icon);
      const menu = E.module.Menu.setApplicationMenu.mock.calls[0]![0] as { label?: string }[];
      expect(menu[0]!.label).toBe(identity.name);
    }
  });

  it("keys the process name and userData on the fixed internal id, never the display name", () => {
    // The process name names the macOS Keychain safeStorage entry; userData holds secrets.json.
    expect(E.module.app.setName).toHaveBeenCalledTimes(1);
    expect(E.module.app.setName).toHaveBeenCalledWith(identity.internalId);
    expect(E.module.app.setName).not.toHaveBeenCalledWith(identity.name);
    const userData = E.module.app.setPath.mock.calls.filter((c) => c[0] === "userData").map((c) => String(c[1]));
    expect(userData).toHaveLength(1);
    expect(path.basename(userData[0]!)).toBe(identity.internalId);
    if (identity.name !== identity.internalId) expect(userData[0]).not.toContain(identity.name);
  });

  it("wires the video host: same plugin folder as the engine, writer on the engine, install only after a native confirm", async () => {
    const host = runtime().ctx.host;
    const video = host.video!;
    expect(video.pluginDir).toBe(host.claude!.pluginDir);
    expect(video.writer).toBeUndefined();
    // A development checkout has scripts/setup/run.mjs, so Install is offered. The fake dialog answers Cancel.
    E.module.dialog.showMessageBox.mockClear();
    expect(await video.install!("ffmpeg")).toEqual({ ok: false, message: "Install cancelled." });
    expect(E.module.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(E.module.dialog.showMessageBox).toHaveBeenCalledWith(win(), expect.objectContaining({
      type: "question", buttons: ["Install", "Cancel"], cancelId: 1, message: "Install ffmpeg for videos?",
    }));
  });

  it("blocks every download", () => {
    const e = { preventDefault: vi.fn() };
    E.module.session.defaultSession.emit("will-download", e, {}, {});
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("answers 404, not a crash, when a renderer file is missing or the read fails", async () => {
    const app = (url: string) => E.protocols.get("app")!({ url, headers: new Headers() }) as Promise<Response>;
    E.module.net.fetch.mockRejectedValueOnce(new Error("net::ERR_FILE_NOT_FOUND"));
    expect((await app("app://careeros/assets/missing.js")).status).toBe(404);
    expect((await app("app://careeros/assets/also-missing.js")).status).toBe(404);
  });

  it("denies every permission request and check, except full screen for the video player", () => {
    const cb = vi.fn();
    E.perms.request!({}, "media", cb);
    E.perms.request!({}, "notifications", cb);
    E.perms.request!({}, "fullscreen", cb);
    expect(cb.mock.calls).toEqual([[false], [false], [true]]);
    expect(E.perms.check!({}, "clipboard-read")).toBe(false);
  });

  it("serves the renderer with the strict CSP and nosniff", async () => {
    const ok = await (E.protocols.get("app")!({ url: "app://careeros/index.html", headers: new Headers() }) as Promise<Response>);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Security-Policy")).toBe(CSP);
    expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(fs.existsSync(path.dirname(RENDERER_INDEX))).toBe(false);
  });
});

describe("navigation, new windows and webviews", () => {
  function contents() {
    const em = E.emitter();
    let openHandler: Fn | undefined;
    const c = { ...em, setWindowOpenHandler: (fn: Fn) => { openHandler = fn; } };
    E.module.app.emit("web-contents-created", {}, c);
    return { c, open: (url: string, disposition = "foreground-tab") => openHandler!({ url, disposition, frameName: "", features: "" }) };
  }
  const ev = (): Ev => ({ preventDefault: vi.fn() });

  it("blocks navigation (a clicked link or a link dropped on the window), redirects and webviews", () => {
    const { c } = contents();
    for (const name of ["will-navigate", "will-redirect", "will-attach-webview"]) {
      const e = ev();
      c.emit(name, e, "https://jobs.example.com/dropped-link");
      expect(e.preventDefault, name).toHaveBeenCalled();
    }
  });

  it("denies every new window, including middle-click, and hands only https links to the confirm", async () => {
    const { open } = contents();
    E.module.dialog.showMessageBox.mockClear();
    for (const url of ["http://jobs.example.com/", "file:///etc/passwd", "javascript:alert(1)", "careeros-file://ws/learning/demo%20clip.png", "app://careeros/index.html"]) {
      expect(open(url), url).toEqual({ action: "deny" });
    }
    expect(open("https://jobs.example.com/role", "background-tab")).toEqual({ action: "deny" });
    expect(open("https://jobs.example.com/role", "new-window")).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(E.module.dialog.showMessageBox).toHaveBeenCalledTimes(2));
    expect(E.module.shell.openExternal).not.toHaveBeenCalled(); // the fake dialog answers "Cancel"
  });
});

describe("external links", () => {
  it("logs, and never leaves an unhandled rejection, when opening a link fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const em = E.emitter();
    let openHandler: Fn | undefined;
    E.module.app.emit("web-contents-created", {}, { ...em, setWindowOpenHandler: (fn: Fn) => { openHandler = fn; } });
    E.module.dialog.showMessageBox.mockRejectedValueOnce(new Error("dialog failed"));
    expect(openHandler!({ url: "https://jobs.example.com/x", disposition: "foreground-tab" })).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("careeros: couldn't open the link (Error)"));
    log.mockRestore();
  });

  const lastPrompt = () => (E.module.dialog.showMessageBox.mock.calls.at(-1) as unknown[]).at(-1) as { message: string; detail: string };

  it("asks first, naming the real host and the full address, and opens only on Open", async () => {
    E.module.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    expect(await call("links.open", ["https://jobs.example.com/role?id=7"])).toBe(false);
    expect(lastPrompt().message).toContain("jobs.example.com");
    expect(lastPrompt().detail).toContain("https://jobs.example.com/role?id=7");
    expect(E.module.shell.openExternal).not.toHaveBeenCalled();

    E.module.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(await call("links.open", ["https://jobs.example.com/role?id=7"])).toBe(true);
    expect(E.module.shell.openExternal).toHaveBeenCalledWith("https://jobs.example.com/role?id=7");
  });

  it("never opens a non-https link or one with a user-info part", async () => {
    const { electronShell } = await import("../src/shell.js");
    const sh = electronShell(() => null, null);
    E.module.dialog.showMessageBox.mockClear();
    E.module.shell.openExternal.mockClear();
    for (const url of ["http://jobs.example.com/", "file:///etc/passwd", "javascript:alert(1)", "https://ok.example.com" + "@" + "evil.example/", "https://user:pw" + "@" + "evil.example/"]) {
      expect(await sh.openExternal(url), url).toBe(false);
    }
    expect(E.module.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(E.module.shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("IPC", () => {
  const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error; } throw new Error("expected a rejection"); };
  const onlyNameAndMessage = (e: Error) => {
    expect(e).toBeInstanceOf(Error);
    expect(Object.keys(e).filter((k) => k !== "name")).toEqual([]);
    for (const k of ["cause", "code", "errno", "path", "syscall"]) expect(e, k).not.toHaveProperty(k);
    expect(e.stack).toBe(`${e.name}: ${e.message}`);
    expect(String(e)).toBe(`${e.name}: ${e.message}`); // what Electron serialises for the renderer
  };

  it("blocks callers other than the app's own window and origin", async () => {
    const otherFrame = { url: "app://careeros/index.html" };
    const other = { sender: { send: vi.fn(), mainFrame: otherFrame }, senderFrame: otherFrame };
    const evil = { sender: win().webContents, senderFrame: { url: "https://evil.example.com/" } };
    // A subframe of the app's own page, even on the app origin, is not the main frame.
    const subframe = { sender: win().webContents, senderFrame: { url: "app://careeros/index.html" } };
    for (const ev of [other, evil, subframe, { sender: win().webContents, senderFrame: null }]) {
      const e = await caught(call("app.info", [], ev));
      expect(e.message).toBe("This request was blocked.");
      onlyNameAndMessage(e);
    }
  });

  it("forwards only name and message of a failure, never stack, cause or code", async () => {
    const arg = await caught(call("no.such.method", []));
    expect(arg.name).toBe("ArgError");
    onlyNameAndMessage(arg);

    const missing = path.join(os.tmpdir(), "careeros-fictional-missing", "CareerOS");
    const fsErr = await caught(call("workspace.open", [missing]));
    onlyNameAndMessage(fsErr);
    expect(fsErr.message).not.toContain(os.tmpdir());

    // Even an error from outside the services (no plainError) is reduced to name and message.
    vi.spyOn(runtime(), "dispatch").mockRejectedValueOnce(Object.assign(new Error(`failed at ${root}/x\nsecond line`, { cause: new Error("inner") }), { code: "EACCES" }));
    const raw = await caught(call("app.info", []));
    onlyNameAndMessage(raw);
    expect(raw.message).not.toContain("second line");
  });
});

describe("careeros-file: protocol", () => {
  beforeAll(async () => { await call("workspace.open", [root]); });

  const body = async (url: string, headers?: Record<string, string>) => { const r = await get(url, headers); return { status: r.status, text: await r.text() }; };

  it("serves workspace media, decoding each segment exactly once", async () => {
    expect(await body(fileUrlFor("learning/demo clip.png"))).toEqual({ status: 200, text: "clip-bytes" });
    // "%41.png" is encoded once to "%2541.png" and must decode to "%41.png", not to "A.png".
    expect(fileUrlFor("learning/%41.png")).toBe("careeros-file://ws/learning/%2541.png");
    expect(await body(fileUrlFor("learning/%41.png"))).toEqual({ status: 200, text: "percent-name" });
  });

  it("marks served media as not cacheable", async () => {
    const r = await get(fileUrlFor("learning/demo clip.png"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 404, not a crash, when the file vanishes between the check and the open", async () => {
    const vanish = path.join(root, "learning", "vanish.png");
    fs.writeFileSync(vanish, "soon gone");
    const rt = runtime();
    const real = rt.resolveMedia.bind(rt);
    vi.spyOn(rt, "resolveMedia").mockImplementationOnce((rel) => { const c = real(rel); fs.rmSync(c.real); return c; });
    expect((await get(fileUrlFor("learning/vanish.png"))).status).toBe(404);
  });

  it("refuses a file swapped for a symlink between the check and the open", async () => {
    const swap = path.join(root, "learning", "swap.png");
    fs.writeFileSync(swap, "harmless");
    const rt = runtime();
    const real = rt.resolveMedia.bind(rt);
    vi.spyOn(rt, "resolveMedia").mockImplementationOnce((rel) => {
      const c = real(rel);
      fs.rmSync(swap);
      fs.symlinkSync(path.join(root, "me", "identity", "passport-scan.png"), swap);
      return c;
    });
    expect((await get(fileUrlFor("learning/swap.png"))).status).toBe(403);
  });

  it("answers a Range with 206 so video can seek, and 416 past the end", async () => {
    const r = await get(fileUrlFor("learning/demo clip.png"), { Range: "bytes=0-3" });
    expect(r.status).toBe(206);
    expect(r.headers.get("Content-Range")).toBe("bytes 0-3/10");
    expect(r.headers.get("Accept-Ranges")).toBe("bytes");
    expect(r.headers.get("Content-Type")).toBe("image/png");
    expect(await r.text()).toBe("clip");
    const past = await get(fileUrlFor("learning/demo clip.png"), { Range: "bytes=50-" });
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("refuses tricks in the URL before touching the disk", async () => {
    const before = opened.length;
    for (const url of [
      "careeros-file://ws/learning/..%2Fme%2Fidentity%2Fpassport-scan.png", // encoded slash
      "careeros-file://ws/learning%5C..%5Cme%5Cidentity%5Cpassport-scan.png", // encoded backslash
      "careeros-file://ws/%2Fetc%2Fpasswd", // absolute, encoded
      "careeros-file://ws/C:/Windows/win.ini", // drive letter
      "careeros-file://ws/learning/demo%0Aclip.png", "careeros-file://ws/learning/demo%00clip.png", "careeros-file://ws/learning/demo%7Fclip.png",
      "careeros-file://ws/learning//demo%20clip.png", // empty segment
      "careeros-file://ws/learning/%2E%2E%2F%2E%2E%2Fsettings", "careeros-file://ws/learning/%E0%A4%A",
      "careeros-file://other/learning/demo%20clip.png", "careeros-file://ws:8080/learning/demo%20clip.png", "careeros-file://alex@ws/learning/demo%20clip.png",
    ]) {
      expect((await get(url)).status, url).toBe(404);
    }
    expect(opened.length).toBe(before);
  });

  it("serves nothing outside the workspace, from a locked folder, or that isn't media", async () => {
    const before = opened.length;
    for (const rel of [
      "me/identity/passport-scan.png", // locked
      "learning/sneaky.png", // symlink into the locked folder
      "learning/escape.png", // symlink out of the workspace
      "learning/hardlink.png", // hard link to a locked scan
      "learning/notes.txt", // not media
      "learning/missing.png",
    ]) {
      expect((await get(fileUrlFor(rel))).status, rel).toBe(403);
    }
    // A dot-dot that the URL parser resolves still lands on a checked path.
    expect((await get("careeros-file://ws/learning/%2e%2e/me/identity/passport-scan.png")).status).toBe(403);
    expect(opened.slice(before)).toEqual([]); // refused by the services check, before any open
  });

  it("serves a locked file only while an allow-once grant is active", async () => {
    const id = listAccessRequests(root).find((r) => r.status === "pending" && r.folder === "me/identity")!.id;
    await call("privacy.allow", [id, 15]);
    expect(await body(fileUrlFor("me/identity/passport-scan.png"))).toEqual({ status: 200, text: "fictional-scan" });
    // The symlink out of the workspace and the hard link stay refused even then.
    expect((await get(fileUrlFor("learning/escape.png"))).status).toBe(403);
    expect((await get(fileUrlFor("learning/hardlink.png"))).status).toBe(403);
    await call("privacy.revoke", ["me/identity"]);
    expect((await get(fileUrlFor("me/identity/passport-scan.png"))).status).toBe(403);
  });
});

describe("sleep and wake", () => {
  it("re-checks grants when the computer resumes", () => {
    const check = vi.mocked(runtime().checkGrants);
    check.mockClear();
    E.module.powerMonitor.emit("resume");
    expect(check).toHaveBeenCalledTimes(1);
    expect(E.createRuntime).toHaveBeenCalledTimes(1);
  });
});

describe("saved views (jobs.saveView through the shell)", () => {
  it("replaces a view with the same name silently: one entry, the newer query wins", async () => {
    await call("jobs.saveView", ["Remote roles", { text: "engineer" }]);
    const after = (await call("jobs.saveView", ["Remote roles", { text: "designer" }])) as { name: string; query: { text?: string } }[];
    const same = after.filter((v) => v.name === "Remote roles");
    expect(same).toHaveLength(1);
    expect(same[0]!.query.text).toBe("designer");
  });
});

// Lane E (read aloud): careeros-file://tts/ goes through the services' exact-name check, then the same serve path.
describe("careeros-file://tts/ read-aloud audio", () => {
  beforeAll(async () => { await call("workspace.open", [root]); });
  it("serves a cached WAV as audio and refuses anything else under tts", async () => {
    const dir = path.join(root, ".careeros", "cache", "tts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${"b".repeat(64)}.wav`), "RIFF-fictional");
    const ok = await get(`careeros-file://tts/${"b".repeat(64)}.wav`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("audio/wav");
    expect(await ok.text()).toBe("RIFF-fictional");
    expect((await get(`careeros-file://tts/${"9".repeat(64)}.wav`)).status).toBe(403);
    expect((await get("careeros-file://tts/..%2Fworkspace.json")).status).toBe(404);
    // A ws/ path still can't reach the hidden cache folder.
    expect((await get(`careeros-file://ws/.careeros/cache/tts/${"b".repeat(64)}.wav`)).status).toBe(403);
  });
});

describe("mail: the careeros-mail: scheme, the email frame, wake and background hand-off", () => {
  const frameEvent = (url: string, isMainFrame = false) => ({ url, isMainFrame, preventDefault: vi.fn() });
  function contents() {
    const em = E.emitter();
    E.module.app.emit("web-contents-created", {}, { ...em, setWindowOpenHandler: () => undefined });
    return em;
  }

  it("registers careeros-mail as standard and secure only (no fetch, CORS or streaming)", () => {
    const schemes = E.module.protocol.registerSchemesAsPrivileged.mock.calls[0]![0] as { scheme: string; privileges: object }[];
    expect(schemes.find((x) => x.scheme === "careeros-mail")).toEqual({ scheme: "careeros-mail", privileges: { standard: true, secure: true } });
  });

  it("answers every careeros-mail: request through the services' resolveMailAsset", async () => {
    const spy = vi.spyOn(runtime(), "resolveMailAsset");
    const res = await (E.protocols.get("careeros-mail")!({ url: "careeros-mail://msg/nothing-here", headers: new Headers() }) as Promise<Response>);
    expect(spy).toHaveBeenCalledWith("careeros-mail://msg/nothing-here");
    expect(res.status).toBe(404);
    spy.mockRestore();
  });

  it("lets the email frame load stored messages only, and turns a link click into the link dialog", () => {
    const c = contents();
    const spy = vi.spyOn(runtime(), "resolveMailAsset");
    const ok = frameEvent("careeros-mail://msg/abc");
    c.emit("will-frame-navigate", ok);
    expect(ok.preventDefault).not.toHaveBeenCalled();
    const link = frameEvent("careeros-mail://link/abc/0");
    c.emit("will-frame-navigate", link);
    expect(link.preventDefault).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith("careeros-mail://link/abc/0");
    for (const u of ["https://jobs.example.com/", "careeros-mail://img/abc/0", "about:blank"]) {
      const e = frameEvent(u);
      c.emit("will-frame-navigate", e);
      expect(e.preventDefault, u).toHaveBeenCalled();
    }
    // The main frame is will-navigate's job (always blocked); this handler leaves it alone.
    const main = frameEvent("careeros-mail://msg/abc", true);
    c.emit("will-frame-navigate", main);
    expect(main.preventDefault).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("syncs mail soon when the computer wakes", () => {
    const spy = vi.spyOn(runtime(), "syncMailSoon");
    E.module.powerMonitor.emit("resume");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("a background run for the open workspace syncs soon; one for another workspace runs headless and never touches the window", async () => {
    await call("workspace.open", [root]);
    const open = runtime().ctx.root!;
    const soon = vi.spyOn(runtime(), "syncMailSoon");
    const focus = (win() as unknown as { focus: ReturnType<typeof vi.fn> }).focus;
    focus.mockClear();
    E.module.app.emit("second-instance", {}, [], "/", { syncMail: true, workspace: open });
    expect(soon).toHaveBeenCalledTimes(1);
    E.module.app.emit("second-instance", {}, [], "/", { syncMail: true, workspace: path.resolve("/fictional/other/CareerOS") });
    expect(soon).toHaveBeenCalledTimes(1);
    const log = path.join(E.state.userData, "logs", "mail-sync.log");
    await vi.waitFor(() => expect(fs.existsSync(log) && fs.readFileSync(log, "utf8")).toMatch(/background sync folder isn't a .* workspace/));
    expect(fs.readFileSync(log, "utf8")).not.toContain("/fictional");
    expect(focus).not.toHaveBeenCalled();
    // Without hand-off data it is a person opening the app again: the window comes forward.
    E.module.app.emit("second-instance", {}, [], "/", {});
    expect(focus).toHaveBeenCalled();
    soon.mockRestore();
  });
});
