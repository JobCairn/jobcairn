import fs from "node:fs";
import path from "node:path";
import { attachFile, draftOwnerFile, ensureAgencyCompany, insideRoot, layout, listAgencies, readAgency, updateAgency, writeFileAtomic } from "@careeros/core";
import { listTriage } from "@careeros/mail";
import {
  actionPaths, agencyActivity, applyAgencyPatch, BASE_RESUME_REL, buildAgencyRows, localDate, RECRUITER_EMAIL_IDS, type ActionId, type ActionTarget,
  type AgencyPatch, type AgencyRecordView, type AgencyRow, type ClaudeRunRequest, type DraftSuggestion, type OutreachDraft, type OutreachReply,
} from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { suggestionAt } from "./mail-ai.js";
import { allDrafts } from "./mail-read.js";
import { jobDetail, jobRows, query } from "./read.js";
import { renderResume } from "./resume.js";

/**
 * Emails for the timeline and reply detection: those mail sync filed (received and sent, with their folder), and those waiting in
 * Mail to sort (a reply from an agency with no company folder lands there).
 */
function replies(root: string): OutreachReply[] {
  let filed: OutreachReply[] = [];
  try {
    filed = query<{ from_addr: string; date: string; subject: string; direction: string; company_slug: string }>(root,
      "SELECT from_addr, date, subject, direction, company_slug FROM emails ORDER BY date DESC LIMIT 5000")
      .map((r) => ({ from: r.from_addr ?? "", date: r.date ?? "", subject: r.subject ?? "", direction: r.direction === "out" ? "out" as const : "in" as const, company_slug: r.company_slug ?? "" }));
  } catch { /* no index yet */ }
  let waiting: OutreachReply[] = [];
  try {
    waiting = listTriage(root).filter((t) => t.email.direction === "in").map((t) => ({ from: t.email.from.address, date: t.email.date, subject: t.email.subject }));
  } catch { /* no mail yet */ }
  return [...filed, ...waiting];
}

function patchAgency(root: string, slug: string, patch: AgencyPatch, at: string, note = ""): void {
  updateAgency(root, slug, (a) => {
    const events = applyAgencyPatch(a as unknown as AgencyRecordView, patch).map((e) => ({ at, ...e, note: e.note || note }));
    a.timeline = [...a.timeline, ...events].slice(-500);
  });
}

/**
 * Every agency as a card, with the saved jobs it advertised and its timeline. Mail moves tracking on by itself: an
 * email sent to the agency sets the contacted date when there is none, and a reply from its address or domain after
 * contact sets the status to Replied (saved, so it sticks).
 */
export function agencyRows(root: string, now: Date = new Date()): AgencyRow[] {
  const outreach = { drafts: allDrafts(root, () => {}) as OutreachDraft[], replies: replies(root), today: localDate(now) };
  let records = listAgencies(root) as unknown as AgencyRecordView[];
  let changed = false;
  for (const a of records) {
    const { patch } = agencyActivity(a, outreach.drafts, outreach.replies, outreach.today);
    if (!patch) continue;
    try { patchAgency(root, a.slug, patch, now.toISOString(), "Found in your mail"); changed = true; } catch { /* shown as it was */ }
  }
  if (changed) records = listAgencies(root) as unknown as AgencyRecordView[];
  return buildAgencyRows(records, jobRows(root), outreach);
}

function update(ctx: ServiceContext, slug: string, patch: AgencyPatch): AgencyRow {
  const root = ctx.requireRoot();
  patchAgency(root, slug, patch, ctx.now().toISOString());
  const row = agencyRows(root, ctx.now()).find((r) => r.slug === slug);
  if (!row) throw new Error("That recruiter isn't in this workspace.");
  return row;
}

/** The emails/outgoing folder of an agency's company (a general enquiry's attachments), made if needed, never through a link. */
function outgoingDir(root: string, slug: string): string {
  draftOwnerFile(root, slug, "");
  const dir = path.join(layout(root).companyEmailsDir(slug), "outgoing");
  for (const d of [path.dirname(dir), dir]) {
    try { if (fs.lstatSync(d).isSymbolicLink()) throw new Error("refusing to use a linked folder"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Main's check of a recruiter email request (spec 2026-10-17-recruiter-email-claude), before anything else about the
 * run is read. A general enquiry (recruiter_email) runs on the agency's company folder: the agency must be saved, and
 * its company folder is made here the first time. About a job (recruiter_job_email), the app names the agency in the
 * `agency` option: it must be saved and list that job. Other actions pass through.
 */
export function recruiterEmailRequest(root: string, id: ActionId, t: ActionTarget, req: ClaudeRunRequest): ClaudeRunRequest {
  if (!RECRUITER_EMAIL_IDS.includes(id)) return req;
  if (id === "recruiter_email") {
    if (t.kind !== "company") throw new Error("Pick the recruiter to write to.");
    ensureAgencyCompany(root, t.company_slug);
    return req;
  }
  if (t.kind !== "job") throw new Error("Pick the job to write about.");
  const slug = req.options?.agency;
  if (typeof slug !== "string" || !slug) throw new Error("Pick the recruiter to write to.");
  const a = readAgency(root, slug);
  if (!a) throw new Error("That recruiter isn't in this workspace.");
  const ref = `${t.company_slug}/${t.id}`;
  if (![...a.job_refs, ...a.people.flatMap((p) => p.job_refs)].includes(ref)) throw new Error("That recruiter didn't advertise this job.");
  return req;
}

/** Claude's latest email to the agency: a general enquiry's (id "") or one about the agency's job. Never who it goes to. */
function suggestion(ctx: ServiceContext, slug: string, id: string): { suggestion: DraftSuggestion | null; problem: string } {
  const root = ctx.requireRoot();
  if (id) {
    jobDetail(root, slug, id); // a real job
    return suggestionAt(root, actionPaths("recruiter_job_email", { kind: "job", company_slug: slug, id }, {}).outputs[0]!);
  }
  return suggestionAt(root, actionPaths("recruiter_email", { kind: "company", company_slug: slug }, {}).outputs[0]!);
}

/**
 * A general resume version (resume-variants/<variant>/resume.md, as the Resumes screen shows it) for a general
 * enquiry: rendered to PDF (Word when PDF isn't available here) into the agency's emails/outgoing, so its draft can
 * attach it. Same name as before replaces the earlier copy.
 */
async function attachVariant(ctx: ServiceContext, slug: string, variant: string): Promise<{ rel: string }> {
  const root = ctx.requireRoot();
  ensureAgencyCompany(root, slug);
  const r = await renderResume(ctx, { kind: "variant", variant }, "resume.md", ctx.host.printer ? "pdf" : "docx");
  const dir = outgoingDir(root, slug);
  const dest = path.join(dir, r.name);
  if (path.dirname(dest) !== dir || !insideRoot(root, dest)) throw new Error("refusing to write outside the workspace");
  writeFileAtomic(dest, Buffer.from(r.bytes));
  return { rel: `companies/${slug}/emails/outgoing/${r.name}` };
}

/**
 * Copies one of the person's own resumes (me/resumes/<file>) into a job's application folder, so an email kept with
 * that job can attach it: drafts only attach files from their own job's folder. Returns the copy's workspace path.
 */
function attachResume(ctx: ServiceContext, slug: string, id: string, rel: string): { rel: string } {
  const root = ctx.requireRoot();
  if (!BASE_RESUME_REL.test(rel)) throw new Error("Pick one of your resumes.");
  const src = path.join(root, ...rel.split("/"));
  const st = fs.lstatSync(src);
  if (!st.isFile() || st.isSymbolicLink() || !insideRoot(root, src)) throw new Error("That resume can't be read.");
  if (id) {
    const inJob = attachFile(root, slug, id, src, { label: "Your resume", subdir: "application" }, ctx.clock());
    return { rel: `companies/${slug}/jobs/${id}/${inJob}` };
  }
  // A company's own email (a general enquiry): the copy goes in its emails/outgoing folder, which the Research tab
  // doesn't list and the mail store doesn't use. Same name as before replaces the earlier copy.
  const dir = outgoingDir(root, slug);
  const dest = path.join(dir, path.basename(src));
  if (!insideRoot(root, dest)) throw new Error("refusing to write outside the workspace");
  writeFileAtomic(dest, fs.readFileSync(src));
  return { rel: `companies/${slug}/emails/outgoing/${path.basename(src)}` };
}

/**
 * Makes sure an agency has a company folder (same slug), so emails to it can be drafted and filed there even when no
 * job is saved: its website lets mail sync file its replies. Never changes a company that is already there.
 */
function mailbox(ctx: ServiceContext, slug: string): { company_slug: string } {
  ensureAgencyCompany(ctx.requireRoot(), slug);
  return { company_slug: slug };
}

export const recruiterHandlers = {
  "recruiters.list": (ctx: ServiceContext) => agencyRows(ctx.requireRoot(), ctx.now()),
  "recruiters.attachResume": attachResume,
  "recruiters.mailbox": mailbox,
  "recruiters.suggestion": suggestion,
  "recruiters.attachVariant": attachVariant,
  "recruiters.update": update,
} satisfies Partial<HandlerTable>;
