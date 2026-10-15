import { isSafeHttpsUrl } from "./validate.js";

/**
 * A company's published contacts: what Research company writes to companies/<slug>/contacts.json when the
 * "Contacts & careers page" focus is on. Only addresses the company itself publishes, each with the https page it
 * came from. Claude writes the file; the app only reads it, through parseCompanyContacts, which keeps what is
 * well-formed and drops the rest (a bad address, a missing or non-https source), so a half-right file still shows
 * its good entries. Pure, so the services and the UI's mock bridge read it the same way.
 */
export const CONTACT_KINDS = ["careers", "hr", "recruiting", "general", "press", "other"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];
export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  careers: "Careers", hr: "HR", recruiting: "Recruiting", general: "General", press: "Press", other: "Other",
};
export interface ContactEmail {
  address: string; kind: ContactKind;
  /** The https page that publishes the address. */
  source_url: string;
  /** When Claude saw it there (YYYY-MM-DD), or "". */
  found_on: string;
  /** False when Claude couldn't confirm it (or didn't say). */
  confirmed: boolean;
}
export interface CompanyContacts {
  /** The careers page on the company's own site, or "". */
  careers_url: string;
  /** Their job board on an applicant tracking system (Greenhouse, Lever, Workday, SmartRecruiters, Ashby...), or "". */
  ats_board_url: string;
  emails: ContactEmail[];
  /** A published switchboard number, or "". */
  phone: string;
  /** The company's own LinkedIn page, or "". */
  linkedin_url: string;
  notes: string;
  /** How many entries were left out as malformed or unsourced. */
  dropped: number;
}
export const CONTACTS_FILE = "contacts.json";
export const CONTACT_EMAILS_MAX = 20;
/** contacts.json bigger than this isn't read at all. */
export const CONTACTS_MAX_BYTES = 64 * 1024;

// Plain addresses only: no quotes, comments, spaces or display names. The domain needs a dot and a letter TLD.
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
/** True for a plain email address: a local part, "@", and a domain with a letter TLD. */
export function isPlainEmail(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 254) return false;
  const at = s.lastIndexOf("@");
  return at > 0 && at <= 64 && LOCAL.test(s.slice(0, at)) && DOMAIN.test(s.slice(at + 1));
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^\+?[0-9 ()-]{6,24}$/;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const https = (v: unknown) => (typeof v === "string" && isSafeHttpsUrl(v.trim()) ? v.trim() : "");
/** An organisation's own LinkedIn page (linkedin.com/company/...), never a person's profile; else "". */
export const linkedinCompanyPage = (v: unknown): string => {
  const u = https(v);
  try {
    const url = new URL(u);
    return u && /(^|\.)linkedin\.com$/i.test(url.hostname) && /^\/company\/[^/]+/i.test(url.pathname) ? u : "";
  } catch { return ""; }
};
const linkedin = linkedinCompanyPage;

/** One email entry, or null when it can't be shown: a bad address or kind, or a source that isn't a plain https page. */
export function parseContactEmail(raw: unknown): ContactEmail | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const address = typeof o.address === "string" ? o.address.trim() : "";
  const source = https(o.source_url);
  if (!isPlainEmail(address) || !source) return null;
  const kind = (CONTACT_KINDS as readonly string[]).includes(o.kind as string) ? (o.kind as ContactKind) : "other";
  const found = typeof o.found_on === "string" && DATE.test(o.found_on) && !Number.isNaN(Date.parse(o.found_on)) ? o.found_on : "";
  return { address: address.toLowerCase(), kind, source_url: source, found_on: found, confirmed: o.confirmed === true };
}

/**
 * contacts.json's content (already JSON-parsed), or null when it isn't an object at all. Unknown fields are ignored;
 * links that aren't plain https are blanked; emails are deduped (first wins) and capped at CONTACT_EMAILS_MAX.
 */
export function parseCompanyContacts(raw: unknown): CompanyContacts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.emails) ? o.emails : [];
  const emails: ContactEmail[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const e of list) {
    const c = parseContactEmail(e);
    if (!c || seen.has(c.address) || emails.length >= CONTACT_EMAILS_MAX) { dropped++; continue; }
    seen.add(c.address);
    emails.push(c);
  }
  const phone = text(o.phone, 40);
  return {
    careers_url: https(o.careers_url), ats_board_url: https(o.ats_board_url), emails,
    phone: PHONE.test(phone) ? phone : "", linkedin_url: linkedin(o.linkedin_url), notes: text(o.notes, 500), dropped,
  };
}

/** Text of contacts.json -> contacts, or null when it is missing, too big or not JSON. Never throws. */
export function readCompanyContacts(textOrNull: string | null | undefined): CompanyContacts | null {
  if (typeof textOrNull !== "string" || textOrNull.length > CONTACTS_MAX_BYTES) return null;
  try { return parseCompanyContacts(JSON.parse(textOrNull.replace(/^﻿/, ""))); } catch { return null; }
}

/** True when there is something to show: a link, an email or a phone number. */
export const hasContacts = (c: CompanyContacts | null): c is CompanyContacts =>
  !!c && !!(c.careers_url || c.ats_board_url || c.emails.length || c.phone || c.linkedin_url);
