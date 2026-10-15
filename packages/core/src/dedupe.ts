import fs from "node:fs";
import { storedPosted } from "@careeros/contract";
import { type Clock, iso } from "./clock.js";
import { listJobs } from "./jobs.js";
import { layout, splitClient } from "./paths.js";
import { readJson, updateRecord } from "./store.js";

/**
 * One duplicate check for every way a job is added (Find jobs, Add a job, the CLI). A job is already in the
 * workspace when it has the same ad (same board id, or the same address once tracking, fragment and trailing slash
 * are gone), or the same company, the same title and a compatible place. The second rule catches a run that found
 * the ad again without its link. Closed jobs (Rejected, Skipped) only block the same ad, never a new posting.
 */

const TRACKING = /^(utm_|ref$|refid$|trk|trackingid$|source$|gh_src$|lever-source)/i;
const CLOSED = new Set(["Rejected", "Skipped"]);

const onHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * One key per job ad. SEEK, LinkedIn and Indeed ads key on their own ids, so a search link with the ad open and
 * the ad's own page match. Anything else keys on the address without fragment, tracking or trailing slash.
 * Kept in step with jobAdKey in @careeros/contract (a services test runs both over the same links). "" when the
 * text isn't a web address.
 */
export function adKey(url: string): string {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const p = u.pathname;
  let m: RegExpExecArray | null;
  if (["seek.com.au", "seek.com", "seek.co.nz"].some((d) => onHost(host, d))) {
    if ((m = /^\/job\/(\d+)/.exec(p))) return `seek:${m[1]}`;
    const id = u.searchParams.get("jobId") ?? "";
    if (/^\d+$/.test(id)) return `seek:${id}`;
  } else if (onHost(host, "linkedin.com")) {
    if ((m = /^\/jobs\/view\/(?:[a-z0-9-]+-)?(\d+)/i.exec(p))) return `linkedin:${m[1]}`;
    const cur = u.searchParams.get("currentJobId") ?? "";
    if (/^\d+$/.test(cur)) return `linkedin:${cur}`;
  } else if (onHost(host, "indeed.com")) {
    const jk = u.searchParams.get("jk") ?? u.searchParams.get("vjk") ?? "";
    if (/^[0-9a-f]{12,20}$/i.test(jk)) return `indeed:${jk.toLowerCase()}`;
  }
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return `${u.protocol}//${host}${p.replace(/\/+$/, "")}${u.search}`;
}

const words = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

const LEGAL = new Set(["pty", "ltd", "limited", "inc", "incorporated", "llc", "plc", "corp", "corporation", "co", "company", "gmbh", "australia", "aus", "au", "the"]);

/** A company name for comparing: no recruiter client, case, punctuation, legal suffixes or "Australia". */
export function companyKey(name: string): string {
  const w = words(splitClient(name).company).split(" ").filter((x) => x && !LEGAL.has(x));
  return w.join(" ");
}

/** A title for comparing: case, punctuation, "&" and "and", and brackets (the words inside them stay). */
export function titleKey(title: string): string {
  return words(title);
}

const PLACE_NOISE = new Set([
  "qld", "queensland", "nsw", "new", "south", "wales", "vic", "victoria", "wa", "western", "sa", "tas", "tasmania", "act", "nt", "northern", "territory",
  "australia", "au", "aus", "remote", "hybrid", "onsite", "on", "site", "office", "city", "cbd", "inner", "greater", "region", "area", "and", "or", "in",
]);
const placeWords = (loc: string) => new Set(words(loc).split(" ").filter((x) => x && !PLACE_NOISE.has(x) && !/^\d+$/.test(x)));

/**
 * Whether two places can be the same job's. An empty or vague place ("Remote", "Australia") fits anything; two
 * named places fit when one's place words are all in the other's, so "Brisbane QLD" fits "Brisbane City, Fortitude
 * Valley" but "Gold Coast" doesn't fit "Sunshine Coast" and "Brisbane" doesn't fit "Sydney".
 */
export function placesCompatible(a: string | undefined, b: string | undefined): boolean {
  const x = placeWords(a ?? "");
  const y = placeWords(b ?? "");
  if (!x.size || !y.size) return true;
  const within = (p: Set<string>, q: Set<string>) => [...p].every((w) => q.has(w));
  return within(x, y) || within(y, x);
}

export interface DuplicateQuery { url?: string; company: string; title: string; location?: string }
export interface DuplicateHit { company_slug: string; id: string; title: string; company_name: string; by: "link" | "title" }
export interface DuplicateOptions {
  /** "url": only the same ad counts (the legacy importer, where two old applications must stay two). */
  match?: "all" | "url";
  /** The key for an ad's address. Services pass contract's jobAdKey, which also knows applicant systems. */
  key?: (url: string) => string;
}

/** The job already in the workspace that this one duplicates, or null. Read only: never changes a file. */
export function findDuplicateJob(root: string, q: DuplicateQuery, opts: DuplicateOptions = {}): DuplicateHit | null {
  const key = opts.key ?? adKey;
  const want = q.url ? key(q.url) : "";
  const company = opts.match === "url" ? "" : companyKey(q.company);
  const title = opts.match === "url" ? "" : titleKey(q.title);
  const L = layout(root);
  const names = new Map<string, string>();
  const nameOf = (slug: string) => {
    if (!names.has(slug)) {
      let n = slug;
      try { const c = readJson(L.companyFile(slug)) as { name?: unknown }; if (typeof c.name === "string" && c.name) n = c.name; } catch { /* the slug will do */ }
      names.set(slug, n);
    }
    return names.get(slug)!;
  };
  let byTitle: DuplicateHit | null = null;
  for (const j of listJobs(root)) {
    let raw: { url?: unknown; title?: unknown; location?: unknown; status?: unknown };
    try { raw = readJson(j.file) as typeof raw; } catch { continue; }
    const t = typeof raw.title === "string" ? raw.title : "";
    const hit = (by: DuplicateHit["by"]): DuplicateHit => ({ company_slug: j.company_slug, id: j.id, title: t, company_name: nameOf(j.company_slug), by });
    if (want && typeof raw.url === "string" && raw.url && key(raw.url) === want) return hit("link");
    if (byTitle || !company || !title || CLOSED.has(String(raw.status))) continue;
    if (titleKey(t) !== title) continue;
    const name = nameOf(j.company_slug);
    if (companyKey(name) !== company && companyKey(j.company_slug.replace(/-/g, " ")) !== company) continue;
    if (!placesCompatible(q.location, typeof raw.location === "string" ? raw.location : "")) continue;
    byTitle = hit("title");
  }
  return byTitle;
}

export interface SeenAgain { url?: string; salary_text?: string; posted?: string; apply_via?: string; site?: string }

/**
 * The job was found again: fills in the link, pay, posted date and how to apply where the job has none (never
 * replacing what is there), and notes "Seen again on <site> <date>" once per site and day. Returns what it filled.
 */
export function markSeenAgain(root: string, hit: { company_slug: string; id: string }, seen: SeenAgain, c?: Clock): string[] {
  const file = layout(root).jobFile(hit.company_slug, hit.id);
  if (!fs.existsSync(file)) return [];
  const at = iso(c);
  const filled: string[] = [];
  updateRecord("job", file, (j) => {
    const url = seen.url?.trim();
    if (url && !j.url) { j.url = url; filled.push("link"); }
    const pay = seen.salary_text?.trim();
    if (pay && !j.salary.text) { j.salary.text = pay; filled.push("pay"); }
    // "3d ago" becomes a date counted from now, marked approximate (contract storedPosted).
    const posted = storedPosted(seen.posted, at);
    if (posted.posted && !j.posted) { j.posted = posted.posted; if (posted.approx) j.posted_approx = true; filled.push("posted date"); }
    const via = seen.apply_via?.trim();
    if (via && !j.apply_via) { j.apply_via = via; filled.push("how to apply"); }
    const note = `Seen again on ${seen.site?.trim() || "a job site"} ${at.slice(0, 10)}`;
    const said = j.timeline.some((e) => e.event === "Seen again" && e.note.startsWith(note));
    if (!said || filled.length) j.timeline.push({ at, event: "Seen again", note: filled.length ? `${note}. Added the ${filled.join(", ")}.` : note });
  });
  return filled;
}
