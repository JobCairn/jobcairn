import fs from "node:fs";
import path from "node:path";
import { insideRoot, isEmailAddress, listApprovals, proposeApproval, setStatus, writeFileAtomic } from "@careeros/core";
import { applyStep, buildApplyPrompt, fileKind, type ApplyState, type ClaimLink, type JobFile } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import { isPlaceholderFile } from "./placeholder.js";
import { realDirInRoot } from "./files.js";
import type { HandlerTable } from "./handlers.js";
import { lockedFor } from "./integrity.js";
import { withEmail } from "./mail-read.js";
import { profileLanguages } from "./languages.js";
import { companyResearchAt } from "./research.js";
import { appApprovals, approvalView, jobDetail, jobDirRel, rememberAppApproval, touch } from "./read.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

/**
 * The job's application/ folder, or null when it is missing. Throws when something other than a real
 * folder inside the workspace (and outside every locked area) sits there, such as a symlink.
 */
function appDir(ctx: ServiceContext, root: string, slug: string, id: string): string | null {
  const rel = `${jobDirRel(slug, id)}/application`;
  const dir = path.join(root, rel);
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return null; }
  if (st.isSymbolicLink() || !st.isDirectory() || !insideRoot(root, dir) || lockedFor(ctx, root, dir)) {
    throw new Error(`${rel} isn't a real folder in your workspace. Fix it before preparing this application.`);
  }
  return dir;
}

/** Like appDir, but a bad folder reads as "nothing there" so the job page still opens. */
function appDirForReading(ctx: ServiceContext, root: string, slug: string, id: string): string | null {
  try { return appDir(ctx, root, slug, id); } catch { return null; }
}

/**
 * Files the person could send: not dot names (application/.studio holds the Resume Studio's style and Claude's
 * suggested rewrite, .versions its history) and not a studio file left at the top level by a stray run. Claude's
 * suggestion is never "ready to send" until it is accepted into the resume itself.
 */
export function isApplicationFile(name: string): boolean {
  return !name.startsWith(".") && !/(\.style\.json|-suggestions\.json|\.suggested\.md)$/i.test(name);
}

function appFiles(ctx: ServiceContext, root: string, slug: string, id: string): JobFile[] {
  const rel = `${jobDirRel(slug, id)}/application`;
  const dir = appDirForReading(ctx, root, slug, id);
  if (!dir) return [];
  return fs.readdirSync(dir).filter(isApplicationFile).sort().flatMap((n): JobFile[] => {
    const st = fs.lstatSync(path.join(dir, n));
    if (!st.isFile()) return [];
    // A cover letter the person turned off is only a placeholder: never shown for review.
    if (isPlaceholderFile(path.join(dir, n))) return [];
    return [{ path: `application/${n}`, rel: `${rel}/${n}`, label: n, at: st.mtime.toISOString(), exists: true, size: st.size, kind: fileKind(n) }];
  });
}

/**
 * claims.json must be a list of objects with a `claim` string; anything else counts as "no
 * claims". A claim is kept even when its `source` is missing or not a string - that is a real
 * finding (an unsourced claim the person still needs to check), not a parse failure, so it
 * comes back as `source: ""` rather than being dropped on the floor.
 */
function readClaims(ctx: ServiceContext, root: string, slug: string, id: string): ClaimLink[] | null {
  const dir = appDirForReading(ctx, root, slug, id);
  if (!dir) return null;
  const f = path.join(dir, "claims.json");
  try {
    if (fs.lstatSync(f).isSymbolicLink()) return null;
    const v = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
    if (!Array.isArray(v)) return null;
    return v.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && typeof c.claim === "string")
      .map((c) => ({ claim: c.claim as string, source: typeof c.source === "string" ? c.source : "" }));
  } catch { return null; }
}

/** The address to email an application to, when apply_via is a plain address or a mailto: link; otherwise "". */
export function applyEmailOf(applyVia: string): string {
  const v = applyVia.trim().replace(/^mailto:/i, "").split("?")[0]!;
  return isEmailAddress(v) ? v : "";
}

export function applyState(ctx: ServiceContext, slug: string, id: string): ApplyState {
  const root = ctx.requireRoot();
  const d = jobDetail(root, slug, id);
  const files = appFiles(ctx, root, slug, id);
  // The latest hand-off, or the latest email send proposed as an application (with its exact preview while it waits).
  const mine = appApprovals(ctx, root);
  const approval = listApprovals(root)
    .filter((a) => a.payload.company_slug === slug && a.payload.id === id && (a.action === "apply_handoff" || (a.action === "email_send" && a.payload.purpose === "apply")))
    .map((a) => withEmail(root, approvalView(a, mine), ctx.clock())).at(-1) ?? null;
  const company = d.company?.name ?? slug;
  return {
    company_slug: slug, id, title: d.job.title, company_name: company,
    url: [d.job.apply_via, d.job.url].find((u) => u.startsWith("https://")) ?? "",
    step: applyStep(d.job.status, files, approval), files, claims: readClaims(ctx, root, slug, id), approval,
    // The same language and research lines as the tailor action's own run (promptInfo).
    prompt: buildApplyPrompt(d.job.title, company, slug, id, { languages: profileLanguages(root), researched_at: companyResearchAt(root, slug) || undefined, now: ctx.now().toISOString() }),
    apply_email: applyEmailOf(d.job.apply_via),
  };
}

function prepare(ctx: ServiceContext, slug: string, id: string): ApplyState {
  const root = ctx.requireRoot();
  const s = applyState(ctx, slug, id);
  const rel = `${jobDirRel(slug, id)}/application`;
  const dir = appDir(ctx, root, slug, id) ?? realDirInRoot(root, path.join(root, rel), rel);
  const file = path.join(dir, "PREPARE.md");
  if (!fs.existsSync(file)) writeFileAtomic(file, `# Prepare this application\n\nPaste this into Claude:\n\n${s.prompt}\n`);
  const status = jobDetail(root, slug, id).job.status;
  if (status === "Found" || status === "Saved") setStatus(root, slug, id, "Applying", "Preparing the application", ctx.clock());
  touch(root, jobDirRel(slug, id));
  return applyState(ctx, slug, id);
}

function requestApproval(ctx: ServiceContext, slug: string, id: string): ApplyState {
  const root = ctx.requireRoot();
  const s = applyState(ctx, slug, id);
  const files = s.files.filter((f) => !f.path.endsWith("PREPARE.md") && f.path.split("/").every(isApplicationFile));
  if (!files.length) throw new Error("Nothing to hand off yet. Prepare the application first.");
  if (!s.url) throw new Error("Add the job's https apply link first.");
  if (listApprovals(root, { status: "pending" }).some((a) => a.action === "apply_handoff" && a.payload.company_slug === slug && a.payload.id === id)) {
    throw new Error("A hand-off for this job is already waiting for you.");
  }
  const a = proposeApproval(root, {
    action: "apply_handoff", title: `Hand off application to ${s.company_name}`, summary: `${files.length} file(s) ready for ${s.title}.`,
    steps: [`Open ${s.url} in your browser`, `Show the application folder (${files.length} files)`, 'Add a timeline event "Handed off"'],
    payload: { company_slug: slug, id, url: s.url, files: files.map((f) => f.path) }, created_by: "app",
  }, ctx.clock());
  rememberAppApproval(ctx, root, a);
  return applyState(ctx, slug, id);
}

function markApplied(ctx: ServiceContext, slug: string, id: string): ApplyState {
  const root = ctx.requireRoot();
  setStatus(root, slug, id, "Applied", `Marked applied in ${identity.name}`, ctx.clock());
  touch(root, jobDirRel(slug, id));
  return applyState(ctx, slug, id);
}

export const applyHandlers = {
  "apply.state": applyState,
  "apply.prepare": prepare,
  "apply.requestApproval": requestApproval,
  "apply.markApplied": markApplied,
} satisfies Partial<HandlerTable>;
