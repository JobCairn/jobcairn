import fs from "node:fs";
import path from "node:path";
import {
  addEvent, forgetTrash, layout, listApprovals, listJobs, listTrash, moveToTrash, purgeTrash, readRecord, refreshIndex, restoreFromTrash,
  trashPurgeAt, updateRecord, type TrashEntry, type TrashKind, type TrashMailMove,
} from "@careeros/core";
import { MAIL_REF, moveMessage, readStored, updateStored, type StoreTarget } from "@careeros/mail";
import type { ClaudeRunView, ResumeItemRef, TrashCheck, TrashItem, TrashTarget } from "@careeros/contract";
import { claudeEngineHandlers } from "./claude/index.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { learnList } from "./learn.js";
import { resumeTrashItem } from "./resumes.js";
import { researchTrashInfo } from "./research.js";
import { videoBusyUnder, videoTrashCheck } from "./video.js";

/**
 * Delete with Undo. Each target becomes a plan (what moves, what it is called, why it can't go now); every plan is
 * made and checked before anything moves, so one refusal moves nothing. Emails in a deleted job move up to its
 * company, and emails in a deleted company move to To sort in Mail, so mail stays in Mail. Restore moves them back.
 */
interface Plan {
  kind: TrashKind; title: string; also: string; note: string; blocked: string | null;
  rels: string[];
  /** Emails to move out first, and where to. */
  mail: { ref: string; to: StoreTarget }[];
  /** A job file's entry in job.json, taken out on delete and put back on restore. */
  jobFile?: { slug: string; id: string; path: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const JOB_FILE_KEEP = new Set(["job.json", "jd.md"]);

function companyName(root: string, slug: string): string {
  try { return readRecord("company", layout(root).companyFile(slug)).name || slug; } catch { return slug; }
}

/** Stored emails (their refs) directly in a workspace folder such as companies/acme/emails. */
function emailRefs(root: string, rel: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(root, rel)); } catch { return []; }
  return names.filter((n) => n.endsWith(".json")).map((n) => `${rel}/${n}`).filter((r) => MAIL_REF.test(r)).sort();
}

const activeRuns = (ctx: ServiceContext): ClaudeRunView[] => {
  try { return claudeEngineHandlers["claude.runs"](ctx).filter((r) => r.status === "queued" || r.status === "running"); } catch { return []; }
};
const runOn = (r: ClaudeRunView, slug: string, id?: string): boolean => {
  const t = r.target as { kind: string; company_slug?: string; id?: string };
  if (t.company_slug !== slug) return false;
  return id === undefined || t.id === id;
};
const pendingFor = (root: string, slug: string, id?: string): boolean => {
  try { return listApprovals(root, { status: "pending" }).some((a) => a.payload.company_slug === slug && (id === undefined || a.payload.id === id)); } catch { return false; }
};

function jobRecord(root: string, slug: string, id: string) {
  const L = layout(root);
  if (!fs.existsSync(L.jobFile(slug, id))) throw new Error("That job isn't there any more.");
  return readRecord("job", L.jobFile(slug, id));
}

function jobBlocked(ctx: ServiceContext, root: string, slug: string, id: string, runs: ClaudeRunView[]): string | null {
  if (runs.some((r) => runOn(r, slug, id))) return "Claude is working on this job. Wait for it to finish, or cancel it in Activity.";
  if (videoBusyUnder(ctx, `companies/${slug}/jobs/${id}`)) return "A video for this job is being made. Wait for it to finish, or cancel it.";
  if (pendingFor(root, slug, id)) return "This job has something waiting for your approval. Approve or decline it first.";
  return null;
}

function plan(ctx: ServiceContext, t: TrashTarget, runs: ClaudeRunView[]): Plan {
  const root = ctx.requireRoot();
  const L = layout(root);
  switch (t.kind) {
    case "job": {
      const job = jobRecord(root, t.company_slug, t.id);
      const rel = `companies/${t.company_slug}/jobs/${t.id}`;
      const mail = emailRefs(root, `${rel}/emails`).map((ref) => ({ ref, to: { company_slug: t.company_slug, job_id: "" } as StoreTarget }));
      const co = companyName(root, t.company_slug);
      return {
        kind: "job", title: `${job.title || t.id} at ${co}`, also: "", rels: [rel], mail,
        note: mail.length ? `Its ${plural(mail.length, "email")} stay in Mail, under ${co}.` : "",
        blocked: jobBlocked(ctx, root, t.company_slug, t.id, runs),
      };
    }
    case "company": {
      if (!fs.existsSync(L.companyFile(t.company_slug))) throw new Error("That company isn't there any more.");
      const jobs = listJobs(root).filter((j) => j.company_slug === t.company_slug);
      const rel = `companies/${t.company_slug}`;
      const refs = [...emailRefs(root, `${rel}/emails`), ...jobs.flatMap((j) => emailRefs(root, `${rel}/jobs/${j.id}/emails`))];
      let blocked: string | null = null;
      if (runs.some((r) => runOn(r, t.company_slug))) blocked = "Claude is working on this company or one of its jobs. Wait for it to finish, or cancel it in Activity.";
      else if (videoBusyUnder(ctx, rel)) blocked = "A video for this company is being made. Wait for it to finish, or cancel it.";
      else if (pendingFor(root, t.company_slug)) blocked = "One of its jobs has something waiting for your approval. Approve or decline it first.";
      return {
        kind: "company", title: companyName(root, t.company_slug), also: jobs.length ? `its ${plural(jobs.length, "job")}` : "", rels: [rel],
        mail: refs.map((ref) => ({ ref, to: "triage" as const })),
        note: refs.length ? `Its ${plural(refs.length, "email")} stay in Mail, under To sort.` : "",
        blocked,
      };
    }
    case "job_file": {
      const job = jobRecord(root, t.company_slug, t.id);
      const parts = t.path.split("/");
      if (JOB_FILE_KEEP.has(t.path) || parts[0] === "emails" || parts.some((p) => p.startsWith("."))) throw new Error("That file belongs to the job itself, so it can't be deleted on its own.");
      const f = job.files.find((x) => x.path === t.path);
      if (!f) throw new Error("That file isn't one of this job's files.");
      const rel = `companies/${t.company_slug}/jobs/${t.id}/${t.path}`;
      if (!fs.existsSync(path.join(root, rel))) throw new Error("That file isn't there any more.");
      const label = f.label && f.label !== path.basename(t.path) ? f.label : path.basename(t.path);
      return {
        kind: "job_file", title: label, also: "", note: "", rels: [rel], mail: [],
        blocked: runs.some((r) => runOn(r, t.company_slug, t.id)) ? "Claude is working on this job. Wait for it to finish, or cancel it in Activity." : null,
        jobFile: { slug: t.company_slug, id: t.id, path: t.path },
      };
    }
    case "resume": {
      const r = resumeTrashItem(ctx, t.ref as ResumeItemRef);
      const busy = r.job && runs.some((x) => runOn(x, r.job!.slug, r.job!.id));
      const variantBusy = t.ref.kind === "variant" && runs.some((x) => (x.target as { kind: string; variant?: string }).variant === (t.ref as { variant: string }).variant);
      return {
        kind: "resume", title: r.title, also: "", note: "", rels: [r.rel], mail: [],
        blocked: busy || variantBusy ? "Claude is writing this resume. Wait for it to finish, or cancel it in Activity." : null,
        ...(r.job && fs.existsSync(L.jobFile(r.job.slug, r.job.id)) && readRecord("job", L.jobFile(r.job.slug, r.job.id)).files.some((f) => f.path === "application/resume.md")
          ? { jobFile: { slug: r.job.slug, id: r.job.id, path: "application/resume.md" } } : {}),
      };
    }
    case "topic": {
      const topic = learnList(ctx).topics.find((x) => x.slug === t.topic);
      if (!topic) throw new Error("That topic isn't in Learn any more.");
      const rel = `learning/${t.topic}`;
      const videos = fs.existsSync(path.join(root, rel, "videos")) ? fs.readdirSync(path.join(root, rel, "videos")).filter((n) => !n.startsWith(".")).length : 0;
      let blocked: string | null = null;
      if (runs.some((r) => (r.target as { kind: string; topic?: string }).kind === "topic" && (r.target as { topic?: string }).topic === t.topic)) blocked = "Claude is writing for this topic. Wait for it to finish, or cancel it in Activity.";
      else if (videoBusyUnder(ctx, rel)) blocked = "A video for this topic is being made. Wait for it to finish, or cancel it.";
      return { kind: "topic", title: topic.title, also: videos ? `its ${plural(videos, "video")}` : "", note: "", rels: [rel], mail: [], blocked };
    }
    case "research": {
      const info = researchTrashInfo(ctx, t.topic);
      const rel = `research/${t.topic}`;
      let blocked: string | null = null;
      if (runs.some((r) => (r.target as { kind: string; topic?: string }).kind === "research" && (r.target as { topic?: string }).topic === t.topic)) blocked = "Claude is researching this topic. Wait for it to finish, or cancel it in Activity.";
      else if (videoBusyUnder(ctx, rel)) blocked = "A video for this topic is being made. Wait for it to finish, or cancel it.";
      return { kind: "research", title: info.title, also: info.videos ? `its ${plural(info.videos, "video")}` : "", note: "", rels: [rel], mail: [], blocked };
    }
    case "video": {
      const v = videoTrashCheck(ctx, t.folder);
      return { kind: "video", title: v.title, also: "", note: "", rels: [t.folder], mail: [], blocked: v.blocked };
    }
  }
}

const view = (e: TrashEntry): TrashItem => ({ id: e.id, kind: e.kind, title: e.title, also: e.detail, deleted_at: e.deleted_at, purge_at: trashPurgeAt(e) });

/** Index paths to refresh after `rels` moved: a job or company folder also refreshes its videos. */
const refreshPaths = (rels: string[]) => rels.flatMap((r) => (r.startsWith("companies/") && r.split("/").length <= 4 ? [r, `${r}/videos`] : [r]));

function check(ctx: ServiceContext, t: TrashTarget): TrashCheck {
  const p = plan(ctx, t, activeRuns(ctx));
  return { title: p.title, also: p.also, note: p.note, blocked: p.blocked };
}

export function trashMove(ctx: ServiceContext, targets: TrashTarget[]): TrashItem[] {
  const root = ctx.requireRoot();
  const runs = activeRuns(ctx);
  const plans = targets.map((t) => plan(ctx, t, runs));
  const stop = plans.find((p) => p.blocked);
  if (stop) throw new Error(plans.length > 1 ? `"${stop.title}" can't be deleted right now: ${stop.blocked} Nothing was deleted.` : stop.blocked!);
  // A company and one of its own jobs in the same request: the company takes the job with it.
  const companies = new Set(plans.filter((p) => p.kind === "company").map((p) => p.rels[0]!));
  const todo = plans.filter((p) => p.kind === "company" || !p.rels.some((r) => [...companies].some((c) => r.startsWith(`${c}/`))));
  const out: TrashItem[] = [];
  for (const p of todo) {
    const moved: TrashMailMove[] = [];
    for (const m of p.mail) {
      let matched = "";
      try { matched = readStored(root, m.ref).email.matched_by; } catch { /* moveMessage says what is wrong */ }
      moved.push({ from: m.ref, to: moveMessage(root, m.ref, m.to, { byUser: false }), ...(matched ? { matched_by: matched } : {}) });
    }
    const jf = p.jobFile;
    const jobFile = jf ? layout(root).jobFile(jf.slug, jf.id) : "";
    const ref = jf ? readRecord("job", jobFile).files.find((f) => f.path === jf.path) ?? null : null;
    let entry: TrashEntry;
    try {
      entry = moveToTrash(root, { kind: p.kind, title: p.title, detail: p.also, rels: p.rels, mail: moved, meta: jf ? { job_file: { ...jf, ref } } : {} }, ctx.clock());
    } catch (e) {
      putMailBack(root, moved);
      throw e;
    }
    if (jf) {
      try {
        updateRecord("job", jobFile, (j) => { j.files = j.files.filter((f) => f.path !== jf.path); });
        addEvent(root, jf.slug, jf.id, "Deleted", p.title, ctx.clock());
      } catch { /* the file is in the trash; the job lists it as missing */ }
    }
    try { refreshIndex(root, refreshPaths([...p.rels, ...moved.map((m) => m.to)])); } catch { /* the next read rebuilds the index */ }
    out.push(view(entry));
  }
  return out;
}

/** Emails moved out on delete go back where they were, if they are still where the delete put them. */
function putMailBack(root: string, moved: TrashMailMove[]): string[] {
  const touched: string[] = [];
  for (const m of moved) {
    const segs = m.from.split("/");
    const to: StoreTarget = segs[2] === "jobs" ? { company_slug: segs[1]!, job_id: segs[3]! } : { company_slug: segs[1]!, job_id: "" };
    try {
      const back = moveMessage(root, m.to, to, { byUser: false });
      if (m.matched_by) updateStored(root, back, (e) => { e.matched_by = m.matched_by as typeof e.matched_by; });
      touched.push(back);
    } catch { /* moved or deleted since: it stays where it is now */ }
  }
  return touched;
}

function restore(ctx: ServiceContext, id: string): TrashItem {
  const root = ctx.requireRoot();
  const e = restoreFromTrash(root, id);
  const back = putMailBack(root, e.mail);
  const jf = e.meta.job_file as { slug: string; id: string; path: string; ref: { path: string } | null } | undefined;
  if (jf?.ref) {
    try {
      updateRecord("job", layout(root).jobFile(jf.slug, jf.id), (j) => { if (!j.files.some((f) => f.path === jf.path)) j.files.push(jf.ref as (typeof j.files)[number]); });
      addEvent(root, jf.slug, jf.id, "Restored", e.title, ctx.clock());
    } catch { /* the file is back; it just isn't listed */ }
  }
  try { refreshIndex(root, refreshPaths([...e.items, ...back, ...e.mail.map((m) => m.to)])); } catch { /* the next read rebuilds the index */ }
  return view(e);
}

function forget(ctx: ServiceContext, id: string, confirmed: boolean): void {
  if (confirmed !== true) throw new Error("Confirm first: this can't be undone.");
  forgetTrash(ctx.requireRoot(), id);
}

/** Opening a workspace removes entries deleted more than 30 days ago. Never stops the workspace opening. */
export function purgeOldTrash(ctx: ServiceContext, root: string): number {
  try { return purgeTrash(root, ctx.now()); } catch { return 0; }
}

export const trashHandlers = {
  "trash.check": check,
  "trash.move": trashMove,
  "trash.list": (ctx: ServiceContext): TrashItem[] => listTrash(ctx.requireRoot()).map(view),
  "trash.restore": restore,
  "trash.forget": forget,
  "resumes.remove": (ctx: ServiceContext, ref: ResumeItemRef): TrashItem => trashMove(ctx, [{ kind: "resume", ref }])[0]!,
  "video.delete": (ctx: ServiceContext, folder: string): TrashItem => trashMove(ctx, [{ kind: "video", folder }])[0]!,
} satisfies Partial<HandlerTable>;

