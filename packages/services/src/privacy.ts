import {
  allowAccessRequest, decideAccessRequest, expireGrants, grantIsHonoured, listAccessRequests, logActivity, nextGrantCheck, readAccessRequest, readActivity, readMeta, revokeGrant, setLocked, writeClaudeSettings,
} from "@careeros/core";
import type { LockableDir, PrivacyState } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { acceptLockedFolders, moveLockedFolderBack, verifyLockedFolders } from "./integrity.js";
import { requestView } from "./read.js";

const MAX_WAIT_MS = 60_000;
const timers = new WeakMap<ServiceContext, () => void>();

export function privacyState(ctx: ServiceContext): PrivacyState {
  const root = ctx.requireRoot();
  const meta = readMeta(root);
  const now = ctx.now().getTime();
  const problems = verifyLockedFolders(ctx, root); // first, so a new problem's log line is in this read's activity
  return {
    locked: meta.privacy.locked,
    grants: meta.privacy.grants.filter((g) => grantIsHonoured(root, g, now)).map(({ folder, until, request_id }) => ({ folder, until, request_id })),
    requests: listAccessRequests(root).map(requestView).reverse(),
    activity: readActivity(root, 50),
    problems,
  };
}

/** A plain log line: the error's code or name only, never its message, which may hold a path. */
function logPlain(what: string, e: unknown): void {
  const err = e as NodeJS.ErrnoException | undefined;
  console.error(`careeros: ${what} (${err?.code ?? err?.name ?? "unknown error"})`);
}

/**
 * Marks the allowed request behind a dropped grant as expired. A request that is already final is left alone.
 * A missing request file is fine (ENOENT, or core's "no request <id>"); anything else is logged.
 */
export function expireGrantRequest(ctx: ServiceContext, root: string, id: string): void {
  if (!id) return; // a grant with no request (hand-written, or dropped as malformed) has nothing to expire
  try {
    if (readAccessRequest(root, id).status === "allowed") decideAccessRequest(root, id, "expired", {}, ctx.clock());
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT" || (e as Error).message === `no request ${id}`;
    if (!missing) logPlain("couldn't mark an access request as expired", e);
  }
}

/**
 * Puts .claude/settings.json back when it no longer matches the lock state (someone edited or deleted it).
 * Compares first and writes only on a difference, so the watcher seeing our own write is a no-op. Never throws.
 */
export function restoreClaudeSettings(ctx: ServiceContext, root: string): boolean {
  try {
    if (!writeClaudeSettings(root, ctx.clock())) return false;
    logActivity(root, "Restored Claude privacy settings", "", ctx.clock());
    ctx.emit("privacy");
    return true;
  } catch (e) {
    logPlain("couldn't check Claude's privacy settings", e);
    return false;
  }
}

/** Ends every grant whose time is up. Returns how many ended. */
export function checkGrants(ctx: ServiceContext): number {
  const root = ctx.root;
  if (!root) return 0;
  const gone = expireGrants(root, ctx.clock());
  for (const g of gone) {
    logActivity(root, "Re-locked", `${g.folder} (time is up)`, ctx.clock());
    expireGrantRequest(ctx, root, g.request_id);
  }
  if (gone.length) ctx.emit("privacy", "home");
  verifyLockedFolders(ctx, root); // every grant tick also checks that the locked folders are still in place
  timers.get(ctx)?.();
  return gone.length;
}

/**
 * Keeps one timer per context aimed at the next grant end, re-armed at least every minute.
 * The timer never dies: a failed check or a failed read of the grants logs a plain line and retries in a minute.
 */
export function installGrantTimer(ctx: ServiceContext): void {
  if (timers.has(ctx)) return; // exactly one timer per context, however many callers install it
  let handle: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { if (handle) clearTimeout(handle); handle = undefined; };
  const schedule = (wait: number) => {
    handle = setTimeout(tick, wait);
    handle.unref?.();
  };
  // Never throws, so it is safe inside setRoot's open hook and inside checkGrants.
  const arm = () => {
    clear();
    const root = ctx.root;
    if (!root) return;
    let next: number | undefined;
    try {
      // Dead or malformed grants come back as "now", so the next tick drops them; nothing non-finite reaches setTimeout.
      next = nextGrantCheck(root, ctx.clock());
    } catch (e) {
      logPlain("couldn't read the privacy grants; checking again in a minute", e);
      schedule(MAX_WAIT_MS);
      return;
    }
    if (next === undefined || !Number.isFinite(next)) return;
    schedule(Math.min(Math.max(0, next - ctx.now().getTime()) + 250, MAX_WAIT_MS));
  };
  function tick() {
    handle = undefined;
    try {
      checkGrants(ctx); // re-arms on success
    } catch (e) {
      logPlain("couldn't re-lock expired grants; trying again in a minute", e);
      clear();
      if (ctx.root) schedule(MAX_WAIT_MS);
    }
  }
  timers.set(ctx, arm);
  ctx.onOpen(() => { arm(); return clear; });
}

const rearm = (ctx: ServiceContext) => timers.get(ctx)?.();

function allow(ctx: ServiceContext, id: string, minutes: number): PrivacyState {
  const root = ctx.requireRoot();
  const r = readAccessRequest(root, id);
  if (r.status !== "pending") throw new Error(`request ${id} is ${r.status}; it can't become allowed`);
  // One clock for the request and its grant, so the grant is backed. An unlocked folder gets no grant; the request is still allowed.
  allowAccessRequest(root, id, minutes, ctx.clock());
  logActivity(root, "Allowed once", `${r.folder} for ${minutes} minutes`, ctx.clock());
  rearm(ctx);
  return privacyState(ctx);
}

function deny(ctx: ServiceContext, id: string): PrivacyState {
  const root = ctx.requireRoot();
  const r = decideAccessRequest(root, id, "denied", {}, ctx.clock());
  logActivity(root, "Denied", r.folder, ctx.clock());
  return privacyState(ctx);
}

function revoke(ctx: ServiceContext, folder: LockableDir): PrivacyState {
  const root = ctx.requireRoot();
  const ids = readMeta(root).privacy.grants.filter((g) => g.folder === folder).map((g) => g.request_id);
  if (revokeGrant(root, folder, ctx.clock())) {
    for (const id of ids) expireGrantRequest(ctx, root, id);
    logActivity(root, "Re-locked", folder, ctx.clock());
  }
  rearm(ctx);
  return privacyState(ctx);
}

function lock(ctx: ServiceContext, folder: LockableDir, locked: boolean): PrivacyState {
  const root = ctx.requireRoot();
  // setLocked ends any grant on the folder either way, so the requests behind those grants end too.
  const ids = readMeta(root).privacy.grants.filter((g) => g.folder === folder).map((g) => g.request_id);
  setLocked(root, folder, locked, ctx.clock());
  for (const id of ids) expireGrantRequest(ctx, root, id);
  logActivity(root, locked ? "Locked" : "Unlocked", folder, ctx.clock());
  rearm(ctx);
  return privacyState(ctx);
}

function acceptFolders(ctx: ServiceContext): PrivacyState {
  acceptLockedFolders(ctx);
  return privacyState(ctx);
}

export const privacyHandlers = {
  "privacy.get": privacyState,
  "privacy.setLocked": lock,
  "privacy.allow": allow,
  "privacy.deny": deny,
  "privacy.revoke": revoke,
  "privacy.acceptFolders": acceptFolders,
  "privacy.moveBack": (ctx: ServiceContext, folder: LockableDir) => { moveLockedFolderBack(ctx, folder); return privacyState(ctx); },
} satisfies Partial<HandlerTable>;
