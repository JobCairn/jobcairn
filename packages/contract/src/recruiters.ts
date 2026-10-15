import { isPlainEmail, linkedinCompanyPage } from "./contacts.js";
import { jobBoardByUrl } from "./job-boards.js";
import type { JobRow } from "./types.js";
import { ArgError, isSafeHttpsUrl } from "./validate.js";

/**
 * An agency's slug: the same as core's slugify(name, "company"), which names company folders, so an agency Claude finds
 * and a job ad from it (saved under companies/<slug>) share one slug, and its mail goes in that company's folder.
 */
export function agencySlug(name: string): string {
  const s = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s || "company";
}

/**
 * Recruiters: recruitment agencies and the recruiters they publish, for emailing about jobs and sponsorship.
 * Records live at recruiters/<slug>/agency.json (core/recruiters.ts writes them through the store). The rules
 * match contacts.json: only details the agency publishes itself (its own site, its own job ads), each with the
 * https page it came from; never a guessed or constructed address; never details taken from LinkedIn profiles.
 * Sponsorship friendliness and tags from ads are worked out when read, from the jobs an agency advertised.
 */

export const AGENCY_STATUSES = ["to_contact", "contacted", "replied", "meeting", "not_a_fit"] as const;
export type AgencyStatus = (typeof AGENCY_STATUSES)[number];
export const AGENCY_STATUS_LABELS: Record<AgencyStatus, string> = {
  to_contact: "To contact", contacted: "Contacted", replied: "Replied", meeting: "Meeting", not_a_fit: "Not a fit",
};
/** Follow up this many business days after the contacted date, unless the person picks a date. */
export const AGENCY_FOLLOW_UP_DAYS = 5;

export interface AgencyContactView { kind: "email" | "phone"; value: string; label: string; source_url: string; found_on: string; confirmed: boolean }
export interface AgencyPersonView { name: string; title: string; email: string; phone: string; source_url: string; specialties: string[]; job_refs: string[] }
/**
 * One place an agency was found, like a job's source: `name` is the board's name as jobs show it ("SEEK", "LinkedIn",
 * "Indeed") when the page is on a job board, else the kind of page ("Web search", "RCSA directory", "Agency website",
 * "Saved job"); `url` the https page; `found_at` an ISO timestamp (like a job's found_at). Older records have none.
 */
export interface AgencySource { name: string; url: string; found_at: string }
export interface AgencyTracking { status: AgencyStatus; contacted_on: string; follow_up_on: string; notes: string }
/** The stored record, as the bridge sends it. */
export interface AgencyRecordView {
  name: string; slug: string; website: string; since: number | null; specialties: string[]; tags: string[]; cities: string[];
  hiring_summary: string; about_url: string; city_links: { city: string; url: string }[]; linkedin_url: string;
  team_note: { text: string; source_url: string }; best_contact: { name: string; source_url: string };
  contacts: AgencyContactView[]; people: AgencyPersonView[]; job_refs: string[]; favourite: boolean; tracking: AgencyTracking;
  timeline: { at: string; event: string; note: string }[];
  /** Where it was found, oldest first (merged by url). Records read through the store always have it ([] by default). */
  sources?: AgencySource[];
}
export interface AgencyJob { company_slug: string; id: string; title: string; location: string; job_type: string; status: string; open: boolean; sponsor_friendly: boolean }
/** One card on the Recruiters screen. */
export interface AgencyRow extends AgencyRecordView {
  /** Its own tags, then job types from the ads it posted ("Contract"), deduped. */
  all_tags: string[];
  /** Saved jobs it advertised, open ones first. */
  jobs: AgencyJob[];
  /** How many of those ads are open to visa holders (sponsorship offered or visas OK). */
  sponsor_jobs: number;
  /** The first published email and phone (agency-wide first, then a named recruiter's), or "". */
  email: string; phone: string;
  /** Its timeline, newest first: own events, emails drafted and sent, replies, a follow-up due (agencyActivity). */
  activity: AgencyEvent[];
}

const CLOSED = new Set(["Rejected", "Skipped"]);
const SPONSOR_LABELS = new Set(["sponsorship_offered", "visa_ok"]);
const uniq = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = x.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
};

/**
 * Cards for every agency, favourites first, then by name. `jobs` are the workspace's job rows; `outreach` is drafts and
 * filed emails for each card's timeline (see agencyActivity), with today's local date.
 */
export function buildAgencyRows(records: AgencyRecordView[], jobs: JobRow[], outreach: { drafts: OutreachDraft[]; replies: OutreachReply[]; today: string } = { drafts: [], replies: [], today: "" }): AgencyRow[] {
  const byRef = new Map(jobs.map((j) => [`${j.company_slug}/${j.id}`, j]));
  return records.map((r): AgencyRow => {
    const mine = uniq([...r.job_refs, ...r.people.flatMap((p) => p.job_refs)]).map((ref) => byRef.get(ref)).filter((j): j is JobRow => !!j)
      .map((j) => ({
        company_slug: j.company_slug, id: j.id, title: j.title, location: j.location, job_type: j.job_type ?? "", status: j.status,
        open: !CLOSED.has(j.status), sponsor_friendly: SPONSOR_LABELS.has(j.wr_label),
      }))
      .sort((a, b) => Number(b.open) - Number(a.open) || a.title.localeCompare(b.title));
    const email = r.contacts.find((c) => c.kind === "email")?.value || r.people.find((p) => p.email)?.email || "";
    const phone = r.contacts.find((c) => c.kind === "phone")?.value || r.people.find((p) => p.phone)?.phone || "";
    return {
      ...r, all_tags: uniq([...r.tags, ...mine.map((j) => j.job_type)]), jobs: mine,
      sponsor_jobs: mine.filter((j) => j.open && j.sponsor_friendly).length, email, phone,
      activity: agencyActivity(r, outreach.drafts, outreach.replies, outreach.today).events,
    };
  }).sort((a, b) => Number(b.favourite) - Number(a.favourite) || a.name.localeCompare(b.name));
}

export interface AgencyFilter { q?: string; tag?: string; city?: string; sponsor?: boolean }
/** Every tag and city across the cards, for the filter menus. */
export function agencyFacets(rows: AgencyRow[]): { tags: string[]; cities: string[] } {
  return {
    tags: uniq(rows.flatMap((r) => r.all_tags)).sort((a, b) => a.localeCompare(b)),
    cities: uniq(rows.flatMap((r) => r.cities)).sort((a, b) => a.localeCompare(b)),
  };
}
/** Cards matching the search words (name, specialties, tags, hiring summary, cities), tag, city and sponsorship signal. */
export function filterAgencies(rows: AgencyRow[], f: AgencyFilter): AgencyRow[] {
  const q = (f.q ?? "").trim().toLowerCase();
  const has = (xs: string[], x: string) => xs.some((y) => y.toLowerCase() === x.toLowerCase());
  return rows.filter((r) =>
    (!q || [r.name, r.hiring_summary, ...r.specialties, ...r.all_tags, ...r.cities, ...r.jobs.map((j) => j.title)].some((s) => s.toLowerCase().includes(q)))
    && (!f.tag || has(r.all_tags, f.tag)) && (!f.city || has(r.cities, f.city)) && (!f.sponsor || r.sponsor_jobs > 0));
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** A YYYY-MM-DD date `n` business days later (Saturdays and Sundays skipped; public holidays aren't known). "" for a bad date. */
export function addBusinessDays(ymd: string, n: number): string {
  if (!YMD.test(ymd)) return "";
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

/** What the person may change on a card. Dates are YYYY-MM-DD or "" to clear. */
export interface AgencyPatch { favourite?: boolean; status?: AgencyStatus; contacted_on?: string; follow_up_on?: string; notes?: string }
export const AGENCY_NOTES_MAX = 4000;
/** Checks a patch from the renderer; throws ArgError on anything else. */
export function agencyPatchArgs(v: unknown, at = "patch"): AgencyPatch {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ArgError(`${at} must be an object`);
  const o = v as Record<string, unknown>;
  const out: AgencyPatch = {};
  for (const k of Object.keys(o)) if (!["favourite", "status", "contacted_on", "follow_up_on", "notes"].includes(k)) throw new ArgError(`${at}.${k} isn't allowed`);
  if (o.favourite !== undefined) { if (typeof o.favourite !== "boolean") throw new ArgError(`${at}.favourite must be true or false`); out.favourite = o.favourite; }
  if (o.status !== undefined) {
    if (!(AGENCY_STATUSES as readonly unknown[]).includes(o.status)) throw new ArgError(`${at}.status must be one of: ${AGENCY_STATUSES.join(", ")}`);
    out.status = o.status as AgencyStatus;
  }
  for (const k of ["contacted_on", "follow_up_on"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "string" || (o[k] !== "" && (!YMD.test(o[k] as string) || Number.isNaN(Date.parse(o[k] as string))))) throw new ArgError(`${at}.${k} must be a date (YYYY-MM-DD) or empty`);
    out[k] = o[k] as string;
  }
  if (o.notes !== undefined) {
    if (typeof o.notes !== "string" || o.notes.length > AGENCY_NOTES_MAX || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(o.notes)) throw new ArgError(`${at}.notes must be text of at most ${AGENCY_NOTES_MAX} characters`);
    out.notes = o.notes;
  }
  return out;
}

/**
 * A checked patch applied to a record (services and the mock share this). Setting a contacted date with no follow-up
 * date (and none given) sets the follow-up AGENCY_FOLLOW_UP_DAYS business days later; setting it also moves "To contact"
 * to "Contacted". Returns the timeline events the change makes.
 */
export function applyAgencyPatch(a: Pick<AgencyRecordView, "favourite" | "tracking">, p: AgencyPatch): { event: string; note: string }[] {
  const events: { event: string; note: string }[] = [];
  const t = a.tracking;
  if (p.favourite !== undefined) a.favourite = p.favourite;
  if (p.contacted_on !== undefined && p.contacted_on !== t.contacted_on) {
    t.contacted_on = p.contacted_on;
    if (p.contacted_on) {
      if (p.follow_up_on === undefined && !t.follow_up_on) t.follow_up_on = addBusinessDays(p.contacted_on, AGENCY_FOLLOW_UP_DAYS);
      if (p.status === undefined && t.status === "to_contact") t.status = "contacted";
      events.push({ event: "Contacted", note: p.contacted_on });
    }
  }
  if (p.follow_up_on !== undefined && p.follow_up_on !== t.follow_up_on) {
    t.follow_up_on = p.follow_up_on;
    if (p.follow_up_on) events.push({ event: "Follow-up set", note: p.follow_up_on });
  }
  if (p.status !== undefined && p.status !== t.status) { t.status = p.status; events.push({ event: AGENCY_STATUS_LABELS[p.status], note: "" }); }
  if (p.notes !== undefined && p.notes !== t.notes) {
    t.notes = p.notes;
    if (p.notes.trim()) events.push({ event: "Notes updated", note: p.notes.trim().replace(/\s+/g, " ").slice(0, 160) });
  }
  return events;
}

// ---- Published contacts, as Claude or a job ad hands them in --------------------------------------------------

const PHONE = /^\+?[0-9 ()-]{6,24}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const line = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const https = (v: unknown) => (typeof v === "string" && isSafeHttpsUrl(v.trim()) ? v.trim() : "");
const words = (v: unknown, max: number, each: number) => (Array.isArray(v) ? uniq(v.map((x) => line(x, each)).filter(Boolean)).slice(0, max) : []);
/** A published phone number as written, or "" when it doesn't look like one. */
export const cleanPhone = (v: unknown): string => { const p = line(v, 40); return PHONE.test(p) && (p.match(/\d/g)?.length ?? 0) >= 6 ? p : ""; };

/** What the recruiter_add tool and ad capture hand to core's mergeAgency, already checked. */
export interface AgencyInputClean {
  slug: string; name: string; website: string; since: number | null; specialties: string[]; tags: string[]; cities: string[];
  hiring_summary: string; about_url: string; city_links: { city: string; url: string }[]; linkedin_url: string;
  team_note: { text: string; source_url: string }; best_contact: { name: string; source_url: string };
  contacts: AgencyContactView[]; people: AgencyPersonView[]; job_refs: string[];
  /** Where it was found (name and https page); the store adds when. */
  sources: { name: string; url: string }[];
}

/** Most sources one save may add. */
export const AGENCY_SOURCES_MAX = 20;
/** A source's name: the job board's own name when the page is on one (as jobs name it), else the name given, else "Web search". */
export function agencySourceName(name: unknown, url: string): string {
  return jobBoardByUrl(url)?.name ?? (line(name, 60) || "Web search");
}

/**
 * Checks one agency as Claude reports it. The name is required; everything else is kept only when it follows the
 * published-contact rules, and each thing left out is named in `dropped` (so the tool can tell Claude why).
 * Named people need an https source page, and the team note and "best reached through" need one too.
 */
export function cleanAgencyInput(raw: unknown, today = ""): { agency: AgencyInputClean; dropped: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ArgError("agency must be an object");
  const o = raw as Record<string, unknown>;
  const name = line(o.name, 200);
  if (!name) throw new ArgError("agency.name is required");
  const dropped: string[] = [];
  const contacts: AgencyContactView[] = [];
  for (const c of Array.isArray(o.contacts) ? o.contacts.slice(0, 40) : []) {
    const x = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const kind = x.kind === "phone" ? "phone" : "email";
    const value = kind === "email" ? (typeof x.value === "string" && isPlainEmail(x.value.trim()) ? x.value.trim().toLowerCase() : "") : cleanPhone(x.value);
    const source = https(x.source_url);
    if (!value || !source) { dropped.push(`contact ${line(x.value, 60) || "(blank)"}: ${!value ? "not a valid " + kind : "no https source page"}`); continue; }
    if (contacts.some((y) => y.kind === kind && y.value === value)) continue;
    contacts.push({ kind, value, label: line(x.label, 80), source_url: source, found_on: typeof x.found_on === "string" && DATE.test(x.found_on) ? x.found_on : today, confirmed: x.confirmed === true });
  }
  const people: AgencyPersonView[] = [];
  for (const p of Array.isArray(o.people) ? o.people.slice(0, 40) : []) {
    const x = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const pname = line(x.name, 120);
    const source = https(x.source_url);
    if (!pname || !source) { dropped.push(`person ${pname || "(no name)"}: no https source page`); continue; }
    const email = typeof x.email === "string" && x.email.trim() ? (isPlainEmail(x.email.trim()) ? x.email.trim().toLowerCase() : "") : "";
    if (typeof x.email === "string" && x.email.trim() && !email) dropped.push(`email for ${pname}: not a valid email`);
    people.push({ name: pname, title: line(x.title, 120), email, phone: cleanPhone(x.phone), source_url: source, specialties: words(x.specialties, 20, 60), job_refs: [] });
  }
  const pair = <K extends string>(v: unknown, key: K, max: number) => {
    const x = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const t = line(x[key], max);
    const s = https(x.source_url);
    if (t && !s) dropped.push(`${key === "text" ? "team note" : "best contact"}: no https source page`);
    return (t && s ? { [key]: t, source_url: s } : { [key]: "", source_url: "" }) as Record<K | "source_url", string>;
  };
  const since = typeof o.since === "number" && Number.isInteger(o.since) && o.since >= 1800 && o.since <= 2100 ? o.since : null;
  const linkedin = linkedinCompanyPage(o.linkedin_url);
  if (typeof o.linkedin_url === "string" && o.linkedin_url && !linkedin) dropped.push("linkedin_url: only the agency's own company page (linkedin.com/company/...)");
  const cityLinks = (Array.isArray(o.city_links) ? o.city_links : []).slice(0, 20).flatMap((c) => {
    const x = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const city = line(x.city, 80);
    const url = https(x.url);
    return city && url ? [{ city, url }] : [];
  });
  const website = https(o.website);
  const sources: { name: string; url: string }[] = [];
  for (const x of (Array.isArray(o.sources) ? o.sources : []).slice(0, AGENCY_SOURCES_MAX)) {
    const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const url = https(r.url);
    if (!url) { dropped.push(`source ${line(r.name, 60) || "(no name)"}: no https page`); continue; }
    if (!sources.some((y) => y.url === url)) sources.push({ name: agencySourceName(r.name, url), url });
  }
  // Nothing said where it was found: its own site is where it was checked.
  if (!sources.length && website) sources.push({ name: "Agency website", url: website });
  return {
    agency: {
      slug: agencySlug(name), name, website, since, specialties: words(o.specialties, 20, 60), tags: words(o.tags, 20, 40),
      cities: words(o.cities, 20, 80), hiring_summary: line(o.hiring_summary, 400), about_url: https(o.about_url), city_links: cityLinks,
      linkedin_url: linkedin, team_note: pair(o.team_note, "text", 400), best_contact: pair(o.best_contact, "name", 120),
      contacts, people, job_refs: [], sources,
    },
    dropped,
  };
}

const AD_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const AD_PHONE = /(?<![\d])(?:\+61[\s-]?|0)[2-478](?:[\s-]?\d){8}(?![\d])/g;
const AD_NAME = /\b(?:[Cc]ontact|[Cc]all|[Ee]mail|[Ss]peak (?:to|with)|[Rr]each out to|[Qq]uestions to)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/;
const NOT_NAMES = new Set(["us", "me", "our", "the", "we", "today", "now"]);

/**
 * Contact details a recruiter's job ad publishes in its own text: email addresses and Australian phone numbers,
 * with the ad's https link as the source, plus the name it gives for the contact ("Contact Jane on ..."), if any.
 * Nothing is guessed: only what is written in the ad. No https link means no source, so nothing comes back.
 */
export function adContacts(text: string, url: string, today = ""): { contacts: AgencyContactView[]; person: string } {
  const source = https(url);
  if (!source || !text) return { contacts: [], person: "" };
  const body = text.slice(0, 200_000);
  const contacts: AgencyContactView[] = [];
  for (const m of body.match(AD_EMAIL) ?? []) {
    const v = m.replace(/\.+$/, "").toLowerCase();
    if (isPlainEmail(v) && !contacts.some((c) => c.value === v)) contacts.push({ kind: "email", value: v, label: "From a job ad", source_url: source, found_on: today, confirmed: true });
  }
  for (const m of body.match(AD_PHONE) ?? []) {
    const v = m.trim();
    if (!contacts.some((c) => c.value.replace(/\D/g, "") === v.replace(/\D/g, ""))) contacts.push({ kind: "phone", value: v, label: "From a job ad", source_url: source, found_on: today, confirmed: true });
  }
  const n = AD_NAME.exec(body)?.[1] ?? "";
  const person = n && !NOT_NAMES.has(n.split(" ")[0]!.toLowerCase()) && contacts.length ? n : "";
  return { contacts: contacts.slice(0, 6), person };
}

// ---- Outreach: the email template, and the timeline from drafts and replies --------------------------------------
//
// No open or click tracking: JobCairn is local-first with no server to receive a pixel or a tracked link, Gmail
// proxies images and Apple Mail preloads them (so "opened" means little), and pixels hurt deliverability and privacy
// in personal outreach. Replies (from mail sync) and follow-up dates do the job instead.

/**
 * The agency's published addresses (matched exactly), and the one domain a reply may come from: its own website's
 * (and subdomains). Address domains never widen the match: an address from an ad may belong to the client, or to
 * web mail, so "Replied" (which saves) only follows mail that is really from the agency.
 */
export function agencyAddresses(a: Pick<AgencyRecordView, "contacts" | "people" | "website">): { addresses: Set<string>; domains: Set<string> } {
  const addresses = new Set([...a.contacts.filter((c) => c.kind === "email").map((c) => c.value), ...a.people.map((p) => p.email)].filter(Boolean).map((x) => x.toLowerCase()));
  const domains = new Set<string>();
  try { if (a.website) domains.add(new URL(a.website).hostname.replace(/^www\./, "").toLowerCase()); } catch { /* no site */ }
  return { addresses, domains };
}
const fromAgency = (addr: string, m: { addresses: Set<string>; domains: Set<string> }) => {
  const x = (/<([^>]+)>/.exec(addr)?.[1] ?? addr).trim().toLowerCase();
  const d = x.slice(x.lastIndexOf("@") + 1);
  return m.addresses.has(x) || [...m.domains].some((dom) => d === dom || d.endsWith(`.${dom}`));
};

export interface OutreachDraft { to: string; subject: string; status: string; updated: string }
export interface OutreachReply { from: string; date: string; subject: string }
export interface AgencyEvent { at: string; event: string; note: string }

/**
 * An agency's timeline: its own events (tracking changes, Claude's finds, ads), emails drafted and sent to its
 * addresses, replies from its addresses or domain, and a follow-up that is due. Newest first. `patch` is what the
 * mail says should change: a reply after contact sets "Replied", and a sent email with no contacted date sets it.
 */
export function agencyActivity(a: AgencyRecordView, drafts: OutreachDraft[], replies: OutreachReply[], today: string): { events: AgencyEvent[]; patch: AgencyPatch | null } {
  const m = agencyAddresses(a);
  const events: AgencyEvent[] = a.timeline.map((e) => ({ at: e.at, event: e.event, note: e.note ?? "" }));
  const mine = drafts.filter((d) => d.to.split(",").some((t) => t.trim() && fromAgency(t, m)));
  for (const d of mine) events.push({ at: d.updated, event: d.status === "sent" ? "Email sent" : d.status === "waiting" ? "Email waiting for approval" : "Email drafted", note: d.subject });
  const theirs = replies.filter((r) => fromAgency(r.from, m));
  for (const r of theirs) events.push({ at: r.date, event: "Reply received", note: r.subject });
  const t = a.tracking;
  if (t.follow_up_on && t.follow_up_on <= today && (t.status === "contacted" || t.status === "to_contact")) events.push({ at: t.follow_up_on, event: "Follow-up due", note: "" });
  events.sort((x, y) => y.at.localeCompare(x.at));
  const sent = mine.filter((d) => d.status === "sent").map((d) => d.updated).sort();
  const since = t.contacted_on || sent[0] || "";
  const patch: AgencyPatch = {};
  if (!t.contacted_on && sent[0]) patch.contacted_on = sent[0].slice(0, 10);
  if ((t.status === "to_contact" || t.status === "contacted") && since && theirs.some((r) => r.date.slice(0, 10) >= since.slice(0, 10))) patch.status = "replied";
  return { events: events.slice(0, 50), patch: Object.keys(patch).length ? patch : null };
}

export interface RecruiterEmailInput {
  /** The candidate, from the profile. */
  me: { name: string; roles: string[]; seniority: string; cities: string[]; visa_subclass: string };
  agency: Pick<AgencyRecordView, "name" | "specialties" | "best_contact">;
  /** The job it is about, or null for a general enquiry. */
  job: { title: string; location: string } | null;
  /** Add the sponsorship question (only offered to people who need sponsorship). */
  sponsorship: boolean;
  attached: boolean;
}
/** The sponsorship question, in the candidate's words. */
export function sponsorshipLine(visa: string): string {
  const v = visa.trim().replace(/^subclass\s*/i, "");
  return `I hold ${v ? `a subclass ${v} visa` : "a temporary visa"} and would need sponsorship. Do your clients sponsor for these roles?`;
}
/** Subject "<Role> – <Name>" or "Enquiry: <specialty> roles – <Name>", and a short body from the profile. The app adds the signature. */
export function recruiterEmailDraft(i: RecruiterEmailInput): { subject: string; body: string } {
  const name = i.me.name.trim() || "Me";
  const first = name.split(/\s+/)[0]!;
  const role = i.me.roles[0]?.trim() ?? "";
  const specialty = i.agency.specialties[0]?.trim() || role || "suitable";
  const subject = i.job ? `${i.job.title} – ${name}` : `Enquiry: ${specialty} roles – ${name}`;
  const greet = i.agency.best_contact.name ? `Hi ${i.agency.best_contact.name.split(/\s+/)[0]},` : "Hi,";
  const who = [i.me.seniority.trim(), role].filter(Boolean).join(" ");
  const where = i.me.cities.filter(Boolean).slice(0, 2).join(" or ");
  const intro = `I'm ${name}${who ? `, ${/^[aeiou]/i.test(who) ? "an" : "a"} ${who}` : ""}${where ? ` based in ${where}` : ""}.`;
  const ask = i.job
    ? `I'm interested in the ${i.job.title} role you advertised${i.job.location ? ` in ${i.job.location}` : ""} and would like to apply.`
    : `I'm looking for ${i.me.roles.slice(0, 2).join(" or ") || "new"} roles${where ? ` in ${where}` : ""} and would like to hear about anything suitable you're recruiting for.`;
  const lines = [greet, "", `${intro} ${ask}`];
  if (i.sponsorship) lines.push("", sponsorshipLine(i.me.visa_subclass));
  lines.push("", i.attached ? "My resume is attached. I'm happy to talk whenever suits you." : "I'm happy to send my resume and talk whenever suits you.", "", "Regards,", first);
  return { subject, body: lines.join("\n") };
}
