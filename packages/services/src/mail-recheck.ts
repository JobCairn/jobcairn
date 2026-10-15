import crypto from "node:crypto";
import { jobFilePath, updateRecord } from "@careeros/core";
import {
  acquireLock, companyIndex, SyncBusyError, deleteStored, moveMessage, RECHECK_VERSION, readMailState, readStored, recheckFiled, writeMailState,
} from "@careeros/mail";
import type { RecheckItem, RecheckPreview, RecheckResult } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { mailWorkspaceId, syncInfo } from "./mail-account.js";
import { allMailRows } from "./mail-read.js";
import { touch } from "./read.js";

const CHANGED = "The filed mail changed since you looked. Check the list again, then confirm.";
const SYNCING = "A mail sync is running. Try again when it finishes.";

interface Planned extends RecheckItem { company_slug: string; job_id: string; message_id: string }

/** Every email the sync filed itself, checked against today's matching rules. Mail you filed or moved is never listed. */
function plan(root: string): { checked: number; items: Planned[] } {
  const companies = companyIndex(root);
  const own = readMailState(root).account;
  let checked = 0;
  const items: Planned[] = [];
  for (const r of allMailRows(root)) {
    if (r.matched_by === "user") continue;
    let email;
    try { email = readStored(root, r.ref).email; } catch { continue; }
    checked++;
    const outcome = recheckFiled(email, r.company_slug, companies, own);
    if (outcome === "keep") continue;
    items.push({
      ref: r.ref, subject: r.subject, from: r.from, date: r.date, company_name: r.company_name, job_title: r.job_title, outcome,
      company_slug: r.company_slug, job_id: r.job_id, message_id: email.message_id,
    });
  }
  return { checked, items };
}

const tokenOf = (items: Planned[]) =>
  crypto.createHash("sha256").update(items.map((i) => `${i.ref}\n${i.outcome}`).sort().join("\n")).digest("hex");

export function recheckPreview(ctx: ServiceContext): RecheckPreview {
  const root = ctx.requireRoot();
  const { checked, items } = plan(root);
  return {
    due: readMailState(root).recheck < RECHECK_VERSION, checked,
    sort: items.filter((i) => i.outcome === "sort").length, unfile: items.filter((i) => i.outcome === "unfile").length,
    items: items.map(({ ref, subject, from, date, company_name, job_title, outcome }) => ({ ref, subject, from, date, company_name, job_title, outcome })),
    token: tokenOf(items),
  };
}

function markOffered(root: string): void {
  const s = readMailState(root);
  if (s.recheck >= RECHECK_VERSION) return;
  writeMailState(root, { ...s, recheck: RECHECK_VERSION });
}

/** The job's "Email received/sent" line for a message that's leaving the job. */
function dropEvent(root: string, slug: string, id: string, messageId: string): void {
  if (!id || !messageId) return;
  try {
    updateRecord("job", jobFilePath(root, slug, id), (j) => {
      j.timeline = j.timeline.filter((e) => !(e.message_id === messageId && (e.event === "Email received" || e.event === "Email sent")));
    });
  } catch { /* a job record that can't be written keeps its line; the email has still moved */ }
}

/**
 * Applies exactly the list the person confirmed (`token` from the preview). Mail that no longer matches goes to
 * Mail to sort; mail that isn't job mail is removed, as a sync would skip it today. Files you saved from an email
 * stay in the job folder. Refuses while a sync runs, and holds the sync lock while it works.
 */
export function recheckApply(ctx: ServiceContext, token: string): RecheckResult {
  const root = ctx.requireRoot();
  if (syncInfo(ctx, root).syncing) throw new Error(SYNCING);
  const release = ctx.host.mail ? lockOrBusy(ctx.host.mail.lockFile(mailWorkspaceId(root)), ctx.now()) : () => undefined;
  try {
    const { items } = plan(root);
    if (tokenOf(items) !== token) throw new Error(CHANGED);
    const out: RecheckResult = { sorted: 0, unfiled: 0 };
    const touched: string[] = [];
    for (const i of items) {
      if (i.outcome === "sort") { touched.push(i.ref, moveMessage(root, i.ref, "triage", { byUser: false })); out.sorted++; }
      else { deleteStored(root, i.ref); touched.push(i.ref); out.unfiled++; }
      dropEvent(root, i.company_slug, i.job_id, i.message_id);
      if (i.job_id) touched.push(`companies/${i.company_slug}/jobs/${i.job_id}`);
    }
    markOffered(root);
    if (touched.length) { try { touch(root, ...touched); } catch { /* the next read rebuilds the index */ } }
    return out;
  } finally {
    release();
  }
}

function lockOrBusy(file: string, now: Date): () => void {
  try { return acquireLock(file, now); } catch (e) { throw e instanceof SyncBusyError ? new Error(SYNCING) : e; }
}

export function recheckDismiss(ctx: ServiceContext): void {
  markOffered(ctx.requireRoot());
}

export const mailRecheckHandlers = {
  "mail.recheck.preview": recheckPreview,
  "mail.recheck.apply": recheckApply,
  "mail.recheck.dismiss": recheckDismiss,
} satisfies Partial<HandlerTable>;
