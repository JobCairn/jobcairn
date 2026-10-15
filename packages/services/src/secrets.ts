import { ArgError, isSafeHttpsUrl, SECRET_NAMES, type SecretName, type SecretStatus } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import type { SecretStore } from "./host.js";
import { setGmailPassword } from "./mail-account.js";
import { isWorkspaceId, workspaceIdOf } from "./workspace-registry.js";

/**
 * Secrets are kept per workspace, so two people sharing a computer (each with their own workspace) never see each
 * other's API key or mail password. The store key is "ws.<workspace id>.<name>"; the id is workspace.json's
 * `workspace_id`. A bare name is the older, unscoped form (moved to the first real workspace opened, once).
 */
export const secretKey = (workspaceId: string, name: SecretName): string => `ws.${workspaceId}.${name}`;
const KEY = new RegExp(`^(ws\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.)?(${SECRET_NAMES.join("|")})$`);
/** The only keys a secret store accepts (the Electron store checks every call with this). */
export const isSecretKey = (k: unknown): k is string => typeof k === "string" && KEY.test(k);

/** The open workspace's secrets. Mail and other features use this; values never travel to the renderer. */
export interface WorkspaceSecrets {
  available(): boolean;
  has(name: SecretName): boolean;
  get(name: SecretName): string | null;
  set(name: SecretName, value: string): void;
  remove(name: SecretName): void;
}

export function workspaceSecrets(ctx: ServiceContext): WorkspaceSecrets {
  return workspaceSecretsAt(ctx, ctx.requireRoot());
}

/** A given workspace's secrets (a sync that started in it reads its own password even after a switch). */
export function workspaceSecretsAt(ctx: ServiceContext, root: string): WorkspaceSecrets {
  const id = workspaceIdOf(root);
  if (!id) throw new Error("This workspace has no id yet. Open it again, then try again.");
  const s = ctx.host.secrets;
  return {
    available: () => s.available(),
    has: (n) => s.has(secretKey(id, n)),
    get: (n) => s.get(secretKey(id, n)),
    set: (n, v) => s.set(secretKey(id, n), v),
    remove: (n) => s.remove(secretKey(id, n)),
  };
}

/**
 * Moves secrets saved before they were kept per workspace into this workspace (called on open, never for the
 * example). Each moves once: the unscoped copy is removed, so a later workspace starts empty. An existing
 * scoped secret is never overwritten. Uses `store.move`, which relocates the already-encrypted value as-is -
 * so opening a workspace never decrypts or re-encrypts anything, and can't trigger the OS Keychain prompt at
 * launch. Runs even when `store.available()` is false: moving ciphertext needs no Keychain access.
 */
export function adoptUnscopedSecrets(store: SecretStore, workspaceId: string): void {
  if (!isWorkspaceId(workspaceId)) return;
  for (const name of SECRET_NAMES) {
    if (!store.has(name)) continue;
    const to = secretKey(workspaceId, name);
    if (store.has(to)) store.remove(name);
    else store.move(name, to);
  }
}

const NO_STORE = "Secure storage isn't available on this computer, so the secret was not saved.";
const NO_WORKSPACE = "Open a workspace first. Secrets are kept separately for each workspace.";
function scoped(ctx: ServiceContext): WorkspaceSecrets {
  if (!ctx.root) throw new Error(NO_WORKSPACE);
  if (!ctx.host.secrets.available()) throw new Error(NO_STORE);
  return workspaceSecrets(ctx);
}

const status = (ctx: ServiceContext, name: SecretName): SecretStatus => ({
  name, available: ctx.host.secrets.available(), set: ctx.root ? workspaceSecrets(ctx).has(name) : false,
});

export const secretHandlers = {
  "secrets.status": status,
  "secrets.set": async (ctx: ServiceContext, name: SecretName, value: string) => {
    // The Gmail password is only stored after it passes a live test (Settings > Email), in this workspace's secrets.
    if (name === "gmail_app_password") { scoped(ctx); return setGmailPassword(ctx, value); }
    scoped(ctx).set(name, value);
    return status(ctx, name);
  },
  "secrets.remove": (ctx: ServiceContext, name: SecretName) => {
    // Removing only the Gmail password would leave an address (and maybe background sync) without a credential.
    if (name === "gmail_app_password") throw new ArgError("Use Disconnect in Settings > Email to remove the Gmail app password.");
    scoped(ctx).remove(name);
    return status(ctx, name);
  },
} satisfies Partial<HandlerTable>;

/** Plain https links only: no other scheme, no user name or password, a real host. The
 * same rule @careeros/contract's isSafeHttpsUrl enforces and core's proposeApproval
 * duplicates - kept as one call here since services already depends on contract. */
export function isSafeLink(url: string): boolean {
  return isSafeHttpsUrl(url);
}

export const linkHandlers = {
  "links.open": async (ctx: ServiceContext, url: string) => {
    if (!isSafeLink(url)) return false;
    return ctx.host.shell.openExternal(new URL(url).href);
  },
  "claude.openDesktop": (ctx: ServiceContext) => ctx.host.shell.openClaudeDesktop(),
} satisfies Partial<HandlerTable>;
