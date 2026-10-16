import { isPlainEmail } from "./contacts.js";
import { jobBoardByUrl } from "./job-boards.js";
import type { DraftView, MailAddressView, MailRow } from "./mail.js";
import { agencySlug, type AgencyContactView } from "./recruiters.js";
import { ArgError, isSafeHttpsUrl } from "./validate.js";

/**
 * Add recruiter and Import (spec 2026-10-17-add-recruiter-and-mail): an agency the person already knows, from a
 * pasted website, a job ad link from it, or a name with an email; and a list of them, one per line. The app saves it
 * straight away with where it came from; Check recruiters (Claude) then fills in the rest from the agency's own pages.
 */

/** The source name for an agency the person added; a job-board link is named after its board instead. */
export const ADDED_BY_YOU = "Added by you";
/** Most lines one import takes. */
export const AGENCY_IMPORT_MAX = 200;
/** Most characters of pasted text or file one import reads. */
export const AGENCY_IMPORT_MAX_CHARS = 100_000;

export interface AddRecruiterInput { text: string; name?: string }
/** One agency to save, already checked. `rename`: the name was made from its site, so Claude's real name replaces it. */
export interface AgencyAddClean {
  slug: string; name: string; website: string; rename: boolean;
  contacts: AgencyContactView[]; sources: { name: string; url: string }[];
}
export interface AgencyAddResult { slug: string; name: string; created: boolean }
export interface AgencyImportResult {
  added: AgencyAddResult[]; merged: AgencyAddResult[];
  /** Lines that couldn't be used (1-based), with why. */
  skipped: { line: number; text: string; why: string }[];
}

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const URL_RE = /\bhttps?:\/\/[^\s<>"',;]+/i;
const HOST_RE = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\.?(?:\/\S*)?$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** "acme.example.com", "http://..." or "https://..." as a safe https address, or "". */
export function asHttps(v: string): string {
  const t = v.trim().replace(/[.,;)]+$/, "");
  if (!t) return "";
  const u = /^https?:\/\//i.test(t) ? t.replace(/^http:\/\//i, "https://") : HOST_RE.test(t) ? `https://${t}` : "";
  return u && isSafeHttpsUrl(u) ? u : "";
}

/** "acmerecruiting.example.com" from a site: its host without www. */
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
/** A stand-in name from a site's host ("acmerecruiting.example.com" gives "Acmerecruiting"), until Claude saves the real one. */
function nameFromHost(host: string): string {
  const label = host.split(".")[0] ?? "";
  return label ? label[0]!.toUpperCase() + label.slice(1) : "";
}

/**
 * One agency from what the person typed: a name, a link (its own site, or a job ad on a board) and emails. A board
 * link is never the agency's website (it is the source, named after the board) and needs a name. Emails are kept as
 * the person's own contacts ("Added by you", no source page). Throws ArgError with a plain reason.
 */
export function agencyFromFields(f: { name: string; url: string; emails: string[] }, today: string): AgencyAddClean {
  const url = f.url ? asHttps(f.url) : "";
  if (f.url && !url) throw new ArgError("That link doesn't look right. Use the https:// address.");
  const board = url ? jobBoardByUrl(url) : undefined;
  const website = url && !board ? new URL(url).origin : "";
  let name = clean(f.name, 200);
  let rename = false;
  if (!name && website) { name = nameFromHost(hostOf(website)); rename = true; }
  if (!name) throw new ArgError(board ? `That's a ${board.name} ad. Add the agency's name too.` : "Add the agency's name, its website or a job ad link.");
  const emails = [...new Set(f.emails.map((e) => e.trim().toLowerCase()))];
  const bad = emails.find((e) => !isPlainEmail(e));
  if (bad) throw new ArgError(`${bad} isn't an email address.`);
  return {
    slug: agencySlug(name), name, website, rename,
    contacts: emails.slice(0, 5).map((value) => ({ kind: "email", value, label: ADDED_BY_YOU, source_url: "", found_on: today, confirmed: false })),
    sources: [{ name: board ? board.name : ADDED_BY_YOU, url }],
  };
}

/** Add recruiter's one box (and optional name): the first link, any emails, and the rest of the first line as the name. */
export function addRecruiterArgs(raw: unknown, today = ""): AgencyAddClean {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.slice(0, 4000) : "";
  const given = typeof o.name === "string" ? o.name : "";
  if (!text.trim() && !given.trim()) throw new ArgError("Paste the agency's website, a job ad link, or its name and email.");
  const emails = text.match(EMAIL_RE) ?? [];
  let rest = text.replace(EMAIL_RE, " ");
  let url = URL_RE.exec(rest)?.[0] ?? "";
  if (url) rest = rest.replace(url, " ");
  else {
    // A bare site ("acmerecruiting.example.com") on its own counts as a link.
    const word = rest.split(/\s+/).find((w) => HOST_RE.test(w) && /\.[a-z]{2,}(\/|$)/i.test(w));
    if (word) { url = word; rest = rest.replace(word, " "); }
  }
  const firstLine = rest.split(/\n/).map((l) => l.replace(/[,;|]+/g, " ").trim()).find(Boolean) ?? "";
  return agencyFromFields({ name: given.trim() || firstLine, url, emails }, today);
}

/** One CSV line's cells: commas split, double quotes group ("Acme, Recruiting"), tabs work too. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === "\"" && line[i + 1] === "\"") { cur += "\""; i++; } else if (ch === "\"") q = false; else cur += ch;
    } else if (ch === "\"") q = true;
    else if (ch === "," || ch === "\t") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * A pasted list or CSV file: one agency per line, `name, website, email` (website and email optional, in any order
 * after the name: a cell with @ is an email, anything else a site). A first line starting with "name" is a header.
 * Blank lines are passed over; at most AGENCY_IMPORT_MAX agencies; lines that can't be used come back in `skipped`.
 */
export function parseAgencyLines(text: string, today = ""): { rows: (AgencyAddClean & { line: number })[]; skipped: AgencyImportResult["skipped"] } {
  const rows: (AgencyAddClean & { line: number })[] = [];
  const skipped: AgencyImportResult["skipped"] = [];
  const lines = text.slice(0, AGENCY_IMPORT_MAX_CHARS).replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const c = cells(line);
    if (i === 0 && /^name$/i.test(c[0] ?? "")) return;
    const shown = clean(line, 120);
    if (rows.length >= AGENCY_IMPORT_MAX) { skipped.push({ line: i + 1, text: shown, why: `Only ${AGENCY_IMPORT_MAX} agencies at a time.` }); return; }
    const [first = "", ...more] = c;
    // A line that starts with a link (no name) is that link: the name comes from the site, or is asked for.
    const firstIsLink = /^https?:\/\//i.test(first) || HOST_RE.test(first);
    const name = firstIsLink ? "" : first;
    const emails = more.filter((x) => x.includes("@"));
    const sites = [...(firstIsLink ? [first] : []), ...more.filter((x) => x && !x.includes("@"))];
    try {
      if (sites.length > 1) throw new ArgError("More than one website on this line.");
      rows.push({ ...agencyFromFields({ name, url: sites[0] ?? "", emails }, today), line: i + 1 });
    } catch (e) {
      skipped.push({ line: i + 1, text: shown, why: e instanceof Error ? e.message : String(e) });
    }
  });
  return { rows, skipped };
}

// ---- The Emails tab ------------------------------------------------------------------------------------------------

/** One message on an agency's Emails tab: filed mail, or a draft to it not sent yet. */
export interface AgencyEmail {
  kind: "mail" | "draft";
  /** Filed mail: its mail ref (opens in the viewer). A draft: "" */
  ref: string;
  direction: "in" | "out";
  /** The other side: the sender of mail in, the first recipient of mail out. */
  who: MailAddressView;
  date: string; subject: string; snippet: string;
  /** Where it is filed (mail) or kept (draft): the owner a reply or an edit uses. */
  company_slug: string; job_id: string;
  /** Drafts: their id and status. */
  draft_id?: string; status?: DraftView["status"];
}
export interface AgencyThread { key: string; subject: string; messages: AgencyEmail[] }
export interface AgencyEmails {
  threads: AgencyThread[]; total: number;
  /** The newest message received, which Reply answers, or null. */
  latest_in: string | null;
}

/** A subject without "Re:", "Fwd:" and the like, lower case, for grouping drafts with their thread. */
export const baseSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, "").trim().toLowerCase();

/**
 * An agency's conversation: messages grouped by thread, oldest to newest inside a thread, the thread with the newest
 * message first. Drafts join the thread with the same subject (Re: ignored), else start their own. A draft marked
 * sent is left out when a sent message with that subject is filed (mail sync brought the real copy from Gmail).
 */
export function agencyThreads(mail: (MailRow & { to?: MailAddressView[] })[], drafts: DraftView[]): AgencyEmails {
  const items: (AgencyEmail & { thread: string })[] = mail.map((r) => ({
    kind: "mail", ref: r.ref, direction: r.direction, who: r.direction === "in" ? r.from : (r.to?.[0] ?? { name: "", address: "" }),
    date: r.date, subject: r.subject, snippet: r.snippet ?? "", company_slug: r.company_slug, job_id: r.job_id, thread: r.thread_key || r.ref,
  }));
  const sentSubjects = new Set(mail.filter((r) => r.direction === "out").map((r) => baseSubject(r.subject)));
  const bySubject = new Map<string, string>();
  for (const it of [...items].sort((a, b) => a.date.localeCompare(b.date))) if (!bySubject.has(baseSubject(it.subject))) bySubject.set(baseSubject(it.subject), it.thread);
  for (const d of drafts) {
    if (d.status === "sent" && sentSubjects.has(baseSubject(d.subject))) continue;
    const to = d.to.split(",")[0]?.trim() ?? "";
    items.push({
      kind: "draft", ref: "", direction: "out", who: { name: "", address: to }, date: d.updated, subject: d.subject, snippet: "",
      company_slug: d.company_slug, job_id: d.id, draft_id: d.draft_id, status: d.status,
      thread: bySubject.get(baseSubject(d.subject)) ?? `draft:${d.company_slug}/${d.id}/${d.draft_id}`,
    });
  }
  const groups = new Map<string, AgencyEmail[]>();
  for (const { thread, ...it } of items) groups.set(thread, [...(groups.get(thread) ?? []), it]);
  const threads = [...groups.entries()].map(([key, messages]): AgencyThread => {
    messages.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
    return { key, subject: messages[0]!.subject, messages };
  }).sort((a, b) => b.messages.at(-1)!.date.localeCompare(a.messages.at(-1)!.date));
  const received = items.filter((i) => i.kind === "mail" && i.direction === "in").sort((a, b) => b.date.localeCompare(a.date));
  return { threads, total: items.length, latest_in: received[0]?.ref ?? null };
}

/** Link recruiter in Mail: the sender's exact address, or their whole domain. */
export type AgencyLinkScope = "address" | "domain";
