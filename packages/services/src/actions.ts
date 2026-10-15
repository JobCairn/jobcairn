import fs from "node:fs";
import path from "node:path";
import { careerosDir, insideRoot, layout, lockedFolderById, readRecord, writeFileAtomic } from "@careeros/core";
import {
  ACTIONS, actionKey, actionPaths, actionStatusView, buildActionPrompt, claudeWrites, deriveTarget, nextVideoFolder, ownTarget, studioOutputs, TEMPLATE_ONLY, videoFolderN,
  LOCKABLE_DIRS, type ActionId, type ActionPrepared, type ActionStatusView, type ActionTarget, type FolderProbe, type LockableDir, type Probe,
  type PromptInfo, type WorkRightsStatus, WR_STATUSES, withSavedSearchOptions,
} from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { lockIdHistory, recordedLockIds } from "./integrity.js";
import { jobDetail } from "./read.js";
import { savedRequest } from "./request-store.js";
import { WEB_ACTIONS } from "./claude/args.js";
import { resumeTextRel } from "./resume-fill.js";
import { readSearchPrefs, webContext } from "./claude/context.js";

const REQUESTED = /^Requested: (\S+)$/m;
const FOLDER = /^Folder: (\S+)$/m;
/** The note's header ends here; the prompt (which carries ad text) follows and is never parsed. */
const PROMPT_START = "\nPaste this into Claude:";
const NOTE_MAX_BYTES = 64 * 1024;

/** `.careeros/actions/`: one Markdown hand-off note per request, kept out of job and learning folders so no screen lists it as content. */
export function actionsDir(root: string): string {
  const dir = path.join(careerosDir(root), "actions");
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(dir); } catch { st = undefined; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(".careeros/actions must be a plain folder.");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface NoteHeader { at: string; folder: string }

const NO_NOTE: NoteHeader = { at: "", folder: "" };

/** A plain folder (not a link), checked with lstat. */
const plainDir = (p: string) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };

/**
 * When the open request was made and, for a video, the folder it asked for, from the note's header lines.
 * The note is opened without following links and must be one regular, single-named file of at most 64 KB inside
 * plain .careeros and .careeros/actions folders; anything else counts as no request.
 */
function readNote(ctx: ServiceContext, root: string, key: string): NoteHeader {
  const top = path.join(root, ".careeros");
  const dir = path.join(top, "actions");
  if (!plainDir(top) || !plainDir(dir)) return NO_NOTE;
  let fd: number;
  try { fd = fs.openSync(path.join(dir, `${key}.md`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return NO_NOTE; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > NOTE_MAX_BYTES) return NO_NOTE;
    const buf = Buffer.alloc(NOTE_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > NOTE_MAX_BYTES) return NO_NOTE;
    const head = buf.subarray(0, n).toString("utf8").split(PROMPT_START)[0] ?? "";
    const folder = head.match(FOLDER)?.[1] ?? "";
    return { at: head.match(REQUESTED)?.[1] ?? "", folder: folder && writableProblem(ctx, root, folder) === null ? folder : "" };
  } catch { return NO_NOTE; } finally { fs.closeSync(fd); }
}

/**
 * Why Claude can't be sent to write at `rel`, or null when it can. The path must be plain and relative; no part of
 * it that exists may be a link, or a file with a second name; the nearest existing part must really be inside the
 * workspace; and it must not be in (or contain) a lockable folder, by path or by the recorded identity of one that
 * was moved, whatever the grants say. Returns the workspace-relative part to name in the message.
 */
export function writableProblem(ctx: ServiceContext, root: string, rel: string, studio: readonly string[] = []): string | null {
  const parts = rel.split("/");
  // No dot segment, with one narrow exception: `studio` lists the exact `<job>/application/.studio/<name>` outputs the
  // running action declares (studioOutputs, only rewrite_resume today). A link anywhere on the way is refused below.
  const studioSeg = (p: string, i: number) => p === ".studio" && i === parts.length - 2 && studio.includes(rel);
  if (!rel || rel.length > 1024 || rel.includes("\\") || rel.startsWith("/") || parts.some((p, i) => p === "" || (p.startsWith(".") && !studioSeg(p, i)))) return rel || ".";
  if ((LOCKABLE_DIRS as readonly string[]).some((d) => rel === d || rel.startsWith(`${d}/`) || d.startsWith(`${rel}/`))) return rel;
  let deepest = root;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(deepest, parts[i]!);
    let st: fs.Stats;
    try { st = fs.lstatSync(next); } catch { break; }
    // A link, or a file with a second name (a hard link may be a locked file under another name), is never written through.
    if (st.isSymbolicLink() || (!st.isDirectory() && st.nlink > 1)) return parts.slice(0, i + 1).join("/");
    deepest = next;
  }
  if (!insideRoot(root, deepest)) return rel;
  const ids: Partial<Record<LockableDir, string[]>> = {};
  const recorded = recordedLockIds(ctx, root);
  const history = lockIdHistory(ctx, root);
  for (const d of LOCKABLE_DIRS) ids[d] = [...(recorded[d] ? [recorded[d]!] : []), ...(history[d] ?? [])];
  return lockedFolderById(root, deepest, ids) ? rel : null;
}

/** Refuses, with a plain message, to send Claude to write anywhere that isn't a plain folder in the workspace. */
function assertWritable(ctx: ServiceContext, root: string, rels: string[], studio: readonly string[] = []): void {
  for (const rel of rels) {
    const bad = writableProblem(ctx, root, rel, studio);
    if (bad !== null) throw new Error(`${bad} isn't a plain folder in the workspace, so Claude can't be asked to write there.`);
  }
}

/**
 * An output counts only as a regular, single-named file whose real path is exactly where it should be:
 * no symlink anywhere on the way (so nothing outside the workspace, nothing in a linked folder) and no hard link.
 */
export function probeFor(root: string): Probe {
  let realRoot: string;
  try { realRoot = fs.realpathSync.native(root); } catch { return () => ({ exists: false, at: "" }); }
  return (rel) => {
    const abs = path.join(root, ...rel.split("/"));
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.nlink > 1) return { exists: false, at: "" };
      if (fs.realpathSync.native(abs) !== path.join(realRoot, ...rel.split("/"))) return { exists: false, at: "" };
      return { exists: true, at: st.mtime.toISOString() };
    } catch { return { exists: false, at: "" }; }
  };
}

/** Anything at all at a path (a folder, a file, even a broken link) takes that video folder number. */
export function folderProbeFor(root: string): FolderProbe {
  return (rel) => {
    try { fs.lstatSync(path.join(root, ...rel.split("/"))); return true; } catch { return false; }
  };
}

/** The candidate's work-rights status from the profile, or "unknown" (no sponsorship) when it can't be read. */
export function workRightsStatus(root: string): WorkRightsStatus {
  try {
    const s = readRecord("profile", layout(root).profile).work_rights?.status;
    return (WR_STATUSES as readonly string[]).includes(s as string) ? (s as WorkRightsStatus) : "unknown";
  } catch { return "unknown"; }
}

/**
 * Job title, company name and the candidate's work-rights status for the prompt. Throws a plain message for a job
 * or company that is gone.
 */
export function promptInfo(root: string, t: ActionTarget): PromptInfo {
  const work_rights = workRightsStatus(root);
  const job = deriveTarget(t, "job");
  if (job?.kind === "job") {
    const d = jobDetail(root, job.company_slug, job.id);
    return { title: d.job.title, company: d.company?.name ?? job.company_slug, work_rights };
  }
  const company = deriveTarget(t, "company");
  if (company?.kind === "company") return { company: readRecord("company", layout(root).companyFile(company.company_slug)).name, work_rights };
  // Workspace actions: suggest_targets reads the resume "Fill from my resume" copied in (its text version).
  return { work_rights, resume: resumeTextRel(root) || undefined };
}

export function actionStatus(ctx: ServiceContext, id: ActionId, target: ActionTarget): ActionStatusView {
  const root = ctx.requireRoot();
  const t = ownTarget(id, target);
  const note = readNote(ctx, root, actionKey(id, t));
  return actionStatusView({
    id, target: t, info: promptInfo(root, t), requested_at: note.at, requested_folder: note.folder, now: ctx.now(),
    probe: probeFor(root), folders: folderProbeFor(root),
  });
}

/** Writes the hand-off note, copies the prompt and opens Claude Desktop if asked. Nothing is run. */
async function prepare(ctx: ServiceContext, id: ActionId, target: ActionTarget, open: boolean): Promise<ActionPrepared> {
  // The video lane's template makes weekly recaps; an old renderer must not get a Claude prompt for one.
  if (!claudeWrites(id)) throw new Error(TEMPLATE_ONLY);
  const root = ctx.requireRoot();
  const t = ownTarget(id, target);
  // Check where Claude would write before reading anything else about the target: a linked company or topic
  // folder may point into a locked folder.
  const first = actionPaths(id, t, { now: ctx.now().toISOString(), n: 1 });
  assertWritable(ctx, root, [first.folder, ...first.outputs, ...first.extras], studioOutputs(id, first.outputs));
  const before = actionStatus(ctx, id, t);
  if (before.status === "blocked") throw new Error(`Do "${before.blockedBy.map((r) => ACTIONS[r].label).join('" and "')}" first.`);
  const now = ctx.now().toISOString();
  const info = { ...promptInfo(root, t), now };
  let n = 1;
  let folderLine = "";
  if (ACTIONS[id].group === "video") {
    // "Ask again" on an open, unfinished request reuses its folder. A new request, or "Redo" after the video is
    // ready, takes the next free one.
    const open = before.status === "pending" ? readNote(ctx, root, before.key) : null;
    const reuse = open?.folder ? videoFolderN(id, t, { ...info, now: before.requested_at }, open.folder) : null;
    const next = reuse ?? nextVideoFolder(id, t, info, folderProbeFor(root))?.n ?? null;
    if (next === null) throw new Error("There are too many videos in this folder. Delete some old ones first.");
    n = next;
    folderLine = `Folder: ${actionPaths(id, t, { ...info, n }).folder}\n`;
  }
  const chosen = actionPaths(id, t, { ...info, n });
  assertWritable(ctx, root, [chosen.folder, ...chosen.outputs, ...chosen.extras], studioOutputs(id, chosen.outputs));
  // The options last chosen in the request composer for this action and target (no note), else the plain prompt.
  // A web action's steps refer to the details given with the request, so the copied prompt carries them too.
  const saved = savedRequest(root, id, t, info.work_rights);
  const base = buildActionPrompt(id, t, { ...info, n }, id === "find_jobs" ? withSavedSearchOptions(saved, readSearchPrefs(root), info.work_rights) : saved);
  const prompt = WEB_ACTIONS.includes(id) ? `${webContext(root, id, t, ctx.now())}\n\n${base}` : base;
  writeFileAtomic(path.join(actionsDir(root), `${before.key}.md`), `# ${ACTIONS[id].label}\n\nRequested: ${now}\n${folderLine}\nPaste this into Claude:\n\n${prompt}\n`);
  let copied = true;
  try { ctx.host.shell.copyText(prompt); } catch { copied = false; }
  const opened = open ? await ctx.host.shell.openClaudeDesktop() : false;
  return { ...actionStatus(ctx, id, t), prompt, copied, opened };
}

export const actionHandlers = {
  "claude.status": actionStatus,
  "claude.prepare": prepare,
} satisfies Partial<HandlerTable>;
