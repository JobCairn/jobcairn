import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyLocks, buildIndex, importLegacy, initWorkspace, isWorkspace, layout, logActivity, migrate, readMeta, readRecord, revokeAllGrants,
  updateRecord,
} from "@careeros/core";
import type { FolderSuggestion, LegacyPreview, WorkspaceSummary } from "@careeros/contract";
import { purgeOldTrash } from "./trash.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { verifyLockedFolders } from "./integrity.js";
import { reconcileSends } from "./mail-send.js";
import { expireGrantRequest } from "./privacy.js";
import { seedExample, SEED_DIR } from "./sample.js";
import { adoptUnscopedSecrets } from "./secrets.js";
import { welcomeTour } from "./tour.js";
import { ensureWorkspaceId, MAX_RECENT, workspaceIdOf } from "./workspace-registry.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

const IGNORABLE = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** The example's flag lives in workspace.json (`is_sample`), so a copy of the folder carries it. */
const isSampleRoot = (root: string): boolean => {
  try { return readMeta(root).is_sample === true; } catch { return false; }
};

function summary(root: string, migrated: number[], indexSkipped: number): WorkspaceSummary {
  const meta = readMeta(root);
  return {
    root, name: readRecord("profile", layout(root).profile).contact.name, dataVersion: meta.data_version, migrated, indexSkipped,
    isSample: meta.is_sample === true,
  };
}

/** The person's home folder. Main sets it (tests set a temporary one); the renderer never chooses it. */
export function homeOf(ctx: ServiceContext): string {
  const home = ctx.host.homeDir ?? os.homedir();
  requireAbsolute(home);
  return home;
}
/** A real folder (not a link or file) holding nothing but system clutter. */
export function emptyFolder(dir: string): boolean {
  const st = fs.lstatSync(dir);
  return st.isDirectory() && !st.isSymbolicLink() && !fs.readdirSync(dir).some((n) => !IGNORABLE.has(n));
}
/** A real folder (not a link) that is a workspace. */
export function realWorkspace(dir: string): boolean {
  return fs.lstatSync(dir).isDirectory() && isWorkspace(dir) && !fs.lstatSync(layout(dir).workspaceFile).isSymbolicLink();
}

function remember(ctx: ServiceContext, root: string | null): void {
  const s = ctx.host.state.read();
  const recent = root ? [root, ...s.recent.filter((r) => r !== root)].slice(0, MAX_RECENT) : s.recent;
  // The id and name as last seen, so a moved folder can be recognised and a missing one still shows a name.
  const info = root ? { ...s.recentInfo, [root]: { id: workspaceIdOf(root), name: profileName(root) } } : { ...s.recentInfo };
  ctx.host.state.write({ ...s, lastWorkspace: root, recent, recentInfo: Object.fromEntries(Object.entries(info).filter(([r]) => recent.includes(r))) });
}

/** The person's name from the profile as one plain line, or "". */
export function profileName(root: string): string {
  try {
    const n = readRecord("profile", layout(root).profile).contact.name;
    return typeof n === "string" ? n.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";
  } catch { return ""; }
}

/** Ends every allow-once grant and logs it. Used on open and on close. */
function relockAll(ctx: ServiceContext, root: string, why: string): void {
  for (const g of revokeAllGrants(root, ctx.clock())) {
    logActivity(root, "Re-locked", `${g.folder} (${why})`, ctx.clock());
    expireGrantRequest(ctx, root, g.request_id);
  }
}

/** Defence in depth: the contract already validates paths, but a relative path must never reach a filesystem write here. */
function requireAbsolute(p: string): void {
  if (!path.isAbsolute(p)) throw new Error("That folder isn't a valid location. Choose a full folder path.");
}

export function openWorkspace(ctx: ServiceContext, dir: string): WorkspaceSummary {
  if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !isWorkspace(dir)) {
    throw new Error(`That folder isn't a ${identity.name} workspace. Choose the folder that holds workspace.json.`);
  }
  const root = fs.realpathSync.native(dir);
  if (ctx.root && ctx.root !== root) closeWorkspace(ctx);
  // Grants end first: it works on the raw file, so a malformed grant can't stop the workspace opening.
  relockAll(ctx, root, "app opened");
  const { applied } = migrate(root, undefined, ctx.clock());
  // Regenerates Claude's settings (only if they differ) and keeps the locked folders owner-only, even with no grants to end.
  applyLocks(root, ctx.clock());
  // Sends interrupted by a crash show as "not sure" (Task 17 fix round 0). Never blocks opening.
  try { reconcileSends(root, ctx.now(), ctx.clock()); } catch { /* tried again after the next sync */ }
  // A stable id per workspace: secrets (API key, mail password) are kept under it, so people sharing a computer
  // never see each other's. Secrets saved before that move to the first real workspace opened (never the example).
  const id = ensureWorkspaceId(root);
  if (!isSampleRoot(root)) adoptUnscopedSecrets(ctx.host.secrets, id);
  // Recently deleted keeps items 30 days; older ones go now, before the index is built.
  purgeOldTrash(ctx, root);
  const report = buildIndex(root);
  ctx.setRoot(root);
  remember(ctx, root);
  verifyLockedFolders(ctx, root);
  return summary(root, applied, report.skipped.length);
}

export function createWorkspace(ctx: ServiceContext, dir: string, name: string): WorkspaceSummary {
  requireAbsolute(dir);
  if (fs.existsSync(dir)) {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("Choose a folder, not a file or a link.");
    if (fs.readdirSync(dir).some((n) => !IGNORABLE.has(n))) throw new Error("That folder isn't empty. Choose an empty folder or make a new one.");
  }
  initWorkspace(dir, { name: name.trim(), now: ctx.now() });
  // Brand new: Home offers its tour once. Opened or brought-in folders don't come through here.
  welcomeTour(dir);
  return openWorkspace(ctx, dir);
}

const MAX_TRIES = 20;
const EXAMPLE_DIR = `${identity.name} Example`;
/** Bundled-example entries never copied: links (could point anywhere) and derived or local-only folders. */
const SKIP_COPY = new Set([".index", ".backup", ".git", SEED_DIR]);

/**
 * Where "Get started" puts the folder, with no picker: ~/CareerOS, or the CareerOS folder already set up there
 * (it opens instead). If ~/CareerOS holds something else, the next free "CareerOS 2", "CareerOS 3"... Links are
 * never followed and the example folder is never offered.
 */
export async function suggestFolder(ctx: ServiceContext): Promise<FolderSuggestion> {
  const home = homeOf(ctx);
  let found: { dir: string; existing: boolean } | null = null;
  for (let i = 1; i <= MAX_TRIES && !found; i++) {
    const d = path.join(home, i === 1 ? identity.name : `${identity.name} ${i}`);
    try {
      if (!fs.existsSync(d) && !isLink(d)) found = { dir: d, existing: false };
      else if (isLink(d)) continue;
      else if (realWorkspace(d) && !isSampleRoot(d)) found = { dir: d, existing: true };
      else if (emptyFolder(d)) found = { dir: d, existing: false };
    } catch { /* unreadable: try the next name */ }
  }
  if (!found) throw new Error(`Your home folder already has ${MAX_TRIES} folders called ${identity.name}. Choose a folder yourself instead.`);
  const rel = path.relative(home, found.dir);
  const display = path.sep === "\\" ? found.dir : `~/${rel.split(path.sep).join("/")}`;
  let name = "";
  try { name = (await ctx.host.userFullName?.()) ?? ""; } catch { name = ""; }
  // Only a plain one-line name the create call accepts.
  name = typeof name === "string" ? name.trim() : "";
  if (name.length > 120 || /[\\/\n\r\t]/.test(name) || /[\u0000-\u001f\u007f]/.test(name) || name.startsWith(".") || name.includes("..")) name = "";
  return { dir: found.dir, display, existing: found.existing, name };
}

export function isLink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * "Get started": one click. Main picks the folder (suggestFolder), then opens the workspace already there or
 * makes a new one with no name yet (the setup page asks for it). The renderer never sends a path.
 */
export async function startWorkspace(ctx: ServiceContext): Promise<WorkspaceSummary> {
  const s = await suggestFolder(ctx);
  if (s.existing) return openWorkspace(ctx, s.dir);
  // A new folder is made without following links: mkdir fails if anything (a link included) appeared meanwhile.
  if (!fs.existsSync(s.dir) && !isLink(s.dir)) fs.mkdirSync(s.dir, { mode: 0o700 });
  return createWorkspace(ctx, s.dir, "");
}

/**
 * "Explore with an example": a fresh copy of the bundled fictional example in ~/CareerOS Example, opened.
 * It never touches the person's own folder: it removes only a folder it made itself (is_sample in workspace.json),
 * never follows links, and copies no links. Opening it again starts over from fresh example data.
 */
export async function openSample(ctx: ServiceContext): Promise<WorkspaceSummary> {
  const src = ctx.host.sampleDir;
  if (!src || !path.isAbsolute(src) || !fs.existsSync(src) || !isWorkspace(src)) throw new Error(`The example isn't included in this copy of ${identity.name}.`);
  const home = homeOf(ctx);
  const dest = path.join(home, EXAMPLE_DIR);
  if (fs.existsSync(dest) || isLink(dest)) {
    let ours = false;
    try { ours = realWorkspace(dest) && isSampleRoot(dest); } catch { ours = false; }
    let empty = false;
    try { empty = emptyFolder(dest); } catch { empty = false; }
    if (!ours && !empty) {
      throw new Error(`A folder called "${EXAMPLE_DIR}" is already in your home folder. Move or rename it, then try again.`);
    }
    if (ctx.root && path.resolve(ctx.root) === path.resolve(fs.realpathSync.native(dest))) closeWorkspace(ctx);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  // Fails if anything (a link included) is in the way, so the copy can't land somewhere else.
  fs.mkdirSync(dest, { mode: 0o700 });
  fs.cpSync(src, dest, {
    recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
    filter: (from) => {
      if (from === src) return true;
      if (SKIP_COPY.has(path.basename(from)) && path.dirname(from) === src) return false;
      return !fs.lstatSync(from).isSymbolicLink();
    },
  });
  // A fresh example gets its own id on open (secrets are never shared with an earlier copy).
  updateRecord("workspace", layout(dest).workspaceFile, (m) => { m.is_sample = true; m.workspace_id = ""; });
  // Seeded before opening, so the index built on open has the example's mail, runs and files.
  await seedExample(dest, src, ctx.now());
  return openWorkspace(ctx, dest);
}

export function closeWorkspace(ctx: ServiceContext): void {
  if (ctx.root) relockAll(ctx, ctx.root, "app closed");
  ctx.setRoot(null);
  remember(ctx, null);
}

/** App quit: re-lock and stop the workspace's hooks, but remember it for the next launch. */
export function shutdownWorkspace(ctx: ServiceContext): void {
  if (ctx.root) relockAll(ctx, ctx.root, "app closed");
  ctx.setRoot(null);
}

/** Opens the workspace from the last session, or returns null (and forgets it) when that fails. */
export function restoreLast(ctx: ServiceContext): WorkspaceSummary | null {
  const last = ctx.host.state.read().lastWorkspace;
  if (!last) return null;
  try { return openWorkspace(ctx, last); } catch { remember(ctx, null); return null; }
}

function toPreview(r: ReturnType<typeof importLegacy>): LegacyPreview {
  return { actions: r.actions.map(({ kind, from, to, note }) => ({ kind, from, to, ...(note ? { note } : {}) })), unmapped: r.unmapped, skipped: r.skipped, issues: r.issues.map((i) => ({ file: i.file, problems: i.problems })) };
}

export function previewLegacy(ctx: ServiceContext, src: string, dest: string): LegacyPreview {
  return toPreview(importLegacy(src, dest, { dryRun: true, now: ctx.now() }));
}

export function importLegacyAndOpen(ctx: ServiceContext, src: string, dest: string): LegacyPreview {
  requireAbsolute(src);
  requireAbsolute(dest);
  if (fs.existsSync(dest) && !isWorkspace(dest) && fs.readdirSync(dest).some((n) => !IGNORABLE.has(n))) {
    throw new Error(`Import into an empty folder or an existing ${identity.name} workspace.`);
  }
  const report = toPreview(importLegacy(src, dest, { now: ctx.now() }));
  openWorkspace(ctx, dest);
  return report;
}

export const workspaceHandlers = {
  "app.info": (ctx: ServiceContext) => ctx.host.info,
  "workspace.current": (ctx: ServiceContext) => (ctx.root ? summary(ctx.root, [], 0) : null),
  "workspace.pickFolder": (ctx: ServiceContext, purpose: "create" | "open" | "legacy") => ctx.host.shell.pickFolder(purpose),
  "workspace.suggest": suggestFolder,
  "workspace.start": startWorkspace,
  "workspace.create": createWorkspace,
  "workspace.openSample": openSample,
  "workspace.open": openWorkspace,
  "workspace.previewLegacy": previewLegacy,
  "workspace.importLegacy": importLegacyAndOpen,
  "workspace.close": closeWorkspace,
} satisfies Partial<HandlerTable>;
