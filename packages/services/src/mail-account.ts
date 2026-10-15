import { isEmailAddress, layout, logActivity, readMeta, readRecord, updateRecord, type MailSettings } from "@careeros/core";
import { listTriage, rawBytes, readMailState, type BackgroundScheduler, type MailAccount } from "@careeros/mail";
import type { MailStatus, MailTestResult, SecretStatus } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import type { MailHost } from "./host.js";
import { secretKey, workspaceSecretsAt, type WorkspaceSecrets } from "./secrets.js";
import { workspaceIdOf } from "./workspace-registry.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

const STAGE_MS = 10 * 60_000;
const WORKSPACE_CHANGED = "The workspace changed while the password was being tested. Try again.";
const LABELS = { imap: "Sign in to Gmail", sent: "Find the Sent folder", smtp: "Sign in to send" } as const;
/** A tested password waiting for Save, per window and workspace: a test in one workspace can never be saved into another. */
const staged = new WeakMap<ServiceContext, Map<string, { address: string; password: string; until: number }>>();
/** Every window's staging map, so Disconnect in one window clears a tested password in all of them at once. */
const allStaged = new Set<WeakRef<Map<string, { address: string; password: string; until: number }>>>();
const stagedIn = (ctx: ServiceContext) => {
  let m = staged.get(ctx);
  if (!m) { m = new Map(); staged.set(ctx, m); allStaged.add(new WeakRef(m)); }
  return m;
};
/** Forgets a tested, not yet saved password for `root` in every window. */
export function clearStagedEverywhere(root: string): void {
  for (const ref of allStaged) {
    const m = ref.deref();
    if (m) m.delete(root); else allStaged.delete(ref);
  }
}

/** The Gmail password lives in the workspace's own secrets (`ws.<workspace_id>.gmail_app_password`). */
export function mailSecrets(ctx: ServiceContext, root: string = ctx.requireRoot()): WorkspaceSecrets {
  return workspaceSecretsAt(ctx, root);
}
const hasPassword = (ctx: ServiceContext, root: string): boolean => { try { return mailSecrets(ctx, root).has("gmail_app_password"); } catch { return false; } };

export interface SyncInfo { syncing: boolean; next: string }
const infos = new WeakMap<ServiceContext, Map<string, SyncInfo>>();
/**
 * Sync state for one workspace in one window (fix round 1): keyed by root, so a sync still running
 * for workspace A never shows as "syncing" on workspace B after a switch. No root: an idle,
 * throwaway state (nothing is open, so nothing is syncing or scheduled).
 */
export function syncInfo(ctx: ServiceContext, root: string | null = ctx.root): SyncInfo {
  if (!root) return { syncing: false, next: "" };
  let byRoot = infos.get(ctx);
  if (!byRoot) { byRoot = new Map(); infos.set(ctx, byRoot); }
  let i = byRoot.get(root);
  if (!i) { i = { syncing: false, next: "" }; byRoot.set(root, i); }
  return i;
}
/** Called after an account is saved. Task 16 registers "sync soon" here. */
export const accountHooks = new WeakMap<ServiceContext, () => void>();

/** This workspace's own OS schedule (null when the shell has none or the workspace has no id). */
export function schedulerFor(ctx: ServiceContext, root: string): BackgroundScheduler | null {
  const id = workspaceIdOf(root);
  return ctx.host.scheduler && id ? ctx.host.scheduler(id) : null;
}

/** This workspace's id, for the per-workspace lock and log in user data. */
export function mailWorkspaceId(root: string): string {
  const id = workspaceIdOf(root);
  if (!id) throw new Error("This workspace has no id yet. Open it again, then try again.");
  return id;
}

export function mailHost(ctx: ServiceContext): MailHost {
  if (!ctx.host.mail) throw new Error("Email isn't available in this version of the app.");
  return ctx.host.mail;
}

export function mailSettings(root: string): MailSettings {
  return readRecord("integrations", layout(root).integrations).mail;
}

/**
 * Google shows an app password as four groups of four letters. Accept exactly that (one space,
 * or none, between groups), so a normal password that happens to have 16 letters once its
 * spaces are removed ("my normal password") is still refused before any connection.
 */
export function normalizePassword(p: string): string {
  const t = p.trim();
  if (!/^[A-Za-z]{4}(?:[ \u00a0]?[A-Za-z]{4}){3}$/.test(t)) throw new Error("An app password is 16 letters. Copy it again from Google's App Passwords page.");
  return t.replace(/[ \u00a0]/g, "").toLowerCase();
}

function cleanAddress(address: string): string {
  const a = address.trim();
  if (!isEmailAddress(a)) throw new Error(`"${a.slice(0, 80)}" isn't an email address.`);
  return a;
}

function cleanName(name: string): string {
  if (/[\r\n\x00-\x1f\x7f"\\<>]/.test(name)) throw new Error("Your name must be one line without quotes or angle brackets.");
  return name.trim().slice(0, 100);
}

export function currentAccount(ctx: ServiceContext, root: string = ctx.requireRoot()): MailAccount | null {
  const m = mailSettings(root);
  const password = m.address ? mailSecrets(ctx, root).get("gmail_app_password") : null;
  return m.address && password ? { address: m.address, password, displayName: m.display_name } : null;
}

export function cloudFolderName(p: string): string {
  const s = p.replace(/\\/g, "/");
  if (/\/Library\/Mobile Documents\//.test(s) || /\/iCloud ?Drive(\/|$)/i.test(s)) return "iCloud Drive";
  if (/\/Library\/CloudStorage\/GoogleDrive/i.test(s) || /\/(Google Drive|GoogleDrive|My Drive)(\/|$)/i.test(s)) return "Google Drive";
  if (/\/Library\/CloudStorage\/OneDrive/i.test(s) || /\/OneDrive( - [^/]+)?(\/|$)/i.test(s)) return "OneDrive";
  if (/\/Library\/CloudStorage\/Dropbox/i.test(s) || /\/Dropbox( \([^/]+\))?(\/|$)/i.test(s)) return "Dropbox";
  return "";
}

/** The example workspace: its mail is made up and shown without Gmail (nothing syncs or sends there). */
export function isExampleMail(root: string): boolean {
  try { return readMeta(root).is_sample === true; } catch { return false; }
}

/** Gmail is usable: this app has mail support, an address is saved and its password is in secure storage. */
export function mailConnected(ctx: ServiceContext, root: string = ctx.requireRoot()): boolean {
  return !!ctx.host.mail && !!mailSettings(root).address && hasPassword(ctx, root);
}

export function mailStatus(ctx: ServiceContext): MailStatus {
  const root = ctx.requireRoot();
  const m = mailSettings(root);
  const st = readMailState(root);
  const info = syncInfo(ctx, root);
  const has = hasPassword(ctx, root);
  return {
    available: !!ctx.host.mail, connected: !!m.address && has, address: m.address, display_name: m.display_name, signature: m.signature,
    password_set: has, secure_storage: ctx.host.secrets.available(), syncing: info.syncing, last_sync: st.last_run, last_ok: st.last_ok,
    next_sync: info.next, last_error: st.last_error, counts: st.counts, purged: st.purged, sync_minutes: m.sync_minutes,
    first_sync_days: m.first_sync_days, send_limit_per_hour: m.send_limit_per_hour, cloud_folder: cloudFolderName(root),
    raw_bytes: rawBytes(root), triage_count: listTriage(root).length, example: isExampleMail(root),
  };
}

export async function testConnection(ctx: ServiceContext, address: string, displayName: string, password: string): Promise<MailTestResult> {
  const host = mailHost(ctx);
  // The workspace the test was asked for: a switch while Gmail answers must never stage it for another one.
  const root = ctx.requireRoot();
  const a = cleanAddress(address);
  const name = cleanName(displayName);
  const pw = normalizePassword(password);
  const checks = await host.provider({ address: a, password: pw, displayName: name }).test();
  const result: MailTestResult = { ok: checks.every((c) => c.ok), checks: checks.map((c) => ({ id: c.id, label: LABELS[c.id], ok: c.ok, message: c.message, fix: c.fix })) };
  if (ctx.root !== root) throw new Error(WORKSPACE_CHANGED);
  if (result.ok) stagedIn(ctx).set(root, { address: a.toLowerCase(), password: pw, until: ctx.now().getTime() + STAGE_MS });
  else stagedIn(ctx).delete(root);
  return result;
}

function takeStaged(ctx: ServiceContext, root: string, address: string): string {
  const s = stagedIn(ctx).get(root);
  if (!s || s.until < ctx.now().getTime() || s.address !== address.trim().toLowerCase()) {
    throw new Error(`Test the connection first. ${identity.name} saves the account only after a passing test.`);
  }
  if (!ctx.host.secrets.available()) throw new Error("Secure storage isn't available on this computer, so the password was not saved.");
  stagedIn(ctx).delete(root);
  return s.password;
}

export function saveAccount(ctx: ServiceContext, address: string, displayName: string): MailStatus {
  const root = ctx.requireRoot();
  const a = cleanAddress(address);
  const name = cleanName(displayName);
  const password = takeStaged(ctx, root, a);
  mailSecrets(ctx, root).set("gmail_app_password", password);
  updateRecord("integrations", layout(root).integrations, (i) => { i.mail.provider = "gmail"; i.mail.address = a; i.mail.display_name = name; });
  logActivity(root, "Email connected", a, ctx.clock());
  accountHooks.get(ctx)?.();
  return mailStatus(ctx);
}

/** secrets.set for the Gmail password: test against the connected address, keep the old password if the new one fails. */
export async function setGmailPassword(ctx: ServiceContext, value: string): Promise<SecretStatus> {
  const root = ctx.requireRoot();
  const m = mailSettings(root);
  if (!m.address) throw new Error("Connect Gmail in Settings > Email first.");
  const r = await testConnection(ctx, m.address, m.display_name, value);
  if (!r.ok) throw new Error(`The new password didn't work: ${r.checks.find((c) => !c.ok)?.message ?? "unknown problem"}`);
  // A switch during the test: the password is never saved into the workspace that is open now.
  if (ctx.root !== root) throw new Error(WORKSPACE_CHANGED);
  mailSecrets(ctx, root).set("gmail_app_password", takeStaged(ctx, root, m.address));
  return { name: "gmail_app_password", available: ctx.host.secrets.available(), set: true };
}

export async function disconnect(ctx: ServiceContext): Promise<MailStatus> {
  const root = ctx.requireRoot();
  const m = mailSettings(root);
  const wasConnected = !!m.address || m.background.on || hasPassword(ctx, root);
  // Order matters (fix round 1): stop background sync first, then remove the credential, then
  // clear the record. A throw at any step leaves no scheduled sync running without a password.
  // Always, not only when the record says it's on: a job can outlive its record (a failed write, a hand edit).
  // remove() is idempotent.
  const sched = schedulerFor(ctx, root);
  if (sched?.supported) await sched.remove();
  mailSecrets(ctx, root).remove("gmail_app_password");
  clearStagedEverywhere(root);
  updateRecord("integrations", layout(root).integrations, (i) => { i.mail.address = ""; i.mail.background.on = false; });
  if (wasConnected) logActivity(root, "Email disconnected", m.address, ctx.clock());
  return mailStatus(ctx);
}

/**
 * A workspace that went to the Trash: its saved Gmail password and its OS schedule go with it. `id` was read before
 * the folder moved. The password goes first (local and certain); the schedule's removal can still fail on the OS.
 */
export async function forgetMailFor(ctx: ServiceContext, id: string, root: string): Promise<void> {
  ctx.host.secrets.remove(secretKey(id, "gmail_app_password"));
  clearStagedEverywhere(root);
  const s = ctx.host.scheduler?.(id);
  if (s?.supported) await s.remove();
}

/** After Locate… found a moved workspace: a background sync that is on now runs it from its new place. */
export async function repointBackground(ctx: ServiceContext, root: string): Promise<void> {
  if (!ctx.host.mail) return;
  const s = schedulerFor(ctx, root);
  if (!s?.supported) return;
  const m = mailSettings(root);
  if (!m.background.on) return;
  await s.install({ ...ctx.host.mail.backgroundCommand(root), minutes: m.background.minutes });
}

export function setSignature(ctx: ServiceContext, text: string): MailStatus {
  const sig = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").slice(0, 2000);
  updateRecord("integrations", layout(ctx.requireRoot()).integrations, (i) => { i.mail.signature = sig; });
  return mailStatus(ctx);
}

export const mailAccountHandlers = {
  "mail.status": mailStatus,
  "mail.testConnection": testConnection,
  "mail.saveAccount": saveAccount,
  "mail.disconnect": disconnect,
  "mail.setSignature": setSignature,
} satisfies Partial<HandlerTable>;
