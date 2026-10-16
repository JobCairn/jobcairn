import fs from "node:fs";
import path from "node:path";
import { iso, type Clock } from "./clock.js";
import { assertSegment, insideRoot, layout } from "./paths.js";
import { defaults } from "./schema.js";
import { readRecord, updateRecord, writeRecord } from "./store.js";
import type { Agency, AgencyContact, AgencyPerson, AgencySource } from "./types.js";

/**
 * Recruitment agencies and the recruiters they publish: one record per agency at recruiters/<slug>/agency.json.
 * Every write goes through the store. Inputs arrive already checked by the contract's published-contact rules
 * (contract/recruiters.ts: plain addresses, an https source for each); this module only merges and saves them.
 */

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CAP = { list: 20, contacts: 40, people: 40, jobs: 500, timeline: 500, sources: 100, email_match: 50 } as const;

/** What a caller may add to an agency: anything left out (or empty) keeps what is there. */
export interface AgencyInput {
  slug: string; name: string; website?: string; since?: number | null;
  specialties?: string[]; tags?: string[]; cities?: string[]; hiring_summary?: string; about_url?: string;
  city_links?: { city: string; url: string }[]; linkedin_url?: string;
  team_note?: { text: string; source_url: string }; best_contact?: { name: string; source_url: string };
  contacts?: AgencyContactInput[];
  people?: AgencyPersonInput[]; job_refs?: string[];
  /** Where it was found: merged by url (the first time an address was seen is kept). */
  sources?: AgencySourceInput[];
  /** Addresses or domains the person linked from Mail (already checked: never a free-mail or board domain). */
  email_match?: string[];
  /** true when the person added it and Claude hasn't checked it; false once Claude saves it. Left out: unchanged. */
  needs_check?: boolean;
}
/** The one source name allowed without a page: an agency the person typed in themselves (name and email). */
export const ADDED_BY_YOU = "Added by you";
export interface AgencySourceInput { name: string; url: string; found_at?: string }
export interface AgencyPersonInput { name?: string; title?: string; email?: string; phone?: string; source_url?: string; specialties?: string[]; job_refs?: string[] }
export interface AgencyContactInput { kind: "email" | "phone"; value: string; source_url: string; label?: string; found_on?: string; confirmed?: boolean }

function agencyPath(root: string, slug: string): string {
  if (!SLUG.test(slug) || slug.length > 64) throw new Error(`unsafe agency slug: "${slug}"`);
  assertSegment(slug, "agency slug");
  const file = layout(root).agencyFile(slug);
  if (!insideRoot(root, file)) throw new Error("refusing to write outside the workspace");
  return file;
}

/** One agency, or null when it isn't there or can't be read. */
export function readAgency(root: string, slug: string): Agency | null {
  try {
    const file = agencyPath(root, slug);
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    return readRecord("agency", file);
  } catch { return null; }
}

/** Every readable agency, by slug. An unreadable one is skipped. */
export function listAgencies(root: string): Agency[] {
  const dir = layout(root).recruitersDir;
  let names: string[];
  try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  return names.filter((n) => SLUG.test(n)).map((n) => readAgency(root, n)).filter((a): a is Agency => !!a);
}

const union = (a: string[], b: string[] | undefined, cap: number) => {
  const out = [...a];
  const seen = new Set(a.map((x) => x.toLowerCase()));
  for (const x of b ?? []) if (x && !seen.has(x.toLowerCase()) && out.length < cap) { seen.add(x.toLowerCase()); out.push(x); }
  return out;
};

function mergePeople(cur: AgencyPerson[], add: AgencyPersonInput[] | undefined): AgencyPerson[] {
  const out = cur.map((p) => ({ ...p }));
  for (const p of add ?? []) {
    if (!p.name || !p.source_url) continue;
    const hit = out.find((x) => x.name.toLowerCase() === p.name!.toLowerCase());
    if (hit) {
      hit.title ||= p.title ?? ""; hit.email ||= p.email ?? ""; hit.phone ||= p.phone ?? "";
      hit.specialties = union(hit.specialties, p.specialties, CAP.list);
      hit.job_refs = union(hit.job_refs, p.job_refs, CAP.jobs);
    } else if (out.length < CAP.people) {
      out.push({ name: p.name, title: p.title ?? "", email: p.email ?? "", phone: p.phone ?? "", source_url: p.source_url, specialties: p.specialties ?? [], job_refs: p.job_refs ?? [] });
    }
  }
  return out;
}

/**
 * Adds to an agency, making it when it is new: lists are merged without duplicates (contacts by kind and value,
 * people by name, sources by url), and a non-empty field replaces the old one (newer research wins). `event` goes on its timeline.
 */
export function mergeAgency(root: string, input: AgencyInput, event: { event: string; note?: string } | null, c?: Clock): Agency {
  const file = agencyPath(root, input.slug);
  const at = iso(c);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(layout(root).recruitersDir, { recursive: true });
    writeRecord("agency", file, defaults("agency", { name: input.name || input.slug, slug: input.slug }));
  }
  return updateRecord("agency", file, (a) => {
    if (input.name && a.name === a.slug) a.name = input.name;
    for (const k of ["website", "hiring_summary", "about_url", "linkedin_url"] as const) if (input[k]) a[k] = input[k]!;
    if (input.since) a.since = input.since;
    if (input.team_note?.text) a.team_note = { ...input.team_note };
    if (input.best_contact?.name) a.best_contact = { ...input.best_contact };
    a.specialties = union(a.specialties, input.specialties, CAP.list);
    a.tags = union(a.tags, input.tags, CAP.list);
    a.cities = union(a.cities, input.cities, CAP.list);
    for (const l of input.city_links ?? []) {
      if (!a.city_links.some((x) => x.city.toLowerCase() === l.city.toLowerCase()) && a.city_links.length < CAP.list) a.city_links.push({ ...l });
    }
    for (const x of input.contacts ?? []) {
      const key = `${x.kind}:${x.value.toLowerCase()}`;
      if (a.contacts.some((y) => `${y.kind}:${y.value.toLowerCase()}` === key) || a.contacts.length >= CAP.contacts) continue;
      a.contacts.push({ kind: x.kind, value: x.value, label: x.label ?? "", source_url: x.source_url, found_on: x.found_on || at.slice(0, 10), confirmed: x.confirmed ?? false } satisfies AgencyContact);
    }
    a.people = mergePeople(a.people, input.people);
    a.job_refs = union(a.job_refs, input.job_refs, CAP.jobs);
    a.sources ??= [];
    for (const x of input.sources ?? []) {
      // Sources merge by page; the person's own "Added by you" with no page merges by name.
      if (!x.name || (!x.url && x.name !== ADDED_BY_YOU) || a.sources.length >= CAP.sources) continue;
      if (a.sources.some((y) => (x.url ? y.url === x.url : !y.url && y.name === x.name))) continue;
      a.sources.push({ name: x.name, url: x.url, found_at: x.found_at || at } satisfies AgencySource);
    }
    a.email_match = union((a.email_match ?? []).map((x) => x.toLowerCase()), input.email_match?.map((x) => x.trim().toLowerCase()), CAP.email_match);
    if (input.needs_check !== undefined) a.needs_check = input.needs_check;
    if (event) a.timeline = [...a.timeline, { at, event: event.event, note: event.note ?? "" }].slice(-CAP.timeline);
  });
}

/** Changes an agency the person owns (favourite, tracking). Throws when it isn't there. */
export function updateAgency(root: string, slug: string, fn: (a: Agency) => void): Agency {
  const file = agencyPath(root, slug);
  if (!fs.existsSync(file)) throw new Error("That recruiter isn't in this workspace.");
  return updateRecord("agency", file, fn);
}

/** A site's host without "www.", lower case, or "" when it isn't a web address. */
export function siteHost(url: string): string {
  const u = url.trim();
  if (!u) return "";
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").replace(/\.$/, "").toLowerCase(); }
  catch { return ""; }
}

/**
 * The saved agency an incoming one is the same as: the one with this slug, else one whose website has the same host
 * (www. ignored). Callers never pass a job board or web-mail address as `website`.
 */
export function findSameAgency(root: string, slug: string, website: string): Agency | null {
  const bySlug = readAgency(root, slug);
  if (bySlug) return bySlug;
  const host = siteHost(website);
  if (!host.includes(".")) return null;
  return listAgencies(root).find((a) => !!a.website && siteHost(a.website) === host) ?? null;
}

/**
 * Makes sure an agency has a company folder with the same slug, so its mail can be filed and drafted there. A new one
 * is marked a recruiter and carries the agency's name and website. A company that is already there is never changed.
 */
export function ensureAgencyCompany(root: string, slug: string): void {
  const a = readAgency(root, slug);
  if (!a) throw new Error("That recruiter isn't in this workspace.");
  const file = layout(root).companyFile(slug);
  if (fs.existsSync(file)) return;
  if (!insideRoot(root, file)) throw new Error("refusing to write outside the workspace");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeRecord("company", file, defaults("company", { name: a.name, slug, website: a.website, type: "recruiter" }));
}
