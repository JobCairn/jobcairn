import fs from "node:fs";
import path from "node:path";
import { careerosDir, layout, readRecord, refreshIndex, setStatus, writeFileAtomic } from "@careeros/core";
import { resolveMailRef, type StatusSuggestion } from "@careeros/mail";
import { MAIL_UPDATE_STATUSES, mailUpdateApplies, mailUpdateNote, type MailUpdate, type MailUpdateStatus } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";

/**
 * "Updates from your mail": the status changes mail sync suggests (mail signals.ts), kept in
 * `.careeros/mail-suggestions.json` next to mail-state.json until the person accepts or dismisses them. Nothing
 * changes a job without that click. The file is small (capped lists) and a missing or broken one reads as empty.
 */

const MAX_PENDING = 200;
const MAX_DISMISSED = 500;
const GONE = "This update is no longer waiting. The list has been refreshed.";
const MOVED_ON = "This job has already moved on, so its status wasn't changed.";

interface Pending { company_slug: string; job_id: string; to: MailUpdateStatus; note: string; ref: string; at: string }
export interface SuggestionFile { schema: 1; pending: Pending[]; dismissed: string[] }

const fileOf = (root: string) => path.join(careerosDir(root), "mail-suggestions.json");
/** One update per job, status and email. */
export const suggestionKey = (s: { company_slug: string; job_id: string; to: string; ref: string }) => `${s.company_slug}/${s.job_id}|${s.to}|${s.ref}`;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function clean(v: unknown): Pending | null {
  const o = v as Partial<Record<keyof Pending, unknown>> | null;
  if (!o || typeof o !== "object") return null;
  const company_slug = str(o.company_slug, 120), job_id = str(o.job_id, 200), ref = str(o.ref, 400), to = str(o.to, 20);
  if (!SLUG.test(company_slug) || !SLUG.test(job_id) || !ref || !(MAIL_UPDATE_STATUSES as readonly string[]).includes(to)) return null;
  return { company_slug, job_id, to: to as MailUpdateStatus, note: str(o.note, 300), ref, at: str(o.at, 40) };
}

/** The saved updates. Never throws: a missing, unreadable or hand-broken file is empty. */
export function readSuggestions(root: string): SuggestionFile {
  let raw: unknown = null;
  try { raw = JSON.parse(fs.readFileSync(fileOf(root), "utf8")); } catch { raw = null; }
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as { pending?: unknown; dismissed?: unknown };
  const pending = Array.isArray(o.pending) ? o.pending.map(clean).filter((p): p is Pending => !!p).slice(-MAX_PENDING) : [];
  const dismissed = Array.isArray(o.dismissed) ? o.dismissed.filter((x): x is string => typeof x === "string" && x.length <= 800).slice(-MAX_DISMISSED) : [];
  return { schema: 1, pending, dismissed };
}

function writeSuggestions(root: string, f: SuggestionFile): void {
  writeFileAtomic(fileOf(root), JSON.stringify({ schema: 1, pending: f.pending.slice(-MAX_PENDING), dismissed: f.dismissed.slice(-MAX_DISMISSED) }, null, 2) + "\n");
}

function jobOf(root: string, slug: string, id: string): { title: string; status: string } | null {
  try { const j = readRecord("job", layout(root).jobFile(slug, id)); return { title: j.title, status: j.status }; } catch { return null; }
}

/** The email is still filed where it was (not moved, re-sorted or removed since). */
function emailThere(root: string, ref: string): boolean {
  try { return fs.existsSync(resolveMailRef(root, ref).json); } catch { return false; }
}

/** Still worth asking about: the job and email are there, and the job hasn't reached (or closed past) that status. */
function live(root: string, p: Pending): boolean {
  const j = jobOf(root, p.company_slug, p.job_id);
  return !!j && mailUpdateApplies(j.status, p.to) && emailThere(root, p.ref);
}

/**
 * Keeps what a sync suggested: one per job, status and email; never one the person dismissed, or one the job has
 * already reached. Drops saved ones that no longer apply. Returns how many are new.
 */
export function recordSuggestions(root: string, list: readonly StatusSuggestion[], now: Date): number {
  const f = readSuggestions(root);
  const dismissed = new Set(f.dismissed);
  const pending = f.pending.filter((p) => live(root, p));
  const seen = new Set(pending.map(suggestionKey));
  let added = 0;
  for (const s of list) {
    const p = clean({ ...s, at: now.toISOString() });
    if (!p) continue;
    const key = suggestionKey(p);
    if (seen.has(key) || dismissed.has(key) || !live(root, p)) continue;
    seen.add(key);
    pending.push(p);
    added++;
  }
  if (added || pending.length !== f.pending.length) writeSuggestions(root, { ...f, pending });
  return added;
}

/** The updates still waiting, newest first, with each job's title and company. */
export function mailUpdates(root: string): MailUpdate[] {
  const names = new Map<string, string>();
  const companyName = (slug: string) => {
    if (!names.has(slug)) {
      let name = slug;
      try { name = readRecord("company", layout(root).companyFile(slug)).name || slug; } catch { /* the slug will do */ }
      names.set(slug, name);
    }
    return names.get(slug)!;
  };
  const out: MailUpdate[] = [];
  for (const p of readSuggestions(root).pending) {
    const j = jobOf(root, p.company_slug, p.job_id);
    if (!j || !mailUpdateApplies(j.status, p.to) || !emailThere(root, p.ref)) continue;
    out.push({ ...p, job_title: j.title, company_name: companyName(p.company_slug), status: j.status });
  }
  return out.reverse();
}

/** How many updates are waiting (Home's shortcut). Never throws. */
export function mailUpdateCount(root: string): number {
  try { return mailUpdates(root).length; } catch { return 0; }
}

function take(root: string, slug: string, id: string, to: MailUpdateStatus, ref: string): Pending {
  const f = readSuggestions(root);
  const key = suggestionKey({ company_slug: slug, job_id: id, to, ref });
  const p = f.pending.find((x) => suggestionKey(x) === key);
  if (!p) throw new Error(GONE);
  writeSuggestions(root, { ...f, pending: f.pending.filter((x) => suggestionKey(x) !== key) });
  return p;
}

/** "Update to <to>": sets the status the usual way (timeline "Status: <to>", note "From an email: …"), then forgets it. */
export function acceptMailUpdate(ctx: ServiceContext, slug: string, id: string, to: MailUpdateStatus, ref: string): MailUpdate[] {
  const root = ctx.requireRoot();
  const p = take(root, slug, id, to, ref);
  const j = jobOf(root, slug, id);
  if (!j || !mailUpdateApplies(j.status, to)) throw new Error(MOVED_ON);
  setStatus(root, slug, id, to, mailUpdateNote(p.note), ctx.clock());
  refreshIndex(root, [`companies/${slug}/jobs/${id}`]);
  return mailUpdates(root);
}

/** "Dismiss": forgets it, and the same email never suggests it again. */
export function dismissMailUpdate(ctx: ServiceContext, slug: string, id: string, to: MailUpdateStatus, ref: string): MailUpdate[] {
  const root = ctx.requireRoot();
  const f = readSuggestions(root);
  const key = suggestionKey({ company_slug: slug, job_id: id, to, ref });
  writeSuggestions(root, { ...f, pending: f.pending.filter((x) => suggestionKey(x) !== key), dismissed: [...f.dismissed.filter((k) => k !== key), key] });
  return mailUpdates(root);
}

export const mailSuggestionHandlers = {
  "mail.updates.list": (ctx: ServiceContext) => mailUpdates(ctx.requireRoot()),
  "mail.updates.accept": acceptMailUpdate,
  "mail.updates.dismiss": dismissMailUpdate,
} satisfies Partial<HandlerTable>;
