// Loads the real main.ts as a `--background-sync` run against a fake `electron`, to check that a person opening the
// app while the run holds the single-instance lock is never turned away: the run stops and starts the normal app.
// On macOS that open can arrive as `second-instance`, or (LaunchServices reactivating the running bundle) as
// `activate` / `open-file` / `open-url`. The `activate` macOS fires at the run's own launch must not count.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type Fn = (...a: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

const E = vi.hoisted(() => {
  let listeners = new Map<string, Fn[]>();
  let ready!: () => void;
  let whenReady = new Promise<void>((r) => { ready = r; });
  const app = {
    isPackaged: false,
    on(ev: string, fn: Fn) { listeners.set(ev, [...(listeners.get(ev) ?? []), fn]); return app; },
    emit(ev: string, ...a: unknown[]) { for (const fn of listeners.get(ev) ?? []) fn(...a); },
    getPath: (() => "") as Fn, setPath: () => undefined, getVersion: () => "0.1.0", getAppPath: () => "/repo/packages/app-electron",
    setName: () => undefined, setAboutPanelOptions: () => undefined, dock: { hide: () => undefined, setIcon: () => undefined },
    enableSandbox: () => undefined, requestSingleInstanceLock: null as unknown as Fn, quit: null as unknown as Fn, exit: null as unknown as Fn, relaunch: null as unknown as Fn,
    whenReady: () => whenReady,
  };
  const module = {
    app, BrowserWindow: function BrowserWindow() { /* never created by a background run */ }, Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined }, ipcMain: { handle: () => undefined },
    net: { fetch: () => undefined }, powerMonitor: { on: () => undefined }, protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    session: { defaultSession: { on: () => undefined, setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined }, fromPartition: () => ({}) },
    dialog: { showMessageBox: () => undefined, showOpenDialog: () => undefined }, shell: { openExternal: () => undefined, showItemInFolder: () => undefined }, clipboard: { writeText: () => undefined },
  };
  return {
    module, app, ready: () => ready(),
    reset() { listeners = new Map(); whenReady = new Promise<void>((r) => { ready = r; }); },
  };
});
vi.mock("electron", () => ({ ...E.module, default: E.module }));

/** The sync itself: held until released or stopped, so events can arrive while it runs. */
const S = vi.hoisted(() => ({ release: null as null | (() => void), stopped: false, started: false }));
vi.mock("@careeros/services", async (orig) => ({
  ...(await orig<typeof import("@careeros/services")>()),
  runBackgroundSync: async (_h: unknown, _w: string, o: { signal?: AbortSignal } = {}) => {
    S.started = true;
    await new Promise<void>((resolve) => {
      S.release = resolve;
      o.signal?.addEventListener("abort", () => { S.stopped = true; resolve(); });
    });
    return { code: 0, line: "fictional" };
  },
}));

const userData = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-bg-")));
const WS = path.join(userData, "fictional-workspace");
const argv = process.argv;
afterAll(() => { process.argv = argv; fs.rmSync(userData, { recursive: true, force: true }); });

beforeEach(() => {
  E.reset();
  vi.resetModules();
  Object.assign(S, { release: null, stopped: false, started: false });
  E.app.getPath = () => userData;
  E.app.requestSingleInstanceLock = vi.fn(() => true);
  E.app.quit = vi.fn(); E.app.exit = vi.fn(); E.app.relaunch = vi.fn();
  process.argv = [argv[0]!, "/repo/packages/app-electron", "--background-sync", "--workspace", WS];
  process.env.CAREEROS_USER_DATA = userData;
});

async function start(): Promise<void> {
  await import("../src/main.js");
  expect(E.app.requestSingleInstanceLock).toHaveBeenCalledWith({ syncMail: true, workspace: WS });
}
const running = () => vi.waitFor(() => expect(S.started).toBe(true));
const yielded = async () => {
  await vi.waitFor(() => expect(E.app.exit).toHaveBeenCalled());
  expect(S.stopped).toBe(true);
  expect(E.app.relaunch).toHaveBeenCalledWith({ args: ["/repo/packages/app-electron"] });
  expect(E.app.exit).toHaveBeenCalledWith(0);
  expect(E.app.quit).not.toHaveBeenCalled();
};
const finishedAlone = async () => {
  S.release?.();
  await vi.waitFor(() => expect(E.app.exit).toHaveBeenCalledWith(0));
  expect(S.stopped).toBe(false);
  expect(E.app.relaunch).not.toHaveBeenCalled();
};

describe("a background run while the person opens the app", () => {
  it("second-instance: stops the run and starts the normal app; another background run's hand-off is ignored", async () => {
    await start();
    E.ready();
    await running();
    E.app.emit("second-instance", {}, [], "/", { syncMail: true, workspace: "/fictional/other" });
    expect(S.stopped).toBe(false);
    E.app.emit("second-instance", {}, [], "/", {});
    await yielded();
  });

  it("ignores the activate macOS fires at the run's own launch, and finishes with no window", async () => {
    await start();
    E.app.emit("activate", {}, false); // before ready
    E.ready();
    await running();
    E.app.emit("activate", {}, false); // just after ready: still the launch
    await finishedAlone();
  });

  it("macOS: a Dock or Finder click (activate, once the run is under way) stops it and opens the app", async () => {
    await start();
    E.ready();
    await running();
    await new Promise((r) => setTimeout(r, 1600));
    E.app.emit("activate", {}, false);
    await yielded();
  });

  it("macOS: opening a file or a link with the app stops the run and opens the app", async () => {
    await start();
    E.ready();
    await running();
    const e = { preventDefault: vi.fn() };
    E.app.emit("open-file", e, "/fictional/resume.pdf");
    expect(e.preventDefault).toHaveBeenCalled();
    await yielded();
  });
});
