// Ghost and repost detection: quiet hints that an ad may no longer be live. Computed on this computer only, from the
// jobs already saved (their posted dates and ad text). Nothing is looked up online.
import { postedDate } from "./analytics.js";
import type { JobStatus } from "./constants.js";
import { closingState } from "./closing-date.js";

const DAY = 86_400_000;

/** An ad posted more than this many days ago is "Possibly stale": most boards close or quietly keep ads by then. */
export const GHOST_STALE_DAYS = 30;
/** Two ads from one company whose text is at least this similar (shingle Jaccard, 0-1) are the same ad posted again. */
export const REPOST_SIMILARITY = 0.9;
/** Ads shorter than this many words are never compared: short or empty text matches too easily. */
export const REPOST_MIN_WORDS = 40;
/** Words per shingle. */
const SHINGLE = 5;
/** Statuses where a stale or reposted ad is worth flagging (and hiding): nothing has been sent yet. */
export const GHOST_OPEN: readonly JobStatus[] = ["Found", "Saved", "Applying"];

/** Why an ad might be a ghost. Each is a sentence for the pill's tooltip, or absent. */
export interface GhostFlags {
  stale?: string;
  repost?: string;
  /** The ad's own closing date has passed (closing-date.ts). Shown by the closing badge, not as a ghost pill. */
  closed?: string;
}

/**
 * Ad text for comparing: accents, case, punctuation, Markdown and links gone, "&" read as "and", one space between
 * words. Same rule as the duplicate check's names (core dedupe.ts words()).
 */
export function normaliseAdText(text: string): string {
  return (text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/https?:\/\/\S+/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** A short fingerprint of normalised ad text (FNV-1a, 32-bit, hex). Equal text gives an equal hash. */
export function adTextHash(text: string): string {
  const s = normaliseAdText(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The ad's word shingles (runs of five words), for comparing two ads that differ in a few words. */
export function shingles(text: string, size = SHINGLE): Set<string> {
  const w = normaliseAdText(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (w.length < size) { if (w.length) out.add(w.join(" ")); return out; }
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(" "));
  return out;
}

/** Jaccard similarity of two shingle sets: 1 for the same text, 0 for nothing in common. */
export function shingleSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let both = 0;
  for (const s of small) if (big.has(s)) both++;
  return both / (a.size + b.size - both);
}

const wordCount = (text: string) => normaliseAdText(text).split(" ").filter(Boolean).length;
const dayLabel = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/** "Possibly stale" for an open ad posted more than GHOST_STALE_DAYS ago, else null. Unknown posted dates never flag. */
export function staleReason(row: { posted: string; status: JobStatus }, now: Date): string | null {
  if (!GHOST_OPEN.includes(row.status)) return null;
  const p = postedDate(row.posted);
  if (!p) return null;
  const age = Math.floor((now.getTime() - Date.parse(`${p}T00:00:00.000Z`)) / DAY);
  if (age <= GHOST_STALE_DAYS) return null;
  return `Posted ${age} days ago (${dayLabel(p)}). Ads this old are often filled or no longer looked at.`;
}

/** One saved ad as repost detection sees it. `company` is already a comparison key (core companyKey). */
export interface GhostAd {
  key: string; company: string; id: string; title: string; posted: string; found_at: string; text: string;
}

/** When the ad first appeared: its posted date, else when it was found. */
const firstSeen = (a: GhostAd) => postedDate(a.posted) ?? a.found_at.slice(0, 10);

/**
 * Reposts: an ad from the same company with near-identical text (an equal text hash, or shingle similarity of at
 * least REPOST_SIMILARITY) under another id or date. The later one is flagged and its reason names the earlier one.
 * Returns the reason by ad key. Ads under REPOST_MIN_WORDS words are left out.
 */
export function findReposts(ads: GhostAd[]): Map<string, string> {
  const out = new Map<string, string>();
  const byCompany = new Map<string, GhostAd[]>();
  for (const a of ads) {
    if (!a.company || wordCount(a.text) < REPOST_MIN_WORDS) continue;
    (byCompany.get(a.company) ?? byCompany.set(a.company, []).get(a.company)!).push(a);
  }
  for (const group of byCompany.values()) {
    if (group.length < 2) continue;
    // Oldest first, so each ad is compared with the ones before it and the earliest one stays unflagged.
    const sorted = [...group].sort((x, y) => firstSeen(x).localeCompare(firstSeen(y)) || x.found_at.localeCompare(y.found_at) || x.id.localeCompare(y.id));
    const prepared = sorted.map((a) => ({ a, hash: adTextHash(a.text), sh: shingles(a.text) }));
    for (let i = 1; i < prepared.length; i++) {
      const cur = prepared[i]!;
      for (let j = 0; j < i; j++) {
        const prev = prepared[j]!;
        const sim = prev.hash === cur.hash ? 1 : shingleSimilarity(prev.sh, cur.sh);
        if (sim < REPOST_SIMILARITY) continue;
        const when = dayLabel(postedDate(prev.a.posted) ?? prev.a.found_at);
        const lead = sim === 1 ? "The same ad text as" : `Ad text ${Math.floor(sim * 100)}% the same as`;
        out.set(cur.a.key, `${lead} "${prev.a.title}"${when ? `, saved from ${when}` : ""}. A role advertised again may be hard to fill, or not really open.`);
        break;
      }
    }
  }
  return out;
}

/**
 * Whether "Hide likely stale" hides this row: an open ad whose closing date has passed, or that was posted again.
 * Age alone ("Possibly stale", posted over 30 days ago) is shown but never hides an ad: many stay open for weeks,
 * and one with a closing date still to come is plainly open (spec 2026-10-17-closing-dates-and-board-health).
 */
export function hiddenAsStale(row: { status: JobStatus; ghost?: GhostFlags }): boolean {
  return GHOST_OPEN.includes(row.status) && !!(row.ghost?.closed || row.ghost?.repost);
}

/** The rows with their ghost flags: stale from the posted date, closed from the ad's closing date, reposts from findReposts (keyed "slug/id"). */
export function withGhostFlags<R extends { company_slug: string; id: string; posted: string; status: JobStatus; closes_on?: string; ghost?: GhostFlags }>(
  rows: R[], reposts: Map<string, string>, now: Date,
): R[] {
  return rows.map((r) => {
    const stale = staleReason(r, now);
    const repost = reposts.get(`${r.company_slug}/${r.id}`);
    const closing = closingState(r, now);
    const closed = closing?.closed ? closing.why : undefined;
    if (!stale && !repost && !closed) return r;
    return { ...r, ghost: { ...(stale ? { stale } : {}), ...(repost ? { repost } : {}), ...(closed ? { closed } : {}) } };
  });
}
