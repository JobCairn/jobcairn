import fs from "node:fs";
import path from "node:path";
import { insideRoot, isEmailAddress, layout, listDraftFiles, readDraft, readEmails, readRecord } from "@careeros/core";
import {
  actionPaths, followUpLimitText, followUpsSent, parseDraftSuggestion, SUGGESTION_MAX_BYTES, SUGGESTION_UNREADABLE,
  type ActionTarget, type ClaudeRunRequest, type DraftAssist, type DraftSuggestion, type MailAddressView,
} from "@careeros/contract";
import { applyEmailOf } from "./apply.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { jobDetail } from "./read.js";

/**
 * "Write with Claude" in the email composer (the draft_email action). Claude writes one suggestion file; the composer
 * fills its fields from it and the person edits, saves and sends the email the usual way (Review and send, then
 * Approvals). Nothing here writes a draft or sends anything.
 */

const REWORK = ["shorter", "warmer", "formal", "grammar"];

/** The suggestion file for a job: draft_email's one output. */
export function suggestionRel(slug: string, id: string): string {
  return actionPaths("draft_email", { kind: "job", company_slug: slug, id }, {}).outputs[0]!;
}

/**
 * Main's mapping of the composer's request: the renderer names the saved draft (draft_id) and picks the purpose and
 * the change. Main checks the draft is an unsent draft of this job, and decides itself whether it answers an email
 * stored in this job's folder (`thread`); the renderer's own `thread` is ignored. No email text goes into the prompt.
 */
export function emailRequest(root: string, t: ActionTarget, req: ClaudeRunRequest): ClaudeRunRequest {
  if (t.kind !== "job") return req;
  const { thread: _ignored, ...options } = (req.options ?? {}) as Record<string, unknown>;
  const draftId = typeof options.draft_id === "string" ? options.draft_id : "";
  // At most two follow-ups per application: a third is refused with the same reason the Outreach card gives.
  if (options.purpose === "follow_up" && (options.mode ?? "new") === "new") {
    let limit = "";
    try { limit = followUpLimitText(followUpsSent(readRecord("job", layout(root).jobFile(t.company_slug, t.id)).timeline)); } catch { limit = ""; }
    if (limit) throw new Error(limit);
  }
  let thread = false;
  if (draftId) {
    const f = listDraftFiles(root, t.company_slug, t.id).find((x) => x.draft_id === draftId);
    if (!f) throw new Error("Save the draft first, then ask Claude again.");
    if (f.sent) throw new Error("This email was already sent. Start a new draft.");
    const d = readDraft(root, t.company_slug, t.id, draftId);
    if (REWORK.includes(String(options.mode)) && !d.body.trim()) throw new Error("Write something first, then Claude can rework it.");
    if (d.in_reply_to) {
      try { thread = readEmails(root, t.company_slug, t.id).some((e) => e.email.message_id === d.in_reply_to); } catch { thread = false; }
    }
  } else if (REWORK.includes(String(options.mode))) {
    throw new Error("Write something first, then Claude can rework it.");
  }
  return { ...req, options: { ...(options as ClaudeRunRequest["options"]), ...(thread ? { thread: true } : {}) } };
}

/** Who the email could go to, from the job's own records: the company's recruiter, else the ad's apply-by-email address. */
function recipient(root: string, slug: string, id: string): MailAddressView | null {
  try {
    const c = readRecord("company", layout(root).companyFile(slug));
    const email = c.recruiter?.email?.trim() ?? "";
    if (email && isEmailAddress(email)) return { name: (c.recruiter?.name ?? "").trim(), address: email };
  } catch { /* no company record: try the ad */ }
  try {
    const address = applyEmailOf(jobDetail(root, slug, id).job.apply_via ?? "");
    return address ? { name: "", address } : null;
  } catch { return null; }
}

/** Claude's suggestion, read only if it is a plain, small, single-named file inside the workspace. */
function suggestion(root: string, slug: string, id: string): { suggestion: DraftSuggestion | null; problem: string } {
  return suggestionAt(root, suggestionRel(slug, id));
}

/** A suggestion file Claude wrote (workspace-relative), with the same checks: also used by the recruiter email. */
export function suggestionAt(root: string, rel: string): { suggestion: DraftSuggestion | null; problem: string } {
  const abs = path.join(root, ...rel.split("/"));
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return { suggestion: null, problem: "" }; }
  if (!st.isFile() || st.nlink > 1 || st.size > SUGGESTION_MAX_BYTES || !insideRoot(root, abs)) return { suggestion: null, problem: SUGGESTION_UNREADABLE };
  try {
    return { suggestion: { ...parseDraftSuggestion(fs.readFileSync(abs, "utf8")), at: st.mtime.toISOString() }, problem: "" };
  } catch { return { suggestion: null, problem: SUGGESTION_UNREADABLE }; }
}

export function draftAssist(ctx: ServiceContext, slug: string, id: string): DraftAssist {
  const root = ctx.requireRoot();
  jobDetail(root, slug, id); // a real job
  return { ...suggestion(root, slug, id), recipient: recipient(root, slug, id) };
}

export const mailAiHandlers = {
  "mail.drafts.assist": draftAssist,
} satisfies Partial<HandlerTable>;
