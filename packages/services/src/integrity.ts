import fs from "node:fs";
import path from "node:path";
import {
  checkLockedFolders, folderId, insideRoot, LOCKED_DIRS, lockedFolderById, lockedFolderFor, lockedOrAll, logActivity, readMeta,
  safeChmod, scanForFolderId, type LockableDir, type LockIds, type LockProblem,
} from "@careeros/core";
import { LOCKED_FOLDER_NAMES, type LockProblemView } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

/*
 * Final review I4: a locked folder is protected by its path, so renaming or moving `me` (or a locked folder)
 * would quietly leave the files unprotected while the app still said "Locked". The app records each locked
 * folder's identity (dev:ino) while it is in place and checks it on open, on every grant tick, on watcher
 * events about `me` or a new top-level folder, and whenever the Privacy screen loads.
 *
 * The identities live in app state (userData), not in the workspace: the point is to notice what Claude did
 * to the workspace, and Claude can write .careeros/ through the CLI and Bash, but can't reach userData.
 */

/** Per context: the workspace and problem keys seen last time, so a change is announced and logged once. */
const lastProblems = new WeakMap<ServiceContext, { root: string; keys: Set<string> }>();

export function recordedLockIds(ctx: ServiceContext, root: string): LockIds {
  const v = ctx.host.state.read().lockIds?.[root];
  return v && typeof v === "object" ? v : {};
}

function saveLockIds(ctx: ServiceContext, root: string, ids: LockIds): void {
  const s = ctx.host.state.read();
  if (JSON.stringify(s.lockIds?.[root] ?? {}) === JSON.stringify(ids)) return;
  ctx.host.state.write({ ...s, lockIds: { ...s.lockIds, [root]: ids } });
}

/**
 * Earlier identities of each locked folder: folders that were locked, then moved, and replaced at the expected
 * path when the person accepted a new folder (final re-review R1). They stay locked by identity for as long as
 * they might exist, and are dropped only when a complete bounded search finds them gone.
 */
export type LockIdHistory = Partial<Record<LockableDir, string[]>>;

export function lockIdHistory(ctx: ServiceContext, root: string): LockIdHistory {
  const v = ctx.host.state.read().lockIdHistory?.[root];
  return v && typeof v === "object" ? v : {};
}

function saveHistory(ctx: ServiceContext, root: string, h: LockIdHistory): void {
  const clean: LockIdHistory = {};
  for (const [d, ids] of Object.entries(h) as [LockableDir, string[] | undefined][]) if (ids?.length) clean[d] = [...new Set(ids)];
  const s = ctx.host.state.read();
  if (JSON.stringify(s.lockIdHistory?.[root] ?? {}) === JSON.stringify(clean)) return;
  ctx.host.state.write({ ...s, lockIdHistory: { ...s.lockIdHistory, [root]: clean } });
}

function lockedList(root: string): readonly LockableDir[] {
  try { return readMeta(root).privacy.locked; } catch { return LOCKED_DIRS; } // unsure means locked
}

const toView = (p: LockProblem): LockProblemView => ({ folder: p.folder, kind: p.kind, found_at: p.foundAt });

/**
 * A locked folder that is missing and was never recorded is simply new to this app (a fresh clone, a folder git
 * didn't keep): create it owner-only, as a new workspace would. A recorded folder that went missing is not
 * recreated, because an empty stand-in would hide where the real one went.
 */
function createUnrecorded(root: string, locked: readonly LockableDir[], recorded: LockIds, problems: LockProblem[]): boolean {
  const fresh = problems.filter((p) => p.kind === "missing" && !recorded[p.folder] && locked.includes(p.folder));
  if (!fresh.length) return false;
  const me = path.join(root, "me");
  if (!fs.existsSync(me)) {
    // A missing `me` while any locked folder is recorded means it was moved: leave it for the person to see.
    if (locked.some((d) => recorded[d])) return false;
    fs.mkdirSync(me);
  }
  for (const p of fresh) {
    fs.mkdirSync(path.join(root, p.folder), { mode: 0o700 });
    safeChmod(path.join(root, p.folder), 0o700);
  }
  return true;
}

/**
 * Checks the locked folders, records the identity of each one that is in place, and keeps the old identity of
 * one that isn't (so it stays a problem until it comes back or the person accepts the new folder). Announces a
 * change in the problem list and logs each new problem once. Never throws: a failure to check is itself a problem.
 */
export function verifyLockedFolders(ctx: ServiceContext, root = ctx.root): LockProblemView[] {
  if (!root) return [];
  let views: LockProblemView[];
  try {
    const locked = lockedList(root);
    const recorded = recordedLockIds(ctx, root);
    let { problems, current } = checkLockedFolders(root, locked, recorded);
    if (createUnrecorded(root, locked, recorded, problems)) ({ problems, current } = checkLockedFolders(root, locked, recorded));
    const next: LockIds = {};
    for (const d of locked) {
      const id = recorded[d] ?? current[d]; // a recorded identity only changes when the person accepts the new folder
      if (id) next[d] = id;
    }
    saveLockIds(ctx, root, next);
    views = problems.map(toView);
    // Earlier identities: still locked wherever they are. One found in the top two levels stays a problem
    // ("elsewhere") until it is moved back; one a complete search can't find is gone and forgotten.
    const history = lockIdHistory(ctx, root);
    const kept: LockIdHistory = {};
    for (const d of locked) {
      for (const id of history[d] ?? []) {
        if (id === next[d]) continue; // moved back: it is the folder in place again
        const scan = scanForFolderId(root, id);
        if (scan.at) views.push({ folder: d, kind: "elsewhere", found_at: scan.at });
        if (scan.at || !scan.complete) (kept[d] ??= []).push(id);
      }
    }
    for (const d of LOCKED_DIRS) if (!locked.includes(d) && history[d]) kept[d] = history[d]; // unlocked now; keep for if it's locked again
    saveHistory(ctx, root, kept);
  } catch {
    views = LOCKED_DIRS.map((folder) => ({ folder, kind: "unreadable" as const, found_at: null }));
  }
  const keys = new Set(views.map((v) => `${v.folder}|${v.kind}|${v.found_at ?? ""}`));
  const before = lastProblems.get(ctx);
  const same = before?.root === root && before.keys.size === keys.size && [...keys].every((k) => before.keys.has(k));
  if (!same) {
    lastProblems.set(ctx, { root, keys });
    for (const v of views) {
      if (before?.root === root && before.keys.has(`${v.folder}|${v.kind}|${v.found_at ?? ""}`)) continue;
      if (v.kind === "elsewhere") continue; // the person already knows: they accepted a new folder
      try { logActivity(root, "Privacy check", `Your ${LOCKED_FOLDER_NAMES[v.folder as LockableDir].toLowerCase()} folder was moved or replaced`, ctx.clock()); } catch { /* best effort */ }
    }
    if (views.length || before?.keys.size) ctx.emit("privacy", "home");
  }
  return views;
}

/** Which locked area a file is in, by path (core's lockedFolderFor) or by recorded folder identity. */
export function lockedFor(ctx: ServiceContext, root: string, file: string): string | null {
  const byPath = lockedFolderFor(root, file, ctx.clock());
  if (byPath) return byPath;
  // Every identity a locked folder has had, not just the current one, so accepting a new folder never unlocks the old.
  const ids = recordedLockIds(ctx, root);
  const history = lockIdHistory(ctx, root);
  const live: Partial<Record<LockableDir, string[]>> = {};
  for (const d of lockedOrAll(root, ctx.clock())) live[d] = [...(ids[d] ? [ids[d]!] : []), ...(history[d] ?? [])];
  return lockedFolderById(root, file, live);
}

/**
 * The person's answer to a problem: lock the folders where they are now. Creates a missing locked folder
 * (owner-only) and records every locked folder's current identity. A link or a file in the way is refused.
 */
export function acceptLockedFolders(ctx: ServiceContext): LockProblemView[] {
  const root = ctx.requireRoot();
  const locked = lockedList(root);
  for (const d of ["me", ...locked]) {
    const p = path.join(root, d);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`${d} isn't a real folder. Move it out of the way first.`);
    if (!st) fs.mkdirSync(p, { mode: 0o700 });
    if (d !== "me") safeChmod(p, 0o700);
  }
  const { problems, current } = checkLockedFolders(root, locked, {});
  if (problems.length) throw new Error(`${problems[0]!.folder} still isn't a real folder.`);
  // The folders being replaced keep their lock: their identities move to the history, never away.
  const recorded = recordedLockIds(ctx, root);
  const history = lockIdHistory(ctx, root);
  for (const d of locked) {
    const old = recorded[d];
    if (old && old !== current[d]) history[d] = [...(history[d] ?? []), old];
  }
  saveHistory(ctx, root, history);
  saveLockIds(ctx, root, current);
  logActivity(root, "Locked folders accepted", locked.join(", "), ctx.clock());
  return verifyLockedFolders(ctx, root);
}

/** lstat that returns null for "not there" and throws anything else. */
function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

const IGNORABLE = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * "Move it back": renames a locked folder from where the check found it back to its expected path. Only a real
 * folder whose identity was recorded for this locked folder moves, only into an absent or empty real folder,
 * and never through a link. The identity stays recorded throughout, so the files are locked before and after.
 */
export function moveLockedFolderBack(ctx: ServiceContext, folder: LockableDir): LockProblemView[] {
  const root = ctx.requireRoot();
  if (!lockedList(root).includes(folder)) throw new Error(`${folder} isn't locked, so there's nothing to move back.`);
  const problem = verifyLockedFolders(ctx, root).find((p) => p.folder === folder && p.found_at);
  if (!problem?.found_at) throw new Error(`${identity.name} doesn't know where ${folder} went, so it can't move it back.`);
  const foundAt = problem.found_at;
  const from = path.join(root, foundAt);
  const to = path.join(root, folder);
  const recorded = recordedLockIds(ctx, root);
  const history = lockIdHistory(ctx, root);
  const known = [...(recorded[folder] ? [recorded[folder]!] : []), ...(history[folder] ?? [])];
  const id = folderId(from);
  if (!id || !known.includes(id) || !insideRoot(root, from)) throw new Error(`${foundAt} changed since ${identity.name} looked. Check Privacy again.`);
  if (to.startsWith(from + path.sep) || from.startsWith(to + path.sep)) throw new Error(`${foundAt} can't be moved into ${folder}.`);
  const me = path.join(root, "me");
  const meSt = lstatOrNull(me);
  if (meSt && (meSt.isSymbolicLink() || !meSt.isDirectory())) throw new Error("me isn't a real folder. Move it out of the way first.");
  const toSt = lstatOrNull(to);
  let removed: string | null = null;
  if (toSt) {
    if (toSt.isSymbolicLink() || !toSt.isDirectory()) throw new Error(`Something that isn't a folder is at ${folder}. Move it out of the way first.`);
    if (fs.readdirSync(to).some((n) => !IGNORABLE.has(n))) {
      throw new Error(`${folder} isn't empty, so ${foundAt} can't move back into it. Its files stay locked where they are.`);
    }
    removed = folderId(to);
    // Remove only the litter files by name, then the folder itself. rmdir refuses a folder that isn't empty, so
    // anything that arrived since the check above stays put instead of being deleted.
    for (const n of fs.readdirSync(to)) {
      if (!IGNORABLE.has(n)) continue;
      const st = lstatOrNull(path.join(to, n));
      if (st && !st.isDirectory()) fs.unlinkSync(path.join(to, n));
    }
    try {
      fs.rmdirSync(to);
    } catch {
      throw new Error(`${folder} isn't empty, so ${foundAt} can't move back into it. Its files stay locked where they are.`);
    }
  }
  if (!meSt) fs.mkdirSync(me);
  fs.renameSync(from, to);
  safeChmod(to, 0o700);
  saveLockIds(ctx, root, { ...recorded, [folder]: id });
  saveHistory(ctx, root, { ...history, [folder]: (history[folder] ?? []).filter((x) => x !== id && x !== removed) });
  logActivity(root, "Moved back", `${foundAt} to ${folder}`, ctx.clock());
  return verifyLockedFolders(ctx, root);
}
