import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, powerMonitor, protocol, safeStorage, session } from "electron";
import { identity } from "@careeros/brand/identity";
import { createScheduler, fakeProviderFromFile, GMAIL_HOSTS, nodeOsHost, type BackgroundScheduler, type Fetcher, type MailProvider } from "@careeros/mail";
import { createRuntime, isSafeLink, memorySecrets, runBackgroundSync, type Host, type Runtime } from "@careeros/services";
import { backgroundCommandFor, backgroundHandoff, isBackgroundHandoff, isPersonOpening, parseBackgroundArgs, relaunchArgs, type BackgroundHandoff } from "./background.js";
import { appMenuTemplate, builtIcon, storageKeys } from "./app-identity.js";
import { CALL, CHANGE } from "./channels.js";
import { e2eHome, e2eIpcLog, e2eMail, e2eMemorySecrets, e2ePicks, e2eScheduler, e2eUserData } from "./e2e.js";
import { electronMailHost, remoteImageFetcher } from "./mail-host.js";
import { serveMediaFile, type MediaCheck } from "./media.js";
import { GUIDE_TYPES, guidesDir, guideUrlToName, resolveGuide } from "./guide-media.js";
import { electronPrinter } from "./printer.js";
import { safeStorageSecrets } from "./secret-store.js";
import { APP_ORIGIN, appFileFor, contentType, CSP, devUrlFrom, fileUrlToRel, frameNavigation, isTrustedSender, rendererError } from "./security.js";
import { electronShell } from "./shell.js";
import { electronClaudeHost, pluginRootEnv } from "./claude-host.js";
import { electronChromeHost, installQuitDetach } from "./chrome-host.js";
import { accountFullName, sampleDirFor } from "./onboarding-host.js";
import { ttsUrlToName } from "./tts-media.js";
import { fileStateStore } from "./state-store.js";
import { electronVideoHost } from "./video-host.js";
import { electronSetupHost } from "./setup-host.js";
import { createUpdates, updatesSupported, type Updates } from "./updates.js";

/** The OS schedule's id prefix: each workspace's background mail sync is `app.careeros.mailsync.<workspace_id>`. */
export const APP_ID = "app.careeros";
const HERE = import.meta.dirname;
const RENDERER = path.join(HERE, "renderer");
const PRELOAD = path.join(HERE, "preload.cjs");
// Rendered from packages/brand/assets/app-icon.svg by the brand icons script; the build copies it here
// when it could render it (otherwise Electron's own icon shows).
const ICON = builtIcon(path.join(HERE, "app-icon-1024.png"));
// Storage is keyed on the fixed internal id, never the display name: the process name names the macOS
// Keychain safeStorage entry, and userData holds secrets.json and state.json. A product rename must not
// orphan them. The display name goes only to presentation APIs (window title, About panel, menu labels).
// The Dock label comes from the running bundle's Info.plist: electron-builder writes the product name into
// the packaged app, and `npm run start` / `dev` on macOS run a product-named copy of Electron.app (scripts/dev-app.mjs).
const devUrl = devUrlFrom(process.env, app.isPackaged);
const pluginRoot = pluginRootEnv(process.env, { packaged: app.isPackaged, resourcesPath: process.resourcesPath, here: HERE });
if (pluginRoot) process.env.CAREEROS_PLUGIN_ROOT = pluginRoot;
const keys = storageKeys(identity.internalId, app.getPath("appData"), e2eUserData(process.env, app.isPackaged));
app.setName(keys.appName);
app.setPath("userData", keys.userData);
app.setAboutPanelOptions({ applicationName: identity.name, applicationVersion: app.getVersion() });
const background = parseBackgroundArgs(process.argv);
const e2eMailHook = e2eMail(process.env, app.isPackaged);
const ipcLog = e2eIpcLog(process.env, app.isPackaged);
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "careeros-file", privileges: { standard: true, secure: true, stream: true } },
  // Only the sandboxed email frame loads this scheme; no fetch, no CORS, no streaming.
  { scheme: "careeros-mail", privileges: { standard: true, secure: true } },
]);
app.enableSandbox();

let win: BrowserWindow | null = null;
let runtime: Runtime | null = null;
/** In-app updates (updates.ts): made for the window run only, never for --background-sync. */
let updates: Updates | undefined;

const notFound = () => new Response("Not found", { status: 404 });

async function serveApp(req: Request): Promise<Response> {
  const file = appFileFor(RENDERER, req.url);
  if (!file) return notFound();
  let res: Response;
  try { res = await net.fetch(pathToFileURL(file).toString()); } catch { return notFound(); }
  if (!res.ok) return notFound();
  return new Response(res.body, { status: 200, headers: { "Content-Type": contentType(file), "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" } });
}

// careeros-file://ws/<rel>: fileUrlToRel decodes once and refuses separators, dots, control characters and absolute
// paths; resolveMedia then real-path checks the workspace boundary, the folder locks (and grants) and the file kind,
// and pins the file by dev/ino; serveMediaFile opens it without following links, confirms dev/ino and streams it
// with single-range support (206/416).
async function serveFile(req: Request): Promise<Response> {
  const tts = ttsUrlToName(req.url); // read-aloud audio (Lane E): its own exact-name check, then the same serve path
  if (tts) { try { return serveMediaFile(runtime!.resolveTtsMedia(tts), req.headers.get("Range"), "audio/wav"); } catch { return new Response("Not available", { status: 403 }); } }
  const guide = guideUrlToName(req.url); // bundled guide videos: one plain name inside the app's own guides folder
  if (guide) {
    const check = resolveGuide(guidesDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, here: HERE }), guide);
    return check ? serveMediaFile(check, req.headers.get("Range"), GUIDE_TYPES[path.extname(guide)]) : notFound();
  }
  const rel = fileUrlToRel(req.url);
  if (!rel || !runtime) return notFound();
  let check: MediaCheck;
  try { check = runtime.resolveMedia(rel); } catch { return new Response("Not available", { status: 403 }); }
  return serveMediaFile(check, req.headers.get("Range"));
}

// careeros-mail://msg|img|link/...: every answer comes from the services (frame CSP, nosniff, no-store set there).
async function serveMail(req: Request): Promise<Response> {
  if (!runtime) return notFound();
  const r = await runtime.resolveMailAsset(req.url);
  const body = r.status === 204 ? null : typeof r.body === "string" ? r.body : new Uint8Array(r.body);
  return new Response(body, { status: r.status, headers: r.headers });
}

/** Remote images for "Load images": the guarded node fetcher (a fixed image in end-to-end runs). */
function imageFetcher(): Fetcher {
  if (e2eMailHook) return async () => new Response(PNG_1X1, { status: 200, headers: { "content-type": "image/png" } });
  return remoteImageFetcher();
}

/** A native "<ok> / Cancel" confirm for tools the app sets up (video tools, the Chrome helper). `ok` is "Install" unless given. */
async function confirmInstall(message: string, detail: string, ok = "Install"): Promise<boolean> {
  const opts = { type: "question" as const, buttons: [ok, "Cancel"], defaultId: 0, cancelId: 1, message, detail };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return response === 0;
}

/** Everything the services need from this shell. The background run uses the same host, with no window. */
function makeHost(): Host {
  const data = app.getPath("userData");
  const claude = electronClaudeHost({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, here: HERE });
  let sentCount = 0;
  const fake: MailProvider | null = e2eMailHook
    ? fakeProviderFromFile(e2eMailHook.fixture, (raw) => {
      fs.mkdirSync(e2eMailHook.sentDir, { recursive: true });
      fs.writeFileSync(path.join(e2eMailHook.sentDir, `${++sentCount}.eml`), raw);
    })
    : null;
  const allowedHosts = [...GMAIL_HOSTS];
  return {
    secrets: e2eMemorySecrets(process.env, app.isPackaged) ? memorySecrets(true) : safeStorageSecrets(path.join(data, "secrets.json"), safeStorage, process.platform),
    state: fileStateStore(path.join(data, "state.json")),
    shell: electronShell(() => win, e2ePicks(process.env, app.isPackaged)),
    info: { version: app.getVersion(), shell: "electron", platform: process.platform },
    printer: electronPrinter(),
    claude,
    // Videos: tools through @careeros/video's runner; the script writer runs on the Claude Code engine above (services
    // default), never a separate `claude`. Same plugin folder as the engine. Tool installs use the shipped setup runner,
    // after a native confirm.
    video: electronVideoHost({
      pluginRoot: claude.pluginDir, distDir: HERE, resourcesPath: process.resourcesPath, packaged: app.isPackaged,
      platform: process.platform, home: app.getPath("home"), env: process.env,
      confirm: (message, detail) => confirmInstall(message, detail),
    }),
    // Setup cards: Claude Code, Node.js, Python and ffmpeg, each after a native confirm naming the command. Never at launch.
    setup: electronSetupHost({
      packaged: app.isPackaged, resourcesPath: process.resourcesPath, here: HERE, platform: process.platform, home: app.getPath("home"), env: process.env,
      confirm: (message, detail) => confirmInstall(message, detail),
    }),
    // Search in my Chrome (lane S): the helper, our config and run folders live in the app's own data folder.
    chrome: electronChromeHost({ dataDir: path.join(data, "chrome-search"), confirm: (message, detail, ok) => confirmInstall(message, detail, ok) }),
    // "Add a job": applicant systems' public job data, over the same guarded https fetcher as mail images (none in e2e runs).
    jobFetch: e2eMailHook ? undefined : remoteImageFetcher(),
    // "Repeat this search": a notification when a scheduled search ends, and "Open at login" so schedules run.
    notify: (title, body) => { if (Notification.isSupported()) new Notification({ title, body, silent: false }).show(); },
    loginItem: process.platform === "darwin" || process.platform === "win32"
      ? { get: () => app.getLoginItemSettings().openAtLogin, set: (on) => app.setLoginItemSettings({ openAtLogin: on }) }
      : undefined,
    // Onboarding: "Get started" and the example go in the home folder, chosen here in main, never by the renderer.
    homeDir: e2eHome(process.env, app.isPackaged) ?? app.getPath("home"),
    userFullName: () => accountFullName(process.platform),
    sampleDir: sampleDirFor({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, here: HERE }),
    mail: electronMailHost({
      userData: data, fetcher: imageFetcher(), allowedHosts, provider: fake ? () => fake : undefined,
      background: (workspace) => backgroundCommandFor({ packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(), workspace }),
    }),
    // One OS job per workspace, named after its workspace_id. With the fake Gmail (end-to-end runs) it is kept in
    // memory, so no test ever queries or changes the machine's launchd, Task Scheduler or systemd.
    scheduler: fake ? (() => { const jobs = new Map<string, BackgroundScheduler>(); return (workspaceId: string) => jobs.get(workspaceId) ?? jobs.set(workspaceId, e2eScheduler()).get(workspaceId)!; })()
      : (workspaceId) => createScheduler(nodeOsHost(), APP_ID, workspaceId),
    net: { allowedHosts },
    updates,
  };
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 640, show: false, title: identity.name, icon: ICON,
    backgroundColor: "#0d0e11", // Graphite background (color.ink.900); avoids a white flash before the CSS loads.
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: !app.isPackaged },
  });
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => { win = null; });
  void win.loadURL(devUrl ?? `${APP_ORIGIN}/index.html`);
}

// Every web contents, now or later: no navigation, no new windows (https links go to the browser after a prompt), no webviews.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (e) => e.preventDefault());
  contents.on("will-redirect", (e) => e.preventDefault());
  contents.on("will-attach-webview", (e) => e.preventDefault());
  // The email frame: stored-message documents only; a link click opens the link dialog instead of navigating.
  contents.on("will-frame-navigate", (e) => {
    if (e.isMainFrame) return;
    const decision = frameNavigation(e.url, false);
    if (decision === "allow") return;
    e.preventDefault();
    if (decision === "link") void runtime?.resolveMailAsset(e.url).catch(() => undefined);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeLink(url)) {
      runtime?.ctx.host.shell.openExternal(url).catch((e: unknown) => {
        console.error(`careeros: couldn't open the link (${(e as { name?: unknown } | null)?.name ?? "unknown error"})`);
      });
    }
    return { action: "deny" };
  });
});

const handoff: BackgroundHandoff | undefined = background ? { syncMail: true, workspace: background.workspace } : undefined;
if (!app.requestSingleInstanceLock(handoff)) {
  // Another CareerOS is running. A background run has handed it its workspace through the lock's data.
  app.quit();
} else if (background) {
  // --background-sync: no window. One sync of that workspace, one log line, then exit.
  app.dock?.hide();
  // A person opening the app while this run holds the single-instance lock: their launch can't start, so this run
  // yields. It stops the sync cleanly (what was stored stays, the Gmail session closes) and starts the normal app
  // in its place. Another background run's hand-off is ignored here: its own schedule tries again.
  // On macOS, LaunchServices may reactivate this running bundle instead of starting a second process, so a Dock or
  // Finder click arrives as `activate` (or `open-file` / `open-url`). `activate` only counts once the run is under
  // way: macOS can fire one at the run's own launch, and that must not open a window.
  const stop = new AbortController();
  let yielding = false;
  let readyAt: number | null = null;
  const yieldToPerson = () => { if (yielding) return; yielding = true; stop.abort(); };
  app.on("second-instance", (_e, _argv, _cwd, data) => { if (!isBackgroundHandoff(data)) yieldToPerson(); });
  app.on("activate", () => { if (isPersonOpening("activate", readyAt, Date.now())) yieldToPerson(); });
  app.on("open-file", (e) => { e.preventDefault(); yieldToPerson(); });
  app.on("open-url", (e) => { e.preventDefault(); yieldToPerson(); });
  void app.whenReady().then(async () => {
    readyAt = Date.now();
    let code = 1;
    try { code = (await runBackgroundSync(makeHost(), background.workspace, { signal: stop.signal })).code; } catch { code = 1; }
    if (yielding) {
      app.relaunch({ args: relaunchArgs(process.argv.slice(1)) });
      app.exit(0);
      return;
    }
    app.exit(code);
  });
} else {
  app.on("second-instance", (_e, _argv, _cwd, data) => {
    // A scheduled run for the open workspace syncs it soon; for another workspace, it runs here without a window.
    const h = backgroundHandoff(data, runtime?.ctx.root ?? null);
    if (h.kind === "soon") { runtime?.syncMailSoon(); return; }
    if (h.kind === "headless") { if (runtime) void runBackgroundSync(runtime.ctx.host, h.workspace).catch(() => undefined); return; }
    if (data && typeof data === "object" && (data as { syncMail?: unknown }).syncMail !== undefined) return;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(() => {
    // Every permission is refused except full screen, which the video player's own button asks for. Email frames
    // are sandboxed without allowfullscreen, so they can't ask.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "fullscreen"));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on("will-download", (e) => e.preventDefault());
    protocol.handle("app", serveApp);
    protocol.handle("careeros-file", serveFile);
    protocol.handle("careeros-mail", serveMail);

    updates = createUpdates({
      supported: updatesSupported({ packaged: app.isPackaged, platform: process.platform, env: process.env }),
      auto: fileStateStore(path.join(app.getPath("userData"), "state.json")).read().autoUpdate !== false,
      load: async () => (await import("electron-updater")).autoUpdater,
      beforeInstall: () => quitDetach.beforeInstall(),
    });
    runtime = createRuntime(makeHost());
    runtime.onChange((e) => win?.webContents.send(CHANGE, e));

    // A failure reaches the renderer as name and message only: no stack, cause or code.
    ipcMain.handle(CALL, async (event, method: unknown, args: unknown) => {
      // Only the main frame of our own window, on our own origin (subframes and other windows are refused).
      const frame = event.senderFrame;
      if (!win || event.sender !== win.webContents || !frame || frame !== event.sender.mainFrame || !isTrustedSender(frame.url, devUrl)) {
        throw rendererError(new Error("This request was blocked."));
      }
      let reply: unknown;
      try { reply = await runtime!.dispatch(String(method), args); } catch (e) { throw rendererError(e); }
      if (ipcLog) { try { fs.appendFileSync(ipcLog, `${JSON.stringify({ method: String(method), reply: reply ?? null })}\n`); } catch { /* test log only */ } }
      return reply;
    });

    // A laptop that slept past a grant's end re-locks as soon as it wakes, and mail catches up (one sync soon;
    // missed intervals are not replayed). (createRuntime already installed the one grant timer for this context;
    // this only runs an extra check.)
    powerMonitor.on("resume", () => { runtime?.checkGrants(); runtime?.syncMailSoon(); });
    powerMonitor.on("unlock-screen", () => { runtime?.checkGrants(); });

    // Unpackaged runs show Electron's own icon in the Dock until told otherwise.
    if (process.platform === "darwin") {
      if (ICON) app.dock?.setIcon(ICON);
      Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(identity.name)));
    }
    createWindow();
    updates.start();
  });

  const quitDetach = installQuitDetach(app, () => runtime);
  app.on("window-all-closed", () => { app.quit(); });
}
