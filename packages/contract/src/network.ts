import type { DraftText } from "./outreach.js";

/**
 * Referral finder: the person's own LinkedIn connections, from the Connections.csv in LinkedIn's official data export
 * (Settings › Data privacy › Get a copy of your data). The app reads only the columns below, keeps them on this
 * computer in the workspace (me/network, which has its own "ignore everything" .gitignore), and never puts them in a
 * Claude prompt. Matching is by company name only; nothing is looked up online and nobody is messaged automatically.
 */

export interface NetworkPerson {
  first: string; last: string;
  /** Their LinkedIn profile address (https only), or "". */
  url: string;
  /** Only when they chose to share it with connections; often "". */
  email: string;
  company: string; position: string;
}
export interface NetworkStatus {
  /** How many connections are saved (0 when none were imported). */
  count: number;
  /** When they were imported (ISO), or "". */
  imported_at: string;
  /** The imported file's name, or "". */
  file: string;
}

/** The most connections one import keeps. */
export const MAX_CONNECTIONS = 30_000;
const MAX_FIELD = 200;

/** Splits CSV text into rows of cells: quoted cells may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const clean = (v: string | undefined) => Array.from((v ?? "").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim()).slice(0, MAX_FIELD).join("");
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/**
 * Reads LinkedIn's Connections.csv. The header row ("First Name,Last Name,URL,Email Address,Company,Position,...") is
 * found wherever it is: LinkedIn puts a "Notes:" preamble above it. Rows with no name are skipped. Throws a plain
 * message when the file isn't a connections export.
 */
export function parseLinkedInConnections(text: string): NetworkPerson[] {
  const rows = parseCsv(text);
  const head = rows.findIndex((r) => r.some((c) => /^first name$/i.test(c.trim())) && r.some((c) => /^last name$/i.test(c.trim())));
  if (head < 0) throw new Error("This doesn't look like LinkedIn's Connections.csv. Pick the Connections.csv file from your LinkedIn data export.");
  const cols = rows[head]!.map((c) => c.trim().toLowerCase());
  const at = (name: string) => cols.indexOf(name);
  const idx = { first: at("first name"), last: at("last name"), url: at("url"), email: at("email address"), company: at("company"), position: at("position") };
  const out: NetworkPerson[] = [];
  for (const r of rows.slice(head + 1)) {
    const get = (i: number) => (i < 0 ? "" : clean(r[i]));
    const first = get(idx.first);
    const last = get(idx.last);
    if (!first && !last) continue;
    const url = get(idx.url);
    const email = get(idx.email);
    out.push({
      first, last, url: /^https:\/\/[^\s<>"'`]+$/i.test(url) ? url : "", email: EMAIL.test(email) ? email : "",
      company: get(idx.company), position: get(idx.position),
    });
    if (out.length >= MAX_CONNECTIONS) break;
  }
  return out;
}

const SUFFIXES = new Set([
  "pty", "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc", "corp", "corporation", "co", "company", "group", "holdings", "gmbh", "ag",
  "sa", "bv", "nv", "the", "australia", "aus", "au", "nz", "global", "international", "intl",
]);

/** A company name for matching: lower case, no accents or punctuation, without "Pty Ltd", "Inc", "Group" and the like. */
export function normaliseCompany(name: string): string {
  const words = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words.at(-1)!)) words.pop();
  while (words.length > 1 && words[0] === "the") words.shift();
  return words.join(" ");
}

/** The connections who work at one of these company names (exact match after normalising), sorted by name. */
export function peopleAt(people: readonly NetworkPerson[], companyNames: readonly string[]): NetworkPerson[] {
  const want = new Set(companyNames.map(normaliseCompany).filter(Boolean));
  if (!want.size) return [];
  return people.filter((p) => p.company && want.has(normaliseCompany(p.company)))
    .sort((a, b) => `${a.first} ${a.last}`.localeCompare(`${b.first} ${b.last}`));
}

/**
 * The referral request: friendly, specific, easy to say no to. For Mail (with subject) or, as `body` alone, to copy into
 * a LinkedIn message. The app adds the signature to emails.
 */
export function referralTemplate(person: Pick<NetworkPerson, "first">, job: { title: string; company: string }): DraftText {
  const hi = person.first ? `Hi ${person.first},` : "Hi,";
  return {
    subject: `${job.title} role at ${job.company}`,
    body: `${hi}\n\nI hope you're well. I'm applying for the ${job.title} role at ${job.company} and wondered if you'd be open to referring me, or telling me a little about the team. I can send my resume and a short summary to make it easy.\n\nNo worries at all if it's not a good time.\n\nRegards,`,
  };
}
