import fs from "node:fs";
import path from "node:path";
import { assertSegment, attachFile, careerosDir, fileInboxItem, insideRoot, JOB_SUBDIRS, jobFilePath, layout, uniquePath } from "@careeros/core";
import { LOCKABLE_DIRS, lockProblemMessage, type InboxItem, type ResumeFieldKey, type ResumeValues, type InboxPutBack, type InboxTarget, type JobSubdir, type LockableDir } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { InboxOrigin } from "./host.js";
import { checkIncomingFile, copyIncoming, realDirInRoot } from "./files.js";
import type { HandlerTable } from "./handlers.js";
import { verifyLockedFolders } from "./integrity.js";
import { inboxOverview } from "./folders.js";
import { inboxItems, jobDetail, jobDirRel, touch } from "./read.js";
import { askClaude, classifyItem, forgetSmart, smartItems } from "./inbox-smart.js";
import { fillFromResume, readResume } from "./resume-fill.js";
import { textReader } from "./inbox-text.js";
import { MAX_JD_BYTES, MCP_TOOLS, mcpSession } from "./claude/mcp/tools.js";

function add(ctx: ServiceContext, paths: string[]): Promise<InboxItem[]> {
  const root = ctx.requireRoot();
  // Check every file first, so one bad file adds nothing.
  const files = paths.map((p) => checkIncomingFile(root, p));
  const dir = realDirInRoot(root, layout(root).inbox, "inbox/");
  const written: string[] = [];
  const origins: Record<string, InboxOrigin> = {};
  try {
    for (const f of files) {
      const dest = uniquePath(path.join(dir, f.name));
      copyIncoming(f, dest);
      written.push(dest);
      // Keyed by the name the copy got (cv-2.pdf), pinned to the copy itself.
      const st = fs.lstatSync(dest);
      origins[path.basename(dest)] = { path: f.abs, dev: st.dev, ino: st.ino };
    }
  } catch (e) {
    // A copy that fails part-way leaves the inbox as it was.
    for (const w of written) fs.rmSync(w, { force: true });
    throw e;
  }
  writeOrigins(ctx, root, { ...readOrigins(ctx, root), ...origins });
  return listItems(ctx);
}

// ---- Where drop box files came from (app state, outside the workspace) ----

function readOrigins(ctx: ServiceContext, root: string): Record<string, InboxOrigin> {
  const mine = ctx.host.state.read().inboxOrigins?.[root];
  return mine && typeof mine === "object" ? mine : {};
}

function writeOrigins(ctx: ServiceContext, root: string, next: Record<string, InboxOrigin>): void {
  const s = ctx.host.state.read();
  const all = { ...s.inboxOrigins };
  if (Object.keys(next).length) all[root] = next;
  else delete all[root];
  ctx.host.state.write({ ...s, inboxOrigins: all });
}

/** The origin of `name`, only while the drop box file is still the very copy the app made. */
function originOf(root: string, origins: Record<string, InboxOrigin>, name: string): InboxOrigin | null {
  const o = Object.hasOwn(origins, name) ? origins[name] : undefined;
  if (!o) return null;
  try {
    const st = fs.lstatSync(path.join(layout(root).inbox, name));
    return st.isFile() && st.dev === o.dev && st.ino === o.ino ? o : null;
  } catch { return null; }
}

/** The folder's own name ("Downloads"), the only part of the origin the window sees. */
const folderLabel = (o: InboxOrigin) => path.basename(path.dirname(o.path)) || "its folder";

/**
 * The drop box list: `from` for files whose origin is still known (stale origins are dropped as it goes), and the
 * smart suggestion (content, then Claude) for each file.
 */
async function listItems(ctx: ServiceContext): Promise<InboxItem[]> {
  const root = ctx.requireRoot();
  const items = await smartItems(ctx, root, inboxItems(root));
  const origins = readOrigins(ctx, root);
  const kept: Record<string, InboxOrigin> = {};
  const out = items.map((it) => {
    const o = originOf(root, origins, it.name);
    if (!o) return it;
    kept[it.name] = o;
    return { ...it, from: folderLabel(o) };
  });
  if (Object.keys(kept).length !== Object.keys(origins).length) writeOrigins(ctx, root, kept);
  return out;
}

function forget(ctx: ServiceContext, root: string, names: string[]): void {
  for (const n of names) forgetSmart(ctx, root, n);
  const origins = readOrigins(ctx, root);
  if (!names.some((n) => Object.hasOwn(origins, n))) return;
  writeOrigins(ctx, root, Object.fromEntries(Object.entries(origins).filter(([n]) => !names.includes(n))));
}

/** A drop box file by name: a plain file directly in a real inbox/ folder, never the log, a dotfile, a link or a folder. */
export function inboxFile(root: string, name: string): string {
  try { assertSegment(name, "inbox file name"); } catch { throw new Error(`"${name}" is not an inbox file name`); }
  if (name.startsWith(".") || name === "_filed.md") throw new Error(`"${name}" is not an inbox file name`);
  const dir = layout(root).inbox;
  let dst: fs.Stats;
  try { dst = fs.lstatSync(dir); } catch { throw new Error(`"${name}" is not in the drop box`); }
  if (dst.isSymbolicLink() || !dst.isDirectory() || !insideRoot(root, dir)) throw new Error("refusing to use an inbox outside the workspace");
  const abs = path.join(dir, name);
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { throw new Error(`"${name}" is not in the drop box`); }
  if (!st.isFile()) throw new Error(`"${name}" is not in the drop box`);
  return abs;
}

function trashFn(ctx: ServiceContext): (abs: string) => Promise<void> {
  const t = ctx.host.shell.trashItem;
  if (!t) throw new Error("Moving files to the Trash isn't available here, so nothing was removed.");
  return (abs) => t.call(ctx.host.shell, abs);
}

/** Moves the named drop box files to the Trash. Every name is checked first, so one bad name removes nothing. */
async function remove(ctx: ServiceContext, names: string[]): Promise<InboxItem[]> {
  const root = ctx.requireRoot();
  const files = [...new Set(names)].map((n) => ({ name: n, abs: inboxFile(root, n) }));
  const trash = trashFn(ctx);
  const done: string[] = [];
  try {
    for (const f of files) { await trash(f.abs); done.push(f.name); }
  } finally {
    forget(ctx, root, done);
  }
  return listItems(ctx);
}

const hidden = (p: string) => p.split(path.sep).some((seg) => seg.startsWith("."));

/**
 * Put back. The drop box holds a copy (inbox.add copies), so: when the original is still where it was, the copy goes
 * to the Trash and the original is left alone; when it is gone, the copy moves back to that path, never overwriting.
 */
async function putBack(ctx: ServiceContext, name: string): Promise<InboxPutBack> {
  const root = ctx.requireRoot();
  const abs = inboxFile(root, name);
  const o = originOf(root, readOrigins(ctx, root), name);
  if (!o) throw new Error(`The drop box doesn't know where ${name} came from. Use Remove instead.`);
  const label = folderLabel(o);
  const dir = path.dirname(o.path);
  const gone = new Error(`${label} isn't there any more, so ${name} stays in the drop box. Use Remove instead.`);
  let dst: fs.Stats;
  try { dst = fs.lstatSync(dir); } catch { throw gone; }
  if (dst.isSymbolicLink() || !dst.isDirectory()) throw gone;
  let realDir: string;
  try { realDir = fs.realpathSync.native(dir); } catch { throw gone; }
  if (hidden(realDir) || insideRoot(root, realDir)) throw gone;

  let original: fs.Stats | null = null;
  try { original = fs.lstatSync(o.path); } catch { original = null; }
  let text: string;
  if (original) {
    await trashFn(ctx)(abs);
    text = `The original is still in ${label}, so the drop box copy went to the Trash.`;
  } else {
    const dest = uniquePath(o.path);
    try {
      fs.copyFileSync(abs, dest, fs.constants.COPYFILE_EXCL);
    } catch { throw new Error(`${name} can't be written to ${label}, so it stays in the drop box.`); }
    fs.rmSync(abs);
    text = `Moved ${name} back to ${label}.`;
  }
  forget(ctx, root, [name]);
  return { items: await listItems(ctx), text };
}

/** inbox.ask: Claude's look at one file (see inbox-smart.ts). Returns the list with the running chip. */
async function ask(ctx: ServiceContext, name: string): Promise<InboxItem[]> {
  const root = ctx.requireRoot();
  inboxFile(root, name);
  const item = inboxItems(root).find((i) => i.name === name);
  if (!item) throw new Error(`"${name}" is not in the drop box`);
  await askClaude(ctx, root, item);
  return listItems(ctx);
}

/**
 * "Use this to fill my profile": the waiting file's path stays in main. A file that looks like it belongs in a locked
 * folder (by kind, target or name) is never read for the profile, because its text would then be kept where Claude reads.
 */
async function waitingResume(ctx: ServiceContext, name: string): Promise<string> {
  const root = ctx.requireRoot();
  const abs = inboxFile(root, name);
  const item = inboxItems(root).find((i) => i.name === name);
  if (!item) throw new Error(`"${name}" is not in the drop box`);
  if ((await classifyItem(ctx, root, item)).locked) throw new Error("This file looks like it belongs in a locked folder, so it can't be used to fill your profile.");
  return abs;
}

async function readWaitingResume(ctx: ServiceContext, name: string) {
  return readResume(ctx, await waitingResume(ctx, name));
}

/**
 * Fills the profile and keeps a copy in Resumes (resume-fill's own saver). The drop box file would then be a second
 * copy, so it goes to the Trash (recoverable). If the Trash isn't available it just stays waiting.
 */
async function fillProfile(ctx: ServiceContext, name: string, values: ResumeValues, overwrite: ResumeFieldKey[]) {
  const abs = await waitingResume(ctx, name);
  const state = await fillFromResume(ctx, abs, values, overwrite);
  const root = ctx.requireRoot();
  try {
    await trashFn(ctx)(abs);
    forget(ctx, root, [name]);
  } catch { /* the copy in Resumes is what matters; the drop box file can be removed by hand */ }
  return state;
}

/** Ad text for job_new: at most MAX_JD_BYTES, cut on a character boundary. */
function jdText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_JD_BYTES) return text;
  let cut = Buffer.from(text, "utf8").subarray(0, MAX_JD_BYTES).toString("utf8");
  while (Buffer.byteLength(cut, "utf8") > MAX_JD_BYTES || cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Add as a job: creates the job the way Claude's job_new tool does (same validation), with the file's text as the
 * job's ad when it can be read here, then files the original into that job's folder.
 */
async function addAsJob(ctx: ServiceContext, name: string, job: { company: string; title: string }) {
  const root = ctx.requireRoot();
  const abs = inboxFile(root, name);
  let text: string | null = null;
  try { text = await textReader().read(abs, name); } catch { text = null; }
  const args = MCP_TOOLS.job_new.validate({ company: job.company, title: job.title, ...(text && text.trim() ? { jd_text: jdText(text) } : {}) }, "job");
  const made = MCP_TOOLS.job_new.run(mcpSession(root, ["job_new"]), args) as { company_slug: string; id: string };
  const items = await file(ctx, name, { kind: "job", company_slug: made.company_slug, id: made.id, subdir: "" }, "Job ad");
  return { items, job: { company_slug: made.company_slug, id: made.id } };
}

function file(ctx: ServiceContext, name: string, target: InboxTarget, note: string): Promise<InboxItem[]> {
  const root = ctx.requireRoot();
  // Filing creates its folder. Into a locked folder that was moved or replaced, that would make an empty
  // stand-in and hide where the real one went (final review I4), so it waits until Privacy is sorted out.
  const folder = target.kind === "me" ? `me/${target.dir}` : "";
  if ((LOCKABLE_DIRS as readonly string[]).includes(folder) && verifyLockedFolders(ctx, root).some((p) => p.folder === folder && p.kind !== "elsewhere")) {
    throw new Error(lockProblemMessage(folder as LockableDir));
  }
  fileInboxItem(root, name, target, note, ctx.clock());
  forget(ctx, root, [name]);
  if (target.kind === "job") touch(root, jobDirRel(target.company_slug, target.id));
  return listItems(ctx);
}

/**
 * Attaches a dropped or picked file to a job. The file is copied (by copyIncoming) into a private staging
 * folder under .careeros/tmp, and core moves that staged copy into the job, so core never reopens the
 * renderer's path.
 */
function attach(ctx: ServiceContext, slug: string, id: string, src: string, label: string, subdir: JobSubdir) {
  const root = ctx.requireRoot();
  // Defence in depth: the dispatcher already checks subdir, but nothing below may create a folder for an unknown one.
  if (!(JOB_SUBDIRS as readonly string[]).includes(subdir)) throw new Error(`unknown subdir "${subdir}"`);
  const f = checkIncomingFile(root, src);
  const jobDir = path.dirname(jobFilePath(root, slug, id));
  realDirInRoot(root, path.join(jobDir, subdir), subdir ? `${jobDirRel(slug, id)}/${subdir}` : jobDirRel(slug, id));
  const tmp = realDirInRoot(root, path.join(careerosDir(root), "tmp"), ".careeros/tmp");
  const stage = fs.mkdtempSync(path.join(tmp, "attach-"));
  try {
    const staged = path.join(stage, f.name);
    copyIncoming(f, staged);
    attachFile(root, slug, id, staged, { label, subdir, move: true }, ctx.clock());
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  touch(root, jobDirRel(slug, id));
  return jobDetail(root, slug, id);
}

export const inboxHandlers = {
  "inbox.list": listItems,
  "inbox.overview": inboxOverview,
  "inbox.add": add,
  "inbox.file": file,
  "inbox.remove": remove,
  "inbox.putBack": putBack,
  "inbox.ask": ask,
  "inbox.addAsJob": addAsJob,
  "inbox.readResume": readWaitingResume,
  "inbox.fillProfile": fillProfile,
  "jobs.attach": attach,
} satisfies Partial<HandlerTable>;
