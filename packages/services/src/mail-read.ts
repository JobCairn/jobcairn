import fs from "node:fs";
import path from "node:path";
import {
  buildDraftMessage, checkDraft, draftOwnerFile, formatAddress, jobFilePath, layout, listApprovals, listDraftFiles, listJobs, mailAccount, messageText,
  iso, mimeTypeFor, newJob, parseAddressList, parseDraft, proposeEmailSend, readDraft, readMeta, readRecord, updateRecord, writeDraft,
  type Clock, type Draft, type EmailRecord, type MessageStamp,
} from "@careeros/core";
import {
  companyIndex, deleteStored, domainMatches, domainOf, isIgnored, isRisky, linkableDomain, linkWarning, listTriage, MAIL_FRAME_CSP, markdownBody, moveMessage,
  parseMessage, pruneRaw, readMailState, readSnippet, readStored, sniffImageType, renderMailDocument, sanitizeEmailHtml, saveAttachmentFile, suggestCompany, textToHtml,
  updateStored, writeMailState, type MailPaths, type ParsedMessage,
} from "@careeros/mail";
import {
  mailRefToken, parseMailUrl, type ApprovalView, type DraftDetail, type DraftInput, type DraftStatus, type DraftView, type EmailPreview, type MailList,
  type MailMessageView, type MailNextUp, type MailQuery, type MailRow, type MailTarget, type PruneResult, type TriageItem,
} from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { sendState, UNSURE } from "./mail-send.js";
import { plainError } from "./errors.js";
import { appApprovals, approvalView, query, rememberAppApproval, touch } from "./read.js";
import { isSafeLink } from "./secrets.js";

const TOO_LARGE = "This email is larger than 25 MB, so only its headers were saved. Open it in Gmail to read it.";

// ---- list ------------------------------------------------------------------
interface EmailIndexRow {
  file: string; company_slug: string; job_id: string; direction: "in" | "out"; date: string; subject: string; from_name: string; from_addr: string;
  thread_key: string; attachments: number; opened: number; matched_by: string; company_name: string; job_title: string;
}
const LIST_SQL = `SELECT e.file, e.company_slug, e.job_id, e.direction, e.date, e.subject, e.from_name, e.from_addr, e.thread_key, e.attachments,
  e.opened, e.matched_by, COALESCE(c.name, e.company_slug) AS company_name, COALESCE(j.title, '') AS job_title
  FROM emails e LEFT JOIN companies c ON c.slug = e.company_slug LEFT JOIN jobs j ON j.company_slug = e.company_slug AND j.id = e.job_id`;

export function allMailRows(root: string): MailRow[] {
  return query<EmailIndexRow>(root, LIST_SQL).map((r): MailRow => ({
    ref: r.file, company_slug: r.company_slug, company_name: r.company_name, job_id: r.job_id, job_title: r.job_title, direction: r.direction,
    date: r.date, subject: r.subject, from: { name: r.from_name, address: r.from_addr }, thread_key: r.thread_key, attachments: r.attachments,
    opened: r.opened === 1, matched_by: r.matched_by,
  })).sort((a, b) => b.date.localeCompare(a.date) || a.ref.localeCompare(b.ref));
}

export function mailList(root: string, q: MailQuery): MailList {
  const text = q.text?.trim().toLowerCase();
  const rows = allMailRows(root).filter((r) =>
    (!q.company_slug || r.company_slug === q.company_slug) &&
    (!q.id || r.job_id === q.id || (q.includeCompany === true && r.job_id === "")) &&
    (!q.direction || r.direction === q.direction) &&
    (!q.unread || (!r.opened && r.direction === "in")) &&
    (!q.attachments || r.attachments > 0) &&
    (!text || [r.subject, r.from.name, r.from.address, r.company_name, r.job_title].some((s) => s.toLowerCase().includes(text))));
  const offset = q.offset ?? 0;
  // The snippet reads each listed message's text copy, so only for the page being returned.
  return { rows: rows.slice(offset, offset + (q.limit ?? 200)).map((r) => ({ ...r, snippet: readSnippet(root, r.ref) })), total: rows.length };
}

/** With Gmail not connected there is no unread count or reply to show; drafts stay so they can still be finished. */
export function mailNextUp(root: string, connected = true): MailNextUp {
  const unread = connected ? allMailRows(root).filter((r) => r.direction === "in" && !r.opened) : [];
  return { unread: unread.slice(0, 10), unreadCount: unread.length, drafts: allDrafts(root) };
}

// ---- one message -----------------------------------------------------------
const SEG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function jobNames(root: string, slug: string, id: string): { company_name: string; job_title: string } {
  let company_name = slug;
  let job_title = "";
  // Only well-formed folder names are read, so a caller's slug or id never reaches a path unchecked.
  if (!SEG.test(slug) || (id && !SEG.test(id))) return { company_name: "", job_title: "" };
  try { company_name = readRecord("company", layout(root).companyFile(slug)).name; } catch { /* company file missing */ }
  if (id) { try { job_title = readRecord("job", layout(root).jobFile(slug, id)).title; } catch { /* job missing */ } }
  return { company_name, job_title };
}

const claimedDomain = (name: string): string => {
  const at = name.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (at) return at[1]!.toLowerCase();
  const d = name.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i);
  return d ? d[1]!.toLowerCase() : "";
};

function warningsFor(e: EmailRecord): string[] {
  const out: string[] = [];
  const real = domainOf(e.from.address);
  if (e.auth === "fail") out.push(`Gmail couldn't confirm this email really came from ${real}. Be careful with its links and attachments.`);
  const claimed = claimedDomain(e.from.name);
  if (claimed && !domainMatches(real, claimed) && !domainMatches(claimed, real)) out.push(`The sender's name shows ${claimed}, but the email came from ${e.from.address}.`);
  if (e.too_large) out.push(TOO_LARGE);
  return out;
}

export function messageView(root: string, ref: string): MailMessageView {
  const { paths, email: e, raw } = readStored(root, ref);
  const names = paths.triage ? { company_name: "", job_title: "" } : jobNames(root, paths.company_slug, paths.job_id);
  return {
    ref, company_slug: paths.company_slug, company_name: names.company_name, job_id: paths.job_id, job_title: names.job_title, triage: paths.triage,
    direction: e.direction, from: e.from, to: e.to, cc: e.cc, reply_to: e.reply_to, subject: e.subject, date: e.date, message_id: e.message_id,
    references: e.references, thread_key: e.thread_key, auth: e.auth, warnings: warningsFor(e), images_allowed: e.images_allowed,
    remote_images: e.remote_images, too_large: e.too_large, has_raw: raw !== null, opened_at: e.opened_at,
    attachments: e.attachments.filter((a) => !a.inline).map((a) => ({ part: a.part, name: a.name, size: a.size, type: a.type, inline: a.inline, saved_rel: a.saved_as, risky: isRisky(a.name, a.type) })),
  };
}

export function getMessage(ctx: ServiceContext, ref: string): MailMessageView {
  const root = ctx.requireRoot();
  const { email } = readStored(root, ref);
  if (!email.opened_at && email.direction === "in") {
    updateStored(root, ref, (e) => { e.opened_at = ctx.now().toISOString(); });
    touch(root, ref);
  }
  return messageView(root, ref);
}

export function loadImages(ctx: ServiceContext, ref: string): MailMessageView {
  const root = ctx.requireRoot();
  updateStored(root, ref, (e) => { e.images_allowed = true; });
  return messageView(root, ref);
}

const parsedCache = new Map<string, ParsedMessage>();
async function parsedFor(paths: MailPaths, raw: Buffer): Promise<ParsedMessage> {
  let mtime: number | null = null;
  try { mtime = fs.statSync(paths.eml).mtimeMs; } catch { mtime = null; }
  // No stat (the raw copy just went): parse without caching rather than fail.
  const key = mtime === null ? null : `${paths.eml}:${raw.length}:${mtime}`;
  const hit = key === null ? undefined : parsedCache.get(key);
  if (hit) return hit;
  const p = await parseMessage(raw);
  if (key === null) return p;
  parsedCache.set(key, p);
  if (parsedCache.size > 8) parsedCache.delete(parsedCache.keys().next().value!);
  return p;
}

export async function saveAttachment(ctx: ServiceContext, ref: string, part: string): Promise<MailMessageView> {
  const root = ctx.requireRoot();
  const s = readStored(root, ref);
  if (!s.raw) throw new Error("The original email isn't stored any more, so its attachments can't be saved. Open it in Gmail.");
  const a = (await parsedFor(s.paths, s.raw)).attachments.find((x) => x.part === part);
  if (!a) throw new Error("That attachment isn't in this email.");
  saveAttachmentFile(root, ref, part, a.name, a.content, ctx.clock());
  touch(root, ref);
  return messageView(root, ref);
}

/**
 * The job's "Email received/sent" event for a stored email, keyed by its Message-ID like mail sync's,
 * so moving or sorting the same email into a job twice (or after sync added it) never repeats it.
 */
function mailEvent(root: string, slug: string, id: string, email: EmailRecord, c: Clock): void {
  const file = jobFilePath(root, slug, id);
  const event = email.direction === "in" ? "Email received" : "Email sent";
  const key = email.message_id;
  updateRecord("job", file, (j) => {
    if (key && j.timeline.some((e) => e.message_id === key)) return;
    j.timeline.push({ at: iso(c), event, note: email.subject.slice(0, 200), ...(key ? { message_id: key } : {}) });
  });
}

export function moveTo(ctx: ServiceContext, ref: string, target: MailTarget): MailMessageView {
  const root = ctx.requireRoot();
  if (target.id) jobFilePath(root, target.company_slug, target.id);
  const { email } = readStored(root, ref);
  const to = moveMessage(root, ref, { company_slug: target.company_slug, job_id: target.id ?? "" });
  if (target.id) mailEvent(root, target.company_slug, target.id, email, ctx.clock());
  touch(root, ref, to);
  return messageView(root, to);
}

export function prune(ctx: ServiceContext, months: number): PruneResult {
  return pruneRaw(ctx.requireRoot(), new Date(ctx.now().getTime() - months * 30 * 86_400_000));
}

// ---- careeros-mail: assets -------------------------------------------------
export interface AssetResponse { status: number; headers: Record<string, string>; body: Buffer | string }
const NOT_FOUND: AssetResponse = { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Not found" };
const SAFE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const PLAIN = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
/** An image response that is inert even if something ever loads it as a document. */
const IMAGE_HEADERS = { ...PLAIN, "Content-Security-Policy": "default-src 'none'" };

/**
 * Answers one careeros-mail: request. Never rejects: anything that goes wrong (a raw copy pruned
 * mid-request, a parse failure) is a plain 404, so no error text (or path) reaches the protocol handler.
 */
export async function mailAsset(ctx: ServiceContext, url: string): Promise<AssetResponse> {
  try { return await serveMailAsset(ctx, url); } catch { return NOT_FOUND; }
}

async function serveMailAsset(ctx: ServiceContext, url: string): Promise<AssetResponse> {
  const u = parseMailUrl(url);
  const root = ctx.root;
  if (!u || !root) return NOT_FOUND;
  let s: ReturnType<typeof readStored>;
  try { s = readStored(root, u.ref); } catch { return NOT_FOUND; }
  const parsed = s.raw ? await parsedFor(s.paths, s.raw) : null;
  const stored = () => (s.email.too_large ? TOO_LARGE : markdownBody(fs.existsSync(s.paths.md) ? fs.readFileSync(s.paths.md, "utf8") : ""));
  // The plain-text view ("msg/<t>/text") and its links ("link/<t>/t<n>") are built from the text alone, so a
  // text link's number always points into the text's own link list, never the original's.
  const textView = (u.kind === "msg" && u.arg === "text") || (u.kind === "link" && u.arg.startsWith("t"));
  const html = textView
    ? textToHtml(parsed?.text || stored())
    : parsed ? parsed.html || textToHtml(parsed.text) : textToHtml(stored());
  const token = mailRefToken(u.ref);
  const clean = sanitizeEmailHtml(html, { token, imagesAllowed: s.email.images_allowed });
  if (u.kind === "msg") {
    const body = textView ? clean.html.split(`careeros-mail://link/${token}/`).join(`careeros-mail://link/${token}/t`) : clean.html;
    return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": MAIL_FRAME_CSP, "Referrer-Policy": "no-referrer", ...PLAIN }, body: renderMailDocument(body) };
  }
  if (textView && u.kind !== "link") return NOT_FOUND;
  if (u.kind === "cid") {
    // Matched against the message's own attachment list only; the cid is never used as a path.
    // The type served is what the bytes say (png, jpeg, gif or webp), never the email's own label, so SVG never gets through.
    const a = parsed?.attachments.find((x) => x.cid === u.arg);
    const type = a ? sniffImageType(a.content) : "";
    return a && SAFE_IMAGE.test(type) ? { status: 200, headers: { "Content-Type": type, ...IMAGE_HEADERS }, body: a.content } : NOT_FOUND;
  }
  if (u.kind === "img") {
    if (!s.email.images_allowed) return { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Images are blocked for this email." };
    const src = clean.remoteImages[Number(u.arg)];
    if (!src || !ctx.host.mail) return NOT_FOUND;
    try {
      const img = await ctx.host.mail.fetchImage(src);
      if (!SAFE_IMAGE.test(img.type) || sniffImageType(img.body) !== img.type) return NOT_FOUND;
      return { status: 200, headers: { "Content-Type": img.type, ...IMAGE_HEADERS }, body: img.body };
    } catch { return NOT_FOUND; }
  }
  const link = clean.links[Number(u.arg.replace(/^t/, ""))];
  if (link && isSafeLink(link.href)) {
    const note = linkWarning(link.text, link.href);
    // The shell shows the dialog; a failure there must not become an unhandled rejection.
    void Promise.resolve().then(() => ctx.host.shell.openExternal(link.href, note || undefined)).catch(() => undefined);
  }
  return { status: 204, headers: {}, body: "" };
}

// ---- Mail to sort ----------------------------------------------------------
const triageRef = (id: string) => `.careeros/mail-triage/${id}.json`;

export function triageItems(ctx: ServiceContext): TriageItem[] {
  const root = ctx.requireRoot();
  const companies = companyIndex(root);
  return listTriage(root).map((t) => ({
    id: t.id, ref: t.ref, from: t.email.from, subject: t.email.subject, date: t.email.date,
    suggestion: suggestCompany({ direction: t.email.direction, from: t.email.from, to: t.email.to, cc: t.email.cc, subject: t.email.subject }, companies),
    free_mail: !linkableDomain(t.email.from.address),
  }));
}

export function assignTriage(ctx: ServiceContext, id: string, target: MailTarget, addMatch: boolean): TriageItem[] {
  const root = ctx.requireRoot();
  const ref = triageRef(id);
  const { email } = readStored(root, ref);
  if (target.id) jobFilePath(root, target.company_slug, target.id);
  const to = moveMessage(root, ref, { company_slug: target.company_slug, job_id: target.id ?? "" });
  if (addMatch && email.direction === "in") {
    const a = email.from.address.toLowerCase();
    updateRecord("company", layout(root).companyFile(target.company_slug), (c) => {
      if (!c.email_match.some((m) => m.toLowerCase() === a)) c.email_match = [...c.email_match, a].slice(-50);
    });
  }
  if (target.id) mailEvent(root, target.company_slug, target.id, email, ctx.clock());
  touch(root, to, `companies/${target.company_slug}`);
  return triageItems(ctx);
}

export function createCompanyFromTriage(ctx: ServiceContext, id: string, name: string, jobTitle: string): TriageItem[] {
  const root = ctx.requireRoot();
  readStored(root, triageRef(id));
  const j = newJob(root, { company: name.trim(), title: jobTitle.trim(), source: "pasted" }, ctx.clock());
  touch(root, `companies/${j.company_slug}`);
  return assignTriage(ctx, id, { company_slug: j.company_slug, id: j.id }, true);
}

export function ignoreTriage(ctx: ServiceContext, id: string, scope: "sender" | "domain"): TriageItem[] {
  const root = ctx.requireRoot();
  const { email } = readStored(root, triageRef(id));
  const st = readMailState(root);
  const value = scope === "sender" ? email.from.address.toLowerCase() : domainOf(email.from.address);
  const list = scope === "sender" ? st.ignore.senders : st.ignore.domains;
  if (!list.includes(value)) list.push(value);
  writeMailState(root, st);
  for (const t of listTriage(root)) if (isIgnored(t.email.from.address, st.ignore)) deleteStored(root, t.ref);
  return triageItems(ctx);
}

// ---- drafts and previews ---------------------------------------------------
export function toDraft(input: DraftInput): Draft {
  return checkDraft({
    to: parseAddressList(input.to), cc: parseAddressList(input.cc), subject: input.subject, attach: input.attach,
    in_reply_to: input.in_reply_to, references: input.references, purpose: input.purpose, body: input.body,
  }, false);
}

export function toInput(d: Draft): DraftInput {
  return { to: d.to.map(formatAddress).join(", "), cc: d.cc.map(formatAddress).join(", "), subject: d.subject, body: d.body, attach: d.attach, in_reply_to: d.in_reply_to, references: d.references, purpose: d.purpose };
}

export function draftViews(root: string, slug: string, id: string, now: Date = new Date()): DraftView[] {
  draftOwnerFile(root, slug, id); // a real job (or, id "", a company), named by plain folder names only
  const names = jobNames(root, slug, id);
  const proposals = listApprovals(root).filter((a) => a.action === "email_send" && a.payload.company_slug === slug && a.payload.id === id);
  return listDraftFiles(root, slug, id).map((f): DraftView => {
    let subject = "(this draft can't be read)";
    let to = "";
    try {
      const d = parseDraft(fs.readFileSync(path.join(root, ...f.rel.split("/")), "utf8"));
      subject = d.subject;
      to = d.to.map((a) => a.address).join(", ");
    } catch { /* shown as unreadable */ }
    const a = proposals.filter((x) => x.payload.draft_id === f.draft_id).at(-1);
    const unsure = !f.sent && a?.status === "approved" && sendState(root, a.id, now) === "unknown";
    const status: DraftStatus = f.sent ? "sent" : unsure ? "unsure" : a?.status === "pending" || a?.status === "approved" ? "waiting" : a?.status === "failed" ? "failed" : "draft";
    return {
      draft_id: f.draft_id, company_slug: slug, id, company_name: names.company_name, job_title: names.job_title, rel: f.rel, subject, to, status,
      updated: f.mtime, approval_id: a?.id ?? "", note: a?.status === "failed" ? a.result_note : unsure ? UNSURE : "",
    };
  }).sort((x, y) => y.updated.localeCompare(x.updated) || x.draft_id.localeCompare(y.draft_id));
}

/**
 * Every job's drafts, and every company's own (general enquiries to recruiters, kept in companies/<slug>/emails/drafts).
 * One folder that can't be used (a link out of the workspace, an unreadable record) is skipped with one plain log
 * line, so Home and the drafts list keep working.
 */
export function allDrafts(root: string, log: (line: string) => void = (l) => console.warn(l)): DraftView[] {
  const owners = [...listJobs(root).map((j) => ({ slug: j.company_slug, id: j.id })), ...companyDraftOwners(root)];
  return owners.flatMap((o) => {
    try { return draftViews(root, o.slug, o.id); } catch (e) {
      log(`Drafts for ${o.id ? `${o.slug}/${o.id}` : o.slug} were skipped: ${plainError(e, [root]).message}`);
      return [];
    }
  }).sort((x, y) => y.updated.localeCompare(x.updated));
}

/** Companies with a drafts folder of their own (plain folders only). */
function companyDraftOwners(root: string): { slug: string; id: string }[] {
  const L = layout(root);
  let names: string[];
  try { names = fs.readdirSync(L.companiesDir).sort(); } catch { return []; }
  return names.filter((n) => SEG.test(n)).filter((n) => {
    try { return fs.lstatSync(L.draftsDir(n, "")).isDirectory(); } catch { return false; }
  }).map((slug) => ({ slug, id: "" }));
}

const lockedDir = (root: string, rel: string): string | null => {
  const r = rel.toLowerCase();
  return readMeta(root).privacy.locked.find((d) => r === d || r.startsWith(`${d}/`)) ?? null;
};

export function emailPreview(root: string, slug: string, id: string, draftId: string, stamp: MessageStamp, expected?: string, c?: Clock): EmailPreview {
  const names = jobNames(root, slug, id);
  const job = { company_slug: slug, id, title: names.job_title, company_name: names.company_name };
  try {
    const b = buildDraftMessage(root, slug, id, draftId, stamp, c);
    const m = b.message;
    const current = expected === undefined || b.digest === expected;
    return {
      account: m.from.address, from: m.from, to: m.to, cc: m.cc, subject: m.subject, text: m.text, in_reply_to: m.in_reply_to,
      attachments: m.attachments.map((a) => ({ rel: a.rel, name: a.name, size: a.size, type: a.type, locked: a.locked })),
      locked: m.attachments.some((a) => a.locked !== null), current, problem: current ? "" : "The draft changed. Review it again.", job,
    };
  } catch (e) {
    const acct = mailAccount(root);
    let d: Draft | null = null;
    try { d = readDraft(root, slug, id, draftId); } catch { d = null; }
    const attachments = (d?.attach ?? []).map((rel) => ({ rel, name: rel.split("/").pop() ?? rel, size: 0, type: mimeTypeFor(rel), locked: lockedDir(root, rel) }));
    return {
      account: acct.address, from: { name: acct.display_name, address: acct.address }, to: d?.to ?? [], cc: d?.cc ?? [], subject: d?.subject ?? "",
      text: d ? messageText(d.body, acct.signature) : "", in_reply_to: d?.in_reply_to ?? "", attachments, locked: attachments.some((a) => a.locked !== null),
      current: false, problem: plainError(e, [root]).message, job,
    };
  }
}

/**
 * Adds the exact message to an email send the person still has to act on: one waiting for approval, or an
 * approved one whose outcome is unknown (`unsure`: the Send again dialog shows it again before anything goes).
 */
export function withEmail(root: string, v: ApprovalView, c?: Clock): ApprovalView {
  if (v.action !== "email_send") return v;
  const unsure = v.unsure || (v.status === "approved" && sendState(root, v.id, c?.now ?? new Date()) === "unknown");
  if (v.status !== "pending" && !unsure) return v;
  const p = v.payload;
  const out = unsure ? { ...v, unsure: true } : v;
  try {
    return { ...out, email: emailPreview(root, String(p.company_slug), String(p.id), String(p.draft_id), { message_id: String(p.message_id), date: String(p.date) }, String(p.sha256), c) };
  } catch { return out; }
}

export function draftDetail(ctx: ServiceContext, slug: string, id: string, draftId: string): DraftDetail {
  const root = ctx.requireRoot();
  const view = draftViews(root, slug, id, ctx.now()).find((v) => v.draft_id === draftId);
  if (!view) throw new Error(`The draft ${draftId} can't be found.`);
  const draft = parseDraft(fs.readFileSync(path.join(root, ...view.rel.split("/")), "utf8"));
  const preview = view.status === "sent" ? null : emailPreview(root, slug, id, draftId, { message_id: "<preview>", date: ctx.now().toISOString() }, undefined, ctx.clock());
  return { view, draft: toInput(draft), preview };
}

export function saveDraft(ctx: ServiceContext, slug: string, id: string, draftId: string, input: DraftInput): DraftDetail {
  const root = ctx.requireRoot();
  if (draftId && listDraftFiles(root, slug, id).some((f) => f.draft_id === draftId && f.sent)) throw new Error("This email was already sent. Start a new draft.");
  const w = writeDraft(root, slug, id, toDraft(input), draftId || undefined, ctx.clock());
  return draftDetail(ctx, slug, id, w.draft_id);
}

export function proposeDraft(ctx: ServiceContext, slug: string, id: string, draftId: string): ApprovalView {
  const root = ctx.requireRoot();
  const a = proposeEmailSend(root, slug, id, draftId, "app", ctx.clock());
  rememberAppApproval(ctx, root, a);
  return withEmail(root, approvalView(a, appApprovals(ctx, root)), ctx.clock());
}

export const mailReadHandlers = {
  "mail.list": (ctx: ServiceContext, q: MailQuery) => mailList(ctx.requireRoot(), q),
  "mail.get": getMessage,
  "mail.loadImages": loadImages,
  "mail.saveAttachment": saveAttachment,
  "mail.move": moveTo,
  "mail.prune": prune,
  "mail.triage.list": triageItems,
  "mail.triage.assign": assignTriage,
  "mail.triage.createCompany": createCompanyFromTriage,
  "mail.triage.ignore": ignoreTriage,
  "mail.drafts.all": (ctx: ServiceContext) => allDrafts(ctx.requireRoot()),
  "mail.drafts.list": (ctx: ServiceContext, slug: string, id: string) => draftViews(ctx.requireRoot(), slug, id, ctx.now()),
  "mail.drafts.get": draftDetail,
  "mail.drafts.save": saveDraft,
  "mail.drafts.propose": proposeDraft,
} satisfies Partial<HandlerTable>;
