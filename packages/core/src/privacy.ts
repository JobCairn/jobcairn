import fs from "node:fs";
import path from "node:path";
import type { Clock } from "./clock.js";
import { layout, LOCKED_DIRS } from "./paths.js";
import { safeChmod } from "./perm.js";
import { decideAccessRequest, logActivity, readAccessRequest } from "./queue.js";
import { readJson, readRecord, RecordError, updateRecord, writeFileAtomic, writeRecord } from "./store.js";
import type { LockableDir, PrivacyGrant, WorkspaceMeta } from "./types.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

/** Shell commands that read or copy files. Claude Code deny rules match the whole command text. */
export const BASH_READERS = ["cat", "head", "tail", "less", "more", "cp", "mv", "open", "xdg-open", "strings", "xxd", "od", "base64", "grep", "rg", "awk", "sed", "tar", "zip"] as const;

/**
 * The files that constrain Claude: the lock state, Claude's own settings, and the app's queues and state.
 * Edit rules cover every file-writing tool. The careeros CLI is unaffected: it writes the queues from its
 * own process, never through Claude's Edit tool, and its commands never name these files.
 */
export const CONTROL_FILE_RULES = [
  "Edit(./workspace.json)", "Edit(./.claude/**)", "Edit(./.careeros/**)",
  "Bash(*.claude/settings*)",
  "Bash(*>*workspace.json*)", "Bash(*tee *workspace.json*)", "Bash(*sed -i*workspace.json*)",
  "Bash(*mv *workspace.json*)", "Bash(*cp *workspace.json*)", "Bash(*rm *workspace.json*)",
  "Bash(*>*.careeros/*)",
] as const;

/**
 * Moving or copying the whole `me` folder carries the locked folders out from under their path-based rules.
 * These catch the obvious forms (whole-token `me` as the argument); they narrow the gap but can't close it,
 * which is why the app also checks the folders' identity (checkLockedFolders).
 */
export const ME_MOVER_RULES = [
  "Bash(mv me *)", "Bash(mv ./me *)", "Bash(mv me/ *)", "Bash(*mv me *)", "Bash(*mv ./me *)", "Bash(*mv me/ *)",
  "Bash(cp -r me*)", "Bash(cp -R me*)", "Bash(cp -a me*)", "Bash(rsync *me*)", "Bash(ln *me*)",
  "Bash(tar * me*)", "Bash(zip * me*)", "Bash(*cd me*)",
] as const;

/** Folders Claude may never write into: records, settings, the person's own files, app internals. */
export const NEVER_WRITE = ["me", "settings", ".careeros", ".claude", ".index", ".backup", ".git"] as const;
/** App internals Claude may never read: migration backups and the search index. */
export const NEVER_READ = [".backup", ".index"] as const;
/** The browser command: the only command Claude's workspace settings allow (see browsing.ts). */
const WORKSPACE_BROWSER_CMD = "./.careeros/bin/jobcairn-chrome";
/** The browser helper run directly, which would skip the browser command's profile check and rules. */
export const RAW_BROWSER_DENY = ["Bash(agent-browser *)", "Bash(npx agent-browser *)", "Bash(*/agent-browser *)", "Bash(*agent-browser --cdp*)"] as const;

/**
 * Claude Code's permission mode for this workspace. "auto": auto mode, the whole workspace readable and writable
 * (minus every deny rule). "ask" (auto mode off): dontAsk, with reading and the browser command allowed only.
 */
export type ClaudeMode = "auto" | "ask";

export interface ClaudeSettings {
  permissions: { deny: string[]; allow?: string[]; defaultMode?: "auto" | "dontAsk" };
  hooks: { SessionStart: { hooks: { type: "command"; command: string }[] }[] };
  /** The app's own plugin, for interactive sessions in the workspace (see claudePluginDir). */
  extraKnownMarketplaces?: Record<string, { source: { source: "directory"; path: string } }>;
  enabledPlugins?: Record<string, boolean>;
}

/** Where one-time setup records the app's plugin folder, so every rewrite of .claude/settings.json keeps it. */
export const CLAUDE_PLUGIN_REL = ".careeros/claude-plugin.json";
/** The marketplace the app's plugin folder declares (plugin/.claude-plugin/marketplace.json) and the plugin in it. */
export const PLUGIN_MARKETPLACE = "jobcairn";
export const PLUGIN_ID = `careeros@${PLUGIN_MARKETPLACE}`;

/**
 * The app's plugin folder recorded by setup, or null: only an absolute folder that holds the marketplace file.
 * Interactive Claude Code sessions in the workspace load the JobCairn skills from it (after the person trusts the
 * folder); the app's own runs pass --plugin-dir and don't need it.
 */
export function claudePluginDir(root: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, CLAUDE_PLUGIN_REL), "utf8")) as { dir?: unknown };
    const dir = typeof j.dir === "string" ? j.dir : "";
    if (!dir || !path.isAbsolute(dir) || dir.includes("\0") || /[\r\n]/.test(dir)) return null;
    return fs.statSync(path.join(dir, ".claude-plugin", "marketplace.json")).isFile() ? dir : null;
  } catch { return null; }
}

export function claudeSettings(locked: readonly string[] = LOCKED_DIRS, mode?: ClaudeMode): ClaudeSettings {
  const deny: string[] = [];
  for (const d of locked) {
    // Edit rules cover every file-writing tool; Write(...) is not a file-permission rule.
    deny.push(`Read(./${d}/**)`, `Edit(./${d}/**)`);
    for (const cmd of BASH_READERS) deny.push(`Bash(${cmd} *${d}*)`);
    // The catch-all also covers the CLI's --jd-file and Windows-style separators.
    deny.push(`Bash(*--jd-file*${d}*)`, `Bash(*${d}*)`, `Bash(*${d.replace(/\//g, "\\")}*)`);
  }
  if (locked.length) deny.push(...ME_MOVER_RULES);
  deny.push("Read(./settings/.env)", "Edit(./settings/.env)", "Bash(*settings/.env*)");
  deny.push(...CONTROL_FILE_RULES);
  if (mode) {
    // Deny rules win over every allow rule, in both modes: app folders and Claude's own settings stay out of reach.
    deny.push(...NEVER_WRITE.map((d) => `Edit(./${d}/**)`), ...NEVER_READ.map((d) => `Read(./${d}/**)`), ...RAW_BROWSER_DENY);
  }
  // A grant left open by an app crash is closed as soon as a Claude session starts in the workspace.
  // $CLAUDE_PROJECT_DIR is the project root Claude Code sets for every hook invocation;
  // pass it explicitly with --ws so the command never depends on the hook's cwd.
  const hooks = { SessionStart: [{ hooks: [{ type: "command" as const, command: 'careeros privacy expire --ws "$CLAUDE_PROJECT_DIR" || true' }] }] };
  if (!mode) return { permissions: { deny }, hooks };
  const allow = mode === "auto"
    ? ["Read(./**)", "Edit(./**)", `Bash(${WORKSPACE_BROWSER_CMD} *)`, `Bash(${WORKSPACE_BROWSER_CMD})`]
    : ["Read(./**)", `Bash(${WORKSPACE_BROWSER_CMD} *)`, `Bash(${WORKSPACE_BROWSER_CMD})`];
  return { permissions: { defaultMode: mode === "auto" ? "auto" : "dontAsk", allow, deny: [...new Set(deny)] }, hooks };
}

export function readMeta(root: string): WorkspaceMeta {
  return readRecord("workspace", layout(root).workspaceFile);
}

function assertLockable(folder: string): asserts folder is LockableDir {
  if (!(LOCKED_DIRS as readonly string[]).includes(folder)) throw new Error(`"${folder}" is not a lockable folder`);
}

/** The longest an allow-once grant may last. addGrant refuses more; a longer grant on disk never counts. */
export const MAX_GRANT_MINUTES = 240;
/** The exact shape Date#toISOString writes. Anything else in a grant is treated as no grant. */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** How far ahead of our clock a grant's start may be (clock adjustments) before it stops counting. */
const GRANT_SKEW_MS = 60_000;

/**
 * When a grant ends (ms since epoch), or null when it must never count: not an object, an unknown
 * folder, a start or end that isn't an exact ISO instant, an end that isn't after the start, a span
 * longer than MAX_GRANT_MINUTES, or a start in the future. A hand-edited "never" or "9999-12-31"
 * therefore opens nothing.
 */
export function grantEnd(g: unknown, nowMs: number): number | null {
  if (!g || typeof g !== "object") return null;
  const { folder, until, granted_at } = g as Record<string, unknown>;
  if (!(LOCKED_DIRS as readonly unknown[]).includes(folder)) return null;
  if (typeof until !== "string" || typeof granted_at !== "string" || !ISO_INSTANT.test(until) || !ISO_INSTANT.test(granted_at)) return null;
  const end = Date.parse(until);
  const start = Date.parse(granted_at);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  if (end <= start || end - start > MAX_GRANT_MINUTES * 60_000 || start > nowMs + GRANT_SKEW_MS) return null;
  return end;
}

/** True while a grant is well formed, within the cap, and not yet over. */
export function grantIsLive(g: unknown, nowMs: number): boolean {
  const end = grantEnd(g, nowMs);
  return end !== null && end > nowMs;
}

const nowMs = (c?: Clock) => (c?.now ?? new Date()).getTime();

/**
 * True when the grant names an access request that the app allowed, for this folder, until exactly this time.
 * Grants the app makes always are (see allowAccessRequest); a grant written into workspace.json by hand is not.
 */
export function grantIsBacked(root: string, g: PrivacyGrant): boolean {
  if (typeof g.request_id !== "string" || !g.request_id) return false;
  try {
    const r = readAccessRequest(root, g.request_id);
    return r.status === "allowed" && r.folder === g.folder && r.expires_at === g.until;
  } catch {
    return false;
  }
}

/** A grant the app honours right now: live (grantIsLive) and backed by its allowed request (grantIsBacked). */
export function grantIsHonoured(root: string, g: PrivacyGrant, now: number): boolean {
  return grantIsLive(g, now) && grantIsBacked(root, g);
}


/** The raw grants list in workspace.json, read without the schema so a malformed grant can still be found and dropped. */
function rawGrants(root: string): { raw: Record<string, unknown>; privacy: Record<string, unknown> | null; grants: unknown[] } {
  const raw = readJson(layout(root).workspaceFile);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { raw: {}, privacy: null, grants: [] };
  const privacy = (raw as Record<string, unknown>).privacy;
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) return { raw: raw as Record<string, unknown>, privacy: null, grants: [] };
  const grants = (privacy as Record<string, unknown>).grants;
  return { raw: raw as Record<string, unknown>, privacy: privacy as Record<string, unknown>, grants: Array.isArray(grants) ? grants : [] };
}

/**
 * When the grant timer should look next (ms since epoch): the earliest honoured grant's end, or now when any
 * grant on disk is already dead (expired, malformed or unbacked) and waits to be dropped. Undefined when there
 * are no grants. Uses the same test as expireGrants, so a "now" always leads to a drop and never to a loop.
 */
export function nextGrantCheck(root: string, c?: Clock): number | undefined {
  const now = nowMs(c);
  const ends = rawGrants(root).grants.map((g) => (grantIsHonoured(root, g as PrivacyGrant, now) ? grantEnd(g, now)! : now)).filter((n) => Number.isFinite(n));
  return ends.length ? Math.min(...ends) : undefined;
}

/** The exact text .claude/settings.json should hold for the current lock state. */
export function expectedClaudeSettings(root: string, c?: Clock): string {
  const s = claudeSettings(lockedOrAll(root, c), claudeMode(root));
  const plugin = claudePluginDir(root);
  if (plugin) {
    s.extraKnownMarketplaces = { [PLUGIN_MARKETPLACE]: { source: { source: "directory", path: plugin } } };
    s.enabledPlugins = { [PLUGIN_ID]: true };
  }
  return JSON.stringify(s, null, 2) + "\n";
}

/** This workspace's Claude mode: auto unless the person turned it off. An unreadable workspace.json is "ask" (safer). */
export function claudeMode(root: string): ClaudeMode {
  try { return readMeta(root).claude?.auto_mode === false ? "ask" : "auto"; } catch { return "ask"; }
}

/** Turns auto mode on or off for this workspace and rewrites .claude/settings.json to match. */
export function setClaudeMode(root: string, mode: ClaudeMode, c?: Clock): ClaudeMode {
  updateRecord("workspace", layout(root).workspaceFile, (w) => { w.claude = { ...(w.claude ?? {}), auto_mode: mode === "auto" }; });
  writeClaudeSettings(root, c);
  return claudeMode(root);
}

/**
 * The folders locked right now: locked minus those with an honoured grant (live and backed by its request),
 * or every lockable folder when workspace.json can't be read. Unsure means locked.
 */
export function lockedOrAll(root: string, c?: Clock): readonly LockableDir[] {
  let meta: WorkspaceMeta;
  try { meta = readMeta(root); } catch (e) {
    if (e instanceof RecordError) return LOCKED_DIRS;
    throw e;
  }
  const now = nowMs(c);
  const open = new Set(meta.privacy.grants.filter((g) => grantIsHonoured(root, g, now)).map((g) => g.folder));
  return meta.privacy.locked.filter((d) => !open.has(d));
}

/** Regenerates .claude/settings.json from the lock state. Writes only when the text differs; returns whether it wrote. */
export function writeClaudeSettings(root: string, c?: Clock): boolean {
  const file = path.join(root, ".claude", "settings.json");
  const want = expectedClaudeSettings(root, c);
  let have: string | null = null;
  try { have = fs.readFileSync(file, "utf8"); } catch { have = null; }
  if (have === want) return false;
  writeFileAtomic(file, want);
  return true;
}

/** Regenerates Claude settings from the lock state and keeps every lockable folder owner-only. */
/**
 * Never creates a missing locked folder: a folder that vanished may have been moved, and an empty
 * replacement would hide that (see checkLockedFolders). initWorkspace creates them for a new workspace.
 * Only real folders are chmodded, never the target of a link.
 */
export function applyLocks(root: string, c?: Clock): void {
  writeClaudeSettings(root, c);
  for (const d of LOCKED_DIRS) {
    if (folderId(path.join(root, d)) !== null) safeChmod(path.join(root, d), 0o700);
  }
}

export function setLocked(root: string, folder: string, locked: boolean, c?: Clock): WorkspaceMeta {
  assertLockable(folder);
  const meta = updateRecord("workspace", layout(root).workspaceFile, (w) => {
    const set = new Set(w.privacy.locked);
    if (locked) set.add(folder); else set.delete(folder);
    w.privacy.locked = LOCKED_DIRS.filter((d) => set.has(d));
    // Locking (or unlocking) a folder ends any allow-once grant on it.
    w.privacy.grants = w.privacy.grants.filter((g) => g.folder !== folder);
  });
  applyLocks(root, c);
  return meta;
}

export function addGrant(root: string, folder: string, minutes: number, requestId: string, c?: Clock): PrivacyGrant {
  assertLockable(folder);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_GRANT_MINUTES) throw new Error(`allow-once lasts 1 to ${MAX_GRANT_MINUTES} minutes`);
  const now = c?.now ?? new Date();
  const grant: PrivacyGrant = { folder, until: new Date(now.getTime() + minutes * 60_000).toISOString(), request_id: requestId, granted_at: now.toISOString() };
  updateRecord("workspace", layout(root).workspaceFile, (w) => {
    if (!w.privacy.locked.includes(folder)) throw new Error(`"${folder}" is not locked, so it needs no grant`);
    w.privacy.grants = [...w.privacy.grants.filter((g) => g.folder !== folder), grant];
  });
  applyLocks(root, c);
  return grant;
}

/**
 * Removes the grants `keep` rejects and re-applies the locks. Works on the raw file, so a grant the
 * schema would reject (a hand-edited "until") can still be dropped. Writes nothing when nothing goes.
 * Entries that aren't objects are always dropped; the others reach `keep` as found on disk.
 */
/**
 * Allows a pending access request and, when its folder is locked, opens it with a grant that ends exactly when
 * the request does (one clock for both, so grantIsBacked holds). Returns the grant, or null for an unlocked folder.
 */
export function allowAccessRequest(root: string, id: string, minutes: number, c?: Clock): PrivacyGrant | null {
  const clock = { now: c?.now ?? new Date() };
  const r = decideAccessRequest(root, id, "allowed", { minutes }, clock);
  if (!readMeta(root).privacy.locked.includes(r.folder)) return null;
  return addGrant(root, r.folder, minutes, id, clock);
}

function dropGrants(root: string, keep: (g: PrivacyGrant) => boolean, c?: Clock): PrivacyGrant[] {
  const { raw, privacy, grants } = rawGrants(root);
  const kept: unknown[] = [];
  const removed: PrivacyGrant[] = [];
  for (const g of grants) {
    if (g && typeof g === "object" && !Array.isArray(g) && keep(g as PrivacyGrant)) kept.push(g);
    else removed.push(asGrant(g));
  }
  if (!removed.length || !privacy) return [];
  privacy.grants = kept;
  writeRecord("workspace", layout(root).workspaceFile, raw);
  applyLocks(root, c);
  return removed;
}

/** A dropped entry as a grant the callers can log: unknown fields become "". */
function asGrant(g: unknown): PrivacyGrant {
  const o = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return { folder: s(o.folder) as LockableDir, until: s(o.until), request_id: s(o.request_id), granted_at: s(o.granted_at) };
}

export function revokeGrant(root: string, folder: string, c?: Clock): boolean {
  assertLockable(folder);
  return dropGrants(root, (g) => g.folder !== folder, c).length > 0;
}

/** Drops every grant that is over, malformed, longer than the cap, or not backed by its allowed request. */
export function expireGrants(root: string, c?: Clock): PrivacyGrant[] {
  const now = nowMs(c);
  return dropGrants(root, (g) => grantIsHonoured(root, g, now), c);
}

export function revokeAllGrants(root: string, c?: Clock): PrivacyGrant[] {
  return dropGrants(root, () => false, c);
}

function realOrResolved(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/**
 * Which locked area (if any) a file really lives in. Follows symlinks and, on
 * case-insensitive disks, normalises case, so "ME/Identity/x" or a link that
 * points into me/identity is still caught.
 */
export function lockedFolderFor(root: string, file: string, c?: Clock): string | null {
  const real = realOrResolved(file);
  const rootReal = realOrResolved(root);
  for (const d of lockedOrAll(root, c)) {
    const dir = realOrResolved(path.join(rootReal, d));
    if (real === dir || real.startsWith(dir + path.sep)) return d;
  }
  const env = realOrResolved(path.join(rootReal, "settings", ".env"));
  return real === env ? "settings/.env" : null;
}

/**
 * A file the CLI (and Claude through it) may read: its real path must be inside the workspace, outside the locked
 * folders (unless a grant is live) and settings/.env, and outside the app's internals; it must be one regular file
 * with a single name, so a link or a second name can't smuggle a locked file out. Returns the real path.
 */
export function workspaceSourceFile(root: string, file: string, c?: Clock): string {
  let real: string;
  try { real = fs.realpathSync.native(path.resolve(root, file)); } catch { throw new Error(`no such file: ${path.basename(file)}`); }
  const rootReal = realOrResolved(root);
  if (!real.startsWith(rootReal + path.sep)) throw new Error(`refusing to read "${path.basename(file)}": it is outside the workspace`);
  const locked = lockedFolderFor(root, real, c);
  if (locked) throw new Error(`refusing to read ${locked}: it is locked. Unlock it in the ${identity.name} app (Privacy) first`);
  const top = path.relative(rootReal, real).split(path.sep)[0];
  if (top === ".careeros" || top === ".claude" || top === ".index" || top === ".backup") throw new Error(`refusing to read "${path.basename(file)}": it belongs to the app`);
  // The path as given must not pass through a link either (the real path above already follows them).
  const lst = fs.lstatSync(path.resolve(root, file));
  if (lst.isSymbolicLink()) throw new Error(`refusing to read "${path.basename(file)}": it is a link`);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`refusing to read "${path.basename(file)}": not a regular file`);
  if (st.nlink > 1) throw new Error(`refusing to read "${path.basename(file)}": it has a second name`);
  return real;
}

// ---- locked-folder identity (final review I4) ---------------------------------------------------------------

/** A real folder's identity, "dev:ino", or null when the path is missing, a link, or not a folder. Never follows links. */
export function folderId(p: string): string | null {
  try {
    const st = fs.lstatSync(p, { bigint: true });
    return st.isDirectory() && !st.isSymbolicLink() ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}

export type LockProblemKind = "missing" | "replaced" | "link" | "not-folder" | "unreadable";
export interface LockProblem {
  folder: LockableDir;
  kind: LockProblemKind;
  /** Where the recorded folder is now, relative to the workspace, when the bounded search found it. */
  foundAt: string | null;
}
/** Locked folder -> "dev:ino" recorded while it was known to be in place. */
export type LockIds = Partial<Record<LockableDir, string>>;

/** What sits at `p`, without following links. "unreadable" covers anything other than "not there" (fail closed). */
function lstatKind(p: string): "folder" | "missing" | "link" | "not-folder" | "unreadable" {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return "link";
    return st.isDirectory() ? "folder" : "not-folder";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

const FIND_DEPTH = 2;
const FIND_CAP = 2000;

/**
 * Looks for the folder with identity `id` in the top two levels of the workspace (root/x and root/x/y),
 * without following links and stopping after FIND_CAP entries. Returns its relative path, or null.
 */
export function findFolderById(root: string, id: string): string | null {
  return scanForFolderId(root, id).at;
}

/**
 * findFolderById plus whether the search saw everything: `complete` is true only when the cap wasn't hit, no
 * folder failed to list, and no folder below the second level was left unvisited. Only a complete search
 * that found nothing proves a folder is gone.
 */
export function scanForFolderId(root: string, id: string): { at: string | null; complete: boolean } {
  let seen = 0;
  let complete = true;
  let level = [""];
  for (let depth = 1; depth <= FIND_DEPTH; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let names: string[];
      try { names = fs.readdirSync(path.join(root, rel)); } catch { complete = false; continue; }
      for (const name of names) {
        if (++seen > FIND_CAP) return { at: null, complete: false };
        const childRel = rel ? `${rel}/${name}` : name;
        const fid = folderId(path.join(root, childRel));
        if (fid === null) continue;
        if (fid === id) return { at: childRel, complete: true };
        if (depth === FIND_DEPTH) complete = false; // a folder we won't look inside
        next.push(childRel);
      }
    }
    level = next;
  }
  return { at: null, complete };
}

/**
 * Checks that `me` and each locked folder are real folders (not links) and, where an identity was recorded,
 * still the same folder. Returns the problems and the identities seen now (only for folders without a problem).
 * It never creates or changes anything.
 */
export function checkLockedFolders(root: string, locked: readonly LockableDir[], recorded: LockIds): { problems: LockProblem[]; current: LockIds } {
  const problems: LockProblem[] = [];
  const current: LockIds = {};
  const me = lstatKind(path.join(root, "me"));
  for (const d of locked) {
    let kind: LockProblemKind | null = null;
    if (me !== "folder") kind = me;
    else {
      const k = lstatKind(path.join(root, d));
      if (k !== "folder") kind = k;
      else {
        const id = folderId(path.join(root, d));
        if (id === null) kind = "unreadable";
        else if (recorded[d] && recorded[d] !== id) kind = "replaced";
        else current[d] = id;
      }
    }
    if (kind) {
      const was = recorded[d];
      problems.push({ folder: d, kind, foundAt: was ? findFolderById(root, was) : null });
    }
  }
  return { problems, current };
}

/**
 * Which locked folder `file` sits in when judged by folder identity, not path: walks from the file's real path up
 * to the workspace root and matches each folder against `ids`. Catches a locked folder that was renamed or moved.
 */
/** The real path of `p`, resolving the deepest part that exists (so a not-yet-existing file still maps correctly). */
function realDeepest(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { /* fall through */ }
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realDeepest(parent), path.basename(abs));
}

export function lockedFolderById(root: string, file: string, ids: Partial<Record<LockableDir, string | readonly string[]>>): LockableDir | null {
  const want = new Map<string, LockableDir>();
  for (const [d, v] of Object.entries(ids) as [LockableDir, string | readonly string[] | undefined][]) {
    for (const id of typeof v === "string" ? [v] : (v ?? [])) if (typeof id === "string") want.set(id, d);
  }
  if (!want.size) return null;
  const rootReal = realOrResolved(root);
  let p = realDeepest(file);
  while (p === rootReal || p.startsWith(rootReal + path.sep)) {
    const id = folderId(p);
    if (id !== null && want.has(id)) return want.get(id)!;
    if (p === rootReal) break;
    p = path.dirname(p);
  }
  return null;
}

const MAX_LOCKED_SCAN_ENTRIES = 20_000;
const MAX_LOCKED_SCAN_DEPTH = 16;

/**
 * "found": a regular-file entry with this dev/ino is in the tree. "absent": the whole
 * tree was read and it isn't there (or the folder doesn't exist at all). "incomplete":
 * part of the tree couldn't be checked (depth or entry limit reached, or any read
 * error, including an entry that vanished mid-walk), so the file may be in there.
 * Callers must treat "incomplete" as locked: this check fails closed.
 */
export type InodeScan = "found" | "absent" | "incomplete";

/**
 * True only when nothing at all is at root/rel (lstat says ENOENT, so not even a
 * link) and every folder between the workspace root and it is a real directory,
 * not a symlink. A dangling link, a renamed parent with a link left in its place,
 * or any other error means we can't say the folder is really gone.
 */
function lockedDirMissing(root: string, rel: string): boolean {
  const parts = rel.split("/");
  if (parts.length > 8) return false;
  try { fs.lstatSync(path.join(root, ...parts)); return false; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  for (let i = 1; i < parts.length; i++) {
    try {
      const st = fs.lstatSync(path.join(root, ...parts.slice(0, i)));
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch { return false; }
  }
  return true;
}

function treeContainsInode(root: string, rel: string, dev: bigint, ino: bigint): InodeScan {
  const dir = path.join(root, rel);
  let entries = 0;
  let incomplete = false;
  const stack: { p: string; depth: number }[] = [{ p: dir, depth: 0 }];
  while (stack.length) {
    const next = stack.pop()!;
    let names: string[];
    try { names = fs.readdirSync(next.p); }
    catch (e) {
      // Only a locked folder that is really not there is a clean "absent"; anything
      // else (a dangling link, a parent swapped for a link) is unknown.
      if (next.depth === 0 && (e as NodeJS.ErrnoException).code === "ENOENT" && lockedDirMissing(root, rel)) return "absent";
      incomplete = true;
      continue;
    }
    for (const n of names) {
      if (++entries > MAX_LOCKED_SCAN_ENTRIES) return "incomplete";
      const child = path.join(next.p, n);
      let st: fs.BigIntStats;
      try { st = fs.lstatSync(child, { bigint: true }); } catch { incomplete = true; continue; }
      if (st.isSymbolicLink()) continue; // an alias isn't where the bytes live
      if (st.isFile()) { if (st.dev === dev && st.ino === ino) return "found"; continue; }
      if (st.isDirectory()) {
        if (next.depth < MAX_LOCKED_SCAN_DEPTH) stack.push({ p: child, depth: next.depth + 1 });
        else incomplete = true;
      }
    }
  }
  return incomplete ? "incomplete" : "absent";
}

/** A locked folder the fd lives in ("contains"), or one that couldn't be fully checked ("unverifiable"). */
export interface LockedHit { folder: LockableDir; reason: "contains" | "unverifiable" }

/**
 * Whether the open file descriptor `fd` is, right now, a file that physically lives
 * inside one of the currently-locked folders (a lockable folder with no active
 * grant) -- decided by dev/ino membership, never by resolving or comparing any path
 * string.
 *
 * Any path-based "is this locked" check needs at least one more path resolution
 * after the file is already open, to turn its location back into a string worth
 * comparing -- and every extra resolution reopens a fresh TOCTOU window. On macOS in
 * particular that gap is real: a realpath/stat interleave can make a file that is
 * genuinely inside a locked folder come back as "not locked" if anything on the path
 * shifts between the resolve and the compare. Walking the small, fixed set of locked
 * folders with lstat (never following a symlink) and comparing the dev/ino the
 * kernel already gave us for the pinned fd has no such window: the fd's identity
 * can't change once it's open, and this never needs to resolve the fd's own path.
 *
 * Bounded by MAX_LOCKED_SCAN_ENTRIES/MAX_LOCKED_SCAN_DEPTH so a pathologically large
 * or deep locked folder can't turn every attachment check into an unbounded scan.
 * The walk fails closed: if a folder is too large, too deep or partly unreadable to
 * check fully, it comes back as { reason: "unverifiable" }, never as "not locked".
 * A "contains" hit in one folder wins over an "unverifiable" one in another.
 *
 * `ignoreGrants` walks every locked folder, active grant or not. resolveAttachment
 * uses that only to label an allowed-once attachment as "from a locked folder".
 */
export function lockedFolderForFd(root: string, fd: number, c?: Clock, opts: { ignoreGrants?: boolean } = {}): LockedHit | null {
  const target = fs.fstatSync(fd, { bigint: true });
  if (!target.isFile()) return null;
  let unverifiable: LockableDir | null = null;
  for (const d of opts.ignoreGrants ? readMeta(root).privacy.locked : lockedOrAll(root, c)) {
    const r = treeContainsInode(root, d, target.dev, target.ino);
    if (r === "found") return { folder: d, reason: "contains" };
    if (r === "incomplete" && !unverifiable) unverifiable = d;
  }
  return unverifiable ? { folder: unverifiable, reason: "unverifiable" } : null;
}

/** Ends grants whose time is up, marks their requests expired and logs it. The SessionStart hook runs this. */
export function expireGrantsAndLog(root: string, c?: Clock): { expired: string[] } {
  const gone = expireGrants(root, c);
  for (const g of gone) {
    // The folder itself is already re-locked above (expireGrants did that for every
    // grant in `gone` before this loop starts); only the request's own bookkeeping
    // happens per grant below, so one bad request record must never stop the rest
    // of this sweep -- the remaining grants still need to be re-locked and logged.
    logActivity(root, "Re-locked", `${g.folder} (time is up)`, c);
    try {
      if (readAccessRequest(root, g.request_id).status === "allowed") decideAccessRequest(root, g.request_id, "expired", {}, c);
    } catch (e) {
      // The request file is simply gone (e.g. cleaned up separately) -- fine to skip.
      if (e instanceof Error && e.message.startsWith("no request ")) continue;
      // Anything else (a corrupted request file, a bug) is logged as one plain line,
      // without the exception's own message (which could contain raw file content),
      // and this sweep keeps going rather than aborting the rest of the grants.
      logActivity(root, "Re-lock bookkeeping skipped", `${g.folder}: its access request couldn't be read`, c);
    }
  }
  return { expired: gone.map((g) => g.folder) };
}
