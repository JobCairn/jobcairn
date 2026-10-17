import fs from "node:fs";
import path from "node:path";
import { addConfirmedFact, addEvent, insideRoot, isEmailAddress, listApprovals, proposeApproval, setStatus, writeFileAtomic } from "@careeros/core";
import {
  applyStep, applyStretch, buildApplyPrompt, fileKind, parseReview, plainFact, REVIEW_REL,
  type ApplicationReview, type ApplyState, type ClaimLink, type JobFile, type ReviewFact, type ReviewStretch, type StretchChoice,
} from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import { isPlaceholderFile } from "./placeholder.js";
import { realDirInRoot } from "./files.js";
import type { HandlerTable } from "./handlers.js";
import { lockedFor } from "./integrity.js";
import { withEmail } from "./mail-read.js";
import { profileLanguages } from "./languages.js";
import { companyResearchAt } from "./research.js";
import { appApprovals, approvalView, jobDetail, jobDirRel, rememberAppApproval, touch } from "./read.js";
import { reviseDraft } from "./resume.js";
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

/** review.json as the app shows it (parseReview), plus the raw object so a decision can be written back into it. */
function readReviewFile(ctx: ServiceContext, root: string, slug: string, id: string): { review: ApplicationReview; raw: Record<string, unknown>; abs: string } | null {
  const dir = appDirForReading(ctx, root, slug, id);
  if (!dir) return null;
  const abs = path.join(dir, REVIEW_REL);
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_REVIEW_BYTES) return null;
    const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
    const review = parseReview(raw);
    return review ? { review, raw: raw as Record<string, unknown>, abs } : null;
  } catch { return null; }
}
const MAX_REVIEW_BYTES = 512 * 1024;

/**
 * The review item at `index` in review.json's `key` list, which must still hold `text` (the app's copy may be older
 * than the file), and the raw object it came from (matched by its text), where the decision is written.
 */
function reviewItem(ctx: ServiceContext, root: string, slug: string, id: string, key: "stretch" | "facts", index: number, text: string) {
  const r = readReviewFile(ctx, root, slug, id);
  const gone = () => new Error("Claude's review changed since you opened it. Reload to see the latest.");
  if (!r) throw gone();
  const item = r.review[key][index];
  const valueOf = (x: ReviewStretch | ReviewFact | undefined) => (x ? ("text" in x ? x.text : x.fact) : "");
  if (!item || valueOf(item) !== text) throw gone();
  // The raw item is the one that reads (parseReview's way: trimmed, without a bullet marker) as the same text.
  const rawList = Array.isArray(r.raw[key]) ? (r.raw[key] as unknown[]) : [];
  const raw = rawList.find((x): x is Record<string, unknown> => valueOf(parseReview({ [key]: [x] })?.[key][0]) === text);
  if (!raw) throw gone();
  return { r, item, raw };
}

/** "the Backend Engineer application at Example Labs": where a fact was confirmed, in plain words. */
function confirmedWhere(root: string, slug: string, id: string, how: string): string {
  const d = jobDetail(root, slug, id);
  return `${how}, ${d.job.title} at ${d.company?.name ?? slug}`;
}

/**
 * A stretch bullet from Claude's review. Keep: the person says it is true, so it is saved as a confirmed fact in
 * me/history (later claim checks then find it as evidence). Soften or drop: the draft is changed and versioned.
 */
function stretch(ctx: ServiceContext, slug: string, id: string, index: number, text: string, choice: StretchChoice): ApplyState {
  const root = ctx.requireRoot();
  const { r, item, raw } = reviewItem(ctx, root, slug, id, "stretch", index, text);
  const s = item as ReviewStretch;
  if (choice === "keep") {
    addConfirmedFact(root, plainFact(s.text), confirmedWhere(root, slug, id, "kept in a review"), ctx.clock());
    raw.state = "kept";
  } else {
    if (choice === "soften" && !s.soften) throw new Error("Claude didn't suggest a softer wording for this one. Edit it in the Resume Studio, or drop it.");
    const done = reviseDraft(ctx, slug, id, s.file, (cur) => applyStretch(cur, s, choice));
    if (!done) throw new Error(`That line isn't in your ${s.file === "resume.md" ? "resume" : "cover letter"} any more. Edit it in the Resume Studio instead.`);
    raw.state = choice === "soften" ? "softened" : "dropped";
    addEvent(root, slug, id, choice === "soften" ? "Bullet softened" : "Bullet dropped", "From Claude's review", ctx.clock());
  }
  writeFileAtomic(r.abs, `${JSON.stringify(r.raw, null, 2)}\n`);
  touch(root, jobDirRel(slug, id));
  return applyState(ctx, slug, id);
}

/**
 * A new fact the person stated themselves (their note, or an ad term they ticked as true), listed in Claude's review:
 * saved to me/history only on this click. Nothing Claude lists is saved without it.
 */
function saveFact(ctx: ServiceContext, slug: string, id: string, index: number, fact: string): ApplyState {
  const root = ctx.requireRoot();
  const { r, item, raw } = reviewItem(ctx, root, slug, id, "facts", index, fact);
  addConfirmedFact(root, plainFact(fact), confirmedWhere(root, slug, id, (item as ReviewFact).source || "your note"), ctx.clock());
  raw.saved = true;
  writeFileAtomic(r.abs, `${JSON.stringify(r.raw, null, 2)}\n`);
  touch(root, jobDirRel(slug, id));
  return applyState(ctx, slug, id);
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
    review: readReviewFile(ctx, root, slug, id)?.review ?? null,
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
  "apply.stretch": stretch,
  "apply.saveFact": saveFact,
} satisfies Partial<HandlerTable>;
