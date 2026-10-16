import fs from "node:fs";
import { ensureAgencyCompany, findSameAgency, jobFilePath, mergeAgency, readAgency, updateAgency, updateRecord, iso, type Clock } from "@careeros/core";
import { companyIndex, domainOf, linkableDomain, listTriage, matchMessage, moveMessage, readSnippet, readStored } from "@careeros/mail";
import {
  addRecruiterArgs, agencyAddresses, agencyThreads, localDate, parseAgencyLines, type AgencyAddClean, type AgencyAddResult,
  type AgencyEmails, type AgencyImportResult, type AgencyLinkScope, type AgencyRecordView, type AgencyRow, type MailAddressView, type MailRow, type TriageItem,
} from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import { checkIncomingFile } from "./files.js";
import type { HandlerTable } from "./handlers.js";
import { allDrafts, allMailRows, triageItems } from "./mail-read.js";
import { touch } from "./read.js";
import { agencyRows } from "./recruiters.js";

/**
 * Add recruiter, Import, linked addresses and the Emails tab (spec 2026-10-17-add-recruiter-and-mail). Every agency
 * write goes through core's mergeAgency/updateAgency; the same-agency rule (slug, else website host) is core's
 * findSameAgency, which recruiter_add uses too, so Claude's later save lands on the same record.
 */

/** Saves one agency the person gave, merged into the same one when it is already saved. */
export function saveAdded(root: string, a: AgencyAddClean, c?: Clock): AgencyAddResult {
  const same = findSameAgency(root, a.slug, a.website);
  const slug = same?.slug ?? a.slug;
  const at = iso(c);
  const saved = mergeAgency(root, {
    slug, name: a.name, website: same?.website ? "" : a.website, contacts: a.contacts,
    sources: a.sources.map((s) => ({ ...s, found_at: at })),
    // A new one waits for Check recruiters; adding to one already saved changes nothing about that.
    ...(same ? {} : { needs_check: true }),
  }, { event: same ? "Added to by you" : "Added by you", note: a.website || a.sources[0]?.url || "" }, c);
  return { slug: saved.slug, name: saved.name, created: !same };
}

function add(ctx: ServiceContext, input: unknown): AgencyAddResult {
  const root = ctx.requireRoot();
  const r = saveAdded(root, addRecruiterArgs(input, localDate(ctx.now())), ctx.clock());
  touch(root, `recruiters/${r.slug}`);
  return r;
}

export function importText(root: string, text: string, now: Date, c?: Clock): AgencyImportResult {
  const { rows, skipped } = parseAgencyLines(text, localDate(now));
  const out: AgencyImportResult = { added: [], merged: [], skipped: [...skipped] };
  for (const row of rows) {
    try {
      const r = saveAdded(root, row, c);
      // Two lines for one agency in the same list: the second one merges.
      (r.created && !out.added.some((x) => x.slug === r.slug) ? out.added : out.merged).push(r);
    } catch (e) {
      out.skipped.push({ line: row.line, text: row.name, why: e instanceof Error ? e.message : String(e) });
    }
  }
  out.skipped.sort((x, y) => x.line - y.line);
  return out;
}

/** A list file is small text; anything bigger isn't one. */
const MAX_LIST_BYTES = 1024 * 1024;
function importFile(ctx: ServiceContext, abs: string): AgencyImportResult {
  const root = ctx.requireRoot();
  const f = checkIncomingFile(null, abs);
  if (!/\.(csv|txt)$/i.test(f.name)) throw new Error(`"${f.name}" isn't a CSV or text file. Save the list as CSV first.`);
  if (f.size > MAX_LIST_BYTES) throw new Error(`"${f.name}" is larger than 1 MB, so it isn't a list of agencies.`);
  const fd = fs.openSync(f.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  let text: string;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino || st.size > MAX_LIST_BYTES) throw new Error(`"${f.name}" changed after it was picked. Pick it again.`);
    text = fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
  const r = importText(root, text, ctx.now(), ctx.clock());
  touch(root, "recruiters");
  return r;
}

function rowOf(ctx: ServiceContext, slug: string): AgencyRow {
  const row = agencyRows(ctx.requireRoot(), ctx.now()).find((r) => r.slug === slug);
  if (!row) throw new Error("That recruiter isn't in this workspace.");
  return row;
}

function unlink(ctx: ServiceContext, slug: string, value: string): AgencyRow {
  const root = ctx.requireRoot();
  const v = value.trim().toLowerCase();
  updateAgency(root, slug, (a) => {
    const before = a.email_match ?? [];
    a.email_match = before.filter((x) => x.toLowerCase() !== v);
    if (a.email_match.length !== before.length) a.timeline = [...a.timeline, { at: iso(ctx.clock()), event: "Email link removed", note: v }].slice(-500);
  });
  return rowOf(ctx, slug);
}

/** A stored message's first recipient (for mail you sent), or nobody when it can't be read. */
function firstTo(root: string, ref: string): MailAddressView[] {
  try { return readStored(root, ref).email.to.slice(0, 1); } catch { return []; }
}

/**
 * An agency's conversation: everything filed under its slug, mail filed elsewhere from one of its addresses or
 * domains (and the rest of those threads), and drafts kept with it or addressed to it.
 */
export function agencyEmails(root: string, slug: string): AgencyEmails {
  const a = readAgency(root, slug) as unknown as AgencyRecordView | null;
  if (!a) throw new Error("That recruiter isn't in this workspace.");
  const m = agencyAddresses(a);
  const theirs = (addr: string) => {
    const x = addr.trim().toLowerCase();
    const d = x.slice(x.lastIndexOf("@") + 1);
    return m.addresses.has(x) || [...m.domains].some((dom) => d === dom || d.endsWith(`.${dom}`));
  };
  const all = allMailRows(root);
  const mine = all.filter((r) => r.company_slug === slug || (r.direction === "in" && theirs(r.from.address)));
  const threads = new Set(mine.map((r) => r.thread_key).filter(Boolean));
  const rows: MailRow[] = all.filter((r) => mine.includes(r) || (!!r.thread_key && threads.has(r.thread_key))).slice(0, 300);
  const withTo = rows.map((r) => ({ ...r, snippet: readSnippet(root, r.ref), ...(r.direction === "out" ? { to: firstTo(root, r.ref) } : {}) }));
  const drafts = allDrafts(root, () => {}).filter((d) => d.company_slug === slug || d.to.split(",").some((t) => t.trim() && theirs(t.replace(/^.*</, "").replace(/>.*$/, ""))));
  return agencyThreads(withTo, drafts);
}

/**
 * Mail to sort › Recruiter: links the sender's address, or (not free mail, not a job board) their domain, to the
 * agency; files this message under it; then files every other waiting message that now matches it.
 */
export function linkAgency(ctx: ServiceContext, id: string, slug: string, scope: AgencyLinkScope): TriageItem[] {
  const root = ctx.requireRoot();
  if (!readAgency(root, slug)) throw new Error("That recruiter isn't in this workspace.");
  const ref = `.careeros/mail-triage/${id}.json`;
  const { email } = readStored(root, ref);
  if (email.direction !== "in") throw new Error("Only an email you received can link its sender.");
  const address = email.from.address.trim().toLowerCase();
  const domain = domainOf(address);
  if (!address.includes("@") || !domain) throw new Error("This email has no sender address to link.");
  if (scope === "domain" && !linkableDomain(domain)) throw new Error(`${domain} is shared by many people, so only this exact address can be linked.`);
  const value = scope === "domain" ? domain : address;
  mergeAgency(root, { slug, name: "", email_match: [value] }, { event: "Email linked", note: value }, ctx.clock());
  ensureAgencyCompany(root, slug);
  const touched: string[] = [`recruiters/${slug}`, `companies/${slug}`];
  const file = (r: string, subject: string, jobId: string) => {
    const to = moveMessage(root, r, { company_slug: slug, job_id: jobId });
    touched.push(r, to);
    if (jobId) {
      const e = readStored(root, to).email;
      updateRecord("job", jobFilePath(root, slug, jobId), (j) => {
        if (e.message_id && j.timeline.some((x) => x.message_id === e.message_id)) return;
        j.timeline.push({ at: iso(ctx.clock()), event: "Email received", note: subject.slice(0, 200), ...(e.message_id ? { message_id: e.message_id } : {}) });
      });
    }
  };
  const companies = companyIndex(root);
  const pick = (h: Parameters<typeof matchMessage>[0]) => matchMessage(h, companies)?.job_id ?? "";
  const header = (e: typeof email) => ({ direction: e.direction, from: e.from, to: e.to, cc: e.cc, subject: e.subject });
  const mineMatch = matchMessage(header(email), companies);
  file(ref, email.subject, mineMatch?.company_slug === slug ? mineMatch.job_id : "");
  // Other waiting mail from the same sender (or domain) follows.
  for (const t of listTriage(root)) {
    if (t.email.direction !== "in") continue;
    const m = matchMessage(header(t.email), companies);
    if (m?.company_slug === slug) file(t.ref, t.email.subject, pick(header(t.email)));
  }
  touch(root, ...touched);
  return triageItems(ctx);
}

export const recruiterAddHandlers = {
  "recruiters.add": add,
  "recruiters.importList": (ctx: ServiceContext, text: string) => {
    const root = ctx.requireRoot();
    const r = importText(root, text, ctx.now(), ctx.clock());
    touch(root, "recruiters");
    return r;
  },
  "recruiters.importFile": importFile,
  "recruiters.unlink": unlink,
  "recruiters.emails": (ctx: ServiceContext, slug: string) => agencyEmails(ctx.requireRoot(), slug),
  "mail.triage.linkAgency": linkAgency,
} satisfies Partial<HandlerTable>;
