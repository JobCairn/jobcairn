import type { BoardId } from "@careeros/contract";
import { BOARDS } from "./boards.js";
import type { HelperRun } from "./helper.js";

/**
 * What a job ad's page holds besides its text, for filling in a job: the page's <title>, a JobPosting JSON-LD block,
 * and the ad's own contact links (mailto: and tel:). SEEK masks an email in the ad's text ("••••@example.com") while
 * the link's address is the real one, so the address is read from the link.
 * PRIVACY and safety: all of it is data. Nothing here clicks, opens or sends anything. Reads stay inside the board's
 * read scope (boards.ts readScope: LinkedIn never past its main landmark), and every value is capped.
 */

/** Most contact links kept from one ad. */
export const MAX_CONTACTS = 5;
/** Largest JSON-LD block read (characters). */
export const MAX_JSON_LD = 64 * 1024;
const MAX_TITLE = 300;

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** A link's address in the helper's tree: `[ref=e3, url=mailto:…]`, or an indented `/url: mailto:…` line. */
const LINK = /(?:\b(?:url|href)=["']?|\/url:\s*)((?:mailto|tel):[^\s,\]"'<>]{1,300})/gi;

/**
 * The ad's contact links from a scoped snapshot with link addresses (`snapshot -u`): `mailto:` as the bare address
 * (no `?subject=` and the like), `tel:` as the number. Deduplicated, in page order, at most MAX_CONTACTS.
 */
export function contactLinks(snapshot: string): string[] {
  const out: string[] = [];
  for (const m of snapshot.matchAll(LINK)) {
    let raw = m[1]!;
    try { raw = decodeURIComponent(raw); } catch { /* keep as is */ }
    const [scheme, rest = ""] = [raw.slice(0, raw.indexOf(":")).toLowerCase(), raw.slice(raw.indexOf(":") + 1)];
    let v = "";
    if (scheme === "mailto") {
      const addr = rest.split("?")[0]!.split(",")[0]!.trim();
      if (EMAIL.test(addr)) v = addr.toLowerCase();
    } else {
      const num = rest.split(/[?;]/)[0]!.replace(/[^\d+]/g, "");
      if (/^\+?\d{6,15}$/.test(num)) v = num;
    }
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_CONTACTS) break;
  }
  return out;
}

/** A masked email in the ad's text ("••••@example.com", "****@example.com"): its domain, lower case. */
function maskedDomains(text: string): string[] {
  return [...text.matchAll(/(?:[•*●·xX]{2,}|\.{3,}|…)@([A-Za-z0-9.-]+\.[A-Za-z]{2,24})/g)].map((m) => m[1]!.toLowerCase());
}

/**
 * The line put after an ad's text: "Contact links in this ad: a@example.com, 0491570006". When the text shows an
 * email masked and a link has the same domain, the line says the link is that address. "" when there are none.
 */
export function contactLine(links: readonly string[], text: string): string {
  if (!links.length) return "";
  const masked = new Set(maskedDomains(text));
  const shown = links.map((l) => (l.includes("@") && masked.has(l.split("@")[1]!) ? `${l} (the ad's text shows it masked as ••••@${l.split("@")[1]})` : l));
  return `Contact links in this ad: ${shown.join(", ")}`;
}

/** The first email among the contact links, for a job's "Apply via". "" when none. */
export const contactEmail = (links: readonly string[]) => links.find((l) => l.includes("@")) ?? "";

/** A JSON-LD block's text, parsed when it is small enough and valid JSON; undefined otherwise. Never run. */
export function parseJsonLd(raw: unknown): unknown {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t || t.length > MAX_JSON_LD) return undefined;
  try { return JSON.parse(t) as unknown; } catch { return undefined; }
}

export interface AdExtras { pageTitle: string; jsonLd: unknown; contacts: string[] }

/**
 * Reads an ad page's extras in the tab the session is bound to (the caller holds the lock and has checked the page
 * is the board's ad). `scope` is the read scope the ad's text came from ("main" or "body"). Each part is best effort.
 */
export async function readAdExtras(run: HelperRun, board: BoardId, scope: "main" | "body"): Promise<AdExtras> {
  const within = (sel: string) => (scope === "body" ? sel : `${scope} ${sel}`);
  const out: AdExtras = { pageTitle: "", jsonLd: undefined, contacts: [] };
  const title = await run(["get", "title"]).catch(() => null);
  const t = title?.ok ? title.data?.title ?? title.data?.text : undefined;
  if (typeof t === "string") out.pageTitle = t.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  // A JobPosting block sits in a script tag: within the scope on a board with private overlays, anywhere otherwise.
  const ldSel = BOARDS[board].readScope.includes("body") ? 'script[type="application/ld+json"]' : within('script[type="application/ld+json"]');
  const ld = await run(["get", "html", ldSel]).catch(() => null);
  if (ld?.ok) out.jsonLd = parseJsonLd(ld.data?.html ?? ld.data?.text);
  const snap = await run(["snapshot", "-i", "-c", "-u", "-s", scope]).catch(() => null);
  if (snap?.ok && typeof snap.data?.snapshot === "string") out.contacts = contactLinks(snap.data.snapshot);
  return out;
}
