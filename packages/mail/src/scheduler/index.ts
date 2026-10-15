import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import nodeOs from "node:os";
import path from "node:path";
import { launchdPlist, SYSTEMD_UNIT, systemdService, systemdTimer, TASK_NAME, taskSchedulerXml, taskXmlBytes } from "./text.js";

export * from "./text.js";

export interface OsHost {
  platform: NodeJS.Platform; home: string; uid: number; tmpDir: string;
  writeFile(p: string, data: string | Buffer, opts?: { exclusive?: boolean }): void;
  removeFile(p: string): void;
  exists(p: string): boolean;
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}
export interface BackgroundScheduler {
  supported: boolean;
  status(): Promise<{ installed: boolean; detail: string }>;
  install(o: { program: string; args: string[]; minutes: number }): Promise<void>;
  remove(): Promise<void>;
}

export function nodeOsHost(): OsHost {
  return {
    platform: process.platform, home: nodeOs.homedir(), uid: process.getuid?.() ?? 0, tmpDir: nodeOs.tmpdir(),
    writeFile: (p, d, opts) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d, { mode: 0o644, flag: opts?.exclusive ? "wx" : "w" }); },
    removeFile: (p) => { fs.rmSync(p, { force: true }); },
    exists: (p) => fs.existsSync(p),
    run: (cmd, args) => new Promise((resolve) => {
      execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    }),
  };
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

// Alphanumeric, dot or hyphen, 1-100 characters, must start and end with an alphanumeric: no
// "/", "\", or leading/trailing/embedded "..", so it can never traverse out of the directory
// it's joined into (fix round 1, item 1).
const APP_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,98}[A-Za-z0-9])?$/;
function validateAppId(appId: string): void {
  if (appId.includes("..") || !APP_ID_RE.test(appId)) {
    throw new Error(`"${appId}" isn't a valid app id for a background schedule.`);
  }
}

// Defense in depth alongside validateAppId: even if the id check above were ever loosened or
// bypassed, this refuses to let the computed path land anywhere but directly inside `dir`.
function assertDirectlyInside(dir: string, file: string): void {
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(file);
  if (path.dirname(resolvedFile) !== resolvedDir) {
    throw new Error(`Refusing to write the background schedule outside ${dir}.`);
  }
}

// Removal is idempotent: "it's already gone" counts as success on every OS, matched by the
// known exit code or message each OS actually uses, not by swallowing every nonzero exit (fix
// round 1, item 2).
function isAlreadyRemoved(platform: NodeJS.Platform, r: { code: number; stdout: string; stderr: string }): boolean {
  const text = `${r.stdout}\n${r.stderr}`;
  if (platform === "darwin") return /No such process|Could not find specified service|service is not loaded/i.test(text);
  if (platform === "linux") return /does not exist|not loaded|no such file or directory/i.test(text);
  if (platform === "win32") return /cannot find the file specified|does not exist/i.test(text);
  return false;
}

// A workspace id (workspace.json's workspace_id): a lowercase UUID, so it can only ever add a plain suffix to a name.
const JOB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The OS schedule for background mail sync. With `workspaceId`, each workspace has its own job
 * (launchd label `<appId>.mailsync.<id>`, Task Scheduler "CareerOS Mail Sync <id>" (a fixed id), systemd
 * `careeros-mailsync-<id>`), so turning it on in one workspace never replaces or removes another's.
 */
export function createScheduler(os: OsHost, appId: string, workspaceId = ""): BackgroundScheduler {
  validateAppId(appId);
  if (workspaceId && !JOB_RE.test(workspaceId)) throw new Error("That workspace id can't name a background schedule.");
  const TASK = workspaceId ? `${TASK_NAME} ${workspaceId}` : TASK_NAME;
  const UNIT = workspaceId ? `${SYSTEMD_UNIT}-${workspaceId}` : SYSTEMD_UNIT;
  const join = os.platform === "win32" ? path.win32.join : path.posix.join;
  if (os.platform === "darwin") {
    const label = workspaceId ? `${appId}.mailsync.${workspaceId}` : `${appId}.mailsync`;
    const dir = join(os.home, "Library", "LaunchAgents");
    const file = join(dir, `${label}.plist`);
    assertDirectlyInside(dir, file);
    const domain = `gui/${os.uid}`;
    return {
      supported: true,
      status: async () => {
        const r = await os.run("launchctl", ["print", `${domain}/${label}`]);
        if (r.code === 0) return { installed: true, detail: "Scheduled with launchd." };
        return { installed: false, detail: os.exists(file) ? "The schedule file exists, but macOS hasn't loaded it." : "Not scheduled." };
      },
      install: async (o) => {
        os.writeFile(file, launchdPlist({ label, ...o }));
        await os.run("launchctl", ["bootout", domain, file]);
        const r = await os.run("launchctl", ["bootstrap", domain, file]);
        if (r.code !== 0) throw new Error(`macOS didn't accept the background job: ${firstLine(r.stderr)}`);
      },
      remove: async () => {
        const r = await os.run("launchctl", ["bootout", domain, file]);
        os.removeFile(file);
        if (r.code !== 0 && !isAlreadyRemoved("darwin", r)) throw new Error(`macOS didn't accept removing the background job: ${firstLine(r.stderr)}`);
      },
    };
  }
  if (os.platform === "win32") {
    return {
      supported: true,
      status: async () => ((await os.run("schtasks", ["/Query", "/TN", TASK])).code === 0 ? { installed: true, detail: "Scheduled in Task Scheduler." } : { installed: false, detail: "Not scheduled." }),
      install: async (o) => {
        const tmp = join(os.tmpDir, `careeros-mailsync-${randomUUID()}.xml`);
        os.writeFile(tmp, taskXmlBytes(taskSchedulerXml({ label: TASK, ...o })), { exclusive: true });
        try {
          const r = await os.run("schtasks", ["/Create", "/TN", TASK, "/XML", tmp, "/F"]);
          if (r.code !== 0) throw new Error(`Windows didn't accept the background job: ${firstLine(r.stderr)}`);
        } finally { os.removeFile(tmp); }
      },
      remove: async () => {
        const r = await os.run("schtasks", ["/Delete", "/TN", TASK, "/F"]);
        if (r.code !== 0 && !isAlreadyRemoved("win32", r)) throw new Error(`Windows didn't accept removing the background job: ${firstLine(r.stderr)}`);
      },
    };
  }
  if (os.platform === "linux") {
    const dir = join(os.home, ".config", "systemd", "user");
    const service = join(dir, `${UNIT}.service`);
    const timer = join(dir, `${UNIT}.timer`);
    const ctl = (...args: string[]) => os.run("systemctl", ["--user", ...args]);
    return {
      supported: true,
      status: async () => {
        const r = await ctl("is-enabled", `${UNIT}.timer`);
        const said = r.stdout.trim();
        if (r.code === 0 && said === "enabled") return { installed: true, detail: "Scheduled with a systemd user timer." };
        return { installed: false, detail: os.exists(timer) ? `The schedule files exist, but systemd reports "${said || "unknown"}".` : "Not scheduled." };
      },
      install: async (o) => {
        const spec = { label: UNIT, ...o };
        os.writeFile(service, systemdService(spec));
        os.writeFile(timer, systemdTimer(spec));
        await ctl("daemon-reload");
        const r = await ctl("enable", "--now", `${UNIT}.timer`);
        if (r.code !== 0) throw new Error(`systemd didn't accept the background job: ${firstLine(r.stderr)}`);
      },
      remove: async () => {
        const r = await ctl("disable", "--now", `${UNIT}.timer`);
        os.removeFile(timer);
        os.removeFile(service);
        await ctl("daemon-reload");
        if (r.code !== 0 && !isAlreadyRemoved("linux", r)) throw new Error(`systemd didn't accept removing the background job: ${firstLine(r.stderr)}`);
      },
    };
  }
  const no = async (): Promise<never> => { throw new Error("Background sync isn't available on this system."); };
  return { supported: false, status: async () => ({ installed: false, detail: "Background sync isn't available on this system." }), install: no, remove: no };
}
