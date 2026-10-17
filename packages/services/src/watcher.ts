import fs from "node:fs";
import path from "node:path";
import { refreshIndex } from "@careeros/core";
import { CHANGE_AREAS, LOCKABLE_DIRS, type ChangeArea } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import { verifyLockedFolders } from "./integrity.js";
import { restoreClaudeSettings } from "./privacy.js";

// .claude never reaches the index, but a change to Claude's settings file is checked (see touchesClaudeSettings).
const IGNORED_TOP = new Set([".index", ".backup", ".git", ".claude"]);
// Locked folders are never read by the app, so their edits are nobody's business; .careeros/tmp is scratch space.
const IGNORED_DIRS = [...LOCKABLE_DIRS, ".careeros/tmp"];

export function ignoredPath(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts.at(-1) ?? "";
  return IGNORED_TOP.has(parts[0]!) || IGNORED_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))
    || base === ".DS_Store" || base === "Thumbs.db" || base.endsWith("~") || /\.tmp$/.test(base) || base.endsWith("-journal");
}

/** A change that may have altered .claude/settings.json: the file itself, or the folder holding it (renamed, deleted). */
export function touchesClaudeSettings(rel: string): boolean {
  return rel === "" || rel === ".claude" || rel === ".claude/settings.json";
}

/**
 * A change that may have moved or replaced a locked folder: anything under `me`, or any top-level entry
 * (`mv me me-x` shows up as "me" and "me-x"; a new top-level folder may be where one went).
 */
export function touchesLockedFolders(rel: string): boolean {
  return rel === "" || rel === "me" || rel.startsWith("me/") || !rel.includes("/");
}

export function areasFor(rels: string[]): ChangeArea[] {
  const out = new Set<ChangeArea>();
  const add = (...as: ChangeArea[]) => as.forEach((a) => out.add(a));
  for (const rel of rels) {
    const [top, second] = rel.split("/");
    if (rel === "" || rel === "." || rel === "workspace.json") return [...CHANGE_AREAS];
    if (top === "settings") add("settings", "jobs", "home");
    else if (top === "companies") {
      add("jobs", "home", "sponsors", "learn");
      if (rel.split("/").includes("emails")) add("mail");
    }
    else if (top === "inbox") add("inbox", "home");
    else if (top === "learning" || top === "recaps" || top === "research") add("learn");
    else if (top === "knowledge") add(second === "sponsors.json" ? "sponsors" : "searches");
    else if (top === ".careeros" && second === "approvals") add("approvals", "home");
    else if (top === ".careeros" && (second === "mail-triage" || second === "mail-state.json")) add("mail", "home");
    // The send journal decides whether an approved send is "not sure", which the approval card shows.
    else if (top === ".careeros" && second === "mail-sends.jsonl") add("mail", "approvals", "home");
    // Staging and the send lock: mail's own working files.
    else if (top === ".careeros" && second?.startsWith("mail-")) add("mail");
    else if (top === ".careeros" && second === "actions") add("jobs", "learn", "searches");
    // Run records are written by the engine, which announces "claude" itself.
    else if (top === ".careeros" && second === "runs") add("claude");
    else if (top === ".careeros") add("privacy", "home");
    const parts = rel.split("/");
    if (top === "recaps" || parts.at(-1) === "video.json" || parts.some((p) => p === "videos" || p === "interview" || p === "summary-video")) {
      out.add("video");
      out.add("learn");
      if (top === "recaps") out.add("home");
    }
  }
  return [...out];
}

const logPlain = (what: string, e: unknown) => console.error(`careeros: ${what}: ${e instanceof Error ? e.message : String(e)}`);

/**
 * Debounces bursts: `fire` runs `wait` ms after the last poke, but never later than `maxWait` ms after
 * the first poke of a burst, so a file that changes non-stop still gets announced.
 */
export function debouncer(fire: () => void, wait: number, maxWait: number): { poke(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | undefined;
  const run = () => { timer = undefined; firstAt = undefined; fire(); };
  return {
    poke() {
      const now = Date.now();
      firstAt ??= now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, Math.max(0, Math.min(wait, firstAt + maxWait - now)));
    },
    cancel() { if (timer) clearTimeout(timer); timer = undefined; firstAt = undefined; },
  };
}

/**
 * Watches the whole workspace (recursive fs.watch: macOS, Windows, Linux on Node 20+), debounces,
 * refreshes the index for just the changed paths, then announces the screen areas they touch.
 * Never throws: a broken or vanished file is left for the index's skip list, and a failed watch is logged.
 */
export function startWatcher(ctx: ServiceContext, root: string, opts: { debounceMs?: number; maxWaitMs?: number } = {}): () => void {
  const pending = new Set<string>();
  let stopped = false;
  let settingsDue = false;
  let foldersDue = false;

  const flush = () => {
    const rels = [...pending];
    pending.clear();
    const checkSettings = settingsDue;
    const checkFolders = foldersDue;
    settingsDue = false;
    foldersDue = false;
    if (stopped || ctx.root !== root) return;
    if (checkFolders) verifyLockedFolders(ctx, root); // never throws; announces "privacy" when the problems change
    // Compares before writing, so our own rewrite comes back here once, matches, and stops.
    if (checkSettings) restoreClaudeSettings(ctx, root);
    if (!rels.length) return;
    try { refreshIndex(root, rels.includes("") ? ["."] : rels); } catch (e) { logPlain("couldn't refresh the index; the next read rebuilds it", e); }
    const areas = areasFor(rels);
    if (areas.length) ctx.emit(...areas); // emit isolates each listener
  };
  const debounce = debouncer(flush, opts.debounceMs ?? 300, opts.maxWaitMs ?? 2000);
  const queue = (rel: string) => {
    if (stopped) return;
    pending.add(rel);
    debounce.poke();
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, file) => {
      const rel = file ? file.toString().split(path.sep).join("/") : "";
      if (touchesClaudeSettings(rel) && !stopped) { settingsDue = true; debounce.poke(); }
      if (touchesLockedFolders(rel) && !stopped) { foldersDue = true; debounce.poke(); }
      if (rel && ignoredPath(rel)) return;
      queue(rel);
    });
  } catch (e) {
    logPlain("couldn't watch the workspace for outside changes", e);
    return () => {};
  }
  // If the OS drops the watcher (folder moved, too many files), fall back to a full refresh once.
  watcher.on("error", (e) => { logPlain("the workspace watcher stopped", e); queue(""); });

  return () => { stopped = true; debounce.cancel(); watcher.close(); };
}
