import type { PageKind } from "./boards.js";

/**
 * Read-only rules for the browser tools (lane S). A run may look and search, never act for the person: no apply,
 * save, follow, message, post, upload or account change. These checks run in jobcairn-chrome (the browser command) on every
 * click and fill, using the element's role and accessible name from the tab's last snapshot (the helper's
 * `snapshot --json` answer), the kind of page the tab is on (boards.ts pageKind) and where the element sits.
 */

export interface RefInfo {
  ref: string;
  role: string;
  name: string;
  /** Inside an inlined frame (another page, maybe another site): never clicked or typed into. */
  inFrame: boolean;
  /** The element's ancestors in the tree, outermost first (role and name), when known. */
  containers: { role: string; name: string }[];
}

export interface Snapshot {
  /** The page's address, from the same answer as the tree (no race with a separate "get url"). */
  url: string;
  /** The tree as text, for Claude. */
  text: string;
  refs: Map<string, RefInfo>;
}

const REF = /^@?(e\d{1,6})$/;

/** `@e12` or `e12` to `e12`, or null. */
export function normRef(ref: string): string | null {
  const m = REF.exec(ref.trim());
  return m ? m[1]! : null;
}

const LINE = /^(\s*)-\s+([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[([^\]]*)\])?/;

/**
 * Reads the helper's `snapshot --json` data: `{ origin, refs: { eN: { role, name } }, snapshot }`. The tree text is
 * walked by indentation (two spaces a level) to find each ref's ancestors, so a ref under an `Iframe` node is
 * marked. A ref listed in `refs` but missing from the text is treated as inside a frame (fail closed).
 */
export function parseSnapshot(data: Record<string, unknown> | null): Snapshot | null {
  if (!data || typeof data.snapshot !== "string") return null;
  const text = data.snapshot;
  const url = typeof data.origin === "string" ? data.origin : "";
  const raw = data.refs && typeof data.refs === "object" && !Array.isArray(data.refs) ? data.refs as Record<string, unknown> : {};
  const seen = new Map<string, { inFrame: boolean; containers: { role: string; name: string }[] }>();
  const stack: { indent: number; role: string; name: string }[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const role = m[2]!.toLowerCase();
    const name = (m[3] ?? "").replace(/\\(.)/g, "$1");
    const ref = /(?:^|,\s*)ref=(e\d{1,6})(?:\s*,|$)/.exec(m[4] ?? "")?.[1];
    if (ref && !seen.has(ref)) {
      seen.set(ref, { inFrame: stack.some((s) => s.role === "iframe"), containers: stack.map((s) => ({ role: s.role, name: s.name })) });
    }
    stack.push({ indent, role, name });
  }
  const refs = new Map<string, RefInfo>();
  for (const [ref, v] of Object.entries(raw)) {
    if (!normRef(ref) || !v || typeof v !== "object") continue;
    const o = v as { role?: unknown; name?: unknown };
    const where = seen.get(ref);
    refs.set(ref, {
      ref, role: typeof o.role === "string" ? o.role.toLowerCase() : "", name: typeof o.name === "string" ? o.name : "",
      inFrame: where ? where.inFrame : true, containers: where?.containers ?? [],
    });
  }
  return { url, text, refs };
}

export function findRef(snap: Snapshot | null | undefined, ref: string): RefInfo | null {
  const id = normRef(ref);
  if (!id || !snap) return null;
  return snap.refs.get(id) ?? null;
}

/**
 * A control's name as the rules read it: compatibility forms folded (full-width "Ａｐｐｌｙ" is "Apply"), zero-width
 * and direction marks removed, accents removed, spaces collapsed, lower case.
 */
export function normName(s: string): string {
  const base = s.normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ").trim().toLowerCase();
  return [...base].map((c) => CONFUSABLE[c] ?? c).join("");
}

/** Cyrillic and Greek letters that look like Latin ones (lower case, after NFKC), folded so a Cyrillic "Аpply" reads "apply". */
const CONFUSABLE: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j",
  "\u0455": "s", "\u0501": "d", "\u04CF": "l", "\u0475": "v", "\u0461": "w", "\u043A": "k", "\u043C": "m", "\u043D": "h", "\u0442": "t",
  "\u0432": "b", "\u051B": "q",
  "\u03BF": "o", "\u03B1": "a", "\u03B5": "e", "\u03B9": "i", "\u03BA": "k", "\u03BD": "v", "\u03C1": "p", "\u03C4": "t", "\u03C5": "u",
  "\u03C7": "x", "\u03B2": "b", "\u03B7": "n", "\u03BC": "u", "\u03C9": "w", "\u03B3": "y",
};

/**
 * True when a name mixes Latin letters with letters of another alphabet (a lookalike trick: "Save" spelt with a
 * Cyrillic "a"). Checked on the raw name, before folding.
 */
export function mixedScripts(name: string): boolean {
  const n = name.normalize("NFKC");
  return /\p{Script=Latin}/u.test(n) && /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u.test(n);
}

/** Exact whole names that only change the results on a search page (checked before the deny list). */
const FILTER_NAMES = [
  /^(apply|show|see|update)( all| selected)? filters?$/,
  /^show( \d[\d,+]*)? (results|jobs)$/,
  /^(see|show) (more|all)( jobs| results)?$/,
  /^(next|previous|prev|next page|previous page|page \d+)$/,
  /^(clear|reset)( all)?( filters)?$/,
];

const COOKIE_ACCEPT = /^(accept|accept all|accept all cookies|accept cookies|allow all( cookies)?|agree|i agree|got it|ok)$/;
const COOKIE_REJECT = /^(reject|reject all|reject all cookies|decline|decline all|necessary only|only necessary( cookies)?|use necessary cookies only|essential only|only essential( cookies)?)$/;
const COOKIE_BOX = /\b(cookies?|tracking|privacy choices)\b/;
const BOX_ROLES = new Set(["dialog", "alertdialog", "region", "banner", "complementary", "contentinfo", "form", "group"]);

export const isCookieAccept = (name: string): boolean => COOKIE_ACCEPT.test(normName(name));
export const isCookieReject = (name: string): boolean => COOKIE_REJECT.test(normName(name));
/** The element sits inside a cookie or consent box (needs the full tree's containers). */
export const inCookieBox = (el: RefInfo): boolean => el.containers.some((c) => BOX_ROLES.has(c.role) && COOKIE_BOX.test(normName(c.name)));

/** Names of controls that act for the person. Matched as words on the normalised name. */
const ACTS = new RegExp([
  "apply", "applied", "applying", "easy\\s*apply", "quick\\s*apply", "submit", "save", "saved", "unsave", "bookmark", "follow", "following", "unfollow",
  "message", "messages", "messaging", "inmail", "connect", "send", "post", "repost", "share", "upload", "attach", "like", "comment", "reply",
  "endorse", "recommend", "invite", "subscribe", "unsubscribe", "create\\s+(a\\s+)?(job\\s+)?alert", "set\\s+(up\\s+)?(an?\\s+)?alert", "alert\\s+me",
  "report", "block", "delete", "remove", "edit", "update\\s+(your\\s+)?profile", "profile\\s+settings", "settings", "preferences", "privacy",
  "sign\\s*out", "log\\s*out", "logout", "sign\\s*in", "log\\s*in", "login", "sign\\s*up", "register", "join(\\s+now)?", "pay", "purchase", "buy",
  "upgrade", "premium", "try\\s+premium", "confirm", "accept", "agree",
  "i'?m\\s+interested", "interested", "not\\s+interested", "dismiss", "hide", "show\\s+less(\\s+like\\s+this)?", "withdraw", "referral", "refer",
  "introduc\\w*", "get\\s+introduced", "notify", "notified", "helpful", "vote", "rate", "review", "add", "add\\s+skill", "download",
  "continue\\s+(as|with)", "use\\s+.*\\s+account", "open\\s+to\\s+work", "verify",
  "application", "applications", "alerts?", "job\\s+alerts?", "contact", "reveal", "request", "show\\s+phone", "phone\\s+number",
  "(company|employer)('?s)?\\s+(site|website)", "turn\\s+on", "enable", "enabled",
].map((w) => `\\b${w}\\b`).join("|"), "i");

/** Roles a run may click: links, buttons, tabs, menu and list choices, filter boxes. */
const CLICKABLE = new Set(["link", "button", "tab", "option", "menuitem", "menuitemradio", "menuitemcheckbox", "combobox", "checkbox", "radio", "treeitem", "listitem"]);
/** Roles that change a setting-like choice: only on a search-results page, where they are filters. */
const CHOICE = new Set(["checkbox", "radio", "option", "menuitemradio", "menuitemcheckbox", "combobox"]);

export interface ClickContext {
  /** The kind of page the tab is on. */
  kind: PageKind;
  /** For a cookie "Accept": whether it sits in a cookie box, and a reject choice in that box (to use instead). */
  cookie?: { inBox: boolean; reject: string | null };
}

/**
 * Plain reasons, given back to Claude. Null: allowed. In order, first match decides:
 * missing ref, inside a frame, a sign-in page, no name, a role a run doesn't click; then the narrow filter names
 * on a search page; a cookie "Accept" inside a cookie box with no reject choice; then the deny list (apply, save,
 * message, …); then choices (checkbox, radio, option) only on a search page.
 */
export function clickRefusal(el: RefInfo | null, ctx: ClickContext): string | null {
  if (!el) return "That element isn't in the last snapshot of this tab. Take a new snapshot and use a ref from it.";
  if (el.inFrame) return "That control is inside a frame (often another site's sign-in or an ad). This run doesn't use frames.";
  if (ctx.kind === "wall") return "This is a sign-in or check page. The person deals with it; this run never clicks here.";
  const name = normName(el.name);
  if (!name) return "That control has no name, so it's unclear what it does. It wasn't clicked.";
  if (mixedScripts(el.name)) return "That control's name mixes alphabets (a lookalike trick), so it wasn't clicked.";
  if (!CLICKABLE.has(el.role)) return `This run doesn't click a ${el.role || "control without a role"}. Use links, buttons, tabs and filters only.`;
  if (ctx.kind === "search" && FILTER_NAMES.some((r) => r.test(name))) return null;
  if (COOKIE_ACCEPT.test(name) && ctx.cookie?.inBox) {
    if (ctx.cookie.reject) return `This cookie box has "${ctx.cookie.reject.slice(0, 40)}". Use that instead of accepting.`;
    return null;
  }
  if (ACTS.test(name)) return `"${el.name.slice(0, 60)}" acts for the person (apply, save, follow, message, post, upload or account changes). This run only reads, so it wasn't clicked.`;
  if (CHOICE.has(el.role) && ctx.kind !== "search") return "Choices like this are only used as filters on a search results page.";
  return null;
}

const FILLABLE_ROLES = new Set(["searchbox", "combobox"]);
const SEARCH_NAME = /\b(search|keywords?|location|where|suburb|city|town|region|postcode|post code)\b/i;
const PRIVATE = /\b(password|e-?mail|phone|mobile|message|comment|note|cover|resume|cv|first\s+name|last\s+name|full\s+name|your\s+name|address|card|salary\s+expectation|answer|question|reply|post|share|talk about|headline|summary)\b/i;

export function fillRefusal(el: RefInfo | null, text: string, kind: PageKind): string | null {
  if (!el) return "That box isn't in the last snapshot of this tab. Take a new snapshot and use a ref from it.";
  if (el.inFrame) return "That box is inside a frame. This run doesn't use frames.";
  if (kind !== "search") return "This run only types into the search box on a search results page. Use search with the board and your words instead.";
  const t = text.trim();
  if (!t) return "There's nothing to type.";
  if (t.startsWith("-")) return "Search words can't start with \"-\".";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(text)) return "Search words are one plain line of text.";
  const name = normName(el.name);
  if (PRIVATE.test(name)) return `"${el.name.slice(0, 60)}" isn't a search box. This run only types search words and places.`;
  const searchy = FILLABLE_ROLES.has(el.role) || (el.role === "textbox" && SEARCH_NAME.test(name));
  if (!searchy) return "This run only types into search, keyword and location boxes.";
  return null;
}

/** Enter only in the board's own search box (a searchbox or combobox) on a search results page. */
export function submitRefusal(el: RefInfo, kind: PageKind): string | null {
  if (kind !== "search" || !FILLABLE_ROLES.has(el.role)) return "Enter is only pressed in the board's search box. The words were typed; use search with the board and your words to search.";
  return null;
}

/** Signs that a person is needed: a check, a CAPTCHA, an "unusual activity" page. Read from the tree, not ad text. */
const CAPTCHA = /captcha|verify (that )?you('| a)re (a )?human|performing security verification|verifying you are (a )?human|are you a robot|not a robot|unusual (activity|traffic)|press (and|&) hold|just a moment|checking (if the site connection is secure|your browser)|let'?s confirm (it'?s|you)|quick security check/i;

export type NeedsPerson = "captcha" | "login" | null;

/**
 * A bot check's own wording (Cloudflare's interstitial and the like), for a page's text when its controls tree is
 * near-empty. Phrases a genuine job ad wouldn't hold ("security check" alone can be part of a clearance ad).
 */
const BOT_CHECK = /performing security verification|verif(y|ying) (that )?you are (a )?human|needs to review the security of your connection|checking (if the site connection is secure|your browser)|just a moment\.\.\.|enable javascript and cookies to continue|cf-chl|ray id: ?[0-9a-f]{8,}/i;
export function botCheckText(text: string): boolean { return BOT_CHECK.test(text); }

/**
 * Whether the page needs the person. Checked on the snapshot tree and the page kind only (never on a job ad's own
 * text, where "security check" or "verify your identity" can be part of a genuine clearance ad).
 */
export function needsPerson(kind: PageKind, snap: Snapshot): NeedsPerson {
  if (CAPTCHA.test(snap.text)) return "captcha";
  if (kind === "wall") return "login";
  for (const r of snap.refs.values()) if (r.role === "textbox" && /\bpassword\b/i.test(normName(r.name))) return "login";
  return null;
}
