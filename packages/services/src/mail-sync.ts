import fs from "node:fs";
import { layout, logActivity, refreshIndex, updateRecord } from "@careeros/core";
import { redact, syncMail, type MailAccount, type SyncResult } from "@careeros/mail";
import type { BackgroundStatus, MailStatus } from "@careeros/contract";
import { ServiceContext } from "./context.js";
import { reconcileSends } from "./mail-send.js";
import { plainError } from "./errors.js";
import type { HandlerTable } from "./handlers.js";
import type { Host } from "./host.js";
import { accountHooks, currentAccount, mailHost, mailSettings, mailStatus, mailWorkspaceId, schedulerFor, syncInfo } from "./mail-account.js";
import { workspaceIdOf } from "./workspace-registry.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

const NOT_CONNECTED = "Connect Gmail in Settings > Email first.";
const NO_SCHEDULER = "Background sync isn't available on this system.";
const MIN_MINUTES = 15;
const MAX_MINUTES = 24 * 60;
const soonTimers = new WeakMap<ServiceContext, { ms: number; handle?: ReturnType<typeof setTimeout> }>();
/**
 * The last sync queued or running per lock file (fix round 1). Each workspace has its own lock in
 * user data (keyed by workspace_id), so two workspaces' syncs never wait on each other; a second
 * run for the same workspace waits its turn here. Across processes the lock file still decides.
 */
const queues = new Map<string, Promise<unknown>>();
/** The running sync per window and workspace root: leaving the workspace stops it (and closes its Gmail session). */
const running = new WeakMap<ServiceContext, Map<string, AbortController>>();
const runningIn = (ctx: ServiceContext) => { let m = running.get(ctx); if (!m) { m = new Map(); running.set(ctx, m); } return m; };

/** What a log line must never hold: the password and the account address. */
const secretsOf = (account: MailAccount) => [account.password, account.address];

/** Counts and the error sentence only. The caller passes it through `redact` with the password. */
function summary(at: Date, r: SyncResult): string {
  const base = `${at.toISOString()} sync stored=${r.stored} sorted=${r.triaged} skipped=${r.skipped} duplicates=${r.duplicates} too_large=${r.too_large} capped=${r.capped ? "yes" : "no"}`;
  return r.error ? `${base} error=${r.error}` : base;
}

/** Folders whose index rows change when these stored emails appear (the emails and their job's timeline). */
function changedPaths(touched: string[]): string[] {
  const out = new Set<string>(touched);
  for (const ref of touched) {
    const m = ref.match(/^(companies\/[^/]+\/jobs\/[^/]+)\//);
    if (m) out.add(m[1]!);
  }
  return [...out];
}

/** One sync for an account: syncMail (whose lock keeps processes apart), the index, one redacted log line. */
async function syncOnce(root: string, host: Host, account: MailAccount, now: Date, signal?: AbortSignal): Promise<{ result: SyncResult; line: string }> {
  const mail = host.mail!;
  const id = mailWorkspaceId(root);
  const m = mailSettings(root);
  let r: SyncResult;
  try {
    r = await syncMail({ root, provider: mail.provider(account), account: account.address, now, firstSyncDays: m.first_sync_days, lockFile: mail.lockFile(id), signal });
  } catch (e) {
    // syncMail reports Gmail and workspace problems in its result; anything thrown here (the
    // lock folder in user data can't be written, say) still gets one plain, path-free log line.
    const err = plainError(e, [root]);
    mail.log(redact(`${now.toISOString()} sync error=${err.message}`, secretsOf(account)), id);
    throw err;
  }
  if (r.touched.length) { try { refreshIndex(root, changedPaths(r.touched)); } catch { /* the next read rebuilds the index */ } }
  // Sends whose outcome wasn't known: one now found in Sent is marked sent (Task 17 fix round 0).
  try { reconcileSends(root, now, { now }); } catch { /* tried again after the next sync */ }
  const line = redact(summary(now, r), secretsOf(account));
  mail.log(line, id);
  return { result: r, line };
}

/**
 * Runs one sync of the open workspace. Null when nothing ran: no account, or a sync of this
 * workspace is already queued or running in this process (a second request never starts
 * another). A sync of a different workspace that is still running is waited for, then this one
 * runs. Across processes the lock file in user data keeps runs apart, and the result carries
 * "A mail sync is already running.".
 */
export async function runSync(ctx: ServiceContext): Promise<SyncResult | null> {
  const root = ctx.requireRoot();
  const host = mailHost(ctx);
  const info = syncInfo(ctx, root);
  if (info.syncing) return null;
  const account = currentAccount(ctx);
  if (!account) return null;
  // No await between the check above and this flag, so two callers in one process can't both pass.
  info.syncing = true;
  ctx.emit("mail");
  const lock = host.lockFile(mailWorkspaceId(root));
  const stop = new AbortController();
  runningIn(ctx).set(root, stop);
  const before = queues.get(lock);
  const run = (async () => {
    if (before) await before.catch(() => undefined);
    return (await syncOnce(root, ctx.host, account, ctx.now(), stop.signal)).result;
  })();
  const tail = run.catch(() => undefined);
  queues.set(lock, tail);
  try {
    return await run;
  } finally {
    if (queues.get(lock) === tail) queues.delete(lock);
    if (runningIn(ctx).get(root) === stop) runningIn(ctx).delete(root);
    info.syncing = false;
    ctx.emit("mail", "jobs", "home");
  }
}

/** Debounced sync, after an account is saved or the computer wakes. Does nothing without a timer or workspace. */
export function syncMailSoon(ctx: ServiceContext): void {
  const t = soonTimers.get(ctx);
  if (!t || !ctx.root || !ctx.host.mail) return;
  if (t.handle) clearTimeout(t.handle);
  const root = ctx.root;
  t.handle = setTimeout(() => {
    t.handle = undefined;
    // A switch since the request cancels it (the closer clears the handle too; this is belt and braces).
    if (ctx.root === root) void runSync(ctx).catch(() => undefined);
  }, t.ms);
  t.handle.unref?.();
}

/** Syncs while a workspace is open: first after firstMs, then every sync_minutes (read again before each wait). */
export function installMailTimer(ctx: ServiceContext, opts: { firstMs?: number; soonMs?: number } = {}): void {
  if (!ctx.host.mail) return;
  soonTimers.set(ctx, { ms: opts.soonMs ?? 2000 });
  accountHooks.set(ctx, () => syncMailSoon(ctx));
  ctx.onOpen((root) => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const info = syncInfo(ctx, root);
    const arm = (ms: number) => {
      if (stopped) return;
      info.next = new Date(ctx.now().getTime() + ms).toISOString();
      handle = setTimeout(async () => {
        handle = undefined;
        if (stopped) return;
        try { if (ctx.root === root) await runSync(ctx); } catch { /* shown through last_error and the log */ }
        let minutes = 15;
        try { minutes = mailSettings(root).sync_minutes; } catch { /* keep the default */ }
        if (!Number.isFinite(minutes) || minutes < 1) minutes = 15;
        arm(minutes * 60_000);
      }, ms);
      handle.unref?.();
    };
    arm(opts.firstMs ?? 5000);
    return () => {
      stopped = true;
      if (handle) { clearTimeout(handle); handle = undefined; }
      // Leaving the workspace: its running sync stops and its Gmail session closes.
      runningIn(ctx).get(root)?.abort();
      const soon = soonTimers.get(ctx);
      if (soon?.handle) { clearTimeout(soon.handle); soon.handle = undefined; }
      info.next = "";
    };
  });
}

export async function syncNow(ctx: ServiceContext): Promise<MailStatus> {
  mailHost(ctx);
  if (!currentAccount(ctx)) throw new Error(NOT_CONNECTED);
  await runSync(ctx);
  return mailStatus(ctx);
}

export async function backgroundStatus(ctx: ServiceContext): Promise<BackgroundStatus> {
  const root = ctx.requireRoot();
  const m = mailSettings(root);
  const s = schedulerFor(ctx, root);
  let st: { installed: boolean; detail: string } = { installed: false, detail: NO_SCHEDULER };
  if (s?.supported) {
    try { st = await s.status(); }
    catch (e) { st = { installed: false, detail: plainError(e, [ctx.root]).message }; }
  }
  let log: string[] = [];
  try { log = ctx.host.mail?.readLog(mailWorkspaceId(root)).slice(-20) ?? []; } catch { /* no log yet */ }
  return { supported: !!s?.supported, on: m.background.on, minutes: m.background.minutes, installed: st.installed, detail: st.detail, log };
}

export async function setBackground(ctx: ServiceContext, on: boolean, minutes: number): Promise<BackgroundStatus> {
  const root = ctx.requireRoot();
  const host = mailHost(ctx);
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    throw new Error(`Choose a background sync interval between ${MIN_MINUTES} minutes and 24 hours.`);
  }
  const s = schedulerFor(ctx, root);
  if (on) {
    if (!currentAccount(ctx)) throw new Error(NOT_CONNECTED);
    if (!s?.supported) throw new Error(NO_SCHEDULER);
    await s.install({ ...host.backgroundCommand(root), minutes });
  } else if (s?.supported) {
    await s.remove();
  }
  updateRecord("integrations", layout(root).integrations, (i) => { i.mail.background = { on, minutes }; });
  logActivity(root, on ? "Background mail sync on" : "Background mail sync off", on ? `every ${minutes} minutes` : "", ctx.clock());
  return backgroundStatus(ctx);
}

/** The `--background-sync` run: no window, one log line, exit code 0 unless the workspace is unusable. */
/** `signal`: stops the run cleanly (the person opened the app while it ran; the app takes over). */
export async function runBackgroundSync(host: Host, workspace: string, opts: { signal?: AbortSignal } = {}): Promise<{ code: number; line: string }> {
  const ctx = new ServiceContext(host);
  const now = ctx.now();
  const at = now.toISOString();
  let id = "";
  const done = (code: number, text: string, secrets: string[] = []) => {
    const line = redact(`${at} ${text}`, secrets);
    try { host.mail?.log(line, id || undefined); } catch { /* the log is best effort */ }
    return { code, line };
  };
  if (!host.mail) return done(1, "Email isn't available in this version of the app.");
  let isWorkspace = false;
  try { isWorkspace = fs.existsSync(layout(workspace).workspaceFile); } catch { /* not a usable path */ }
  if (!isWorkspace) return done(1, `The background sync folder isn't a ${identity.name} workspace. Turn background sync off and on again in Settings > Email.`);
  // Plain field assignment, not setRoot: a headless run starts no timers or watchers.
  ctx.root = workspace;
  id = workspaceIdOf(workspace);
  // Its secrets, lock and log are keyed by the workspace id; one without an id hasn't been opened in the app yet.
  if (!id) return done(1, `The background sync folder hasn't been opened in ${identity.name} yet. Open it, then turn background sync on again.`);
  let m;
  try { m = mailSettings(workspace); } catch { return done(1, "The workspace settings can't be read."); }
  if (!m.background.on) return done(0, "Background sync is off. Nothing to do.");
  if (!m.address) return done(0, "Gmail isn't connected. Nothing to do.");
  // A locked store (a Mac before first unlock, Linux without a keyring) exits 0 so the OS doesn't retry in a loop.
  const LOCKED = `The password store is locked, so mail wasn't synced. ${identity.name} will try again next time.`;
  let account: MailAccount | null;
  try {
    if (!host.secrets.available()) return done(0, LOCKED);
    account = currentAccount(ctx);
  } catch { return done(0, LOCKED); }
  if (!account) return done(0, "The Gmail app password isn't saved. Connect Gmail again in Settings > Email.");
  try {
    return { code: 0, line: (await syncOnce(workspace, host, account, now, opts.signal)).line };
  } catch (e) {
    // syncOnce has already logged its one line.
    return { code: 1, line: redact(`${at} sync error=${plainError(e, [workspace]).message}`, secretsOf(account)) };
  }
}

export const mailSyncHandlers = {
  "mail.syncNow": syncNow,
  "mail.background.status": backgroundStatus,
  "mail.background.set": setBackground,
} satisfies Partial<HandlerTable>;
