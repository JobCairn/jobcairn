import fs from "node:fs";
import path from "node:path";
import { layout, readMeta } from "@careeros/core";
import type { LocateResult, RecentWorkspace, WorkspaceSummary } from "@careeros/contract";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import type { AppState } from "./host.js";
import { forgetMailFor, repointBackground } from "./mail-account.js";
import { MAX_RECENT, recentKey, workspaceIdOf } from "./workspace-registry.js";
import { companyCount, isEmptyWorkspace } from "./workspace-empty.js";
import { createWorkspace, emptyFolder, homeOf, isLink, openWorkspace, profileName, realWorkspace } from "./workspace.js";

export { MAX_RECENT, workspaceIdOf } from "./workspace-registry.js";

/**
 * The workspace switcher (one computer, several people, each with their own workspace). The list lives in app
 * state (user data, never in a workspace). The renderer only ever sees names, folder names and opaque keys:
 * main maps a key back to the folder.
 */

const MAX_TRIES = 20;

function recentRoots(ctx: ServiceContext): string[] {
  const seen = new Set<string>();
  const raw = ctx.host.state.read().recent;
  return (Array.isArray(raw) ? raw : []).filter((r): r is string => typeof r === "string" && path.isAbsolute(r) && !seen.has(r) && !!seen.add(r)).slice(0, MAX_RECENT);
}

/** Moves every per-root record from `from` to `to` (a relinked workspace), or drops them (`to` null). */
function moveRootState(s: AppState, from: string, to: string | null): AppState {
  const move = <T>(m: Record<string, T> | undefined): Record<string, T> | undefined => {
    if (!m || !Object.hasOwn(m, from)) return m;
    const { [from]: v, ...rest } = m;
    return to === null ? rest : { ...rest, [to]: v as T };
  };
  return { ...s, recentInfo: move(s.recentInfo), appApprovals: move(s.appApprovals), lockIds: move(s.lockIds), lockIdHistory: move(s.lockIdHistory) };
}

const pathProblem = (root: string): RecentWorkspace["problem"] => {
  let st: fs.Stats;
  try { st = fs.lstatSync(root); } catch { return "missing"; }
  try { return st.isDirectory() && realWorkspace(root) ? "" : "not_workspace"; } catch { return "not_workspace"; }
};
const createdDate = (root: string): string => {
  try { const at = readMeta(root).created_at; return typeof at === "string" && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : ""; } catch { return ""; }
};

export function listRecent(ctx: ServiceContext): RecentWorkspace[] {
  const state = ctx.host.state.read();
  const info = { ...state.recentInfo };
  let changed = false;
  const out: RecentWorkspace[] = [];
  for (const root of recentRoots(ctx)) {
    const current = ctx.root === root;
    const problem = pathProblem(root);
    const available = problem === "";
    let isSample = false;
    if (available) { try { isSample = readMeta(root).is_sample === true; } catch { isSample = false; } }
    // The example has its own menu item; it's listed only while it's open.
    if (isSample && !current) continue;
    let name = info[root]?.name ?? "";
    if (available) {
      // Backfill what a later "Locate…" needs, for entries remembered before ids were kept.
      name = profileName(root);
      const id = workspaceIdOf(root);
      if (info[root]?.id !== id || info[root]?.name !== name) { info[root] = { id, name }; changed = true; }
    }
    out.push({
      key: recentKey(root), name, folder: path.basename(root), place: path.basename(root), isSample, current, available, problem,
      companies: available ? companyCount(root) : null, created: available ? createdDate(root) : "",
      empty: available && !isSample && isEmptyWorkspace(root, { lockRecorded: lockRecorded(ctx, root) }),
    });
  }
  if (changed) ctx.host.state.write({ ...ctx.host.state.read(), recentInfo: info });
  // Two entries that would read the same ("Alex Example · CareerOS") also show their parent folder's name.
  const roots = new Map(recentRoots(ctx).map((r) => [recentKey(r), r]));
  let home = "";
  try { home = homeOf(ctx); } catch { home = ""; }
  const label = (r: RecentWorkspace) => `${r.name.trim().toLowerCase()}\0${r.folder.toLowerCase()}`;
  for (const r of out) {
    if (out.filter((o) => label(o) === label(r)).length < 2) continue;
    const dir = path.dirname(roots.get(r.key) ?? "");
    const parent = path.resolve(dir) === path.resolve(home) ? "Home folder" : path.basename(dir);
    if (parent) r.place = `${parent} › ${r.folder}`;
  }
  return out.sort((a, b) => Number(b.current) - Number(a.current));
}

function rootFor(ctx: ServiceContext, key: string): string {
  const root = recentRoots(ctx).find((r) => recentKey(r) === key);
  if (!root) throw new Error("That workspace isn't in the list any more. Use Open another workspace to find it.");
  return root;
}

/** Whether a locked folder's identity was ever recorded for this root (see integrity.ts). */
function lockRecorded(ctx: ServiceContext, root: string): boolean {
  const s = ctx.host.state.read();
  const has = (m: Record<string, unknown> | undefined) => !!m && Object.keys(m).length > 0;
  return has(s.lockIds?.[root]) || has(s.lockIdHistory?.[root] as Record<string, unknown> | undefined);
}

export function switchWorkspace(ctx: ServiceContext, key: string): WorkspaceSummary {
  const root = rootFor(ctx, key);
  const problem = pathProblem(root);
  // Never made again at the old place: a missing folder is found with Locate…, not recreated.
  if (problem === "missing") throw new Error("Can't find this folder. It may have been moved or deleted. Use Locate… to find it, or remove it from the list.");
  if (problem) throw new Error(`That folder isn't a ${identity.name} workspace any more. Remove it from the list, or use Open another workspace.`);
  return openWorkspace(ctx, root);
}

/** Takes a workspace off the list. Never touches its files. */
export function forgetWorkspace(ctx: ServiceContext, key: string): RecentWorkspace[] {
  const root = rootFor(ctx, key);
  if (ctx.root === root) throw new Error("This workspace is open. Switch to another workspace first, then remove it from the list.");
  const s = moveRootState(ctx.host.state.read(), root, null);
  ctx.host.state.write({ ...s, recent: s.recent.filter((r) => r !== root), lastWorkspace: s.lastWorkspace === root ? null : s.lastWorkspace });
  return listRecent(ctx);
}

/**
 * Moves an empty workspace to the system Trash (recoverable) and takes it off the list. Everything is checked again
 * here: listed, not open, not the example, a real folder (not a link) holding a real workspace.json, not the home
 * folder or a drive's root, and still empty. If the Trash refuses, nothing is deleted instead.
 */
export async function trashWorkspace(ctx: ServiceContext, key: string): Promise<RecentWorkspace[]> {
  const root = rootFor(ctx, key);
  const refuse = (why: string) => new Error(`${why} Nothing was moved.`);
  if (ctx.root === root) throw refuse("This workspace is open.");
  const trash = ctx.host.shell.trashItem;
  if (!trash) throw refuse("Moving to the Trash isn't available here.");
  let st: fs.Stats;
  try { st = fs.lstatSync(root); } catch { throw refuse("Can't find this folder."); }
  const home = homeOf(ctx);
  if (st.isSymbolicLink() || !st.isDirectory() || path.resolve(root) === path.parse(path.resolve(root)).root || path.resolve(root) === path.resolve(home)) {
    throw refuse("Only a workspace folder can be moved to the Trash.");
  }
  let ok = false;
  try { ok = realWorkspace(root) && fs.lstatSync(layout(root).workspaceFile).isFile() && readMeta(root).is_sample !== true; } catch { ok = false; }
  if (!ok) throw refuse("Only a workspace folder can be moved to the Trash.");
  if (!isEmptyWorkspace(root, { lockRecorded: lockRecorded(ctx, root) })) throw refuse("This workspace has your files in it, so it can only be removed from the list.");
  const id = workspaceIdOf(root);
  try { await trash(root); } catch { throw new Error("The folder couldn't be moved to the Trash, so it was left where it is."); }
  // Its mail goes too: the saved Gmail password and the background sync schedule. Best effort: the folder is already
  // in the Trash, and a schedule that survives only logs that its folder isn't a workspace.
  if (id) { try { await forgetMailFor(ctx, id, root); } catch { /* see above */ } }
  const s = moveRootState(ctx.host.state.read(), root, null);
  ctx.host.state.write({ ...s, recent: s.recent.filter((r) => r !== root), lastWorkspace: s.lastWorkspace === root ? null : s.lastWorkspace });
  return listRecent(ctx);
}

/** A real, non-example workspace folder the person picked, as its real path. */
function pickedWorkspace(dir: string): string {
  let real: string;
  try { real = fs.realpathSync.native(dir); } catch { throw new Error(`That folder isn't a ${identity.name} workspace. Choose the folder that holds workspace.json.`); }
  let ok = false;
  try { ok = realWorkspace(real) && readMeta(real).is_sample !== true; } catch { ok = false; }
  if (!ok) throw new Error(`That folder isn't a ${identity.name} workspace. Choose the folder that holds workspace.json.`);
  return real;
}

/**
 * "Locate…" for a missing entry. The picked folder replaces it only when it is the same workspace (the same id from
 * workspace.json as the one remembered); its privacy records move with it. Otherwise nothing changes and the
 * window offers to add it as a separate entry. Never creates a folder anywhere.
 */
export async function locateWorkspace(ctx: ServiceContext, key: string, dir: string): Promise<LocateResult> {
  const old = rootFor(ctx, key);
  if (pathProblem(old) !== "missing") throw new Error("That folder is there now. Choose it from the list.");
  const real = pickedWorkspace(dir);
  const want = ctx.host.state.read().recentInfo?.[old]?.id ?? "";
  const got = workspaceIdOf(real);
  if (!want || !got || want !== got) return { relinked: false, list: listRecent(ctx) };
  let s = moveRootState(ctx.host.state.read(), old, real);
  // Already listed at its new place too: keep one entry, where the old one was.
  const recent = s.recent.filter((r) => r !== real).map((r) => (r === old ? real : r));
  s = { ...s, recent, lastWorkspace: s.lastWorkspace === old ? real : s.lastWorkspace };
  ctx.host.state.write(s);
  // A background mail sync that is on still points at the old place: point it here. Best effort (the OS may refuse);
  // turning background sync off and on in Settings > Email does the same.
  try { await repointBackground(ctx, real); } catch { /* see above */ }
  return { relinked: true, list: listRecent(ctx) };
}

/** Adds a workspace to the list without opening it (after the open one, if any). */
export function addRecentWorkspace(ctx: ServiceContext, dir: string): RecentWorkspace[] {
  const real = pickedWorkspace(dir);
  const s = ctx.host.state.read();
  if (!s.recent.includes(real)) {
    const at = ctx.root && s.recent[0] === ctx.root ? 1 : 0;
    const recent = [...s.recent.slice(0, at), real, ...s.recent.slice(at)].slice(0, MAX_RECENT);
    const info = Object.fromEntries(Object.entries({ ...s.recentInfo, [real]: { id: workspaceIdOf(real), name: profileName(real) } }).filter(([r]) => recent.includes(r)));
    ctx.host.state.write({ ...s, recent, recentInfo: info });
  }
  return listRecent(ctx);
}

/**
 * "Start a new one": a new folder in the home folder, "CareerOS <name>" (or "CareerOS" with no name), then the next
 * free numbered one. Never reuses a folder with things in it, never follows a link. Main builds the path.
 */
export async function startNewWorkspace(ctx: ServiceContext, name: string): Promise<WorkspaceSummary> {
  const clean = name.trim();
  if (clean.length > 120 || /[\\/]/.test(clean) || clean.includes("..") || clean.startsWith(".") || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error("Use a plain name, without slashes or dots at the start.");
  }
  const home = homeOf(ctx);
  const base = clean ? `${identity.name} ${clean}` : identity.name;
  for (let i = 1; i <= MAX_TRIES; i++) {
    const dir = path.join(home, i === 1 ? base : `${base} ${i}`);
    if (path.dirname(dir) !== home) continue;
    try {
      if (isLink(dir)) continue;
      if (!fs.existsSync(dir)) {
        // Non-recursive: fails if anything (a link included) appeared meanwhile.
        fs.mkdirSync(dir, { mode: 0o700 });
        return createWorkspace(ctx, dir, clean);
      }
      if (emptyFolder(dir)) return createWorkspace(ctx, dir, clean);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
  }
  throw new Error(`Your home folder already has ${MAX_TRIES} folders with that name. Use Open another workspace to choose a folder yourself.`);
}

export const switcherHandlers = {
  "workspace.recent": listRecent,
  "workspace.switchTo": switchWorkspace,
  "workspace.forget": forgetWorkspace,
  "workspace.trash": trashWorkspace,
  "workspace.locate": locateWorkspace,
  "workspace.addRecent": addRecentWorkspace,
  "workspace.startNew": startNewWorkspace,
} satisfies Partial<HandlerTable>;
